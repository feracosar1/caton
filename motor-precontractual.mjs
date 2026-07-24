/**
 * MOTOR PRECONTRACTUAL — el fundamento de la veeduría.
 *
 * Principio rector: el contrato se analiza todo porque lo precontractual es la base.
 * Si el pliego fue hecho a la medida de un proponente, si no hubo competencia real,
 * si el presupuesto se adjudicó sin rebaja — la irregularidad no está en el informe
 * de supervisión: está en el origen. Este motor lee la raíz.
 *
 * FUENTES (en orden de confianza):
 *   1. p6dx-8zbt (Socrata) — datos del proceso precontractual.
 *      Costo $0. Determinista, reproducible, auditable.
 *   2. secop_alertas (DB)  — alertas del pliego PDF si ya fue analizado por IA.
 *      Solo disponibles si el proceso pasó por la cola de pliegos.
 *
 * REGLAS (PC = PreContractual):
 *   PC-01  PROPONENTE_UNICO          — Solo 1 oferta en proceso competitivo            [alta]
 *   PC-02  COMPETENCIA_FICTICIA      — Varios invitados, 1 solo respondió              [alta]
 *   PC-03  PRESUPUESTO_CALCADO       — Adjudicado == presupuesto base exacto           [alta]
 *   PC-04  SIN_REBAJA                — Adjudicado ≥ 98% del presupuesto base           [media]
 *   PC-05  DIRECTA_ALTO_VALOR        — Directa + valor > $500M sin licitación          [alta]
 *   PC-06  URGENCIA_VALOR            — Urgencia manifiesta en contrato de alto valor   [alta]
 *   PC-07  JUSTIFICACION_AUSENTE     — Directa sin justificación registrada            [media]
 *   PC-08  ADENDAS_EXCESIVAS         — Más de 3 adendas (cambios post-publicación)    [media]
 *   PC-09  PLAZO_SOSPECHOSO          — Plazo de publicación < 5 días calendario        [media]
 *   PC-PLI PLIEGO_*                  — Alertas de análisis de pliego PDF (si existe)  [alta/media]
 */

import https from 'https';

const SOCRATA = 'www.datos.gov.co';
const EP_PROCESOS = 'p6dx-8zbt';

const esc = (s) => String(s).replace(/'/g, "''");
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const fmtCOP = (n) => n == null ? '—' : '$' + Math.round(n).toLocaleString('es-CO');
const fmtPct = (n) => n == null ? '—' : (n * 100).toFixed(1) + '%';

function socrata(params) {
  const q = new URLSearchParams(params);
  if (process.env.SOCRATA_APP_TOKEN) q.set('$$app_token', process.env.SOCRATA_APP_TOKEN);
  return new Promise((resolve, reject) => {
    const req = https.get(
      { hostname: SOCRATA, path: `/resource/${EP_PROCESOS}.json?${q}`, headers: { Accept: 'application/json' } },
      (res) => {
        const c = [];
        res.on('data', d => c.push(d));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(c).toString());
            resolve(Array.isArray(data) ? data : []);
          } catch (e) { reject(e); }
        });
      });
    req.on('error', reject);
    req.setTimeout(30_000, () => { req.destroy(); reject(new Error('timeout socrata')); });
  });
}

// Busca el proceso en p6dx-8zbt probando tres llaves en orden.
async function buscarProceso(idProceso) {
  const v = esc(idProceso);
  for (const campo of ['id_del_portafolio', 'id_del_proceso', 'referencia_del_proceso']) {
    try {
      const rows = await socrata({ $where: `${campo} = '${v}'`, $limit: '1' });
      if (rows.length) return rows[0];
    } catch { /* intenta siguiente campo */ }
  }
  return null;
}

// ── Helpers para extraer campos del proceso crudo ─────────────────────────────

function leerOfertas(p) {
  return Math.max(
    num(p.respuestas_al_procedimiento) ?? 0,
    num(p.conteo_de_respuestas_a_ofertas) ?? 0,
    num(p.proveedores_unicos_con) ?? 0,
  ) || null;
}

function leerInvitados(p) {
  return num(p.proveedores_invitados);
}

function leerModalidad(p) {
  return (p.modalidad_de_contratacion ?? '').toLowerCase();
}

function esCompetitivo(modalidad) {
  // Procesos que deberían tener competencia real
  return !modalidad.includes('directa') &&
         !modalidad.includes('urgencia') &&
         !modalidad.includes('régimen especial') &&
         !modalidad.includes('regimen especial') &&
         !modalidad.includes('mínima') &&
         !modalidad.includes('minima');
}

function esDirecta(modalidad) {
  return modalidad.includes('directa');
}

function esUrgencia(modalidad) {
  return modalidad.includes('urgencia');
}

// Calcula días entre dos fechas ISO
function diasEntre(desde, hasta) {
  if (!desde || !hasta) return null;
  const d1 = new Date(desde).getTime();
  const d2 = new Date(hasta).getTime();
  if (isNaN(d1) || isNaN(d2)) return null;
  return Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
}

// ── Constructores de hallazgo ─────────────────────────────────────────────────

function H(regla_id, titulo, descripcion, evidencia, severidad, cifras = []) {
  return { regla_id, titulo, descripcion, evidencia, severidad, fuente: 'datos_proceso', cifras };
}

function HPliego(alerta) {
  const mapa = {
    ESPECIFICACION_SASTRE:      ['Especificación a la medida',       'alta'],
    REQUISITO_EXCLUYENTE:       ['Requisito excluyente',             'alta'],
    PLAZO_IRREAL:               ['Plazo irreal para ofertar',        'media'],
    FRACCIONAMIENTO:            ['Señal de fraccionamiento',         'alta'],
    OBJETO_VAGO:                ['Objeto del contrato vago',         'media'],
    CRITERIO_DISCRIMINATORIO:   ['Criterio discriminatorio',         'alta'],
    CONFLICTO_ESPECIFICACION:   ['Contradicción en el pliego',       'media'],
  };
  const [titulo, severidadDefault] = mapa[alerta.tipo_alerta] ?? ['Irregularidad en pliego', 'media'];
  return {
    regla_id:    `PC-PLI-${alerta.tipo_alerta}`,
    titulo,
    descripcion: alerta.descripcion,
    evidencia:   alerta.evidencia?.evidencia_textual ?? '(sin extracto)',
    severidad:   alerta.severidad ?? severidadDefault,
    fuente:      'pliego_pdf',
    cifras:      [],
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// REGLAS DETERMINISTAS (sobre metadatos del proceso)
// ══════════════════════════════════════════════════════════════════════════════

function reglaProponenteUnico(p) {
  const ofertas = leerOfertas(p);
  const modalidad = leerModalidad(p);
  if (ofertas === null || !esCompetitivo(modalidad)) return null;
  if (ofertas > 1) return null;
  return H(
    'PC-01',
    'Proponente único en proceso competitivo',
    `Solo ${ofertas === 0 ? 'ningún proponente' : '1 proponente'} respondió al proceso de ${p.modalidad_de_contratacion ?? modalidad}. Sin competencia real.`,
    `${ofertas === 0 ? 'Cero propuestas recibidas' : '1 sola propuesta'} · Modalidad: ${p.modalidad_de_contratacion ?? modalidad}`,
    'alta',
    [
      { label: 'Propuestas recibidas', valor: String(ofertas) },
      { label: 'Modalidad', valor: p.modalidad_de_contratacion ?? modalidad },
    ]
  );
}

function reglaCompetenciaFicticia(p) {
  const ofertas = leerOfertas(p);
  const invitados = leerInvitados(p);
  if (ofertas === null || invitados === null) return null;
  if (invitados < 3 || ofertas > 1) return null;
  const tasa = invitados > 0 ? (ofertas / invitados) : 0;
  return H(
    'PC-02',
    'Competencia ficticia — muchos invitados, un solo oferente',
    `Se invitaron ${invitados} proveedores pero solo ${ofertas} presentó oferta. Tasa de participación: ${fmtPct(tasa)}. Señal de competencia aparente.`,
    `${invitados} invitados · ${ofertas} ofertas recibidas`,
    'alta',
    [
      { label: 'Proveedores invitados', valor: String(invitados) },
      { label: 'Ofertas recibidas', valor: String(ofertas) },
      { label: 'Tasa participación', valor: fmtPct(tasa) },
    ]
  );
}

function reglaPresupuestoCalcado(p, valorContrato) {
  const precioBase = num(p.precio_base);
  const adjudicado = num(p.valor_total_adjudicacion) || valorContrato;
  if (!precioBase || !adjudicado || precioBase <= 0) return null;
  const razon = adjudicado / precioBase;
  // Exacto o prácticamente idéntico (diferencia < 0.1%)
  if (razon < 0.999) return null;
  const esPerfecto = Math.abs(adjudicado - precioBase) < 10; // diferencia < $10
  return H(
    'PC-03',
    esPerfecto ? 'Presupuesto calcado — sin ninguna rebaja' : 'Adjudicado igual al presupuesto oficial',
    `El valor adjudicado (${fmtCOP(adjudicado)}) es prácticamente igual al presupuesto base (${fmtCOP(precioBase)}). En procesos con competencia real siempre hay rebaja.`,
    `Presupuesto: ${fmtCOP(precioBase)} · Adjudicado: ${fmtCOP(adjudicado)} · Diferencia: ${fmtCOP(precioBase - adjudicado)}`,
    esPerfecto ? 'alta' : 'media',
    [
      { label: 'Presupuesto base', valor: fmtCOP(precioBase) },
      { label: 'Valor adjudicado', valor: fmtCOP(adjudicado) },
      { label: 'Rebaja', valor: fmtCOP(precioBase - adjudicado) },
    ]
  );
}

function reglaSinRebaja(p, valorContrato) {
  const precioBase = num(p.precio_base);
  const adjudicado = num(p.valor_total_adjudicacion) || valorContrato;
  if (!precioBase || !adjudicado || precioBase <= 0) return null;
  const razon = adjudicado / precioBase;
  // Si ya disparó PC-03 (razon >= 0.999), no duplicar
  if (razon >= 0.999) return null;
  // PC-04 solo si la rebaja es menor del 2%
  if (razon < 0.98) return null;
  const rebajaPct = (1 - razon) * 100;
  return H(
    'PC-04',
    'Sin rebaja efectiva sobre el presupuesto',
    `El contratista recibió el ${(razon * 100).toFixed(1)}% del presupuesto oficial — una rebaja de apenas ${rebajaPct.toFixed(1)}%. En licitaciones competitivas la rebaja promedio es 10-25%.`,
    `Presupuesto: ${fmtCOP(precioBase)} · Adjudicado: ${fmtCOP(adjudicado)} · Rebaja: ${rebajaPct.toFixed(1)}%`,
    'media',
    [
      { label: 'Presupuesto base', valor: fmtCOP(precioBase) },
      { label: 'Valor adjudicado', valor: fmtCOP(adjudicado) },
      { label: 'Rebaja real', valor: rebajaPct.toFixed(2) + '%' },
    ]
  );
}

function reglaDirectaAltoValor(p, valorContrato) {
  const modalidad = leerModalidad(p);
  if (!esDirecta(modalidad)) return null;
  const valor = num(p.valor_total_adjudicacion) || valorContrato;
  if (!valor || valor < 500_000_000) return null;
  return H(
    'PC-05',
    'Contratación directa de alto valor sin licitación',
    `Contrato de ${fmtCOP(valor)} adjudicado por contratación directa. Contratos de esta magnitud deberían someterse a licitación o selección abreviada para garantizar transparencia.`,
    `Modalidad: ${p.modalidad_de_contratacion ?? modalidad} · Valor: ${fmtCOP(valor)}`,
    'alta',
    [
      { label: 'Modalidad', valor: p.modalidad_de_contratacion ?? modalidad },
      { label: 'Valor contrato', valor: fmtCOP(valor) },
      { label: 'Justificación', valor: (p.justificaci_n_modalidad_de ?? '').slice(0, 120) || '(sin justificación registrada)' },
    ]
  );
}

function reglaUrgenciaValor(p, valorContrato) {
  const modalidad = leerModalidad(p);
  if (!esUrgencia(modalidad)) return null;
  const valor = num(p.valor_total_adjudicacion) || valorContrato;
  if (!valor || valor < 200_000_000) return null;
  return H(
    'PC-06',
    'Urgencia manifiesta en contrato de alto valor',
    `La "urgencia manifiesta" se declaró para un contrato de ${fmtCOP(valor)}. Esta causal exime de licitación y es frecuentemente abusada para contratar sin competencia. Verificar que la urgencia sea real y documentada.`,
    `Modalidad: ${p.modalidad_de_contratacion ?? modalidad} · Valor: ${fmtCOP(valor)}`,
    'alta',
    [
      { label: 'Modalidad', valor: p.modalidad_de_contratacion ?? modalidad },
      { label: 'Valor contrato', valor: fmtCOP(valor) },
      { label: 'Justificación', valor: (p.justificaci_n_modalidad_de ?? '').slice(0, 120) || '(sin justificación registrada)' },
    ]
  );
}

function reglaJustificacionAusente(p) {
  const modalidad = leerModalidad(p);
  if (!esDirecta(modalidad)) return null;
  const justificacion = (p.justificaci_n_modalidad_de ?? '').trim();
  if (justificacion.length > 20) return null; // tiene justificación
  return H(
    'PC-07',
    'Contratación directa sin justificación registrada',
    `El proceso usa contratación directa pero no tiene justificación registrada en SECOP. La Ley 80/93 y el Dec. 1082/2015 exigen que la causal esté documentada.`,
    `Modalidad: ${p.modalidad_de_contratacion ?? modalidad} · Justificación: (ausente)`,
    'media',
    [
      { label: 'Modalidad', valor: p.modalidad_de_contratacion ?? modalidad },
      { label: 'Justificación en SECOP', valor: justificacion || '(vacía)' },
    ]
  );
}

function reglaAdendas(p) {
  const adendas = num(p.numero_de_adendas);
  if (adendas === null || adendas <= 3) return null;
  return H(
    'PC-08',
    `${adendas} adendas al pliego — cambios excesivos post-publicación`,
    `Se registraron ${adendas} adendas (modificaciones al pliego después de publicado). Más de 3 adendas es señal de que el pliego fue ajustando sus requisitos, posiblemente para favorecer a un proponente.`,
    `Número de adendas: ${adendas}`,
    'media',
    [
      { label: 'Número de adendas', valor: String(adendas) },
    ]
  );
}

function reglaPlazoCorto(p) {
  const inicio = p.fecha_de_publicacion_del_proceso ?? p.fecha_publicacion ?? null;
  const fin    = p.fecha_limite_de_recepcion_de_ofertas ?? p.fecha_de_apertura_de_respuestas ?? null;
  if (!inicio || !fin) return null;
  const dias = diasEntre(inicio, fin);
  if (dias === null || dias >= 5) return null;
  return H(
    'PC-09',
    `Plazo de publicación muy corto — ${dias} día${dias === 1 ? '' : 's'}`,
    `El proceso tuvo solo ${dias} día${dias === 1 ? '' : 's'} de ventana para que los proveedores prepararan y presentaran sus ofertas. Un plazo tan corto restringe la competencia y favorece a quien ya conocía de antemano los pliegos.`,
    `Publicado: ${inicio?.slice(0, 10) ?? '—'} · Límite ofertas: ${fin?.slice(0, 10) ?? '—'} · Días: ${dias}`,
    dias <= 2 ? 'alta' : 'media',
    [
      { label: 'Fecha publicación', valor: inicio?.slice(0, 10) ?? '—' },
      { label: 'Límite ofertas', valor: fin?.slice(0, 10) ?? '—' },
      { label: 'Días disponibles', valor: String(dias) },
    ]
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// PUNTO DE ENTRADA
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Analiza la fase precontractual de un proceso SECOP.
 *
 * @param idProceso  El id_del_portafolio (CO1.BDOS.*) o proceso_de_compra del contrato.
 * @param opts       { supabase, valorContrato } — supabase opcional para alertas de pliego.
 * @returns { hallazgos, proceso, fuentes, total_hallazgos, por_severidad }
 */
export async function motorPrecontractual(idProceso, { supabase, valorContrato = 0 } = {}) {
  const fuentes = [];
  const hallazgos = [];

  // ── FUENTE 1: Datos del proceso (p6dx-8zbt) ───────────────────────────────
  let proceso = null;
  try {
    proceso = await buscarProceso(idProceso);
    if (proceso) fuentes.push('p6dx-8zbt (proceso SECOP)');
  } catch (e) {
    console.warn('[PRECONTRACTUAL] Error consultando proceso:', e.message);
  }

  if (proceso) {
    const reglas = [
      reglaProponenteUnico(proceso),
      reglaCompetenciaFicticia(proceso),
      reglaPresupuestoCalcado(proceso, valorContrato),
      reglaSinRebaja(proceso, valorContrato),
      reglaDirectaAltoValor(proceso, valorContrato),
      reglaUrgenciaValor(proceso, valorContrato),
      reglaJustificacionAusente(proceso),
      reglaAdendas(proceso),
      reglaPlazoCorto(proceso),
    ];
    for (const h of reglas) {
      if (h) hallazgos.push(h);
    }
  }

  // ── FUENTE 2: Alertas de pliego PDF (DB) ──────────────────────────────────
  if (supabase) {
    try {
      // Busca alertas para este proceso o id_portafolio
      const { data: alertas } = await supabase
        .from('secop_alertas')
        .select('tipo_alerta, severidad, descripcion, evidencia, score_contribucion')
        .eq('id_proceso', idProceso)
        .contains('evidencia', { fuente: 'pliego_pdf' });

      if (alertas?.length) {
        fuentes.push('pliego PDF (análisis previo)');
        for (const a of alertas) {
          hallazgos.push(HPliego(a));
        }
      }
    } catch (e) {
      console.warn('[PRECONTRACTUAL] Error leyendo alertas de pliego:', e.message);
    }
  }

  // Ordenar: alta → media → baja
  const ORDEN = { alta: 0, media: 1, baja: 2 };
  hallazgos.sort((a, b) => (ORDEN[a.severidad] ?? 2) - (ORDEN[b.severidad] ?? 2));

  // Resumen del proceso para mostrar en la UI
  const resumenProceso = proceso ? {
    id_proceso:   proceso.id_del_proceso ?? proceso.referencia_del_proceso ?? idProceso,
    modalidad:    proceso.modalidad_de_contratacion ?? null,
    precio_base:  num(proceso.precio_base),
    adjudicado:   num(proceso.valor_total_adjudicacion),
    ofertas:      leerOfertas(proceso),
    invitados:    leerInvitados(proceso),
    adendas:      num(proceso.numero_de_adendas),
    estado:       proceso.estado_del_procedimiento ?? null,
    url:          (typeof proceso.urlproceso === 'object' ? proceso.urlproceso?.url : proceso.urlproceso) ?? null,
    justificacion:proceso.justificaci_n_modalidad_de ?? null,
    fecha_publicacion: proceso.fecha_de_publicacion_del_proceso ?? proceso.fecha_publicacion ?? null,
    fecha_limite_oferta: proceso.fecha_limite_de_recepcion_de_ofertas ?? null,
  } : null;

  const por_severidad = {
    alta:  hallazgos.filter(h => h.severidad === 'alta').length,
    media: hallazgos.filter(h => h.severidad === 'media').length,
    baja:  hallazgos.filter(h => h.severidad === 'baja').length,
  };

  return {
    hallazgos,
    proceso: resumenProceso,
    fuentes,
    total_hallazgos: hallazgos.length,
    por_severidad,
    sin_datos: !proceso,
  };
}
