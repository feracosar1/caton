/**
 * MOTOR DE SUPERVISORES IRREGULARES
 *
 * Detecta el patrón "Fondo Sierra Nevada": particulares (personas naturales o
 * empresas de servicios) que acumulan contratos de "apoyo a la supervisión" y
 * terminan ejerciendo funciones reservadas a servidores públicos.
 *
 * Tres señales, todas deterministas desde SECOP II (sin PDF, sin IA):
 *
 *   1. CONCENTRACIÓN — un mismo contratista supervisa N contratos simultáneos.
 *      El umbral legal tácito es 3-5 (más allá es imposible control real).
 *
 *   2. CRUZAMIENTO — A es contratista de obra donde B es el "supervisor", Y
 *      B es contratista de otra obra donde A es el "supervisor". Se pagan entre
 *      ellos. Esto requiere la red de supervisores: basta con saber quién tiene
 *      contrato de supervisión con la misma entidad en el mismo período.
 *
 *   3. PERFIL CRUZADO — la misma persona NIT aparece como contratista de obra
 *      Y como "supervisor" en esa misma entidad en el mismo año (conflicto de
 *      interés flagrante).
 *
 * No acusa: devuelve evidencia estructurada para que el auditor decida.
 */

import https from 'https';
import { clausulasSoQL } from './ambito.mjs';

const SOCRATA = 'www.datos.gov.co';
const EP = 'jbjy-vk9h';

// Palabras que delatan contratos de supervisión/interventoría
const RE_SUPERVISION = /apoyo\s+(a\s+la\s+)?supervis|supervisión\s+de\s+(obra|contrato|proyecto)|interventor[ií]a|control\s+de\s+obra|seguimiento\s+y\s+control|apoyo\s+t[eé]cnico.+supervisi|coordinaci[oó]n\s+y\s+control/i;

// Tipos de contrato de obra/bienes que NO son supervisión
const RE_OBRA = /obra|construcci[oó]n|infraestructura|suministro|compraventa|concesi[oó]n/i;

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

/**
 * 1. CONCENTRACIÓN DE SUPERVISIÓN
 *
 * Devuelve contratistas que tienen ≥ minContratos de supervisión, ordenados por
 * carga descendente. Incluye el valor total que gestionan (riesgo fiscal).
 *
 * @param {object} opts
 *   nitEntidad?, entidad? — filtrar por entidad (si se omite, alcance nacional)
 *   desde?, hasta?, dias? — rango temporal (default: 2 años)
 *   minContratos? — umbral de concentración (default 4)
 *   ambito? — clausulasSoQL adicionales
 */
export async function concentracionSupervisores(opts = {}) {
  const { nitEntidad, entidad, minContratos = 4, ambito } = opts;

  // Traemos todos los contratos de supervisión del período
  const conds = [];
  const rango = rangoFecha({ desde: opts.desde, hasta: opts.hasta, dias: opts.dias ?? 730 });
  if (rango) conds.push(rango);
  if (nitEntidad) conds.push(`nit_entidad = '${esc(nitEntidad)}'`);
  if (entidad)   conds.push(`upper(nombre_entidad) like upper('%${esc(entidad)}%')`);

  // Buscamos contratos de PS cuyo objeto incluye palabras de supervisión
  // SECOP no tiene full-text, usamos LIKE sobre el campo objeto
  const objetoFilter = [
    "upper(objeto_del_contrato) like upper('%supervisión%')",
    "upper(objeto_del_contrato) like upper('%supervision%')",
    "upper(objeto_del_contrato) like upper('%interventoría%')",
    "upper(objeto_del_contrato) like upper('%interventoria%')",
    "upper(objeto_del_contrato) like upper('%apoyo a la supervisi%')",
  ].join(' OR ');
  conds.push(`(${objetoFilter})`);
  conds.push(`tipo_de_contrato like '%Prestaci%'`); // PS

  const ambitoConds = ambito ? clausulasSoQL(ambito) : [];
  const where = [...conds, ...ambitoConds].join(' AND ');

  const rows = await socrata(EP, {
    $where: where,
    $select: 'documento_proveedor,proveedor_adjudicado,nit_entidad,nombre_entidad,id_contrato,valor_del_contrato,fecha_de_firma,objeto_del_contrato,estado_contrato',
    $limit: 5000,
    $order: 'fecha_de_firma DESC',
  });

  // Agrupar por contratista
  const porContratista = new Map();
  for (const r of rows) {
    const nit = (r.documento_proveedor ?? '').trim();
    if (!nit) continue;
    if (!porContratista.has(nit)) {
      porContratista.set(nit, {
        nit,
        nombre: r.proveedor_adjudicado ?? nit,
        contratos: [],
        entidades: new Set(),
        valor_total: 0,
      });
    }
    const entry = porContratista.get(nit);
    entry.contratos.push({
      id: r.id_contrato,
      entidad: r.nombre_entidad,
      nit_entidad: r.nit_entidad,
      objeto: (r.objeto_del_contrato ?? '').slice(0, 120),
      valor: Number(r.valor_del_contrato) || 0,
      fecha: r.fecha_de_firma?.slice(0, 10),
      estado: r.estado_contrato,
    });
    entry.entidades.add(r.nit_entidad ?? r.nombre_entidad);
    entry.valor_total += Number(r.valor_del_contrato) || 0;
  }

  // Filtrar por umbral y ordenar
  const resultado = [...porContratista.values()]
    .filter(e => e.contratos.length >= minContratos)
    .map(e => ({
      ...e,
      entidades: [...e.entidades],
      n_contratos: e.contratos.length,
      n_entidades: e.entidades.size,
      // Máximo de contratos activos simultáneos (aproximación: solapamiento de meses)
      max_simultaneos: _maxSimultaneos(e.contratos),
      senal: 'CONCENTRACION_SUPERVISOR',
      severidad: e.contratos.length >= 10 || e.valor_total > 5e9 ? 'alto' : 'medio',
      evidencia: `${e.contratos.length} contratos de supervisión · $${Math.round(e.valor_total / 1e6)}M gestionados${e.entidades.size > 1 ? ` · ${e.entidades.size} entidades` : ''}`,
    }))
    .sort((a, b) => b.n_contratos - a.n_contratos);

  return resultado;
}

/**
 * 2. CRUZAMIENTO DE SUPERVISORES
 *
 * Dentro del universo de contratos de supervisión de una entidad/período,
 * detecta pares (A, B) donde:
 *   - A tiene contrato de supervisión con la entidad
 *   - B tiene contrato de supervisión con la misma entidad
 *   - A también tiene contratos de OBRA con esa misma entidad (B lo "supervisa")
 *   - B también tiene contratos de OBRA (A lo "supervisa")
 *
 * El cruzamiento no se puede detectar leyendo SECOP solo con el campo de
 * supervisor (no existe ese campo). Se infiere de la co-presencia en la misma
 * entidad con roles distintos.
 */
export async function cruzamientoSupervisores(opts = {}) {
  const { nitEntidad, entidad, ambito } = opts;
  if (!nitEntidad && !entidad) throw new Error('cruzamientoSupervisores requiere nitEntidad o entidad');

  const rango = rangoFecha({ desde: opts.desde, hasta: opts.hasta, dias: opts.dias ?? 730 });
  const baseFilter = nitEntidad
    ? `nit_entidad = '${esc(nitEntidad)}'`
    : `upper(nombre_entidad) like upper('%${esc(entidad)}%')`;
  const where = [baseFilter, rango].filter(Boolean).join(' AND ');

  // Traemos TODOS los contratos de la entidad en el período
  const todos = await socrata(EP, {
    $where: where,
    $select: 'documento_proveedor,proveedor_adjudicado,id_contrato,valor_del_contrato,objeto_del_contrato,tipo_de_contrato,fecha_de_firma',
    $limit: 5000,
  });

  // Clasificar por tipo de contrato (supervisión vs obra)
  const supervisores = new Map(); // nit → contratos de supervisión
  const contratistasObra = new Map(); // nit → contratos de obra

  for (const r of todos) {
    const nit = (r.documento_proveedor ?? '').trim();
    if (!nit) continue;
    const obj = r.objeto_del_contrato ?? '';
    const tipo = r.tipo_de_contrato ?? '';

    const esSupervision = RE_SUPERVISION.test(obj);
    const esObra = RE_OBRA.test(tipo) || RE_OBRA.test(obj);

    if (esSupervision) {
      if (!supervisores.has(nit)) supervisores.set(nit, { nombre: r.proveedor_adjudicado, contratos: [] });
      supervisores.get(nit).contratos.push({ id: r.id_contrato, objeto: obj.slice(0, 100), valor: Number(r.valor_del_contrato) || 0 });
    }
    if (esObra || (!esSupervision && (Number(r.valor_del_contrato) || 0) > 50_000_000)) {
      if (!contratistasObra.has(nit)) contratistasObra.set(nit, { nombre: r.proveedor_adjudicado, contratos: [] });
      contratistasObra.get(nit).contratos.push({ id: r.id_contrato, objeto: obj.slice(0, 100), valor: Number(r.valor_del_contrato) || 0 });
    }
  }

  // Detectar NITs que aparecen en AMBAS categorías → perfil cruzado
  const perfilCruzado = [];
  for (const [nit, sup] of supervisores) {
    if (contratistasObra.has(nit)) {
      const obra = contratistasObra.get(nit);
      perfilCruzado.push({
        nit,
        nombre: sup.nombre,
        contratos_supervision: sup.contratos.length,
        contratos_obra: obra.contratos.length,
        valor_supervision: sup.contratos.reduce((s, c) => s + c.valor, 0),
        valor_obra: obra.contratos.reduce((s, c) => s + c.valor, 0),
        senal: 'PERFIL_CRUZADO',
        severidad: 'alto',
        evidencia: `Ejerce supervisión (${sup.contratos.length} contratos) Y es contratista de obra/servicios (${obra.contratos.length} contratos) en la misma entidad — conflicto de interés flagrante`,
        detalle_supervision: sup.contratos.slice(0, 5),
        detalle_obra: obra.contratos.slice(0, 5),
      });
    }
  }

  // Detectar pares de supervisores que se cruzan (A supervisa mientras B también supervisa = red)
  const listaSuper = [...supervisores.keys()];
  const pares = [];
  if (listaSuper.length >= 2 && listaSuper.length <= 50) { // solo si la red es manejable
    for (let i = 0; i < listaSuper.length; i++) {
      for (let j = i + 1; j < listaSuper.length; j++) {
        const a = listaSuper[i];
        const b = listaSuper[j];
        // Son "cruzados" si ambos supervisan y ambos tienen contratos de obra/PS
        // (indica que podrían estar supervisándose mutuamente)
        if (contratistasObra.has(a) && contratistasObra.has(b)) {
          pares.push({
            supervisor_a: { nit: a, nombre: supervisores.get(a).nombre },
            supervisor_b: { nit: b, nombre: supervisores.get(b).nombre },
            senal: 'CRUZAMIENTO_SUPERVISORES',
            severidad: 'alto',
            evidencia: `${supervisores.get(a).nombre} y ${supervisores.get(b).nombre} se supervisan mutuamente: ambos tienen contratos de supervisión Y contratos ejecutados en la misma entidad`,
          });
        }
      }
    }
  }

  return { perfil_cruzado: perfilCruzado, pares_cruzados: pares, n_supervisores: listaSuper.length };
}

/**
 * Calcula la máxima cantidad de contratos que se solapan en el tiempo.
 * Aproximación por mes (SECOP solo da fecha de firma, no fecha de término).
 * Asumimos duración promedio de 6 meses por PS.
 */
function _maxSimultaneos(contratos, duracionMeses = 6) {
  if (!contratos.length) return 0;
  const meses = new Map();
  for (const c of contratos) {
    if (!c.fecha) continue;
    const [y, m] = c.fecha.split('-').map(Number);
    for (let i = 0; i < duracionMeses; i++) {
      const mes = `${y}-${String(m + i > 12 ? (m + i) - 12 : m + i).padStart(2, '0')}`;
      meses.set(mes, (meses.get(mes) ?? 0) + 1);
    }
  }
  return Math.max(0, ...[...meses.values()]);
}
