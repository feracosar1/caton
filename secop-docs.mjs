/**
 * SECOP DOCS — descubrimiento y descarga de documentos vía Datos Abiertos.
 *
 * Reemplaza el flujo login + reCAPTCHA + scraping de OpportunityDetail:
 *   1. Los documentos de cada proceso están publicados en datasets Socrata
 *      dedicados ("SECOP II - Archivos Descarga"), con URL de descarga directa.
 *   2. Esa URL (/Public/Archive/RetrieveFile/) es PÚBLICA: no exige sesión ni
 *      captcha — a diferencia de /Public/Tendering/, que sí bloquea bots.
 *
 * Llave de join: `proceso` en los datasets de archivos = `id_del_portafolio`
 * (CO1.BDOS.*) del dataset de procesos p6dx-8zbt. NO es id_del_proceso (CO1.REQ.*).
 *
 * Los documentos aparecen en datos abiertos con ~1-2 días de rezago respecto a
 * la publicación del proceso. Un proceso sin documentos hoy casi siempre los
 * tiene mañana — tratar como "reintentar", no como error.
 *
 * Variables de entorno:
 *   SOCRATA_APP_TOKEN  — opcional; sube el rate limit de datos.gov.co (gratis)
 */

import https from 'https';

const SOCRATA_HOST = 'www.datos.gov.co';
const SECOP_HOST   = 'community.secop.gov.co';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Datasets "SECOP II - Archivos Descarga", del más fresco al más viejo.
// Se consultan en cascada hasta encontrar el proceso.
const DATASETS_ARCHIVOS = [
  { id: 'dmgg-8hin', desde: 2025 },  // Desde 2025 (se actualiza a diario)
  { id: 'nbae-kzan', desde: 2024 },  // Histórico 2024
  { id: '3skv-9na7', desde: 2023 },  // Histórico 2023
  { id: 'kgcd-kt7i', desde: 2022 },  // Histórico 2022
  { id: 'f8va-cf4m', desde: 0    },  // Histórico hasta 2021
];

const MAX_PDF_BYTES = 50 * 1024 * 1024;  // Doc Intelligence no necesita más
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Throttle suave global: el endpoint aguanta paralelo, pero somos buenos
// ciudadanos — 1 request en vuelo por vez con gap corto.
const MIN_GAP_MS = 800;
let ultimaReq = 0;
async function throttle() {
  const desde = Date.now() - ultimaReq;
  if (desde < MIN_GAP_MS) await sleep(MIN_GAP_MS - desde);
  ultimaReq = Date.now();
}

// ── GET binario con límite de tamaño y backoff ───────────────────────────────
function httpGetBuf(url, { maxBytes = MAX_PDF_BYTES, timeoutMs = 90_000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { 'User-Agent': UA, ...headers },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return httpGetBuf(new URL(res.headers.location, url).href, { maxBytes, timeoutMs, headers })
          .then(resolve, reject);
      }
      const chunks = [];
      let total = 0;
      res.on('data', (c) => {
        total += c.length;
        if (total > maxBytes) { req.destroy(); return reject(new Error(`Archivo supera ${Math.round(maxBytes / 1e6)}MB`)); }
        chunks.push(c);
      });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('HTTP timeout')); });
    req.end();
  });
}

async function socrataGet(dataset, params, { intentos = 4 } = {}) {
  await throttle();
  const q = new URLSearchParams(params);
  const headers = { Accept: 'application/json' };
  if (process.env.SOCRATA_APP_TOKEN) headers['X-App-Token'] = process.env.SOCRATA_APP_TOKEN;

  const res = await httpGetBuf(`https://${SOCRATA_HOST}/resource/${dataset}.json?${q}`, {
    maxBytes: 20 * 1024 * 1024, timeoutMs: 60_000, headers,
  });

  if ((res.status === 429 || res.status >= 500) && intentos > 1) {
    const espera = Math.round(2_000 * 2 ** (4 - intentos) * (0.7 + Math.random() * 0.6));
    console.warn(`[DOCS] Socrata HTTP ${res.status} — reintento en ${Math.round(espera / 1000)}s`);
    await sleep(espera);
    return socrataGet(dataset, params, { intentos: intentos - 1 });
  }
  if (res.status !== 200) throw new Error(`Socrata HTTP ${res.status}: ${res.body.toString().slice(0, 200)}`);

  const data = JSON.parse(res.body.toString());
  if (!Array.isArray(data)) {
    throw new Error(`Socrata devolvió error: ${data?.message || JSON.stringify(data).slice(0, 200)}`);
  }
  return data;
}

function clasificar(nombre) {
  const n = (nombre || '').toLowerCase();
  if (n.includes('pliego'))  return 'pliego';
  if (n.includes('estudio')) return 'estudios_previos';
  if (n.includes('adenda'))  return 'adenda';
  if (n.includes('anexo'))   return 'anexo';
  return 'otro';
}

// ── Descubrir documentos de un proceso ────────────────────────────────────────
// idPortafolio: CO1.BDOS.* (id_del_portafolio de p6dx-8zbt)
// anioHint: año de publicación del proceso — corta la cascada de datasets
export async function descubrirDocumentos(idPortafolio, { anioHint = null } = {}) {
  if (!idPortafolio?.startsWith('CO1.BDOS.')) {
    throw new Error(`id_portafolio inválido: '${idPortafolio}' — se espera CO1.BDOS.*`);
  }

  const candidatos = DATASETS_ARCHIVOS.filter(d => anioHint == null || anioHint >= d.desde);
  const datasets = candidatos.length ? candidatos : DATASETS_ARCHIVOS;

  for (const ds of datasets) {
    const rows = await socrataGet(ds.id, {
      $select: 'id_documento,nombre_archivo,extensi_n,tamanno_archivo,fecha_carga',
      proceso: idPortafolio,
      $order: 'fecha_carga DESC',
      $limit: '200',
    });
    if (rows.length === 0) continue;

    console.log(`[DOCS] ${rows.length} documentos en datos abiertos (${ds.id}) para ${idPortafolio}`);
    return rows.map(r => ({
      fileId:    r.id_documento,
      nombre:    r.nombre_archivo || '',
      extension: (r.extensi_n || '').toLowerCase(),
      bytes:     Number(r.tamanno_archivo) || 0,
      fecha:     r.fecha_carga,
      tipo:      clasificar(r.nombre_archivo),
      url: `https://${SECOP_HOST}/Public/Archive/RetrieveFile/Index?DocumentId=${r.id_documento}&InCommunity=False&InPaymentGateway=False&DocUniqueIdentifier=`,
    }));
  }
  return [];
}

// ── Descubrir documentos de EJECUCIÓN de un contrato ──────────────────────────
// Los informes de supervisión, actas y pagos cuelgan del CONTRATO (CO1.PCCNTR.*),
// no del proceso (CO1.BDOS.*). Son dos llaves distintas del mismo dataset. Esta
// es la puerta a la fase de ejecución — donde está la corrupción que audita el
// motor. Filtra a los informes de supervisión por nombre de archivo.
const RE_INFORME_SUPERVISION = /infor.{0,4}super|informe\s+de\s+supervis|f1\.?p18|supervisi[oó]n.{0,20}contrato/i;

export async function descubrirInformesDeContrato(idContrato, { soloSupervision = true } = {}) {
  if (!idContrato?.startsWith('CO1.PCCNTR.')) {
    throw new Error(`id_contrato inválido: '${idContrato}' — se espera CO1.PCCNTR.*`);
  }
  // Se busca en los datasets de archivos por la llave del contrato.
  for (const ds of DATASETS_ARCHIVOS) {
    const rows = await socrataGet(ds.id, {
      $select: 'id_documento,nombre_archivo,extensi_n,tamanno_archivo,fecha_carga',
      n_mero_de_contrato: idContrato,
      $order: 'fecha_carga ASC',
      $limit: '300',
    });
    if (rows.length === 0) continue;

    const docs = rows.map(r => ({
      fileId: r.id_documento,
      nombre: r.nombre_archivo || '',
      extension: (r.extensi_n || '').toLowerCase(),
      bytes: Number(r.tamanno_archivo) || 0,
      fecha: r.fecha_carga,
      es_informe: RE_INFORME_SUPERVISION.test(r.nombre_archivo || ''),
      url: `https://${SECOP_HOST}/Public/Archive/RetrieveFile/Index?DocumentId=${r.id_documento}&InCommunity=False&InPaymentGateway=False&DocUniqueIdentifier=`,
    }));

    const informes = docs.filter(d => d.es_informe && d.extension === 'pdf' && d.bytes > 5_000);
    console.log(`[DOCS] contrato ${idContrato}: ${docs.length} documentos, ${informes.length} informes de supervisión (${ds.id})`);
    return soloSupervision ? informes : docs;
  }
  return [];
}

// ── Elegir el documento a analizar ────────────────────────────────────────────
// Prioridad: pliego definitivo > pliego > estudios previos > anexo > cualquier PDF.
// Solo PDFs entre 5KB y 50MB (fuera de eso: firmas sueltas o escaneos gigantes).
export function elegirPliego(docs) {
  const pdfs = docs.filter(d =>
    d.extension === 'pdf' && d.bytes > 5_000 && d.bytes <= MAX_PDF_BYTES);
  if (pdfs.length === 0) return null;

  const rank = (d) => {
    const n = d.nombre.toLowerCase();
    if (n.includes('pliego') && n.includes('definitiv') && !n.includes('proyecto')) return 0;
    if (n.includes('pliego') && !n.includes('proyecto')) return 1;
    if (n.includes('proyecto') && n.includes('pliego')) return 2;
    if (n.includes('estudio')) return 3;
    if (n.includes('anexo')) return 4;
    return 5;
  };
  pdfs.sort((a, b) => rank(a) - rank(b) || b.bytes - a.bytes);
  return pdfs[0];
}

// ── Descargar un documento (público, sin sesión) ──────────────────────────────
export async function descargarDocumento(doc, { intentos = 3 } = {}) {
  await throttle();
  const res = await httpGetBuf(doc.url, {
    headers: { Accept: 'application/pdf,application/octet-stream,*/*' },
  });

  if ((res.status === 429 || res.status >= 500) && intentos > 1) {
    const espera = Math.round(3_000 * 2 ** (3 - intentos) * (0.7 + Math.random() * 0.6));
    console.warn(`[DOCS] HTTP ${res.status} descargando ${doc.fileId} — reintento en ${Math.round(espera / 1000)}s`);
    await sleep(espera);
    return descargarDocumento(doc, { intentos: intentos - 1 });
  }
  if (res.status !== 200) throw new Error(`HTTP ${res.status} descargando documento ${doc.fileId}`);

  // El dataset declara el tamaño exacto: si difiere mucho, algo raro pasó
  // (página de error, archivo truncado). Los magic bytes los valida el caller.
  if (doc.bytes && Math.abs(res.body.length - doc.bytes) > 1024) {
    console.warn(`[DOCS] Tamaño inesperado en ${doc.fileId}: ${res.body.length}b vs declarado ${doc.bytes}b`);
  }
  return res.body;
}
