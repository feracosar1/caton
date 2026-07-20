/**
 * ANALIZADOR DE PLIEGOS
 *
 * Flujo por proceso:
 *   1. Descarga PDF (sesión SECOP autenticada o URL directa)
 *   2. Sube PDF a Azure Blob Storage (pliegos/{id_proceso}/{tipo}.pdf)
 *   3. Azure Document Intelligence → texto limpio
 *   4. Chunkea el texto + embeddings con Voyage AI (voyage-law-2)
 *   5. Indexa chunks en Azure AI Search (veedor-secop)
 *   6. Claude → detecta irregularidades técnicas → alertas con evidencia textual
 *   7. Guarda alertas en secop_alertas + actualiza score
 */

import https from 'https';
import http from 'http';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { BlobServiceClient } from '@azure/storage-blob';
import { SearchClient, AzureKeyCredential } from '@azure/search-documents';
import { descargarConSesion, obtenerDocumentosDeProceso } from './secop-session.mjs';
import { descubrirDocumentos, elegirPliego, descargarDocumento } from './secop-docs.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '.env') });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { realtime: { transport: ws } },
);

const DOC_INTEL_ENDPOINT = process.env.AZURE_DOC_INTELLIGENCE_ENDPOINT?.replace(/\/$/, '');
const DOC_INTEL_KEY      = process.env.AZURE_DOC_INTELLIGENCE_KEY;
const ANTHROPIC_KEY      = process.env.ANTHROPIC_API_KEY;
const VOYAGE_KEY         = process.env.VOYAGE_API_KEY;
const SEARCH_ENDPOINT    = process.env.AZURE_SEARCH_ENDPOINT;
const SEARCH_KEY         = process.env.AZURE_SEARCH_KEY;
const SEARCH_INDEX       = process.env.AZURE_SEARCH_INDEX || 'veedor-secop';
const STORAGE_CONN       = process.env.AZURE_STORAGE_CONNECTION_STRING;

// Clientes Azure
const blobService   = STORAGE_CONN ? BlobServiceClient.fromConnectionString(STORAGE_CONN) : null;
const searchClient  = (SEARCH_ENDPOINT && SEARCH_KEY)
  ? new SearchClient(SEARCH_ENDPOINT, SEARCH_INDEX, new AzureKeyCredential(SEARCH_KEY))
  : null;

// ── Descarga PDF como buffer ──────────────────────────────────────────────────
function descargarPDF(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Veedor-SECOP/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return descargarPDF(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => { req.destroy(); reject(new Error('Timeout descargando PDF')); });
  });
}

// ── Azure Blob Storage — subir PDF ───────────────────────────────────────────
async function subirBlob(idProceso, tipDoc, pdfBuffer) {
  if (!blobService) return null;
  try {
    const containerClient = blobService.getContainerClient('pliegos');
    const blobName = `${idProceso}/${tipDoc}.pdf`;
    const blockBlob = containerClient.getBlockBlobClient(blobName);
    await blockBlob.upload(pdfBuffer, pdfBuffer.length, {
      blobHTTPHeaders: { blobContentType: 'application/pdf' },
    });
    console.log(`[PLIEGOS] PDF subido a Blob: ${blobName}`);
    return blobName;
  } catch (e) {
    console.warn('[PLIEGOS] Error subiendo a Blob:', e.message);
    return null;
  }
}

// ── Azure Document Intelligence — extraer texto ───────────────────────────────
async function extraerTexto(pdfBuffer) {
  const endpoint = `${DOC_INTEL_ENDPOINT}/documentintelligence/documentModels/prebuilt-read:analyze?api-version=2024-11-30`;

  const submitRes = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Ocp-Apim-Subscription-Key': DOC_INTEL_KEY, 'Content-Type': 'application/pdf' },
    body: pdfBuffer,
  });

  if (!submitRes.ok) throw new Error(`Doc Intelligence submit: ${submitRes.status} ${await submitRes.text()}`);

  const operationUrl = submitRes.headers.get('operation-location');
  if (!operationUrl) throw new Error('No operation-location header');

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2_000));
    const pollRes  = await fetch(operationUrl, { headers: { 'Ocp-Apim-Subscription-Key': DOC_INTEL_KEY } });
    const result   = await pollRes.json();
    if (result.status === 'succeeded') return (result.analyzeResult?.content ?? '').slice(0, 100_000);
    if (result.status === 'failed')    throw new Error(`Doc Intelligence failed: ${JSON.stringify(result.error)}`);
  }
  throw new Error('Doc Intelligence timeout (60s)');
}

// ── Voyage AI — embeddings ────────────────────────────────────────────────────
async function getEmbeddings(texts) {
  if (!VOYAGE_KEY || texts.length === 0) return [];
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${VOYAGE_KEY}` },
    body: JSON.stringify({ model: 'voyage-law-2', input: texts, input_type: 'document' }),
  });
  if (!res.ok) throw new Error(`Voyage AI: ${await res.text()}`);
  const data = await res.json();
  return data.data.map(d => d.embedding);
}

// ── Chunkear texto ────────────────────────────────────────────────────────────
function chunkearTexto(texto, tamano = 800) {
  // Dividir por párrafos primero, luego por tamaño
  const parrafos = texto.split(/\n{2,}/);
  const chunks = [];
  let actual = '';

  for (const p of parrafos) {
    if ((actual + p).length > tamano && actual.length > 0) {
      chunks.push(actual.trim());
      actual = p;
    } else {
      actual += (actual ? '\n\n' : '') + p;
    }
  }
  if (actual.trim()) chunks.push(actual.trim());
  return chunks.filter(c => c.length > 50);
}

// ── Azure AI Search — indexar chunks ─────────────────────────────────────────
// AI Search solo acepta claves con letras, dígitos, _, - y =. Los IDs de SECOP
// traen puntos (CO1.REQ.10372832), así que se normalizan. El id_proceso real
// viaja en su propio campo, por lo que la clave puede ser lossy sin perder nada.
const claveSearch = (idProceso, i) => `${String(idProceso).replace(/[^A-Za-z0-9_\-=]/g, '_')}-${i}`;

async function indexarEnSearch(idProceso, entidad, modalidad, chunks, embeddings, fecha) {
  if (!searchClient || chunks.length === 0) return;
  try {
    const docs = chunks.map((content, i) => ({
      id:         claveSearch(idProceso, i),
      id_proceso: idProceso,
      entidad:    entidad || '',
      modalidad:  modalidad || '',
      chunk_idx:  i,
      content,
      embedding:  embeddings[i] || [],
      tipo_doc:   'pliego',
      fecha:      fecha ? new Date(fecha).toISOString() : new Date().toISOString(),
    }));

    // Subir en lotes de 100
    for (let i = 0; i < docs.length; i += 100) {
      await searchClient.uploadDocuments(docs.slice(i, i + 100));
    }
    console.log(`[PLIEGOS] ${chunks.length} chunks indexados en AI Search para ${idProceso}`);
  } catch (e) {
    console.warn('[PLIEGOS] Error indexando en AI Search:', e.message);
  }
}

// ── Claude — analizar texto del pliego ───────────────────────────────────────
async function analizarConClaude(texto, proceso) {
  const valorFmt = proceso.valor_proceso
    ? `$${Number(proceso.valor_proceso).toLocaleString('es-CO')}`
    : 'No especificado';

  const prompt = `Eres un experto en veeduría de contratación pública colombiana. Analiza este pliego de condiciones y detecta irregularidades técnicas y jurídicas.

PROCESO: ${proceso.id}
ENTIDAD: ${proceso.entidad || 'N/A'}
MODALIDAD: ${proceso.modalidad || 'N/A'}
VALOR: ${valorFmt}

TEXTO DEL PLIEGO:
${texto}

Busca específicamente:
- ESPECIFICACION_SASTRE: requisitos técnicos que parecen diseñados para un proveedor específico (marcas, modelos, experiencias muy particulares)
- REQUISITO_EXCLUYENTE: exigencias de capacidad financiera, experiencia o certificaciones desproporcionadas al valor del contrato
- PLAZO_IRREAL: tiempo de ejecución o presentación de ofertas insuficiente para la complejidad del objeto
- FRACCIONAMIENTO: señales de que el contrato debió licitarse como uno solo (objetos similares, misma época, misma entidad)
- OBJETO_VAGO: descripción del objeto tan genérica que permite ejecutar cualquier cosa
- CRITERIO_DISCRIMINATORIO: factores de calificación que favorecen artificialmente a un oferente
- CONFLICTO_ESPECIFICACION: contradicciones entre secciones del pliego que generan ambigüedad favorable a un proponente

Responde ÚNICAMENTE con JSON:
{
  "alertas": [
    {
      "tipo": "ESPECIFICACION_SASTRE" | "REQUISITO_EXCLUYENTE" | "PLAZO_IRREAL" | "FRACCIONAMIENTO" | "OBJETO_VAGO" | "CRITERIO_DISCRIMINATORIO" | "CONFLICTO_ESPECIFICACION",
      "severidad": "alta" | "media" | "baja",
      "descripcion": "Descripción concreta de la irregularidad",
      "evidencia_textual": "Fragmento exacto del pliego que lo evidencia (máx 300 chars)",
      "score_contribucion": 10-45
    }
  ],
  "resumen": "Resumen de 2-3 líneas del análisis"
}

Si no hay irregularidades claras, devuelve alertas: []. No inventes evidencia.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`Anthropic error: ${res.status}`);
  const data = await res.json();
  const texto_resp = data.content?.[0]?.text ?? '{}';
  const match = texto_resp.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Claude no devolvió JSON válido');
  return JSON.parse(match[0]);
}

// ── Procesar un item de la cola ───────────────────────────────────────────────
async function procesarItem(item) {
  const { id, id_proceso, url } = item;
  console.log(`[PLIEGOS] Procesando ${id_proceso}`);

  await supabase.from('secop_cola_descarga')
    .update({ estado: 'procesando', updated_at: new Date().toISOString() })
    .eq('id', id);

  try {
    const { data: proceso } = await supabase
      .from('secop_procesos')
      .select('id,entidad,modalidad,valor_proceso,fecha_publicacion,nit_entidad,id_portafolio')
      .eq('id', id_proceso).single();

    // 1+2. Descubrir y descargar el pliego — vía datos abiertos (sin sesión).
    // El portal autenticado (obtenerDocumentosDeProceso/descargarConSesion)
    // queda solo como fallback explícito con VEEDOR_PORTAL_FALLBACK=1.
    let pdfBuffer;
    let nombreArchivo = `${id_proceso}-pliego.pdf`;

    const portafolio = proceso?.id_portafolio;
    if (portafolio) {
      const anioHint = proceso?.fecha_publicacion
        ? new Date(proceso.fecha_publicacion).getFullYear() : null;
      const docs = await descubrirDocumentos(portafolio, { anioHint });
      const pliego = elegirPliego(docs);
      if (!pliego) {
        // Los documentos aparecen en datos abiertos con ~1-2 días de rezago:
        // esto es "todavía no", no un fallo — reintentar en el próximo run.
        throw new Error(`SIN_DOCS_ABIERTOS: aún no hay PDF en datos abiertos para ${portafolio}`);
      }
      console.log(`[PLIEGOS] Elegido: "${pliego.nombre}" (${Math.round(pliego.bytes / 1024)}KB, ${pliego.tipo})`);
      pdfBuffer = await descargarDocumento(pliego);
      nombreArchivo = pliego.nombre || nombreArchivo;
    } else if (process.env.VEEDOR_PORTAL_FALLBACK === '1'
               && (url.includes('OpportunityDetail') || url.includes('noticeUID='))) {
      const noticeUID = new URL(url).searchParams.get('noticeUID') || id_proceso;
      console.log(`[PLIEGOS] (fallback portal) Descubriendo documentos para ${noticeUID}...`);
      const docs = await obtenerDocumentosDeProceso(noticeUID);
      const pliego = docs.find(d => d.tipo === 'pliego') || docs[0];
      if (!pliego) throw new Error(`No se encontraron documentos para ${noticeUID}`);
      pdfBuffer = await descargarConSesion(pliego.url);
    } else {
      throw new Error(`Proceso sin id_portafolio — re-ingestar fase 1 para capturar id_del_portafolio`);
    }
    console.log(`[PLIEGOS] PDF descargado: ${Math.round(pdfBuffer.length / 1024)}KB`);

    if (pdfBuffer.slice(0, 4).toString() !== '%PDF') {
      throw new Error('No es PDF válido — el documento puede no ser un PDF real');
    }

    // 3. Subir a Azure Blob Storage
    const blobKey = await subirBlob(id_proceso, 'pliego', pdfBuffer);

    // 4. Extraer texto con Document Intelligence
    console.log(`[PLIEGOS] Extrayendo texto...`);
    const texto = await extraerTexto(pdfBuffer);
    console.log(`[PLIEGOS] ${texto.length} chars extraídos`);

    if (texto.length < 100) throw new Error('Texto demasiado corto — PDF sin contenido');

    // 5. Guardar documento con blob_key
    await supabase.from('secop_documentos').upsert({
      id_proceso,
      tipo_doc: 'pliego',
      nombre_archivo: nombreArchivo,
      blob_key: blobKey,
      tamanio_bytes: pdfBuffer.length,
      tipo_contenido: 'application/pdf',
      texto_extraido: texto,
      indexado: false,
    }, { onConflict: 'id_proceso,tipo_doc' });

    // 6. Chunkear + embeddings + indexar en AI Search
    console.log(`[PLIEGOS] Indexando en AI Search...`);
    const chunks     = chunkearTexto(texto);
    const embeddings = await getEmbeddings(chunks);
    await indexarEnSearch(
      id_proceso,
      proceso?.entidad,
      proceso?.modalidad,
      chunks,
      embeddings,
      proceso?.fecha_publicacion
    );

    // Marcar como indexado
    await supabase.from('secop_documentos')
      .update({ indexado: true })
      .eq('id_proceso', id_proceso).eq('tipo_doc', 'pliego');

    // 7. Analizar con Claude
    console.log(`[PLIEGOS] Analizando con Claude...`);
    const analisis = await analizarConClaude(texto, proceso ?? { id: id_proceso });
    console.log(`[PLIEGOS] ${analisis.alertas?.length ?? 0} alertas del pliego`);

    // 8. Guardar alertas del pliego (marcadas con fuente: pliego_pdf)
    if (analisis.alertas?.length > 0) {
      // Eliminar alertas previas de PDF de este proceso
      await supabase.from('secop_alertas').delete()
        .eq('id_proceso', id_proceso)
        .filter('evidencia->fuente', 'eq', 'pliego_pdf');

      await supabase.from('secop_alertas').insert(
        analisis.alertas.map(a => ({
          id_proceso,
          tipo_alerta:       a.tipo,
          severidad:         a.severidad,
          descripcion:       a.descripcion,
          evidencia: {
            evidencia_textual:  a.evidencia_textual,
            fuente:             'pliego_pdf',
            resumen_analisis:   analisis.resumen,
          },
          score_contribucion: a.score_contribucion,
        }))
      );
    }

    // 9. Marcar cola como completado
    await supabase.from('secop_cola_descarga').update({
      estado: 'completado',
      updated_at: new Date().toISOString(),
    }).eq('id', id);

    console.log(`[PLIEGOS] ✓ ${id_proceso} — ${chunks.length} chunks, ${analisis.alertas?.length ?? 0} alertas`);

  } catch (err) {
    console.error(`[PLIEGOS] Error ${id_proceso}:`, err.message);
    if (err.message.startsWith('SECOP_ACCOUNT_LOCKED')) throw err;
    // Tres clases de fallo:
    //  - fatalSecop (fallback portal): cuenta bloqueada/cooldown — no es culpa
    //    del item; queda pending sin gastar intento y la cola aborta.
    //  - SIN_DOCS_ABIERTOS: los datos abiertos cargan documentos con ~1-2 días
    //    de rezago — queda pending y se reintenta en el próximo run.
    //  - resto: error real del item; gasta intento y queda pending hasta agotar
    //    MAX_INTENTOS (antes quedaba en estado 'error' y nunca se reintentaba).
    const fatalSecop = /^SECOP_(ACCOUNT_LOCKED|COOLDOWN)/.test(err.message);
    const sinDocsAun = err.message.startsWith('SIN_DOCS_ABIERTOS');
    const intentos   = fatalSecop ? (item.intentos ?? 0) : (item.intentos ?? 0) + 1;

    await supabase.from('secop_cola_descarga').update({
      estado: (fatalSecop || sinDocsAun || intentos < MAX_INTENTOS) ? 'pending' : 'error',
      error_msg: err.message,
      intentos,
      updated_at: new Date().toISOString(),
    }).eq('id', id);

    if (fatalSecop) throw err;
  }
}

// Tope de intentos por item (compartido por todas las clases de fallo; la cola
// solo toma items con intentos < MAX_INTENTOS). 5 y no 3 porque el rezago
// normal de datos abiertos puede consumir 1-2 intentos en SIN_DOCS_ABIERTOS.
const MAX_INTENTOS = 5;

// ── Loop principal ────────────────────────────────────────────────────────────
export async function procesarCola({ limite = 10 } = {}) {
  const { data: items } = await supabase
    .from('secop_cola_descarga')
    .select('*')
    .eq('estado', 'pending')
    .lt('intentos', MAX_INTENTOS)
    .order('id', { ascending: true })
    .limit(limite);

  if (!items?.length) {
    console.log('[PLIEGOS] Cola vacía');
    return 0;
  }

  console.log(`[PLIEGOS] ${items.length} pliegos en cola`);
  let procesados = 0;
  for (const item of items) {
    try {
      await procesarItem(item);
      procesados++;
    } catch (err) {
      if (/^SECOP_(ACCOUNT_LOCKED|COOLDOWN)/.test(err.message)) {
        console.error(`[PLIEGOS] ⛔ SECOP cortó el acceso — abortando cola tras ${procesados} pliegos: ${err.message}`);
        break;
      }
      throw err;
    }
  }
  return procesados;
}
