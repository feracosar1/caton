/**
 * ORQUESTADOR — convierte los módulos sueltos en un pipeline con estado.
 *
 * Ata: búsqueda → descubrimiento → descarga con custodia → extracción (LLM) →
 * motor (SQL/regex) → hallazgos. Mueve el expediente por la máquina de estados
 * del schema-veeduria y persiste en cada paso.
 *
 * El humano decide en las compuertas (marcadas ⚑): NADA se envía, ni se escala a
 * tutela, ni se presenta, sin que una persona lo apruebe. El pipeline llega hasta
 * 'denuncia_borrador' y se detiene ahí.
 *
 * Persistencia OPCIONAL: con { repo } persiste en Supabase; sin él corre en
 * memoria y devuelve el expediente completo — así se prueba el flujo antes de
 * tener la base montada.
 */

import { createHash } from 'crypto';
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import https from 'https';
import { descubrirDocumentos, descubrirInformesDeContrato } from './secop-docs.mjs';
import { extraerInforme } from './extractor-f1p18.mjs';
import { motorNivel1, reglasAritmeticas, reconoceIncumplimiento } from './motor-reglas.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36';
const SOCRATA = 'www.datos.gov.co';

function httpGet(host, path, { binario = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname: host, path, headers: { 'User-Agent': UA, Accept: '*/*' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const u = new URL(res.headers.location, `https://${host}`);
        return httpGet(u.hostname, u.pathname + u.search, { binario }).then(resolve, reject);
      }
      const c = [];
      res.on('data', d => c.push(d));
      res.on('end', () => resolve(binario ? Buffer.concat(c) : Buffer.concat(c).toString()));
    });
    req.on('error', reject);
    req.setTimeout(90_000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Ficha del contrato desde datos abiertos (jbjy-vk9h) ───────────────────────
async function fichaContrato(idContrato) {
  const q = new URLSearchParams({
    $where: `id_contrato = '${idContrato}'`,
    $select: 'id_contrato,referencia_del_contrato,proceso_de_compra,nombre_entidad,nit_entidad,'
           + 'proveedor_adjudicado,documento_proveedor,nombre_representante_legal,'
           + 'valor_del_contrato,fecha_de_firma,tipo_de_contrato,objeto_del_contrato',
    $limit: '1',
  });
  if (process.env.SOCRATA_APP_TOKEN) q.set('$$app_token', process.env.SOCRATA_APP_TOKEN);
  const rows = JSON.parse(await httpGet(SOCRATA, `/resource/jbjy-vk9h.json?${q}`));
  if (!rows.length) throw new Error(`Contrato ${idContrato} no encontrado en datos abiertos`);
  const r = rows[0];
  return {
    id_contrato: idContrato,
    referencia_contrato: r.referencia_del_contrato,
    id_portafolio: r.proceso_de_compra,
    entidad: r.nombre_entidad, nit_entidad: r.nit_entidad,
    contratista: r.proveedor_adjudicado, nit_contratista: r.documento_proveedor,
    supervisor: null,
    valor_contrato: Number(r.valor_del_contrato) || 0,
    fecha_firma: r.fecha_de_firma?.slice(0, 10),
    tipo: r.tipo_de_contrato,
    objeto: r.objeto_del_contrato,
    // el motor necesita estos alias
    referencia: r.referencia_del_contrato,
    valor: Number(r.valor_del_contrato) || 0,
  };
}

const pdftotext = (buf) => {
  const t = `/tmp/vp_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`;
  try { writeFileSync(t, buf); return execSync(`pdftotext -layout -enc UTF-8 "${t}" - 2>/dev/null`, { maxBuffer: 20e6 }).toString(); }
  catch { return ''; }
  finally { try { unlinkSync(t); } catch {} }
};

// ── CRUCE DOCUMENTAL — pliego/estudios × informe de supervisión ───────────────
//
// Usa el texto ya extraído por pdftotext (sin Azure, sin costo adicional).
// Claude Haiku lee el pliego + el informe y busca discrepancias de HECHO:
// plazos, valores, obligaciones y objeto. No reporta diferencias de redacción.
//
// Diseño fail-silencioso: si Anthropic no responde, no hay ANTHROPIC_API_KEY, o
// el texto es insuficiente, devuelve [] y el pipeline sigue sin perder hallazgos.
async function cruzarDocumentos(documentos, contrato, { model } = {}) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return [];

  const MIN_TEXTO = 800;
  const pliegos   = documentos.filter(d => d.tipo === 'pliego'           && (d._texto?.length ?? 0) > MIN_TEXTO);
  const estudios  = documentos.filter(d => d.tipo === 'estudios_previos' && (d._texto?.length ?? 0) > MIN_TEXTO);
  const informes  = documentos.filter(d => d.es_informe                  && (d._texto?.length ?? 0) > MIN_TEXTO);

  // Sin informe no hay qué cruzar — el análisis del informe ya se hace en Nivel 1-2.
  if (!informes.length) return [];

  // Prioridad: pliego > estudios previos
  const docRef = pliegos[0] ?? estudios[0];
  if (!docRef) return [];

  const fmtCOP = (n) => n ? '$' + Math.round(n).toLocaleString('es-CO') : 'N/D';

  // Inventario determinista de documentos del expediente (para que Haiku sepa qué existe).
  // Esto evita el falso positivo de "CDP no encontrado" cuando el CDP SÍ está en el expediente.
  const inventarioDocumentos = documentos
    .map((d, i) => `  ${i + 1}. [${d.tipo ?? 'sin_tipo'}] ${d.nombre}`)
    .join('\n');

  // Detección determinista de CDP: si hay un archivo que parece CDP, anotarlo explícitamente.
  const CDP_RE = /\b(cdp|certificado\s+de\s+disponibilidad|disponibilidad\s+presupuestal)\b/i;
  const tieneCdp = documentos.some(d => CDP_RE.test(d.nombre));
  const notaCdp = tieneCdp
    ? '\nNOTA: El expediente SÍ contiene un Certificado de Disponibilidad Presupuestal (CDP). NO reportes hallazgo de CDP ausente.'
    : '';

  // Recortar para no exceder ~12K tokens de contexto útil:
  //   pliego: primero 10K chars (portada + objeto + obligaciones)
  //   informes: hasta 2 informes × 6K chars c/u
  const textoPliego = docRef._texto.slice(0, 10_000);
  const textoInformes = informes
    .slice(0, 2)
    .map((d, i) => `=== INFORME ${i + 1}: ${d.nombre} ===\n${d._texto.slice(0, 6_000)}`)
    .join('\n\n');

  const TIPOS_VALIDOS = new Set(['CRUCE-PLAZO', 'CRUCE-VALOR', 'CRUCE-OBLIGACION', 'CRUCE-OBJETO', 'CRUCE-REQUISITO']);

  const prompt = `Eres auditor experto en contratación pública colombiana. Tu trabajo es detectar discrepancias de HECHO entre lo que dice el documento precontractual y lo que certifica el informe de supervisión.

CONTRATO: ${contrato.id_contrato}
ENTIDAD: ${contrato.entidad}
VALOR PACTADO: ${fmtCOP(contrato.valor)}
OBJETO: ${contrato.objeto}

DOCUMENTOS EN EL EXPEDIENTE (${documentos.length} archivos):
${inventarioDocumentos}${notaCdp}

=== ${docRef.tipo === 'pliego' ? 'PLIEGO DE CONDICIONES' : 'ESTUDIOS PREVIOS'} — ${docRef.nombre} ===
${textoPliego}

=== INFORME(S) DE SUPERVISIÓN ===
${textoInformes}

Detecta ÚNICAMENTE contradicciones verificables entre lo pactado y lo certificado.
Usa EXACTAMENTE uno de estos tipos (ningún otro):
- CRUCE-PLAZO: plazo del pliego vs plazo real según el informe
- CRUCE-VALOR: valor pactado vs valor certificado o ejecutado
- CRUCE-OBLIGACION: obligación exigida en el pliego que el informe no acredita o reporta incumplida
- CRUCE-OBJETO: el objeto ejecutado difiere del objeto contratado
- CRUCE-REQUISITO: requisito documental exigido en el pliego ausente en el informe

NO reportes: diferencias de redacción, ausencia de menciones si no hay contradicción, inferencias.
Si no hay discrepancia clara, devuelve cruces vacío.

Responde ÚNICAMENTE con JSON válido:
{
  "cruces": [
    {
      "tipo": "CRUCE-PLAZO" | "CRUCE-VALOR" | "CRUCE-OBLIGACION" | "CRUCE-OBJETO" | "CRUCE-REQUISITO",
      "descripcion": "Qué dice el pliego vs qué certifica el informe (máx 200 chars)",
      "evidencia_pliego": "Fragmento exacto del documento precontractual (máx 250 chars)",
      "evidencia_informe": "Fragmento exacto del informe (máx 250 chars)",
      "severidad": "alta" | "media"
    }
  ]
}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: model ?? 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const txt = data.content?.[0]?.text ?? '{}';
    const match = txt.match(/\{[\s\S]*\}/);
    if (!match) return [];

    const { cruces = [] } = JSON.parse(match[0]);

    // Filtrar tipos inválidos — Haiku a veces inventa tipos como "CRUCE-05".
    // Solo aceptamos los 5 tipos del enum del prompt.
    const crucesValidos = cruces.filter(c => TIPOS_VALIDOS.has(c.tipo));
    if (crucesValidos.length < cruces.length) {
      console.warn(`[VEEDOR] cruce documental: ${cruces.length - crucesValidos.length} cruces con tipo inválido descartados →`, cruces.filter(c => !TIPOS_VALIDOS.has(c.tipo)).map(c => c.tipo));
    }

    // Convertir al formato hallazgo estándar del motor
    return crucesValidos.map(c => ({
      regla_id: c.tipo,
      doc_id: informes[0].id,
      doc_nombre: `${docRef.nombre} ↔ ${informes[0].nombre}`,
      folio: 'cruce documental',
      evidencia_textual: c.descripcion,
      detalle: {
        evidencia_pliego: c.evidencia_pliego,
        evidencia_informe: c.evidencia_informe,
        severidad: c.severidad,
        doc_ref_nombre: docRef.nombre,
        doc_ref_tipo: docRef.tipo,
        informes_cruzados: informes.slice(0, 2).map(d => d.nombre),
      },
    }));
  } catch (e) {
    console.warn('[VEEDOR] cruce documental falló silenciosamente:', e.message);
    return [];
  }
}

// ── ANÁLISIS PRE-CONTRACTUAL ────────────────────────────────────────────────
//
// Analiza los documentos pre-contractuales (estudios previos, CDP, pliego,
// análisis de sector) para detectar irregularidades ANTES de la ejecución.
// Se usa principalmente en Contratación Directa, donde no hay informes de
// supervisión que cruzar.
//
// Tipos de hallazgo:
//   PRE-OBJETO-VAGO         Objeto vago o genérico sin especificaciones técnicas
//   PRE-CAUSAL-CD           Contratación directa sin justificación de la causal legal
//   PRE-VALOR-INJUSTIFICADO Valor no respaldado por el estudio de costos
//   PRE-CDP-INCONSISTENTE   CDP con valor diferente al contrato o sin vigencia
//   PRE-SECTOR-DEFICIENTE   Análisis de sector insuficiente para justificar CD
//   PRE-FRACCIONAMIENTO     Valor sospechosamente cercano a tope de CD
//
async function analizarDocumentosPrecontractuales(documentos, contrato, { model } = {}) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return [];

  const MIN_TEXTO = 500;
  const CDP_RE = /\b(cdp|certificado\s+de\s+disponibilidad|disponibilidad\s+presupuestal)\b/i;
  const TIPOS_VALIDOS = new Set([
    'PRE-OBJETO-VAGO', 'PRE-CAUSAL-CD', 'PRE-VALOR-INJUSTIFICADO',
    'PRE-CDP-INCONSISTENTE', 'PRE-SECTOR-DEFICIENTE', 'PRE-FRACCIONAMIENTO',
  ]);

  // Solo documentos pre-contractuales con texto legible
  const docsPrec = documentos.filter(d =>
    (d.tipo === 'estudios_previos' || d.tipo === 'pliego' ||
     CDP_RE.test(d.nombre) || d.tipo === 'analisis_sector' || d.tipo === 'otro_ejecucion') &&
    (d._texto?.length ?? 0) > MIN_TEXTO
  );

  if (!docsPrec.length) return [];

  const fmtCOP = (n) => n ? '$' + Math.round(n).toLocaleString('es-CO') : 'N/D';

  // Construir inventario y fragmentos (máx 8K chars total)
  const fragmentos = docsPrec.slice(0, 4).map((d, i) => {
    const tipo = CDP_RE.test(d.nombre) ? 'CDP' : (d.tipo ?? 'documento').toUpperCase();
    return `=== DOCUMENTO ${i + 1}: [${tipo}] ${d.nombre} ===\n${d._texto.slice(0, 2000)}`;
  }).join('\n\n');

  const prompt = `Eres auditor experto en contratación pública colombiana (Ley 80/93, Ley 1150/07, Decreto 1082/15).
Analiza los documentos pre-contractuales de una Contratación Directa y detecta irregularidades.

CONTRATO: ${contrato.id_contrato}
ENTIDAD: ${contrato.entidad}
VALOR PACTADO: ${fmtCOP(contrato.valor)}
OBJETO: ${contrato.objeto}
MODALIDAD: Contratación Directa

${fragmentos}

Detecta ÚNICAMENTE hallazgos verificables en los documentos anteriores. Usa exactamente uno de estos tipos:
- PRE-OBJETO-VAGO: El objeto del contrato es vago, genérico o sin especificaciones técnicas suficientes
- PRE-CAUSAL-CD: No se justifica la causal legal para Contratación Directa (Ley 80 Art.2 §4, D.1082 Arts. 2.2.1.2.1.4 y ss.)
- PRE-VALOR-INJUSTIFICADO: El valor no está respaldado por el estudio de costos o hay sobreprecios evidentes
- PRE-CDP-INCONSISTENTE: El CDP tiene un valor diferente al del contrato, o no cubre el plazo de ejecución
- PRE-SECTOR-DEFICIENTE: El análisis del sector no justifica por qué solo un proveedor puede ejecutar el objeto
- PRE-FRACCIONAMIENTO: El valor es sospechosamente cercano al tope legal de Contratación Directa (SMMLV vigente)

NO reportes: suposiciones, ausencias que no sean verificables en el texto, ni diferencias menores de redacción.
Si los documentos son insuficientes para detectar un hallazgo, NO lo reportes.

Responde ÚNICAMENTE con JSON válido:
{
  "hallazgos": [
    {
      "tipo": "PRE-OBJETO-VAGO",
      "descripcion": "Qué dice el documento y por qué es irregular (máx 200 chars)",
      "evidencia": "Fragmento exacto del documento que sustenta el hallazgo (máx 300 chars)",
      "doc_nombre": "nombre del documento donde se encontró",
      "severidad": "alta" | "media"
    }
  ]
}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: model ?? 'claude-haiku-4-5-20251001',
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const txt = data.content?.[0]?.text ?? '{}';
    const match = txt.match(/\{[\s\S]*\}/);
    if (!match) return [];

    const { hallazgos = [] } = JSON.parse(match[0]);
    const validos = hallazgos.filter(h => TIPOS_VALIDOS.has(h.tipo));

    // Convertir al formato estándar del motor
    return validos.map(h => {
      const doc = docsPrec.find(d => d.nombre === h.doc_nombre) ?? docsPrec[0];
      return {
        regla_id: h.tipo,
        doc_id: doc.id,
        doc_nombre: h.doc_nombre ?? doc.nombre,
        folio: 'análisis pre-contractual',
        evidencia_textual: h.descripcion,
        detalle: {
          evidencia_doc: h.evidencia,
          severidad: h.severidad,
          doc_tipo: doc.tipo,
          fuente: 'analisis_precontractual',
        },
      };
    });
  } catch (e) {
    console.warn('[VEEDOR] análisis pre-contractual falló silenciosamente:', e.message);
    return [];
  }
}

/**
 * Corre el pipeline completo sobre un contrato hasta 'auditado'.
 * @param idContrato  CO1.PCCNTR.*
 * @param opts.repo   capa de persistencia (opcional; sin ella corre en memoria)
 * @param opts.onEstado  callback(estado, detalle) para progreso
 */
export async function auditarContrato(idContrato, { repo = null, onEstado = () => {}, model } = {}) {
  const contrato = await fichaContrato(idContrato);
  onEstado('seleccionado', { contrato });

  let expedienteId = null;
  if (repo) expedienteId = await repo.crearExpediente(contrato);

  // ── INGESTA con custodia ──
  // Todo lo que dependa de descubrir/descargar/extraer el informe va protegido: si
  // SECOP se cae, el PDF viene corrupto o el extractor falla, la auditoría NO se
  // tumba — se deja el expediente en 'sin_hallazgos' y el veredicto determinista
  // (que arma el endpoint) igual sale. Auditar nunca revienta por el informe.
  try {
    onEstado('ingestando', {});
    // TODOS los documentos del expediente, no solo el informe de supervisión: todo
    // proceso real tiene pliego, estudios previos, adendas y el contrato firmado.
    // Se traen los del proceso (por id_portafolio CO1.BDOS.*) y los del contrato
    // (CO1.PCCNTR.*), en paralelo y sin tumbarse si una de las dos falla.
    const [docsProceso, docsContrato] = await Promise.all([
      contrato.id_portafolio ? descubrirDocumentos(contrato.id_portafolio).catch(() => []) : Promise.resolve([]),
      descubrirInformesDeContrato(idContrato, { soloSupervision: false }).catch(() => []),
    ]);
    // Dedupe por nombre+tamaño (SECOP repite el mismo archivo en varias filas).
    // Se preserva el campo `tipo` que viene de descubrirDocumentos ('pliego',
    // 'estudios_previos', 'adenda', etc.) — es la clave del cruce documental.
    const vistos = new Set();
    const hallados = [];
    for (const d of [...docsProceso, ...docsContrato]) {
      const clave = `${d.nombre}|${d.bytes}`;
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      hallados.push(d);
    }
    if (!hallados.length) {
      if (repo) await repo.actualizarEstado(expedienteId, 'sin_hallazgos');
      onEstado('sin_hallazgos', { motivo: 'El proceso no tiene documentos publicados en datos abiertos (suelen aparecer 1-2 días después).' });
      return { expedienteId, contrato, documentos: [], hallazgos: [], estado: 'sin_hallazgos' };
    }

    // Descarga con custodia (sha256). Acotada: solo PDFs razonables y tope de 25.
    const MAX_DOCS = 25;
    const documentos = [];
    const fechaCaptura = new Date().toISOString();
    let omitidos = 0;
    for (const inf of hallados) {
      if (documentos.length >= MAX_DOCS) { omitidos += hallados.length - documentos.length - omitidos; break; }
      if (inf.extension !== 'pdf' || inf.bytes < 3_000 || inf.bytes > 25_000_000) { omitidos++; continue; }
      const u = new URL(inf.url);
      let pdf;
      try { pdf = await httpGet(u.hostname, u.pathname + u.search, { binario: true }); }
      catch (e) { onEstado('aviso', { doc: inf.nombre, problema: `no se pudo descargar: ${e.message}` }); omitidos++; continue; }
      if (pdf.slice(0, 4).toString() !== '%PDF') {
        onEstado('aviso', { doc: inf.nombre, problema: 'no es PDF válido, se omite' });
        omitidos++;
        continue;
      }
      const sha256 = createHash('sha256').update(pdf).digest('hex');
      const doc = {
        id: documentos.length + 1, nombre: inf.nombre,
        origen: 'secop', id_documento_secop: inf.fileId, url_origen: inf.url,
        sha256, fecha_captura: fechaCaptura, tamano_bytes: pdf.length,
        es_informe: !!inf.es_informe,
        tipo: inf.tipo ?? (inf.es_informe ? 'informe' : 'otro_ejecucion'),
        _pdf: pdf, _texto: pdftotext(pdf),
      };
      documentos.push(doc);
      if (repo) doc.doc_id_db = await repo.guardarDocumento(expedienteId, doc);
      onEstado('documento', { nombre: inf.nombre, sha256: sha256.slice(0, 12), n: documentos.length, de: Math.min(hallados.length, MAX_DOCS) });
    }
    if (omitidos) console.log(`[VEEDOR] ${idContrato}: ${documentos.length} docs en custodia, ${omitidos} omitidos (no PDF / tamaño / tope)`);

    // ── EXTRACCIÓN (LLM transcribe) + MOTOR (decide) ── SOLO sobre los informes de
    // supervisión: de ahí salen los hallazgos aritméticos. El resto queda en
    // custodia para lectura, sin gastar un token.
    const informes = documentos.filter(d => d.es_informe);
    onEstado('extrayendo', { documentos: informes.length });
    const hallazgos = [];
    for (const doc of informes) {
      const { campos } = await extraerInforme(doc._pdf, model ? { model } : {});
      campos.reconoce_incumplimiento = reconoceIncumplimiento(doc._texto);   // booleano del texto, no del LLM
      hallazgos.push(...reglasAritmeticas({ id: doc.id, nombre: doc.nombre }, campos, contrato));
    }
    // Reglas documentales (Nivel 1) + transversales — sobre el texto de los informes
    const docsTexto = informes.map(d => ({ id: d.id, nombre: d.nombre, texto: d._texto }));
    hallazgos.unshift(...motorNivel1(docsTexto, contrato));

    // ── NIVEL 3 — cruce documental (pliego/estudios × informe) ──────────────
    // Solo corre cuando hay pliego O estudios previos con texto legible.
    // Falla silenciosamente — no tumba la auditoría si Anthropic no responde.
    const pliegos = documentos.filter(d => (d.tipo === 'pliego' || d.tipo === 'estudios_previos') && (d._texto?.length ?? 0) > 800);
    if (pliegos.length) {
      onEstado('cruzando', { docs: pliegos.map(d => d.nombre) });
      const hallazgosCruce = await cruzarDocumentos(documentos, contrato, { model });
      if (hallazgosCruce.length) {
        hallazgos.push(...hallazgosCruce);
        console.log(`[VEEDOR] ${idContrato}: ${hallazgosCruce.length} hallazgos de cruce documental`);
      }
    }

    // ── NIVEL 4 — análisis pre-contractual ──────────────────────────────────
    // Corre SIEMPRE que haya documentos pre-contractuales (estudios previos,
    // CDP, pliego). Especialmente útil para Contratación Directa donde no hay
    // informes de supervisión que cruzar. Falla silenciosamente.
    const docsPrec = documentos.filter(d =>
      d.tipo === 'estudios_previos' || d.tipo === 'pliego' ||
      /\b(cdp|certificado\s+de\s+disponibilidad)\b/i.test(d.nombre)
    );
    if (docsPrec.length) {
      onEstado('analizando_precontractual', { docs: docsPrec.map(d => d.nombre) });
      const hallazgosPrec = await analizarDocumentosPrecontractuales(documentos, contrato, { model });
      if (hallazgosPrec.length) {
        hallazgos.push(...hallazgosPrec);
        console.log(`[VEEDOR] ${idContrato}: ${hallazgosPrec.length} hallazgos pre-contractuales`);
      }
    }

    const estadoFinal = hallazgos.length ? 'auditado' : 'sin_hallazgos';
    if (repo) {
      // El hallazgo referencia el documento por su id de memoria (1,2,3); la FK de
      // la base necesita el id real. Se mapea antes de guardar.
      const mapaDoc = new Map(documentos.map(d => [d.id, d.doc_id_db]));
      for (const h of hallazgos) await repo.guardarHallazgo(expedienteId, { ...h, doc_id_db: mapaDoc.get(h.doc_id) });
      await repo.actualizarEstado(expedienteId, estadoFinal);
    }
    onEstado(estadoFinal, { hallazgos: hallazgos.length });

    return {
      expedienteId, contrato,
      documentos: documentos.map(({ _pdf, _texto, ...d }) => d),   // sin binarios
      hallazgos: hallazgos.map((h, i) => ({ ...h, numero: i + 1 })),
      estado: estadoFinal,
    };
  } catch (e) {
    console.error(`[VEEDOR] pipeline informe ${idContrato}:`, e.message);
    if (repo) { try { await repo.actualizarEstado(expedienteId, 'sin_hallazgos'); } catch {} }
    onEstado('sin_hallazgos', { motivo: `No se pudo procesar el informe: ${e.message}` });
    return { expedienteId, contrato, documentos: [], hallazgos: [], estado: 'sin_hallazgos', error: e.message };
  }
}
