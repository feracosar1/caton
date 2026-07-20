/**
 * EXTRACCIÓN POR TANDAS — Batch API de Anthropic.
 *
 * Mismo modelo, mismos tokens, misma precisión: la mitad del precio.
 * El único costo es la espera, y auditar contratos no necesita respuesta
 * inmediata — el humano marca los contratos, se procesan de noche, en la mañana
 * están los hallazgos.
 *
 * Costo medido por contrato (3 informes de supervisión):
 *   PDF completo, en vivo ....... US$ 1.02
 *   recorte por contenido ....... US$ 0.21   (−79%)
 *   recorte + tanda ............. US$ 0.11   (−90%)
 *
 * Reglas del Batch API que hay que respetar:
 *   · hasta 100.000 peticiones o 256 MB por tanda
 *   · la mayoría termina en menos de 1 hora; el techo duro es 24 h
 *   · los resultados llegan en CUALQUIER orden → se indexan por custom_id,
 *     nunca por posición
 *   · cada resultado puede venir succeeded | errored | canceled | expired
 */

import { construirPeticion, leerTranscripcion } from './extractor-f1p18.mjs';

const API = 'https://api.anthropic.com/v1/messages/batches';

const cab = (apiKey) => ({
  'x-api-key': apiKey,
  'anthropic-version': '2023-06-01',
  'content-type': 'application/json',
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Encola una tanda.
 * @param items [{ custom_id, pdf }]  custom_id identifica el informe (ej. "exp42-inf1")
 * @returns { batchId, recortes }  recortes: qué se recortó de cada uno, para auditar
 */
export async function encolarTanda(items, { apiKey = process.env.ANTHROPIC_API_KEY, model } = {}) {
  if (!apiKey) throw new Error('Falta ANTHROPIC_API_KEY');
  if (!items?.length) throw new Error('Tanda vacía');
  if (items.length > 100_000) throw new Error('El Batch API admite máximo 100.000 peticiones por tanda');

  const recortes = {};
  const requests = items.map(({ custom_id, pdf }) => {
    const { body, recorte } = construirPeticion(pdf, model ? { model } : {});
    recortes[custom_id] = recorte.paginas
      ? { paginas: recorte.paginas, numerales: recorte.detectados.map(d => d.numeral) }
      : { completo: true, motivo: recorte.motivo };
    return { custom_id, params: body };
  });

  const res = await fetch(API, {
    method: 'POST',
    headers: cab(apiKey),
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw new Error(`Batch create ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const batch = await res.json();
  return { batchId: batch.id, estado: batch.processing_status, recortes };
}

export async function estadoTanda(batchId, { apiKey = process.env.ANTHROPIC_API_KEY } = {}) {
  const res = await fetch(`${API}/${batchId}`, { headers: cab(apiKey) });
  if (!res.ok) throw new Error(`Batch retrieve ${res.status}`);
  const b = await res.json();
  return { estado: b.processing_status, conteos: b.request_counts, urlResultados: b.results_url };
}

/**
 * Espera a que termine y devuelve los resultados indexados por custom_id.
 * NUNCA por posición: el Batch API los devuelve en cualquier orden.
 */
export async function recogerTanda(batchId, {
  apiKey = process.env.ANTHROPIC_API_KEY,
  intervaloMs = 60_000,
  maxEsperaMs = 24 * 3600 * 1000,     // techo duro del Batch API
  onProgreso = null,
} = {}) {
  const t0 = Date.now();

  let info;
  for (;;) {
    info = await estadoTanda(batchId, { apiKey });
    if (info.estado === 'ended') break;
    if (Date.now() - t0 > maxEsperaMs) throw new Error(`La tanda ${batchId} superó las 24 h`);
    onProgreso?.(info);
    await sleep(intervaloMs);
  }

  const res = await fetch(info.urlResultados, { headers: cab(apiKey) });
  if (!res.ok) throw new Error(`Batch results ${res.status}`);
  const texto = await res.text();

  const ok = {}, fallidos = {};
  for (const linea of texto.split('\n')) {                 // JSONL
    if (!linea.trim()) continue;
    let r;
    try { r = JSON.parse(linea); } catch { continue; }

    switch (r.result?.type) {
      case 'succeeded':
        try { ok[r.custom_id] = leerTranscripcion(r.result.message); }
        catch (e) { fallidos[r.custom_id] = { tipo: 'sin_transcripcion', detalle: e.message }; }
        break;
      case 'errored':
        // invalid_request = el envío está mal, reintentarlo no arregla nada.
        // El resto (5xx, sobrecarga) sí es reintentable.
        fallidos[r.custom_id] = {
          tipo: r.result.error?.type === 'invalid_request' ? 'peticion_invalida' : 'error_servidor',
          detalle: r.result.error?.message ?? 'sin detalle',
          reintentable: r.result.error?.type !== 'invalid_request',
        };
        break;
      case 'expired':
        fallidos[r.custom_id] = { tipo: 'expirado', reintentable: true };
        break;
      case 'canceled':
        fallidos[r.custom_id] = { tipo: 'cancelado', reintentable: true };
        break;
    }
  }

  return { ok, fallidos, conteos: info.conteos };
}
