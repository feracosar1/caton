/**
 * GRAFO DE CONTRATISTAS + DETECCIÓN DE AMAÑO
 *
 * Mismo principio que el motor de veeduría: los DATOS deciden, no la IA. Todo
 * sale de datos abiertos (jbjy-vk9h, contratos electrónicos SECOP II) con SQL/
 * agregación — reproducible, sin leer un PDF, sin gastar un token.
 *
 * Aristas del grafo:
 *   entidad ──adjudica──▶ contratista ──representa──▶ representante legal
 *
 * El representante legal es la clave: conecta empresas con NIT distinto que en
 * realidad responden a la misma persona. Es lo que convierte "audito un contrato"
 * en "descubro la red".
 *
 * Señales de amaño, todas deterministas:
 *   · CONTRATISTA_RECURRENTE  — mismo NIT gana ≥N veces la misma entidad
 *   · REP_LEGAL_MULTIPLE      — un rep legal detrás de varias empresas que
 *                                contratan con la misma entidad (empresas de cartón)
 *   · FRACCIONAMIENTO         — varios contratos del mismo objeto/entidad/período
 *                                justo bajo el umbral, para evitar licitar
 *   · ADICION_INFLA           — adiciones que elevan el valor tras adjudicar barato
 */

import https from 'https';
import { clausulasSoQL } from './ambito.mjs';

const SOCRATA = 'www.datos.gov.co';
const EP_CONTRATOS = 'jbjy-vk9h';

// Aseguradoras, fiducias y grandes proveedores que aparecen como "rep legal" de
// sí mismos y ensucian la señal de red. No son carteles, son volumen legítimo.
const RUIDO_REP = /seguros|fiduci|aseguradora|positiva|previsora|banco|s\.?a\.?s?$|sin descripcion|no aplica/i;

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

const norm = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
const desde = (dias) => new Date(Date.now() - dias * 864e5).toISOString().slice(0, 10);
const esc  = (s) => String(s).replace(/'/g, "''");   // escapa comillas para SoQL

// Rango temporal para el $where: acepta desde/hasta ('YYYY' o 'YYYY-MM-DD') o
// `dias` hacia atrás. Un año suelto se expande al borde (2022 → 2022-01-01 /
// 2022-12-31), así "de 2022 a 2026" cubre ambos años completos.
function rangoFecha({ desde: d, hasta: h, dias } = {}) {
  const norm = (x, fin) => (!x ? null : /^\d{4}$/.test(String(x)) ? `${x}-${fin ? '12-31' : '01-01'}` : String(x));
  const dd = norm(d, false), hh = norm(h, true), w = [];
  if (dd) w.push(`fecha_de_firma >= '${dd}T00:00:00.000'`);
  if (hh) w.push(`fecha_de_firma <= '${hh}T23:59:59.999'`);
  if (!dd && !hh) w.push(`fecha_de_firma > '${desde(dias ?? 730)}T00:00:00.000'`);
  return w;
}

// Filtros opcionales por entidad (NIT) y por tipo de contrato (Obra, Suministro…).
function filtrosExtra({ nitEntidad, tipoContrato, entidad } = {}) {
  const w = [];
  if (nitEntidad)   w.push(`nit_entidad = '${esc(nitEntidad)}'`);
  if (entidad)      w.push(`upper(nombre_entidad) like '%${esc(String(entidad).toUpperCase())}%'`);
  if (tipoContrato) w.push(`upper(tipo_de_contrato) like '%${esc(String(tipoContrato).toUpperCase())}%'`);
  return w;
}

// ── CONTRATISTA_RECURRENTE ────────────────────────────────────────────────────
// Mismo contratista, misma entidad, muchas veces en poco tiempo.
export async function contratistaRecurrente({ nitEntidad, dias = 365, minContratos = 3 } = {}) {
  const where = [
    `documento_proveedor IS NOT NULL`,
    `fecha_de_firma > '${desde(dias)}T00:00:00.000'`,
    nitEntidad ? `nit_entidad = '${nitEntidad}'` : null,
  ].filter(Boolean).join(' AND ');

  const rows = await socrata(EP_CONTRATOS, {
    $select: 'nit_entidad,nombre_entidad,documento_proveedor,proveedor_adjudicado,'
           + 'count(id_contrato) as contratos,sum(valor_del_contrato) as valor_total',
    $where: where,
    $group: 'nit_entidad,nombre_entidad,documento_proveedor,proveedor_adjudicado',
    $having: `count(id_contrato) >= ${minContratos}`,
    $order: 'contratos DESC',
    $limit: '200',
  });

  return rows.map(r => ({
    senal: 'CONTRATISTA_RECURRENTE',
    entidad: norm(r.nombre_entidad), nit_entidad: r.nit_entidad,
    contratista: norm(r.proveedor_adjudicado), nit_contratista: r.documento_proveedor,
    contratos: Number(r.contratos), valor_total: Number(r.valor_total) || 0,
  }));
}

// ── REP_LEGAL_MULTIPLE ────────────────────────────────────────────────────────
// Un mismo representante legal detrás de VARIAS empresas (NITs distintos).
// La señal fuerte: esas empresas contratan con la MISMA entidad → oferentes de
// cartón / competencia simulada.
export async function repLegalMultiple({ dias = 365, minEmpresas = 2, ambito, desde: d, hasta: h, nitEntidad, tipoContrato, entidad } = {}) {
  const where = [
    `identificaci_n_representante_legal IS NOT NULL`,
    ...rangoFecha({ desde: d, hasta: h, dias }),
    ...filtrosExtra({ nitEntidad, tipoContrato, entidad }),
    ...clausulasSoQL(ambito),
  ].join(' AND ');
  const rows = await socrata(EP_CONTRATOS, {
    $select: 'identificaci_n_representante_legal as rep_id,nombre_representante_legal as rep_nombre,'
           + 'nit_entidad,nombre_entidad,'
           + 'count(distinct documento_proveedor) as empresas,count(id_contrato) as contratos,'
           + 'sum(valor_del_contrato) as valor_total',
    $where: where,
    $group: 'rep_id,rep_nombre,nit_entidad,nombre_entidad',
    $having: `count(distinct documento_proveedor) >= ${minEmpresas}`,
    $order: 'empresas DESC',
    $limit: '300',
  });

  return rows
    .filter(r => !RUIDO_REP.test(r.rep_nombre ?? '') && !RUIDO_REP.test(r.rep_id ?? ''))
    .map(r => {
      const empresas = Number(r.empresas);
      const contratos = Number(r.contratos);
      const valor = Number(r.valor_total) || 0;
      const nivel = empresas >= 4 ? 'alto' : 'medio';
      const repNombre = norm(r.rep_nombre);
      const entNombre = norm(r.nombre_entidad);
      return {
        senal: 'REP_LEGAL_MULTIPLE',
        titulo: `${repNombre} es rep. legal de ${empresas} empresas ante ${entNombre}`,
        descripcion: `${repNombre} (ID: ${r.rep_id}) aparece como representante legal de ${empresas} empresas distintas que contrataron con ${entNombre}. ${contratos} contratos por $${Math.round(valor).toLocaleString('es-CO')}.`,
        severidad: nivel,
        evidencia: {
          rep_id: r.rep_id, rep_nombre: repNombre,
          nit_entidad: r.nit_entidad, nombre_entidad: entNombre,
          empresas_distintas: empresas,
        },
        representante: repNombre, rep_id: r.rep_id,
        entidad: entNombre, nit_entidad: r.nit_entidad,
        empresas_distintas: empresas, contratos,
        valor_total: valor,
      };
    });
}

// ── FRACCIONAMIENTO ───────────────────────────────────────────────────────────
// Muchos contratos de la misma entidad, mismo tipo, en ventana corta, con valores
// que rondan un umbral — señal de partir un contrato grande para no licitar.
export async function fraccionamiento({ nitEntidad, dias = 180, umbral = 60_000_000, minContratos = 4 } = {}) {
  if (!nitEntidad) throw new Error('fraccionamiento requiere nitEntidad');
  const rows = await socrata(EP_CONTRATOS, {
    $select: 'tipo_de_contrato,count(id_contrato) as n,sum(valor_del_contrato) as total,'
           + 'avg(valor_del_contrato) as promedio,max(valor_del_contrato) as maximo',
    $where: `nit_entidad = '${nitEntidad}' AND fecha_de_firma > '${desde(dias)}T00:00:00.000' `
          + `AND valor_del_contrato < '${umbral}'`,
    $group: 'tipo_de_contrato',
    $having: `count(id_contrato) >= ${minContratos}`,
    $order: 'total DESC',
    $limit: '50',
  });
  return rows.map(r => ({
    senal: 'FRACCIONAMIENTO_POSIBLE',
    tipo_contrato: norm(r.tipo_de_contrato),
    contratos: Number(r.n), valor_agregado: Number(r.total) || 0,
    promedio: Math.round(Number(r.promedio) || 0), maximo: Number(r.maximo) || 0,
    umbral,
    nota: `${r.n} contratos bajo $${umbral.toLocaleString('es-CO')} suman $${Math.round(Number(r.total)).toLocaleString('es-CO')} — revisar si debieron licitarse como uno solo`,
  }));
}

// ── RECURRENTE SIN COMPETENCIA (a dedo) ──────────────────────────────────────
// Mismo contratista, misma entidad, muchas veces, TODO por contratación directa
// (sin licitar). El nº de oferentes está vacío en el 91% de SECOP, así que se usa
// la MODALIDAD —que sí está poblada— como proxy de "sin competencia". No acusa:
// ganar a dedo es legal; muchas veces seguidas de la misma entidad es lo que hay
// que mirar. Determinista, un query.
// Nombres típicos de entes públicos: convenios interadministrativos (a dedo pero
// LEGAL, el Estado contratando al Estado). Se marcan/filtran para que quede lo
// que de verdad interesa: un PRIVADO ganando a dedo repetidamente.
const RE_ENTE_PUBLICO = /e\.?s\.?e\.?\b|empresa social|empresa de desarrollo|empresa distrital|empresa industrial|instituto para|instituto de|unidad de salud|esp oficial|s\.?a\.?\s*e\.?s\.?p|aguas de|acueducto|alcantarillado|\bidea\b|infraestructura|fondo de|instituto municipal|beneficencia|lote(r|rí)a|universidad|hospital|corporaci[oó]n aut[oó]noma/i;

export async function recurrenteSinCompetencia({ nitEntidad, entidad, dias = 730, minContratos = 5, ambito, desde: d, hasta: h, soloPrivados = true } = {}) {
  const where = [
    `documento_proveedor IS NOT NULL`,
    `upper(modalidad_de_contratacion) like '%DIRECTA%'`,
    ...rangoFecha({ desde: d, hasta: h, dias }),
    ...filtrosExtra({ nitEntidad, entidad }),
    ...clausulasSoQL(ambito),
  ].join(' AND ');
  const rows = await socrata(EP_CONTRATOS, {
    $select: 'nit_entidad,nombre_entidad,documento_proveedor,proveedor_adjudicado,'
           + 'count(id_contrato) as contratos,sum(valor_del_contrato) as valor',
    $where: where,
    $group: 'nit_entidad,nombre_entidad,documento_proveedor,proveedor_adjudicado',
    $having: `count(id_contrato) >= ${minContratos}`,
    $order: 'valor DESC',
    $limit: '150',
  });
  const out = rows.map(r => ({
    senal: 'RECURRENTE_SIN_COMPETENCIA',
    entidad: norm(r.nombre_entidad), nit_entidad: r.nit_entidad,
    contratista: norm(r.proveedor_adjudicado), nit_contratista: r.documento_proveedor,
    contratos: Number(r.contratos), valor: Number(r.valor) || 0,
    probable_publico: RE_ENTE_PUBLICO.test(norm(r.proveedor_adjudicado)),
    nota: `${Number(r.contratos)} contratos a dedo (contratación directa) de ${norm(r.nombre_entidad)} — $${Math.round(Number(r.valor) || 0).toLocaleString('es-CO')}`,
  }));
  // Por defecto se sacan los convenios interadministrativos (ente público → ente público).
  return soloPrivados ? out.filter(x => !x.probable_publico) : out;
}

// ── Perfil de un contratista: todo lo que se sabe de un NIT ───────────────────
export async function perfilContratista(nit, { dias = 730 } = {}) {
  const contratos = await socrata(EP_CONTRATOS, {
    $select: 'nombre_entidad,nit_entidad,id_contrato,valor_del_contrato,fecha_de_firma,'
           + 'objeto_del_contrato,estado_contrato,nombre_representante_legal',
    $where: `documento_proveedor = '${nit}' AND fecha_de_firma > '${desde(dias)}T00:00:00.000'`,
    $order: 'fecha_de_firma DESC', $limit: '500',
  });
  const entidades = new Map();
  for (const c of contratos) {
    const e = entidades.get(c.nit_entidad) ?? { nombre: norm(c.nombre_entidad), n: 0, valor: 0 };
    e.n++; e.valor += Number(c.valor_del_contrato) || 0;
    entidades.set(c.nit_entidad, e);
  }
  return {
    nit,
    total_contratos: contratos.length,
    valor_total: contratos.reduce((s, c) => s + (Number(c.valor_del_contrato) || 0), 0),
    representantes: [...new Set(contratos.map(c => norm(c.nombre_representante_legal)).filter(Boolean))],
    por_entidad: [...entidades.entries()]
      .map(([nit_entidad, e]) => ({ nit_entidad, ...e }))
      .sort((a, b) => b.valor - a.valor),
    contratos_recientes: contratos.slice(0, 10),
  };
}

// ── BARRIDO DE RED — expansión por sujeto vigilado ────────────────────────────
// Parte de un sujeto y teje la red hacia afuera. Un contratista lleva a sus
// entidades y a su(s) representante(s) legal(es); cada representante lleva a las
// OTRAS empresas que están detrás de él, y esas a SUS entidades. Así se ve cómo
// una misma mano se derrama entre varias entidades. Determinista, Socrata puro.
//
//   semilla: { nit }   arranca de un contratista (documento_proveedor)
//            { repId }  arranca de una persona (identificaci_n_representante_legal)
//
// Devuelve el grafo (nodos + aristas) para pintar, un resumen, y las "manos
// comunes": representantes con varias empresas repartidas entre varias entidades.
const SELECT_RED = 'id_contrato,documento_proveedor,proveedor_adjudicado,'
  + 'identificaci_n_representante_legal,nombre_representante_legal,'
  + 'nit_entidad,nombre_entidad,valor_del_contrato,fecha_de_firma';

export async function barridoRed(semilla, { saltos = 2, dias = 730, limitePorSalto = 1000, maxRepsPorSalto = 40, ambito, desde: d, hasta: h } = {}) {
  const rango = rangoFecha({ desde: d, hasta: h, dias });

  const contratistas  = new Map();  // nit    → { nit, nombre, contratos, valor, salto }
  const representantes = new Map();  // rep_id → { rep_id, nombre, empresas:Set<nit>, salto }
  const entidades      = new Map();  // nit_ent→ { nit_entidad, nombre, contratos, valor }
  const aristas = [];                // { from, to, tipo:'adjudica'|'representa', valor? }
  const repsExpandidos = new Set();

  // Absorbe un lote de contratos: llena nodos y aristas, devuelve reps nuevos.
  function absorber(rows, salto) {
    const nuevosReps = new Set();
    for (const r of rows) {
      const nit = r.documento_proveedor, repId = r.identificaci_n_representante_legal, nitEnt = r.nit_entidad;
      const valor = Number(r.valor_del_contrato) || 0;
      if (nit) {
        const c = contratistas.get(nit) ?? { nit, nombre: norm(r.proveedor_adjudicado), contratos: 0, valor: 0, salto };
        c.contratos++; c.valor += valor; contratistas.set(nit, c);
      }
      if (nitEnt) {
        const e = entidades.get(nitEnt) ?? { nit_entidad: nitEnt, nombre: norm(r.nombre_entidad), contratos: 0, valor: 0 };
        e.contratos++; e.valor += valor; entidades.set(nitEnt, e);
        if (nit) aristas.push({ from: nit, to: nitEnt, tipo: 'adjudica', valor });
      }
      // Un rep legal solo expande la red si no es ruido (S.A.S genérico, aseguradora…).
      if (repId && !RUIDO_REP.test(r.nombre_representante_legal ?? '') && !RUIDO_REP.test(repId)) {
        const rp = representantes.get(repId) ?? { rep_id: repId, nombre: norm(r.nombre_representante_legal), empresas: new Set(), salto };
        if (nit) { rp.empresas.add(nit); aristas.push({ from: repId, to: nit, tipo: 'representa' }); }
        representantes.set(repId, rp);
        if (!repsExpandidos.has(repId)) nuevosReps.add(repId);
      }
    }
    return nuevosReps;
  }

  // Salto 0 — la semilla.
  let where0;
  if (semilla.nit)        where0 = `documento_proveedor = '${esc(semilla.nit)}'`;
  else if (semilla.repId) where0 = `identificaci_n_representante_legal = '${esc(semilla.repId)}'`;
  else throw new Error('barridoRed: semilla debe ser { nit } o { repId }');

  const filas0 = await socrata(EP_CONTRATOS, {
    $select: SELECT_RED, $where: [where0, ...rango, ...clausulasSoQL(ambito)].join(' AND '),
    $order: 'fecha_de_firma DESC', $limit: String(limitePorSalto),
  });
  if (semilla.repId) repsExpandidos.add(semilla.repId);
  let frontera = absorber(filas0, 0);

  // Saltos siguientes — expandir por los representantes nuevos (revela hermanas).
  for (let s = 1; s < saltos && frontera.size; s++) {
    const lista = [...frontera].filter(r => !repsExpandidos.has(r)).slice(0, maxRepsPorSalto);
    if (!lista.length) break;
    lista.forEach(r => repsExpandidos.add(r));
    const inClause = lista.map(r => `'${esc(r)}'`).join(',');
    const filas = await socrata(EP_CONTRATOS, {
      $select: SELECT_RED,
      $where: [`identificaci_n_representante_legal IN (${inClause})`, ...rango, ...clausulasSoQL(ambito)].join(' AND '),
      $order: 'fecha_de_firma DESC', $limit: String(limitePorSalto * 2),
    });
    frontera = absorber(filas, s);
  }

  // "Manos comunes": un representante con ≥2 empresas, y en cuántas entidades caen.
  const reps = [...representantes.values()].map(r => {
    const empresas = [...r.empresas];
    const ents = new Set(aristas.filter(a => a.tipo === 'adjudica' && empresas.includes(a.from)).map(a => a.to));
    return { rep_id: r.rep_id, nombre: r.nombre, salto: r.salto, empresas, num_empresas: empresas.length, num_entidades: ents.size };
  });
  const manos_comunes = reps.filter(r => r.num_empresas >= 2)
    .sort((a, b) => b.num_empresas - a.num_empresas || b.num_entidades - a.num_entidades)
    .map(r => ({ ...r, nota: `${r.nombre}: ${r.num_empresas} empresas repartidas en ${r.num_entidades} entidad(es).` }));

  const valor_total = [...entidades.values()].reduce((a, e) => a + e.valor, 0);

  return {
    semilla, saltos,
    nodos: {
      contratistas: [...contratistas.values()].sort((a, b) => b.valor - a.valor),
      representantes: reps.sort((a, b) => b.num_empresas - a.num_empresas),
      entidades: [...entidades.values()].sort((a, b) => b.valor - a.valor),
    },
    aristas,
    manos_comunes,
    resumen: {
      contratistas: contratistas.size,
      representantes: reps.length,
      entidades: entidades.size,
      valor_total,
      empresas_hermanas: Math.max(0, contratistas.size - 1),
      entidades_alcanzadas: entidades.size,
    },
  };
}

// ── DETECTOR DE CARRUSELES ────────────────────────────────────────────────────
// El sistema barre solo: parte de los representantes con varias empresas, teje la
// red de cada uno y le pone un SCORE de carrusel — determinista y explicable. No
// acusa; ordena para que el humano revise primero lo más sospechoso.
//
// Señales que suben el score (todas verificables en la red):
//   · muchas empresas detrás de una sola mano
//   · el valor concentrado en UNA entidad (competencia simulada)
//   · magnitud del dinero movido
//   · las empresas son consorcios/uniones temporales (rotación de consorcios)
const RE_CONSORCIO = /consorci|uni[oó]n\s+temporal|\bu\.?\s?t\.?\b/i;

export async function detectarCarruseles({ topN = 12, dias = 730, minEmpresas = 3, ambito, desde: d, hasta: h, nitEntidad, tipoContrato, entidad } = {}) {
  const cands = await repLegalMultiple({ dias, minEmpresas, ambito, desde: d, hasta: h, nitEntidad, tipoContrato, entidad });
  // repLegalMultiple viene por (rep, entidad): consolidar a un candidato por rep.
  const porRep = new Map();
  for (const c of cands) {
    const cur = porRep.get(c.rep_id);
    if (!cur || c.empresas_distintas > cur.empresas_distintas) porRep.set(c.rep_id, c);
  }
  const semillas = [...porRep.values()]
    .sort((a, b) => b.empresas_distintas - a.empresas_distintas)
    .slice(0, topN);

  const carruseles = [];
  for (const s of semillas) {
    let red;
    try { red = await barridoRed({ repId: s.rep_id }, { saltos: 1, dias, ambito, desde: d, hasta: h }); }
    catch { continue; }

    const ents = red.nodos.entidades;
    const valorTotal = red.resumen.valor_total || 0;
    const maxEnt = ents.length ? Math.max(...ents.map(e => e.valor)) : 0;
    const concentracion = valorTotal ? maxEnt / valorTotal : 0;      // 0..1 en una entidad
    const empresas = red.resumen.contratistas;
    const consorcios = red.nodos.contratistas.filter(c => RE_CONSORCIO.test(c.nombre)).length;
    const patronConsorcio = empresas ? consorcios / empresas : 0;

    const score = Math.round(
      Math.min(40, empresas * 4) +                                    // hasta 40
      concentracion * 30 +                                            // hasta 30
      Math.min(20, Math.log10(Math.max(1, valorTotal / 1e6)) * 5) +   // hasta ~20
      patronConsorcio * 10                                            // hasta 10
    );
    const nivel = score >= 70 ? 'alto' : score >= 45 ? 'medio' : 'bajo';

    const senales = [`${empresas} empresas detrás de una sola mano`];
    if (concentracion >= 0.7) senales.push(`${Math.round(concentracion * 100)}% del valor en ${ents[0]?.nombre ?? 'una entidad'} — competencia simulada`);
    if (patronConsorcio >= 0.5) senales.push(`${Math.round(patronConsorcio * 100)}% son consorcios/UT — rotación de consorcios`);
    senales.push(`$${Math.round(valorTotal).toLocaleString('es-CO')} en ${ents.length} entidad(es)`);

    carruseles.push({
      rep_id: s.rep_id, representante: s.representante,
      score, nivel, senales,
      entidad_principal: ents[0]?.nombre ?? null,
      resumen: { empresas, entidades: ents.length, valor_total: valorTotal, concentracion: Math.round(concentracion * 100) },
    });
  }
  return carruseles.sort((a, b) => b.score - a.score);
}

// ── CARRUSEL POR CONCENTRACIÓN DE ADJUDICACIONES ──────────────────────────────
// Detecta el patrón colombiano clásico: una entidad pública que reparte
// contratos entre los mismos 2-5 favoritos una y otra vez, sin que
// necesariamente compartan representante legal.
//
// Método: para cada entidad, calcula el HHI (Herfindahl-Hirschman Index)
// sobre la distribución de valor entre sus contratistas. HHI > 0.5 con
// pocos proveedores = concentración sospechosa.
//
// No requiere traversal de red — dos queries SoQL de agregación.
// Retorna hallazgos con fuente 'carrusel_concentracion'.
export async function carruselPorConcentracion({ dias = 730, minContratos = 5, topN = 60, umbralHHI = 0.45, nitEntidad, entidad, ambito } = {}) {
  const rango = rangoFecha({ dias });
  const filtroEnt = [];
  if (nitEntidad) filtroEnt.push(`nit_entidad = '${esc(nitEntidad)}'`);
  else if (entidad) filtroEnt.push(`nombre_entidad like '%${esc(entidad.toUpperCase())}%'`);
  const clasSoQL = clausulasSoQL(ambito) ?? [];

  // Paso 1: entidades con pocos proveedores distintos y suficientes contratos.
  // Ordenamos por n_proveedores ASC para priorizar las más concentradas — los
  // carruseles están en entidades pequeñas (2-6 favoritos), NO en las más grandes.
  const where1 = [
    ...rango,
    'documento_proveedor IS NOT NULL',
    'valor_del_contrato > 0',
    ...filtroEnt,
    ...clasSoQL,
  ].join(' AND ');

  const entidades = await socrata(EP_CONTRATOS, {
    $select: 'nit_entidad,nombre_entidad,count(id_contrato) as total_contratos,sum(valor_del_contrato) as valor_total,count(distinct documento_proveedor) as n_proveedores',
    $where: where1,
    $group: 'nit_entidad,nombre_entidad',
    // Solo 2-8 proveedores distintos: más concentrado de lo normal pero no monopólico.
    // ≥ minContratos: suficiente actividad para que sea señal real, no ruido.
    $having: `count(id_contrato) >= ${minContratos} AND count(distinct documento_proveedor) BETWEEN 2 AND 8`,
    $order: 'n_proveedores ASC, total_contratos DESC',
    $limit: String(topN * 2),
  });

  if (!entidades.length) return [];

  // Paso 2: para cada entidad, distribución por proveedor
  const nits = [...new Set(entidades.map(e => e.nit_entidad))];
  const inClause = nits.map(n => `'${esc(n)}'`).join(',');

  const distribRows = await socrata(EP_CONTRATOS, {
    $select: 'nit_entidad,documento_proveedor,proveedor_adjudicado,count(id_contrato) as contratos,sum(valor_del_contrato) as valor',
    $where: [where1, `nit_entidad IN (${inClause})`].join(' AND '),
    $group: 'nit_entidad,documento_proveedor,proveedor_adjudicado',
    $order: 'nit_entidad,valor DESC',
    $limit: '5000',
  });

  // Agrupar distribución por entidad
  const porEntidad = new Map();
  for (const r of distribRows) {
    const k = r.nit_entidad;
    if (!porEntidad.has(k)) porEntidad.set(k, []);
    porEntidad.get(k).push({ nit: r.documento_proveedor, nombre: r.proveedor_adjudicado, contratos: Number(r.contratos), valor: Number(r.valor) });
  }

  const hallazgos = [];

  for (const ent of entidades) {
    const provs = porEntidad.get(ent.nit_entidad);
    if (!provs || provs.length < 2) continue;

    const valorTotal = provs.reduce((s, p) => s + p.valor, 0);
    if (!valorTotal) continue;

    // HHI sobre participación de valor
    const hhi = provs.reduce((s, p) => {
      const share = p.valor / valorTotal;
      return s + share * share;
    }, 0);

    if (hhi < umbralHHI) continue;  // concentración normal

    const nProvs = provs.length;
    const top3Valor = provs.slice(0, 3).reduce((s, p) => s + p.valor, 0);
    const top3Pct = Math.round(top3Valor / valorTotal * 100);

    // Score: HHI * 50 + pocos proveedores + volumen
    const score = Math.round(
      hhi * 50 +                                                            // hasta 50
      Math.max(0, 20 - nProvs * 3) +                                        // hasta 20 (menos es peor)
      Math.min(20, Math.log10(Math.max(1, valorTotal / 1e6)) * 5) +          // hasta ~20
      (nProvs <= 3 ? 10 : 0)                                                 // bonus si ≤3 provs
    );

    const nivel = score >= 70 ? 'alto' : score >= 45 ? 'medio' : 'bajo';

    const top3Nombres = provs.slice(0, 3).map(p => p.nombre ?? p.nit).join(', ');

    hallazgos.push({
      senal: 'CARRUSEL_CONCENTRACION',
      titulo: `Concentración anormal: ${top3Pct}% del valor en ${Math.min(3, nProvs)} contratista${nProvs > 1 ? 's' : ''}`,
      descripcion: `${ent.nombre_entidad} adjudicó $${Math.round(valorTotal).toLocaleString('es-CO')} entre ${nProvs} proveedor${nProvs > 1 ? 'es' : ''} (HHI ${Math.round(hhi * 100)}%). Favorecidos: ${top3Nombres}.`,
      severidad: nivel,
      valor: Math.round(valorTotal),
      evidencia: {
        nit_entidad: ent.nit_entidad,
        entidad: ent.nombre_entidad,
        total_contratos: Number(ent.total_contratos),
        n_proveedores: nProvs,
        hhi: Math.round(hhi * 1000) / 1000,
        top3_pct_valor: top3Pct,
        top_proveedores: provs.slice(0, 5).map(p => ({
          nit: p.nit,
          nombre: p.nombre,
          contratos: p.contratos,
          valor: p.valor,
          pct: Math.round(p.valor / valorTotal * 100),
        })),
        valor_total: Math.round(valorTotal),
        score,
      },
    });
  }

  return hallazgos.sort((a, b) => b.valor - a.valor);
}

// ── BARRIDO por VARIOS sujetos vigilados: teje cada red y detecta los CRUCES ──
// Donde dos sujetos vigilados comparten una entidad o un representante, hay un
// puente entre sus redes — la señal más fuerte de que operan juntos.
export async function barridoRedMultiple(semillas, opts = {}) {
  const redes = [];
  for (const s of semillas) {
    try { redes.push({ semilla: s, red: await barridoRed(s, opts) }); }
    catch (e) { redes.push({ semilla: s, error: e.message }); }
  }
  const entEnRedes = new Map(), repEnRedes = new Map();
  redes.forEach((r, i) => {
    if (r.error) return;
    for (const e of r.red.nodos.entidades) (entEnRedes.get(e.nit_entidad) ?? entEnRedes.set(e.nit_entidad, new Set()).get(e.nit_entidad)).add(i);
    for (const rp of r.red.nodos.representantes) (repEnRedes.get(rp.rep_id) ?? repEnRedes.set(rp.rep_id, new Set()).get(rp.rep_id)).add(i);
  });
  const nombreEnt = new Map(redes.flatMap(r => r.red ? r.red.nodos.entidades.map(e => [e.nit_entidad, e.nombre]) : []));
  const nombreRep = new Map(redes.flatMap(r => r.red ? r.red.nodos.representantes.map(rp => [rp.rep_id, rp.nombre]) : []));
  return {
    redes,
    cruces: {
      entidades_compartidas: [...entEnRedes].filter(([, s]) => s.size >= 2)
        .map(([nit_entidad, s]) => ({ nit_entidad, nombre: nombreEnt.get(nit_entidad), en_redes: s.size })),
      representantes_compartidos: [...repEnRedes].filter(([, s]) => s.size >= 2)
        .map(([rep_id, s]) => ({ rep_id, nombre: nombreRep.get(rep_id), en_redes: s.size })),
    },
  };
}

// ── EVOLUCIÓN TEMPORAL de una red — la vida del carrusel ──────────────────────
// Con la fecha de firma de cada contrato se reconstruye cómo nació, cómo se
// perpetuó y si se desintegró. Serie por año: empresas activas, empresas nuevas,
// entidades, contratos y valor. Determinista, un solo query.
export async function evolucionRed(semilla, { dias = 2200, ambito } = {}) {
  const desdeF = `${desde(dias)}T00:00:00.000`;
  let where;
  if (semilla.repId)    where = `identificaci_n_representante_legal = '${esc(semilla.repId)}'`;
  else if (semilla.nit) where = `documento_proveedor = '${esc(semilla.nit)}'`;
  else throw new Error('evolucionRed: semilla debe ser { nit } o { repId }');

  const filas = await socrata(EP_CONTRATOS, {
    $select: 'documento_proveedor,proveedor_adjudicado,nit_entidad,valor_del_contrato,fecha_de_firma',
    $where: [where, `fecha_de_firma > '${desdeF}'`, ...clausulasSoQL(ambito)].join(' AND '),
    $order: 'fecha_de_firma ASC', $limit: '3000',
  });

  const porAno = new Map();
  for (const f of filas) {
    const ano = (f.fecha_de_firma ?? '').slice(0, 4);
    if (!/^\d{4}$/.test(ano)) continue;
    const b = porAno.get(ano) ?? { periodo: ano, empresas: new Set(), entidades: new Set(), contratos: 0, valor: 0 };
    if (f.documento_proveedor) b.empresas.add(f.documento_proveedor);
    if (f.nit_entidad) b.entidades.add(f.nit_entidad);
    b.contratos++; b.valor += Number(f.valor_del_contrato) || 0;
    porAno.set(ano, b);
  }

  const vistas = new Set();
  const serie = [...porAno.values()].sort((a, b) => a.periodo.localeCompare(b.periodo)).map(b => {
    const nuevas = [...b.empresas].filter(e => !vistas.has(e)).length;
    b.empresas.forEach(e => vistas.add(e));
    return { periodo: b.periodo, empresas: b.empresas.size, empresas_nuevas: nuevas, entidades: b.entidades.size, contratos: b.contratos, valor: b.valor };
  });

  // Hitos e interpretación (explicable, no acusatoria).
  const pico = serie.reduce((m, s) => (s.valor > (m?.valor ?? -1) ? s : m), null);
  const ultimo = serie[serie.length - 1];
  const anoActual = desde(0).slice(0, 4);
  let estado = 'sin datos';
  if (serie.length) {
    const inactivoReciente = Number(ultimo.periodo) < Number(anoActual) - 1;   // sin firmas el último año+
    if (inactivoReciente)                          estado = 'inactivo / desintegrado';
    else if (ultimo.valor < (pico.valor || 1) * 0.2) estado = 'en declive';
    else if (serie.length >= 3)                    estado = 'perpetuado (activo varios años)';
    else                                           estado = 'reciente / en formación';
  }

  return {
    semilla, serie,
    hitos: { inicio: serie[0]?.periodo ?? null, ultimo: ultimo?.periodo ?? null, pico: pico?.periodo ?? null, estado },
    total_contratos: filas.length,
  };
}
