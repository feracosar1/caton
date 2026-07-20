/**
 * BÚSQUEDA LOCALIZADA — la pantalla de entrada del veedor.
 *
 * "Tal entidad, tal monto, tal período, tal estado, tal tipo." Un $where sobre
 * datos abiertos (jbjy-vk9h contratos · p6dx-8zbt procesos). Instantáneo, gratis.
 *
 * Es el filtro que precede a TODO: el humano acota el universo de ~cientos de
 * miles de contratos a un puñado, y de ahí decide qué auditar (motor) o de qué
 * contratista tirar el hilo (grafo). No gasta un token ni descarga un PDF.
 */

import https from 'https';
import { clausulasSoQL } from './ambito.mjs';
import { scorearContrato } from './score-contrato.mjs';

const SOCRATA = 'www.datos.gov.co';
const EP_CONTRATOS = 'jbjy-vk9h';   // contratos electrónicos
const EP_PROCESOS  = 'p6dx-8zbt';   // procesos (para la fase precontractual)

function socrata(dataset, params) {
  const q = new URLSearchParams(params);
  if (process.env.SOCRATA_APP_TOKEN) q.set('$$app_token', process.env.SOCRATA_APP_TOKEN);
  return new Promise((resolve, reject) => {
    const req = https.get(
      { hostname: SOCRATA, path: `/resource/${dataset}.json?${q}`, headers: { Accept: 'application/json' } },
      (res) => {
        const c = [];
        res.on('data', d => c.push(d));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(c).toString());
            if (!Array.isArray(data)) return reject(new Error(`Socrata: ${data?.message ?? 'respuesta no iterable'}`));
            resolve(data);
          } catch (e) { reject(e); }
        });
      });
    req.on('error', reject);
    req.setTimeout(40_000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// Escapa comillas simples en valores de texto (Socrata usa '' para escapar).
const esc = (s) => String(s).replace(/'/g, "''");
const iso = (d) => `${d}T00:00:00.000`;

/**
 * @param filtros {
 *   entidad?: string           coincidencia parcial en nombre_entidad
 *   nitEntidad?: string
 *   contratista?: string       parcial en proveedor_adjudicado
 *   nitContratista?: string
 *   objeto?: string            parcial en objeto_del_contrato
 *   valorMin?, valorMax?: number
 *   desde?, hasta?: string     fecha_de_firma, formato 'AAAA-MM-DD'
 *   estado?: string            estado_contrato (ej. 'En ejecución', 'Terminado')
 *   tipo?: string              tipo_de_contrato (ej. 'Obra', 'Prestación de servicios')
 *   modalidad?: string
 *   limite?: number            default 100
 * }
 */
export async function buscarContratos(filtros = {}) {
  const w = [];
  if (filtros.entidad)        w.push(`upper(nombre_entidad) like '%${esc(filtros.entidad).toUpperCase()}%'`);
  if (filtros.nitEntidad)     w.push(`nit_entidad = '${esc(filtros.nitEntidad)}'`);
  if (filtros.contratista)    w.push(`upper(proveedor_adjudicado) like '%${esc(filtros.contratista).toUpperCase()}%'`);
  if (filtros.nitContratista) w.push(`documento_proveedor = '${esc(filtros.nitContratista)}'`);
  if (filtros.objeto)         w.push(`upper(objeto_del_contrato) like '%${esc(filtros.objeto).toUpperCase()}%'`);
  if (filtros.valorMin != null) w.push(`valor_del_contrato >= '${filtros.valorMin}'`);
  if (filtros.valorMax != null) w.push(`valor_del_contrato <= '${filtros.valorMax}'`);
  if (filtros.desde)          w.push(`fecha_de_firma >= '${iso(filtros.desde)}'`);
  if (filtros.hasta)          w.push(`fecha_de_firma <= '${iso(filtros.hasta)}'`);
  if (filtros.estado)         w.push(`estado_contrato = '${esc(filtros.estado)}'`);
  if (filtros.tipo)           w.push(`upper(tipo_de_contrato) like '%${esc(filtros.tipo).toUpperCase()}%'`);
  if (filtros.modalidad)      w.push(`upper(modalidad_de_contratacion) like '%${esc(filtros.modalidad).toUpperCase()}%'`);

  // Filtro de ruido: fuera cancelados y contratos en $0 (borradores/sin ejecución).
  if (filtros.sinRuido) w.push(`estado_contrato != 'Cancelado'`, `valor_del_contrato > '0'`);
  // Solo empresas: fuera TODAS las cédulas (agresivo — también saca negocios que operan como persona natural).
  if (filtros.soloEmpresas) w.push(`tipodocproveedor = 'NIT'`);
  // Ocultar servicios personales (el ruido real): fuera prestación de servicios de
  // personas naturales (individuos/nómina), pero DEJA obras/suministros de persona
  // natural (negocios que operan con cédula, ej. constructores informales).
  if (filtros.sinServiciosPersonales) w.push(`not (upper(tipo_de_contrato) like 'PRESTACI%SERVICIOS' and tipodocproveedor != 'NIT')`);
  // Recorte por ámbito de competencia (quién puede ver qué). Si no hay ámbito o es
  // nacional pleno, no agrega nada.
  w.push(...clausulasSoQL(filtros.ambito));

  const rows = await socrata(EP_CONTRATOS, {
    $select: 'id_contrato,referencia_del_contrato,proceso_de_compra,nombre_entidad,nit_entidad,'
           + 'proveedor_adjudicado,documento_proveedor,nombre_representante_legal,'
           + 'valor_del_contrato,fecha_de_firma,estado_contrato,tipo_de_contrato,'
           + 'modalidad_de_contratacion,objeto_del_contrato,departamento,ciudad,orden,sector,tipodocproveedor',
    ...(w.length ? { $where: w.join(' AND ') } : {}),
    $order: 'fecha_de_firma DESC',
    $limit: String(filtros.limite ?? 100),
  });

  // Cada resultado ya viene "enganchado": las llaves para auditar (contrato) y
  // para tirar del grafo (NIT contratista, rep legal).
  const out = rows.map(r => {
    const c = {
      id_contrato: r.id_contrato,
      referencia: r.referencia_del_contrato,
      proceso: r.proceso_de_compra,
      entidad: r.nombre_entidad, nit_entidad: r.nit_entidad,
      contratista: r.proveedor_adjudicado, nit_contratista: r.documento_proveedor,
      representante_legal: r.nombre_representante_legal,
      valor: Number(r.valor_del_contrato) || 0,
      fecha_firma: r.fecha_de_firma?.slice(0, 10),
      estado: r.estado_contrato, tipo: r.tipo_de_contrato,
      modalidad: r.modalidad_de_contratacion,
      objeto: (r.objeto_del_contrato ?? '').slice(0, 180),
      departamento: r.departamento, ciudad: r.ciudad, orden: r.orden, sector: r.sector,
      tipo_doc: r.tipodocproveedor,
      _auditar: r.id_contrato,          // → motor: descarga informes de este contrato
      _grafo: r.documento_proveedor,    // → grafo: perfil y red de este contratista
    };
    return { ...c, ...scorearContrato(c) };   // score + nivel + razones
  });
  // Radar: los más sospechosos primero.
  return out.sort((a, b) => b.score - a.score);
}

/** Resumen agregado del mismo filtro: cuántos, cuánto, sin traer las filas. */
export async function resumenBusqueda(filtros = {}) {
  const w = [];
  if (filtros.entidad)    w.push(`upper(nombre_entidad) like '%${esc(filtros.entidad).toUpperCase()}%'`);
  if (filtros.nitEntidad) w.push(`nit_entidad = '${esc(filtros.nitEntidad)}'`);
  if (filtros.desde)      w.push(`fecha_de_firma >= '${iso(filtros.desde)}'`);
  if (filtros.hasta)      w.push(`fecha_de_firma <= '${iso(filtros.hasta)}'`);
  if (filtros.estado)     w.push(`estado_contrato = '${esc(filtros.estado)}'`);
  if (filtros.valorMin != null) w.push(`valor_del_contrato >= '${filtros.valorMin}'`);
  if (filtros.sinRuido) w.push(`estado_contrato != 'Cancelado'`, `valor_del_contrato > '0'`);
  if (filtros.soloEmpresas) w.push(`tipodocproveedor = 'NIT'`);
  if (filtros.sinServiciosPersonales) w.push(`not (upper(tipo_de_contrato) like 'PRESTACI%SERVICIOS' and tipodocproveedor != 'NIT')`);
  w.push(...clausulasSoQL(filtros.ambito));

  const [r] = await socrata(EP_CONTRATOS, {
    $select: 'count(id_contrato) as contratos,sum(valor_del_contrato) as valor_total',
    ...(w.length ? { $where: w.join(' AND ') } : {}),
  });
  return { contratos: Number(r?.contratos) || 0, valor_total: Number(r?.valor_total) || 0 };
}
