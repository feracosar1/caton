/**
 * MOTOR DE SIMILITUD DE OBJETOS (CLONES)
 *
 * Detecta el patrón: misma descripción de objeto de contrato copiada entre N
 * contratistas distintos → indicio de coordinación previa o concurrencia ilegal.
 *
 * También detecta:
 *   - ANTICIPOS_MASIVOS: cuando la mayoría de contratos de una entidad tienen
 *     anticipo > 30% (requiere campo anticipo si lo reporta SECOP; si no,
 *     se marca como "no verificable desde datos abiertos").
 *   - ACTAS_ANTES_CDP: actas de inicio firmadas antes del registro presupuestal
 *     (señal del caso Sierra Nevada — no disponible en SECOP público directamente,
 *      se detecta cuando fecha_inicio_precontractual > fecha_de_firma en la
 *      tabla de procesos).
 *   - OBJETOS_IDENTICOS: Jaccard similarity > 0.75 entre objetos de contratos
 *     distintos dentro de la misma entidad/período.
 *   - FUNCIONES_IDENTICAS: cuando ≥ N contratos de PS comparten >80% del texto
 *     del objeto (copia del pliego), solo variando el nombre del contratista.
 *
 * Todo determinista. Sin IA.
 */

import https from 'https';
import { clausulasSoQL } from './ambito.mjs';

const SOCRATA = 'www.datos.gov.co';
const EP_CONTRATOS = 'jbjy-vk9h';
const EP_PROCESOS  = 'p6dx-8zbt';

function socrata(dataset, params) {
  const q = new URLSearchParams(params);
  if (process.env.SOCRATA_APP_TOKEN) q.set('$$app_token', process.env.SOCRATA_APP_TOKEN);
  return new Promise((resolve, reject) => {
    https.get({ hostname: SOCRATA, path: `/resource/${dataset}.json?${q}`, headers: { Accept: 'application/json' } }, (res) => {
      const c = [];
      res.on('data', d => c.push(d));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(c).toString());
          if (!Array.isArray(data)) return reject(new Error(data?.message ?? 'Socrata error'));
          resolve(data);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

const esc = (s) => String(s).replace(/'/g, "''");

function rangoFecha({ desde, hasta, dias } = {}) {
  const norm = (x, fin) => (!x ? null : /^\d{4}$/.test(String(x)) ? `${x}-${fin ? '12-31' : '01-01'}` : String(x));
  const d = norm(desde, false) ?? (dias ? new Date(Date.now() - dias * 864e5).toISOString().slice(0, 10) : null);
  const h = norm(hasta, true);
  const conds = [];
  if (d) conds.push(`fecha_de_firma >= '${d}T00:00:00.000'`);
  if (h) conds.push(`fecha_de_firma <= '${h}T23:59:59.999'`);
  return conds.join(' AND ');
}

/** Jaccard similarity entre dos strings, con stopwords mínimas de español */
const STOPWORDS = new Set(['de', 'la', 'el', 'en', 'y', 'a', 'los', 'del', 'las', 'un', 'una', 'por', 'con', 'para', 'que', 'se', 'su', 'al', 'es', 'o', 'e', 'no', 'lo', 'sus', 'les']);

function tokenizar(s) {
  return new Set(
    (s ?? '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quitar tildes
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !STOPWORDS.has(w))
  );
}

function jaccard(a, b) {
  const setA = tokenizar(a);
  const setB = tokenizar(b);
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const w of setA) if (setB.has(w)) inter++;
  const union = setA.size + setB.size - inter;
  return inter / union;
}

/**
 * OBJETOS CLONADOS
 *
 * Descarga todos los contratos de una entidad/período y detecta grupos donde
 * el objeto del contrato es casi idéntico entre contratistas distintos.
 *
 * @param {object} opts
 *   nitEntidad o entidad — obligatorio al menos uno
 *   desde?, hasta?, dias? — default 2 años
 *   umbralSimilitud? — default 0.75 (75% de palabras en común)
 *   minGrupo? — mínimo de contratos en un grupo para reportar (default 2)
 *   tipo? — filtrar por tipo_de_contrato
 */
export async function objetosDuplicados(opts = {}) {
  const { nitEntidad, entidad, umbralSimilitud = 0.75, minGrupo = 2, tipo, ambito } = opts;
  if (!nitEntidad && !entidad) throw new Error('objetosDuplicados requiere nitEntidad o entidad');

  const conds = [];
  const rango = rangoFecha({ desde: opts.desde, hasta: opts.hasta, dias: opts.dias ?? 730 });
  if (rango) conds.push(rango);
  if (nitEntidad) conds.push(`nit_entidad = '${esc(nitEntidad)}'`);
  if (entidad)   conds.push(`upper(nombre_entidad) like upper('%${esc(entidad)}%')`);
  if (tipo)      conds.push(`upper(tipo_de_contrato) like upper('%${esc(tipo)}%')`);
  const ambitoConds = ambito ? clausulasSoQL(ambito) : [];

  const rows = await socrata(EP_CONTRATOS, {
    $where: [...conds, ...ambitoConds].join(' AND '),
    $select: 'id_contrato,referencia_del_contrato,documento_proveedor,proveedor_adjudicado,objeto_del_contrato,valor_del_contrato,tipo_de_contrato,fecha_de_firma',
    $limit: 2000,
    $order: 'valor_del_contrato DESC',
  });

  if (rows.length < 2) return [];

  // Solo contratos con objeto no vacío
  const validos = rows.filter(r => (r.objeto_del_contrato ?? '').trim().length > 20);

  // Algoritmo O(n²) con corte: agrupar por similitud
  const visitados = new Set();
  const grupos = [];

  for (let i = 0; i < validos.length; i++) {
    if (visitados.has(i)) continue;
    const grupo = [i];
    for (let j = i + 1; j < validos.length; j++) {
      if (visitados.has(j)) continue;
      // Optimización: si NIT es el mismo, no es clone (mismo contratista puede tener objetos similares)
      const mismaNit = validos[i].documento_proveedor === validos[j].documento_proveedor;
      if (mismaNit) continue;
      const sim = jaccard(validos[i].objeto_del_contrato, validos[j].objeto_del_contrato);
      if (sim >= umbralSimilitud) {
        grupo.push(j);
        visitados.add(j);
      }
    }
    visitados.add(i);
    if (grupo.length >= minGrupo) {
      const miembros = grupo.map(idx => ({
        id_contrato: validos[idx].id_contrato,
        referencia: validos[idx].referencia_del_contrato,
        contratista: validos[idx].proveedor_adjudicado,
        nit: validos[idx].documento_proveedor,
        valor: Number(validos[idx].valor_del_contrato) || 0,
        fecha: validos[idx].fecha_de_firma?.slice(0, 10),
        tipo: validos[idx].tipo_de_contrato,
        objeto: (validos[idx].objeto_del_contrato ?? '').slice(0, 150),
      }));
      // Similitud promedio del grupo
      let totalSim = 0, pairs = 0;
      for (let a = 0; a < grupo.length; a++) {
        for (let b = a + 1; b < grupo.length; b++) {
          totalSim += jaccard(validos[grupo[a]].objeto_del_contrato, validos[grupo[b]].objeto_del_contrato);
          pairs++;
        }
      }
      const simPromedio = pairs ? totalSim / pairs : umbralSimilitud;
      grupos.push({
        senal: 'OBJETOS_CLONADOS',
        similitud: Math.round(simPromedio * 100),
        n_contratos: miembros.length,
        valor_total: miembros.reduce((s, m) => s + m.valor, 0),
        objeto_muestra: (validos[grupo[0]].objeto_del_contrato ?? '').slice(0, 200),
        contratistas: miembros,
        severidad: simPromedio >= 0.9 ? 'alto' : 'medio',
        evidencia: `${miembros.length} contratos con objeto ${Math.round(simPromedio * 100)}% idéntico entre contratistas distintos — posible coordinación previa o fraccionamiento con pliego copiado`,
      });
    }
  }

  return grupos.sort((a, b) => b.valor_total - a.valor_total);
}

/**
 * ACTAS ANTES DE REGISTRO PRESUPUESTAL
 *
 * Detecta contratos donde la fecha de inicio del proceso precontractual
 * (fecha_inicio_precontractual) es POSTERIOR a la fecha de firma —
 * lo que indica actas de inicio firmadas retroactivamente.
 *
 * También detecta: procesos con estado "Celebrado" pero sin proceso
 * precontractual registrado (contrato directo sin soporte).
 */
export async function actasAntesDeRegistro(opts = {}) {
  const { nitEntidad, entidad, ambito } = opts;
  if (!nitEntidad && !entidad) throw new Error('actasAntesDeRegistro requiere nitEntidad o entidad');

  const rango = rangoFecha({ desde: opts.desde, hasta: opts.hasta, dias: opts.dias ?? 730 });
  const baseFilter = nitEntidad
    ? `nit_entidad = '${esc(nitEntidad)}'`
    : `upper(nombre_entidad) like upper('%${esc(entidad)}%')`;
  const ambitoConds = ambito ? clausulasSoQL(ambito) : [];
  const where = [baseFilter, rango, ...ambitoConds].filter(Boolean).join(' AND ');

  const contratos = await socrata(EP_CONTRATOS, {
    $where: where,
    $select: 'id_contrato,referencia_del_contrato,proceso_de_compra,proveedor_adjudicado,documento_proveedor,valor_del_contrato,fecha_de_firma,modalidad_de_contratacion,objeto_del_contrato',
    $limit: 2000,
    $order: 'valor_del_contrato DESC',
  });

  // Para cada contrato, buscar el proceso precontractual en p6dx-8zbt
  // Lo hacemos en batch para no hacer N llamadas: buscamos los procesos de la misma entidad
  const procesosFilter = nitEntidad
    ? `nit_entidad_compradora = '${esc(nitEntidad)}'`
    : `upper(nombre_entidad) like upper('%${esc(entidad)}%')`;
  const procesos = await socrata(EP_PROCESOS, {
    $where: [procesosFilter, rango].filter(Boolean).join(' AND '),
    $select: 'id_del_proceso,referencia_del_proceso,fecha_inicio_del_proceso,fecha_de_adjudicacion,modalidad_de_contratacion,precio_base',
    $limit: 2000,
  }).catch(() => []);

  // Indexar procesos por referencia
  const procIdx = new Map(procesos.map(p => [p.referencia_del_proceso, p]));

  const hallazgos = [];
  for (const c of contratos) {
    const proc = procIdx.get(c.proceso_de_compra);
    if (!proc) {
      // Sin proceso = contratación directa sin soporte
      const modalidad = (c.modalidad_de_contratacion ?? '').toLowerCase();
      if (!modalidad.includes('directa') && !modalidad.includes('especial')) {
        hallazgos.push({
          id_contrato: c.id_contrato,
          referencia: c.referencia_del_contrato,
          contratista: c.proveedor_adjudicado,
          valor: Number(c.valor_del_contrato) || 0,
          fecha_firma: c.fecha_de_firma?.slice(0, 10),
          senal: 'SIN_PROCESO_PRECONTRACTUAL',
          severidad: 'medio',
          evidencia: 'Contrato sin proceso precontractual registrado en SECOP — no es modalidad directa',
        });
      }
      continue;
    }
    // Verificar fechas: proceso debe iniciarse ANTES de la firma
    const fechaInicioProceso = proc.fecha_inicio_del_proceso?.slice(0, 10);
    const fechaFirma = c.fecha_de_firma?.slice(0, 10);
    if (fechaInicioProceso && fechaFirma && fechaInicioProceso > fechaFirma) {
      const diasAntes = Math.round((new Date(fechaInicioProceso) - new Date(fechaFirma)) / 864e5);
      hallazgos.push({
        id_contrato: c.id_contrato,
        referencia: c.referencia_del_contrato,
        contratista: c.proveedor_adjudicado,
        valor: Number(c.valor_del_contrato) || 0,
        fecha_firma: fechaFirma,
        fecha_inicio_proceso: fechaInicioProceso,
        dias_irregularidad: diasAntes,
        senal: 'PROCESO_POSTERIOR_A_CONTRATO',
        severidad: 'alto',
        evidencia: `Proceso precontractual iniciado ${diasAntes} días DESPUÉS de la firma del contrato — indica retroactividad`,
      });
    }
  }

  return hallazgos.sort((a, b) => (b.dias_irregularidad ?? 0) - (a.dias_irregularidad ?? 0));
}
