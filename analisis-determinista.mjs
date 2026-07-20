/**
 * ANÁLISIS DETERMINISTA de un contrato — el veredicto que auditar SIEMPRE puede dar.
 *
 * Auditar se construyó para contratos con INFORME de supervisión (F1.P18 del ICBF).
 * El 90% de los contratos no tienen ese informe → auditar volvía "sin_hallazgos"
 * vacío (o se caía). Este módulo es el piso: sin gastar un token ni descargar un
 * PDF, siempre devuelve lo que se sabe de datos abiertos.
 *
 *   Nivel 0 — Metadatos del contrato → score de sospecha (score-contrato.mjs).
 *   Nivel 1 — El proceso precontractual (p6dx-8zbt) → con cuántos compitió y a
 *             qué precio. Contratación directa de mil millones con 1 solo
 *             proponente es la prueba, y vive en datos abiertos.
 *
 * El informe (Nivel 3, IA) queda como PROFUNDIZACIÓN cuando existe, no como
 * requisito. Determinista, reproducible, gratis.
 */

import https from 'https';
import { scorearContrato } from './score-contrato.mjs';

const SOCRATA = 'www.datos.gov.co';
const EP_CONTRATOS = 'jbjy-vk9h';
const EP_PROCESOS  = 'p6dx-8zbt';

function socrata(dataset, params) {
  const q = new URLSearchParams(params);
  if (process.env.SOCRATA_APP_TOKEN) q.set('$$app_token', process.env.SOCRATA_APP_TOKEN);
  return new Promise((resolve, reject) => {
    const req = https.get(
      { hostname: SOCRATA, path: `/resource/${dataset}.json?${q}`, headers: { Accept: 'application/json' } },
      (res) => {
        const c = [];
        res.on('data', d => c.push(d));
        res.on('end', () => { try { const d = JSON.parse(Buffer.concat(c).toString()); resolve(Array.isArray(d) ? d : []); } catch (e) { reject(e); } });
      });
    req.on('error', reject);
    req.setTimeout(30_000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

const esc = (s) => String(s).replace(/'/g, "''");
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const fmtCOP = (n) => n == null ? '—' : '$' + Math.round(n).toLocaleString('es-CO');

// ── Nivel 1: el proceso precontractual ───────────────────────────────────────
// El contrato trae `proceso_de_compra` (ej. CO1.BDOS.*); en p6dx-8zbt puede
// matchear por distintas llaves — se prueban en orden.
async function fichaProceso(procesoDeCompra) {
  if (!procesoDeCompra) return null;
  const v = esc(procesoDeCompra);
  for (const campo of ['id_del_proceso', 'id_del_portafolio', 'referencia_del_proceso']) {
    try {
      const [p] = await socrata(EP_PROCESOS, { $where: `${campo} = '${v}'`, $limit: '1' });
      if (p) return p;
    } catch { /* sigue con la próxima llave */ }
  }
  return null;
}

// Convierte el proceso crudo en cifras + señales explicables.
function leerProceso(p) {
  if (!p) return null;
  // El nº de ofertas viene en varios campos según la versión del dataset; tomamos
  // el mayor de los que existan como "cuántos respondieron de verdad".
  const ofertas = Math.max(
    num(p.respuestas_al_procedimiento) ?? 0,
    num(p.conteo_de_respuestas_a_ofertas) ?? 0,
    num(p.proveedores_unicos_con) ?? 0,
    num(p.proveedores_que_manifestaron) ?? 0,
  ) || null;
  const precioBase  = num(p.precio_base);
  const adjudicado  = num(p.valor_total_adjudicacion);
  return {
    id_proceso: p.id_del_proceso ?? p.referencia_del_proceso ?? null,
    modalidad: p.modalidad_de_contratacion ?? null,
    justificacion: p.justificaci_n_modalidad_de ?? null,
    invitados: num(p.proveedores_invitados),
    manifestaron: num(p.proveedores_que_manifestaron),
    ofertas,
    precio_base: precioBase,
    adjudicado,
    duracion: p.duracion ? `${p.duracion} ${p.unidad_de_duracion ?? ''}`.trim() : null,
    estado: p.estado_del_procedimiento ?? null,
    // urlproceso a veces llega como objeto { url: '...' } y a veces como string.
    url: (typeof p.urlproceso === 'object' ? p.urlproceso?.url : p.urlproceso) ?? null,
  };
}

// ── Ficha del contrato con los campos que el score necesita ───────────────────
async function fichaContratoScore(idContrato) {
  const [r] = await socrata(EP_CONTRATOS, {
    $where: `id_contrato = '${esc(idContrato)}'`,
    $select: 'id_contrato,proceso_de_compra,nombre_entidad,proveedor_adjudicado,documento_proveedor,'
           + 'nombre_representante_legal,valor_del_contrato,modalidad_de_contratacion,objeto_del_contrato,'
           + 'tipo_de_contrato,tipodocproveedor,estado_contrato',
    $limit: '1',
  });
  if (!r) return null;
  return {
    id_contrato: r.id_contrato,
    proceso_de_compra: r.proceso_de_compra,
    entidad: r.nombre_entidad,
    contratista: r.proveedor_adjudicado,
    nit_contratista: r.documento_proveedor,
    representante_legal: r.nombre_representante_legal,
    valor: num(r.valor_del_contrato) ?? 0,
    modalidad: r.modalidad_de_contratacion,
    objeto: r.objeto_del_contrato,
    tipo: r.tipo_de_contrato,
    tipo_doc: r.tipodocproveedor,
    estado: r.estado_contrato,
  };
}

/**
 * El veredicto determinista completo de un contrato. Nunca lanza por falta de
 * informe ni de proceso: si algo no está, lo omite.
 * @param idContrato CO1.PCCNTR.*
 * @returns { score, nivel, razones[], senales[], contrato, proceso } | null si el
 *          contrato no existe en datos abiertos.
 */
export async function analisisDeterminista(idContrato) {
  const contrato = await fichaContratoScore(idContrato);
  if (!contrato) return null;

  // Nivel 0 — metadatos
  const { score, nivel, razones } = scorearContrato(contrato);
  const senales = razones.map(t => ({ nivel: 'contrato', texto: t }));

  // Nivel 1 — proceso precontractual (mejor esfuerzo)
  let proceso = null;
  try { proceso = leerProceso(await fichaProceso(contrato.proceso_de_compra)); } catch { /* omite */ }

  if (proceso) {
    // El monto adjudicado suele vivir en el contrato, no en el proceso: si el
    // proceso lo trae en 0, se usa el valor del contrato para comparar.
    const adj = proceso.adjudicado || contrato.valor;
    if (proceso.ofertas != null && proceso.ofertas <= 1)
      senales.push({ nivel: 'proceso', texto: `Un solo proponente respondió — sin competencia real` });
    if (proceso.precio_base && adj && adj >= proceso.precio_base * 0.99)
      senales.push({ nivel: 'proceso', texto: `Adjudicado sin rebaja: ${fmtCOP(adj)} sobre un presupuesto de ${fmtCOP(proceso.precio_base)}` });
    if (proceso.invitados != null && proceso.invitados <= 1 && /directa|especial/i.test(proceso.modalidad ?? ''))
      senales.push({ nivel: 'proceso', texto: `Modalidad sin apertura pública (${proceso.modalidad})` });
  }

  return { score, nivel, razones, senales, contrato, proceso };
}
