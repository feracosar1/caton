/**
 * SECOP DOCUMENT RESOLVER
 *
 * Obtiene URLs reales de documentos de un proceso usando la API OCDS oficial
 * de Colombia Compra Eficiente — sin scraping, sin browser.
 *
 * API OCDS: https://api.colombiacompra.gov.co
 * Estándar: Open Contracting Data Standard (OCDS)
 *
 * El campo tender.documents[] contiene las URLs directas a los PDFs.
 */

import https from 'https';

const OCDS_BASE = 'https://api.colombiacompra.gov.co';
const TIMEOUT_MS = 20_000;

// ── HTTP helper con timeout ───────────────────────────────────────────────────
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Veedor-SECOP/1.0',
      },
    }, (res) => {
      // Seguir redirect
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJson(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} en ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(); reject(new Error(`Timeout ${TIMEOUT_MS}ms`)); });
  });
}

/**
 * Obtiene documentos de un proceso via OCDS API.
 * Retorna array de { nombre, url, tipo } o [] si no hay documentos.
 */
export async function obtenerDocumentos(idProceso) {
  console.log(`[DOCS] Consultando OCDS para ${idProceso}`);

  // OCDS API acepta el id del proceso directamente como ocid
  const url = `${OCDS_BASE}/releases/tender/?ocid=${encodeURIComponent(idProceso)}&page=1`;

  let data;
  try {
    data = await fetchJson(url);
  } catch (err) {
    throw new Error(`OCDS API error para ${idProceso}: ${err.message}`);
  }

  // El response puede ser un objeto con .releases[] o directamente el release
  const releases = Array.isArray(data?.releases) ? data.releases
    : Array.isArray(data) ? data
    : data?.release ? [data.release]
    : data?.tender ? [data]
    : [];

  if (releases.length === 0) {
    console.log(`[DOCS] Sin releases OCDS para ${idProceso}`);
    return [];
  }

  // Extraer documentos de todos los releases (tender.documents + documents)
  const docs = [];
  for (const release of releases) {
    const tenderDocs = release.tender?.documents ?? [];
    const rootDocs   = release.documents ?? [];
    for (const d of [...tenderDocs, ...rootDocs]) {
      if (!d.url) continue;
      docs.push({
        nombre: d.title || d.description || d.documentType || '',
        url: d.url,
        tipo: clasificarDocumento(d.title || '', d.documentType || '', d.url),
      });
    }
  }

  // Deduplicar por URL
  const seen = new Set();
  const unicos = docs.filter(d => {
    if (seen.has(d.url)) return false;
    seen.add(d.url);
    return true;
  });

  console.log(`[DOCS] ${unicos.length} documentos OCDS para ${idProceso}`);
  return unicos;
}

function clasificarDocumento(titulo, tipo, url) {
  const t = (titulo + ' ' + tipo + ' ' + url).toLowerCase();
  if (t.includes('pliego') || tipo === 'tenderNotice' || tipo === 'biddingDocuments') return 'pliego';
  if (t.includes('estudio') && t.includes('previo')) return 'estudios_previos';
  if (t.includes('adenda') || tipo === 'clarifications') return 'adenda';
  if (t.includes('anexo') || tipo === 'annexe') return 'anexo';
  if (t.includes('minuta') || t.includes('contrato') || tipo === 'contractDraft') return 'minuta_contrato';
  if (t.includes('presupuesto') || tipo === 'budgetBreakdown') return 'presupuesto';
  return 'otro';
}

/**
 * Construye la URL pública del proceso en el portal (para referencia, no para descargar PDFs).
 */
export function construirUrlPublica(idProceso, urlActual) {
  if (urlActual && urlActual.includes('/Public/Tendering/')) return urlActual;
  return `https://community.secop.gov.co/Public/Tendering/OpportunityDetail/Index?Id=${encodeURIComponent(idProceso)}`;
}
