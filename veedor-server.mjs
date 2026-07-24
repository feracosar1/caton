/**
 * VEEDOR — Servidor de ingesta SECOP II
 *
 * Pipeline en 4 fases (siempre en este orden):
 *   1. /ingestar   → descarga metadata de procesos (sin alertas)
 *   2. /contratos  → descarga contratos adjudicados + grafo
 *   3. /pliegos    → descarga PDFs → OCR → embeddings → Azure AI Search
 *   4. /scorear    → genera alertas con contexto completo
 *
 *   /pipeline → encadena las 4 fases automáticamente
 */

import express from 'express';
import https from 'https';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '.env') });

// Import dinámico — después de dotenv para que las env vars estén disponibles
const { procesarCola } = await import('./analizador-pliegos.mjs');

// ── Supabase ──────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { realtime: { transport: ws } },
);

// ── Config ────────────────────────────────────────────────────────────────────
const SECRET      = process.env.VEEDOR_SECRET;
const NUMA_URL    = process.env.NUMA_SUPABASE_URL || '';
const NUMA_ANON   = process.env.NUMA_ANON_KEY || '';
const CATON_URL   = process.env.SUPABASE_URL || '';
const CATON_ANON  = process.env.SUPABASE_ANON_KEY || '';
const APP_TOKEN = process.env.SECOP_APP_TOKEN || '';
const PORT      = Number(process.env.PORT) || 3002;
const BATCH     = 1000;

const EP_PROCESOS  = 'https://www.datos.gov.co/resource/p6dx-8zbt.json';
const EP_CONTRATOS = 'https://www.datos.gov.co/resource/jbjy-vk9h.json';

const PLAZOS_MIN = {
  'Licitación Pública':  10,
  'Selección Abreviada':  5,
  'Concurso de Méritos': 10,
  'Mínima Cuantía':       1,
  'Contratación Directa': 0,
};

const MODALIDADES_DIRECTAS = new Set([
  'Contratación directa',
  'Contratación Directa (con ofertas)',
  'Contratación régimen especial',
  'Contratación régimen especial (con ofertas)',
]);

const OBJETOS_VAGOS = /servicios profesionales|apoyo a la gesti[oó]n|consultor[ií]a\s+individual|asistencia t[eé]cnica/i;

// ── Estado global ─────────────────────────────────────────────────────────────
const state = {
  running: false, fase: 'idle',
  procesados: 0, alertas: 0, errores: 0,
  contratos: 0, relaciones: 0,
  pliegos_ok: 0, pliegos_err: 0,
  ultimo: null, started_at: null,
  pipeline_fase: null,   // 'procesos' | 'contratos' | 'pliegos' | 'scorear'
};
let shouldStop = false;

// ── HTTP helper ───────────────────────────────────────────────────────────────
// Socrata responde 200 con {message, errorCode} ante una query inválida, y 429
// ante rate limit. Devolver eso como si fuera un array revienta río abajo con
// "rows is not iterable" — se valida acá y se falla con el motivo real.
function httpGet(url, { intentos = 4 } = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Accept: 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', async () => {
        const raw = Buffer.concat(chunks).toString();

        // 429 / 5xx → backoff exponencial con jitter
        if ((res.statusCode === 429 || res.statusCode >= 500) && intentos > 1) {
          const espera = backoffMs(5 - intentos);
          console.warn(`[VEEDOR] HTTP ${res.statusCode} de Socrata — reintento en ${Math.round(espera / 1000)}s`);
          await sleep(espera);
          return httpGet(url, { intentos: intentos - 1 }).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Socrata HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
        }

        let data;
        try { data = JSON.parse(raw); }
        catch (e) { return reject(new Error(`JSON parse error: ${e.message}`)); }

        if (!Array.isArray(data)) {
          const motivo = data?.message || data?.error || JSON.stringify(data).slice(0, 200);
          return reject(new Error(`Socrata devolvió error en vez de filas: ${motivo}`));
        }
        resolve(data);
      });
    }).on('error', reject);
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Backoff exponencial con jitter: 2s, 4s, 8s, 16s (±30%)
function backoffMs(intento) {
  const base = Math.min(2_000 * 2 ** intento, 60_000);
  return Math.round(base * (0.7 + Math.random() * 0.6));
}

function secopUrl(base, params) {
  const q = new URLSearchParams({ $limit: String(BATCH), ...params });
  if (APP_TOKEN) q.set('$$app_token', APP_TOKEN);
  return `${base}?${q}`;
}

// ── Normalizadores ────────────────────────────────────────────────────────────
function normalizarProceso(raw) {
  const urlRaw = raw.urlproceso || raw.url_proceso;
  const url_proceso = urlRaw?.url ?? urlRaw ?? null;
  return {
    id:                raw.id_del_proceso || raw.referencia_del_proceso || raw.id_proceso || raw.proceso_de_compra,
    // CO1.BDOS.* — llave de join con los datasets "Archivos Descarga" (dmgg-8hin
    // etc.), que es de donde salen los PDFs. Sin esto no hay fase 3.
    id_portafolio:     raw.id_del_portafolio || null,
    entidad:           raw.entidad || raw.nombre_entidad,
    nit_entidad:       raw.nit_entidad,
    departamento:      raw.departamento_entidad,
    ciudad:            raw.ciudad_entidad,
    modalidad:         raw.modalidad_de_contratacion || raw.modalidad,
    estado:            raw.estado_del_procedimiento || raw.estado_proceso || raw.estado,
    fase:              raw.fase || raw.fase_proceso,
    descripcion:       raw.descripci_n_del_procedimiento || raw.descripcion_del_procedimiento || raw.nombre_del_procedimiento || raw.objeto,
    valor_proceso:     raw.precio_base ? parseFloat(raw.precio_base) : (raw.valor_proceso ? parseFloat(raw.valor_proceso) : null),
    codigo_unspsc:     raw.codigo_principal_de_categoria || raw.codigo_unspsc,
    fecha_publicacion: raw.fecha_de_publicacion_del || raw.fecha_publicacion,
    fecha_limite:      raw.fecha_de_recepcion_de || raw.fecha_de_apertura_de_respuesta || raw.fecha_limite_de_recepcion || raw.fecha_limite,
    fecha_adjudicacion:raw.fecha_adjudicacion,
    url_proceso,
    raw,
  };
}

function normalizarContrato(raw) {
  return {
    id:              raw.id_contrato || raw.referencia_del_contrato || raw.numero_de_contrato,
    id_proceso:      raw.proceso_de_compra || raw.id_proceso,
    entidad:         raw.nombre_entidad || raw.entidad,
    nit_entidad:     raw.nit_entidad,
    contratista:     raw.proveedor_adjudicado || raw.nombre_del_contratista || raw.contratista,
    nit_contratista: raw.documento_proveedor || raw.nit_contratista,
    valor_contrato:  raw.valor_del_contrato ? parseFloat(raw.valor_del_contrato) : null,
    fecha_firma:     raw.fecha_de_firma || raw.fecha_de_firma_del_contrato || raw.fecha_firma,
    objeto:          raw.descripcion_del_proceso || raw.objeto_del_contrato || raw.objeto,
    codigo_unspsc:   raw.codigo_principal_de_categoria || raw.codigo_unspsc,
    raw,
  };
}

// ── Motor de alertas (corre DESPUÉS de tener contratos + pliegos) ─────────────
async function getPrecioReferencia(codigoUnspsc) {
  if (!codigoUnspsc) return null;
  try {
    const hace1anio = new Date(Date.now() - 365 * 86_400_000).toISOString();
    const { data } = await supabase
      .from('secop_contratos').select('valor_contrato')
      .eq('codigo_unspsc', codigoUnspsc)
      .gte('fecha_firma', hace1anio).gt('valor_contrato', 0).limit(200);
    if (!data || data.length < 5) return null;
    const valores = data.map(c => Number(c.valor_contrato)).sort((a, b) => a - b);
    return { mediana: valores[Math.floor(valores.length / 2)], muestra: valores.length };
  } catch { return null; }
}

function detectarAlertas(p, historialNit = [], precioRef = null, alertasPliegos = []) {
  const alertas = [...alertasPliegos]; // incluir alertas ya detectadas del PDF
  const raw = p.raw || {};
  const valor = p.valor_proceso || 0;
  const modalidad = p.modalidad || '';
  const descripcion = p.descripcion || raw.nombre_del_procedimiento || '';
  const justificacion = raw.justificaci_n_modalidad_de || '';
  const unicosConOferta = Number(raw.proveedores_unicos_con) || 0;
  const respuestas = Number(raw.respuestas_al_procedimiento) || 0;

  // A1 — Plazo mínimo violado
  if (p.fecha_publicacion && p.fecha_limite) {
    const dias = Math.ceil((new Date(p.fecha_limite) - new Date(p.fecha_publicacion)) / 86_400_000);
    const min = PLAZOS_MIN[modalidad] ?? 5;
    if (dias < min && min > 0) {
      alertas.push({ tipo_alerta: 'PLAZO_MINIMO_VIOLADO', severidad: 'alta',
        descripcion: `Plazo de ${dias} días < mínimo legal de ${min} días para ${modalidad}`,
        evidencia: { dias_publicado: dias, minimo_legal: min, modalidad }, score_contribucion: 25 });
    }
  }

  // A2 — Contratista recurrente (ahora sí tenemos contratos cargados)
  const recurrentes = {};
  historialNit.forEach(c => { if (c.nit_contratista) recurrentes[c.nit_contratista] = (recurrentes[c.nit_contratista] || 0) + 1; });
  for (const [nit, count] of Object.entries(recurrentes)) {
    if (count >= 3) {
      alertas.push({ tipo_alerta: 'CONTRATISTA_RECURRENTE', severidad: 'media',
        descripcion: `NIT ${nit} acumula ${count} contratos con esta entidad en 12 meses`,
        evidencia: { nit_contratista: nit, contratos_count: count }, score_contribucion: 15 });
    }
  }

  // A3 — Valor extremo
  if (valor > 10_000_000_000_000) {
    alertas.push({ tipo_alerta: 'VALOR_EXTREMO', severidad: 'alta',
      descripcion: `Valor $${Number(valor).toLocaleString('es-CO')} es extraordinariamente alto`,
      evidencia: { valor }, score_contribucion: 20 });
  }

  // A4 — Precio inflado vs mediana UNSPSC (ahora sí tenemos datos de contratos)
  if (precioRef && valor > 0) {
    const factor = valor / precioRef.mediana;
    if (factor >= 2.5) {
      alertas.push({ tipo_alerta: 'PRECIO_INFLADO', severidad: 'alta',
        descripcion: `Precio $${(valor/1e6).toFixed(0)}M es ${factor.toFixed(1)}× la mediana histórica ($${(precioRef.mediana/1e6).toFixed(0)}M)`,
        evidencia: { valor_proceso: valor, mediana_historica: precioRef.mediana, factor, muestra: precioRef.muestra }, score_contribucion: 30 });
    } else if (factor >= 1.75) {
      alertas.push({ tipo_alerta: 'PRECIO_ELEVADO', severidad: 'media',
        descripcion: `Precio $${(valor/1e6).toFixed(0)}M es ${factor.toFixed(1)}× la mediana histórica`,
        evidencia: { valor_proceso: valor, mediana_historica: precioRef.mediana, factor, muestra: precioRef.muestra }, score_contribucion: 15 });
    }
  }

  // A5 — Contratación directa con señales combinadas
  if (MODALIDADES_DIRECTAS.has(modalidad) && valor > 500_000_000) {
    const esVago = OBJETOS_VAGOS.test(justificacion || descripcion);
    const hayRecurrente = Object.values(recurrentes).some(c => c >= 3);
    const esPrecioInflado = precioRef && (valor / precioRef.mediana) >= 2;
    const señales = [esVago, hayRecurrente, esPrecioInflado].filter(Boolean).length;
    if (señales >= 1) {
      alertas.push({ tipo_alerta: 'CONTRATACION_DIRECTA_RIESGO', severidad: señales >= 2 ? 'alta' : 'media',
        descripcion: `Contratación directa $${(valor/1e6).toFixed(0)}M con ${señales} señal(es): ${[esVago && 'objeto vago', hayRecurrente && 'contratista recurrente', esPrecioInflado && 'precio inflado'].filter(Boolean).join(', ')}`,
        evidencia: { valor, modalidad, objeto_vago: esVago, contratista_recurrente: hayRecurrente, precio_inflado: esPrecioInflado },
        score_contribucion: señales >= 2 ? 25 : 12 });
    }
  }

  // A6 — Proveedor único en licitación
  if (!MODALIDADES_DIRECTAS.has(modalidad) && unicosConOferta === 1 && respuestas === 1 && valor > 100_000_000) {
    alertas.push({ tipo_alerta: 'PROVEEDOR_UNICO_LICITACION', severidad: 'alta',
      descripcion: `Solo 1 proveedor en ${modalidad} de $${(valor/1e6).toFixed(0)}M — posible competencia simulada`,
      evidencia: { valor, modalidad, proveedores_con_oferta: unicosConOferta }, score_contribucion: 30 });
  }

  // A7 — Objeto vago + valor alto
  if (!MODALIDADES_DIRECTAS.has(modalidad) && OBJETOS_VAGOS.test(justificacion || descripcion) && valor > 200_000_000) {
    alertas.push({ tipo_alerta: 'OBJETO_VAGO_VALOR_ALTO', severidad: 'media',
      descripcion: `Objeto genérico "${(descripcion || justificacion).slice(0, 80)}" con valor $${(valor/1e6).toFixed(0)}M`,
      evidencia: { valor, objeto: (descripcion || justificacion).slice(0, 300) }, score_contribucion: 15 });
  }

  return alertas;
}

// ── FASE 1: Ingesta de procesos (loop paginado hasta agotar) ──────────────────
async function ingestar({ offset = 0, departamento = null } = {}) {
  state.running = true; state.fase = 'procesos'; state.pipeline_fase = 'procesos';
  state.started_at = new Date().toISOString(); shouldStop = false;
  state.procesados = 0; state.errores = 0;

  const deptoUpper = departamento ? departamento.toUpperCase() : null;
  const where = deptoUpper
    ? `precio_base > 50000000 AND upper(departamento_entidad) like '%${deptoUpper}%'`
    : `precio_base > 50000000`;

  let currentOffset = offset;
  try {
    while (!shouldStop) {
      const url = secopUrl(EP_PROCESOS, {
        $offset: String(currentOffset),
        $where: where,
        $order: 'fecha_de_publicacion_del DESC',
      });
      console.log(`[VEEDOR] GET procesos offset=${currentOffset}`);
      const rows = await httpGet(url);
      console.log(`[VEEDOR] ${rows.length} procesos recibidos (offset ${currentOffset})`);
      if (!rows.length) break;

      for (const raw of rows) {
        if (shouldStop) break;
        const p = normalizarProceso(raw);
        if (!p.id) { state.errores++; continue; }

        const { error } = await supabase.from('secop_procesos').upsert(p, { onConflict: 'id' });
        if (error) { console.error('[VEEDOR] upsert error:', error.message); state.errores++; continue; }

        state.procesados++;
        state.ultimo = p.id;
      }

      if (rows.length < BATCH) break; // última página
      currentOffset += BATCH;
    }
    console.log(`[VEEDOR] Fase 1 completa: ${state.procesados} procesos guardados`);
  } catch (err) {
    console.error('[VEEDOR] Error fase procesos:', err.message);
  } finally {
    state.running = false; state.fase = 'idle';
  }
}

// ── FASE 2: Ingesta de contratos + grafo (loop paginado) ─────────────────────
async function ingestarContratos({ offset = 0, departamento = null } = {}) {
  state.running = true; state.fase = 'contratos'; state.pipeline_fase = 'contratos';
  state.contratos = 0; state.relaciones = 0;

  const deptoUpper = departamento ? departamento.toUpperCase() : null;
  // jbjy-vk9h usa "departamento" (no "departamento_entidad") y también "nit_entidad"
  // Intentamos ambos campos con OR para cubrir variantes del dataset
  // Solo contratos en ejecución — son los que el veedor puede actuar sobre ellos.
  // El histórico (terminados/liquidados) no aporta al radar de alertas activas.
  const baseWhere = `estado_contrato = 'En ejecuci\u00f3n'`;
  const contratoWhere = deptoUpper
    ? `${baseWhere} AND (upper(departamento_entidad) like '%${deptoUpper}%' OR upper(departamento) like '%${deptoUpper}%')`
    : baseWhere;

  let currentOffset = offset;
  try {
    while (!shouldStop) {
      const params = {
        $offset: String(currentOffset),
        // La columna es `fecha_de_firma` — `fecha_de_firma_del_contrato` no existe en
        // el dataset jbjy-vk9h y hacía que Socrata devolviera un error, no filas.
        $order: 'fecha_de_firma DESC',
      };
      if (contratoWhere) params.$where = contratoWhere;

      const url = secopUrl(EP_CONTRATOS, params);
      console.log(`[VEEDOR] GET contratos offset=${currentOffset}`);
      const rows = await httpGet(url);
      console.log(`[VEEDOR] ${rows.length} contratos recibidos (offset ${currentOffset})`);
      if (!rows.length) break;

      for (const raw of rows) {
        if (shouldStop) break;
        const c = normalizarContrato(raw);
        if (!c.id) continue;

        await supabase.from('secop_contratos').upsert(c, { onConflict: 'id' });
        state.contratos++;

        if (c.nit_contratista && c.contratista) {
          await supabase.from('secop_contratistas').upsert({
            nit: c.nit_contratista, razon_social: c.contratista,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'nit' });
        }

        if (c.nit_entidad && c.nit_contratista) {
          const { error } = await supabase.from('secop_relaciones').upsert({
            tipo: 'ADJUDICÓ',
            nodo_origen_tipo: 'entidad',   nodo_origen_id: c.nit_entidad,
            nodo_destino_tipo: 'contratista', nodo_destino_id: c.nit_contratista,
            peso: c.valor_contrato || 1,
            metadata: { id_contrato: c.id, valor: c.valor_contrato, fecha: c.fecha_firma, objeto: c.objeto?.slice(0, 200) },
          }, { onConflict: 'tipo,nodo_origen_tipo,nodo_origen_id,nodo_destino_tipo,nodo_destino_id' });
          if (!error) state.relaciones++;
        }
      }

      if (rows.length < BATCH) break; // última página
      currentOffset += BATCH;
    }
    console.log(`[VEEDOR] Fase 2 completa: ${state.contratos} contratos, ${state.relaciones} relaciones`);
  } catch (err) {
    console.error('[VEEDOR] Error fase contratos:', err.message);
  } finally {
    state.running = false; state.fase = 'idle';
  }
}

// ── FASE 3: Descarga de pliegos (analizador-pliegos.mjs) ─────────────────────
async function descargarPliegos({ limite = 50 } = {}) {
  state.running = true; state.fase = 'pliegos'; state.pipeline_fase = 'pliegos';
  state.pliegos_ok = 0; state.pliegos_err = 0;

  // Encolar procesos con id_portafolio (la llave hacia los PDFs en datos
  // abiertos). url_proceso ya no se usa para descargar — solo queda informativo.
  try {
    const { data: procesos } = await supabase
      .from('secop_procesos')
      .select('id, id_portafolio, url_proceso')
      .not('id_portafolio', 'is', null)
      .gte('valor_proceso', 50_000_000)
      .limit(500);

    let encolados = 0;
    for (const p of (procesos || [])) {
      const { error } = await supabase.from('secop_cola_descarga')
        .upsert({ id_proceso: p.id, url: p.url_proceso, tipo_doc: 'pliego', estado: 'pending' },
                 { onConflict: 'id_proceso,tipo_doc', ignoreDuplicates: true });
      if (!error) encolados++;
    }
    console.log(`[VEEDOR] ${encolados} procesos encolados para descarga de pliego`);

    const procesados = await procesarCola({ limite });
    state.pliegos_ok = procesados;
    console.log(`[VEEDOR] Fase 3 completa: ${procesados} pliegos procesados`);
  } catch (err) {
    console.error('[VEEDOR] Error fase pliegos:', err.message);
  } finally {
    state.running = false; state.fase = 'idle';
  }
}

// ── FASE 4: Generar alertas con contexto completo ────────────────────────────
async function scorear() {
  state.running = true; state.fase = 'scorear'; state.pipeline_fase = 'scorear';
  state.alertas = 0;

  try {
    // Procesar en lotes de 100
    let offset = 0;
    const lote = 100;

    while (!shouldStop) {
      const { data: procesos } = await supabase
        .from('secop_procesos')
        .select('*')
        .range(offset, offset + lote - 1)
        .order('valor_proceso', { ascending: false });

      if (!procesos || procesos.length === 0) break;

      for (const p of procesos) {
        if (shouldStop) break;

        // Historial de contratos de la entidad (12 meses)
        let historial = [];
        if (p.nit_entidad) {
          const hace1anio = new Date(Date.now() - 365 * 86_400_000).toISOString();
          const { data } = await supabase.from('secop_contratos')
            .select('nit_contratista').eq('nit_entidad', p.nit_entidad).gte('fecha_firma', hace1anio);
          historial = data || [];
        }

        // Precio de referencia UNSPSC
        const precioRef = await getPrecioReferencia(p.codigo_unspsc);

        // Alertas ya detectadas del pliego (PDF)
        const { data: alertasPdfRows } = await supabase
          .from('secop_alertas')
          .select('*')
          .eq('id_proceso', p.id)
          .not('evidencia->fuente', 'is', null);
        const alertasPdf = (alertasPdfRows || []).filter(a => a.evidencia?.fuente === 'pliego_pdf');

        // Generar alertas combinadas
        const alertas = detectarAlertas(p, historial, precioRef, alertasPdf);
        const score   = alertas.reduce((s, a) => s + a.score_contribucion, 0);

        // Reemplazar alertas no-PDF (las de metadata se regeneran; las de PDF se conservan)
        await supabase.from('secop_alertas').delete()
          .eq('id_proceso', p.id)
          .or('evidencia->fuente.is.null,evidencia->fuente.neq.pliego_pdf');

        if (alertas.length > 0) {
          const alertasNuevas = alertas.filter(a => a.evidencia?.fuente !== 'pliego_pdf');
          if (alertasNuevas.length > 0) {
            await supabase.from('secop_alertas').insert(
              alertasNuevas.map(a => ({ ...a, id_proceso: p.id }))
            );
          }
          await supabase.from('secop_procesos')
            .update({ score_riesgo: score, alertas_count: alertas.length, procesado_at: new Date().toISOString() })
            .eq('id', p.id);
          state.alertas += alertasNuevas.length;
        } else {
          await supabase.from('secop_procesos')
            .update({ score_riesgo: 0, alertas_count: alertasPdf.length, procesado_at: new Date().toISOString() })
            .eq('id', p.id);
        }

        state.ultimo = p.id;
      }

      offset += lote;
      if (procesos.length < lote) break;
    }
    console.log(`[VEEDOR] Fase 4 completa: ${state.alertas} alertas generadas`);
  } catch (err) {
    console.error('[VEEDOR] Error fase scorear:', err.message);
  } finally {
    state.running = false; state.fase = 'idle';
  }
}

// ── Pipeline completo (fases 1→2→3→4) ───────────────────────────────────────
async function pipeline({ offset = 0, limite_pliegos = 50, departamento = null } = {}) {
  const depto = departamento || null;
  console.log(`[VEEDOR] ▶ Pipeline iniciado${depto ? ` — departamento: ${depto}` : ''}`);
  await ingestar({ offset, departamento: depto });
  if (shouldStop) { console.log('[VEEDOR] Pipeline detenido en fase 1'); return; }
  await ingestarContratos({ offset, departamento: depto });
  if (shouldStop) { console.log('[VEEDOR] Pipeline detenido en fase 2'); return; }
  await descargarPliegos({ limite: limite_pliegos });
  if (shouldStop) { console.log('[VEEDOR] Pipeline detenido en fase 3'); return; }
  await scorear();
  console.log('[VEEDOR] ✅ Pipeline completo');
}

// ── Membrete (letterhead config, persisted locally) ───────────────────────────
const MEMBRETE_FILE = join(__dirname, 'membrete.json');
function getMembrete() {
  if (existsSync(MEMBRETE_FILE)) {
    try { return JSON.parse(readFileSync(MEMBRETE_FILE, 'utf8')); } catch {}
  }
  return { nombre_org: '', ciudad: '', telefono: '', email_remitente: '', nombre_firmante: '', cargo_firmante: '', logo_base64: null, firma_base64: null };
}

function buildEmailHtml(membrete, denunciaHtml) {
  const logo = membrete.logo_base64
    ? `<img src="${membrete.logo_base64}" style="max-height:80px;max-width:160px;object-fit:contain;" />`
    : '';
  const firma = membrete.firma_base64
    ? `<img src="${membrete.firma_base64}" style="max-height:70px;max-width:200px;display:block;margin-bottom:8px;" />`
    : '';
  const fecha = new Date().toLocaleDateString('es-CO', { year: 'numeric', month: 'long', day: 'numeric' });
  // Strip html/body wrappers if present in the denuncia
  const body = denunciaHtml
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<html[^>]*>/gi, '').replace(/<\/html>/gi, '')
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<body[^>]*>/gi, '').replace(/<\/body>/gi, '')
    .trim();
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"></head>
<body style="font-family:Georgia,'Times New Roman',serif;max-width:800px;margin:0 auto;padding:40px 60px;color:#111;font-size:12pt;line-height:1.7;">
  <div style="border-bottom:2px solid #0F3D2E;padding-bottom:20px;margin-bottom:30px;display:flex;align-items:flex-start;gap:20px;">
    ${logo}
    <div style="flex:1;">
      <div style="font-size:18px;font-weight:800;color:#0F3D2E;">${membrete.nombre_org || 'Veeduría Ciudadana'}</div>
      <div style="font-size:12px;color:#5A6472;margin-top:4px;">${[membrete.ciudad, membrete.telefono].filter(Boolean).join(' · ')}</div>
    </div>
    <div style="font-size:12px;color:#5A6472;text-align:right;">${fecha}</div>
  </div>
  ${body}
  <div style="margin-top:60px;padding-top:24px;border-top:1px solid #ccc;">
    ${firma}
    <div style="font-weight:700;font-size:13pt;">${membrete.nombre_firmante || ''}</div>
    <div style="font-size:11pt;color:#5A6472;">${membrete.cargo_firmante || ''}</div>
  </div>
</body></html>`;
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '10mb' }));  // base64 images pueden ser grandes
app.use(express.static(join(__dirname, 'public')));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Auth: en prod valida el JWT de sesión de NUMA + que sea super_admin (una sola
// llamada a la RPC is_super_admin). Retrocompat: el VEEDOR_SECRET sigue sirviendo
// para dev local (túnel SSH), pero ya NO viaja en el bundle de producción.
async function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  if (SECRET && token === SECRET) return next();               // dev local (túnel)

  // Intento 0: API Key externa — formato sk_veedor_*
  if (token.startsWith('sk_veedor_') && CATON_URL && CATON_ANON) {
    try {
      const keyHash = crypto.createHash('sha256').update(token).digest('hex');
      const r = await fetch(`${CATON_URL}/rest/v1/rpc/verificar_api_key`, {
        method: 'POST',
        headers: { apikey: CATON_ANON, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_key_hash: keyHash }),
      });
      if (r.ok) {
        const ok = await r.json();
        if (ok === true) { req.isApiKey = true; return next(); }
        if (ok === false) return res.status(429).json({ error: 'Límite mensual de peticiones alcanzado' });
      }
    } catch { /* sigue a JWT */ }
  }

  // Intento 1: JWT de CATÓN — is_caton_admin (admin o coordinador de veeduría)
  if (CATON_URL && CATON_ANON) {
    try {
      const r = await fetch(`${CATON_URL}/rest/v1/rpc/is_caton_admin`, {
        method: 'POST',
        headers: { apikey: CATON_ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (r.ok) {
        const esAdmin = await r.json();
        if (esAdmin === true) return next();
      }
    } catch { /* sigue al siguiente intento */ }
  }

  // Intento 2: JWT de NUMA — is_super_admin (acceso de operaciones internas)
  if (NUMA_URL && NUMA_ANON) {
    try {
      const r = await fetch(`${NUMA_URL}/rest/v1/rpc/is_super_admin`, {
        method: 'POST',
        headers: { apikey: NUMA_ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (r.ok) {
        const esAdmin = await r.json();
        if (esAdmin === true) return next();
      }
    } catch { /* sigue */ }
  }

  // Si ninguno pasó, verificar si el usuario de CATÓN tiene membresía activa (no solo admin)
  if (CATON_URL && CATON_ANON) {
    try {
      const r = await fetch(`${CATON_URL}/auth/v1/user`, {
        headers: { apikey: CATON_ANON, Authorization: `Bearer ${token}` },
      });
      if (r.ok) {
        const u = await r.json();
        if (u?.id) return next();  // cualquier usuario autenticado de CATÓN
      }
    } catch { /* sigue */ }
  }

  return res.status(401).json({ error: 'Unauthorized' });
}

// ── Endpoints ─────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.get('/status', auth, (_req, res) => res.json({ ...state, ts: new Date().toISOString() }));

app.post('/pipeline', auth, (req, res) => {
  if (state.running) return res.json({ ok: false, msg: 'Ya está corriendo' });
  const { offset = 0, limite_pliegos = 50, departamento = null } = req.body || {};
  const msg = departamento
    ? `Pipeline iniciado para departamento: ${departamento}`
    : 'Pipeline iniciado: procesos → contratos → pliegos → alertas';
  res.json({ ok: true, msg });
  pipeline({ offset, limite_pliegos, departamento }).catch(console.error);
});

app.post('/ingestar', auth, (req, res) => {
  if (state.running) return res.json({ ok: false, msg: 'Ya está corriendo' });
  const { offset = 0, departamento = null } = req.body || {};
  res.json({ ok: true, msg: `Fase 1: ingesta de procesos offset=${offset}${departamento ? ` (depto: ${departamento})` : ''}` });
  ingestar({ offset, departamento }).catch(console.error);
});

app.post('/contratos', auth, (req, res) => {
  if (state.running) return res.json({ ok: false, msg: 'Ya está corriendo' });
  const { offset = 0, departamento = null } = req.body || {};
  res.json({ ok: true, msg: `Fase 2: ingesta de contratos offset=${offset}${departamento ? ` (depto: ${departamento})` : ''}` });
  ingestarContratos({ offset, departamento }).catch(console.error);
});

app.post('/pliegos', auth, (req, res) => {
  if (state.running) return res.json({ ok: false, msg: 'Ya está corriendo' });
  const { limite = 50 } = req.body || {};
  res.json({ ok: true, msg: `Fase 3: descarga de pliegos (limite=${limite})` });
  descargarPliegos({ limite }).catch(console.error);
});

app.post('/scorear', auth, (req, res) => {
  if (state.running) return res.json({ ok: false, msg: 'Ya está corriendo' });
  res.json({ ok: true, msg: 'Fase 4: generando alertas con contexto completo' });
  scorear().catch(console.error);
});

app.post('/stop', auth, (_req, res) => {
  shouldStop = true;
  res.json({ ok: true, msg: 'Señal de parada enviada' });
});

// ── Endpoints de datos ────────────────────────────────────────────────────────
app.get('/data/stats', auth, async (_req, res) => {
  const { data, error } = await supabase.rpc('veedor_stats');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/data/procesos', auth, async (req, res) => {
  const limit    = Math.min(Number(req.query.limit)  || 50, 200);
  const offset   = Number(req.query.offset) || 0;
  const minScore = Number(req.query.min_score) || 1;
  const entidad  = req.query.entidad?.trim() || null;

  let q = supabase
    .from('secop_procesos')
    .select('id,entidad,departamento,modalidad,fase,estado,valor_proceso,score_riesgo,alertas_count,fecha_publicacion,url_proceso,descripcion,codigo_unspsc,raw')
    .gte('score_riesgo', minScore)
    .order('score_riesgo', { ascending: false })
    .range(offset, offset + limit - 1);

  if (entidad) q = q.ilike('entidad', `%${entidad}%`);

  const { data, error } = await q;

  if (error) return res.status(500).json({ error: error.message });

  const enriched = (data || []).map(p => {
    const raw = p.raw || {};
    return {
      id: p.id, entidad: p.entidad, departamento: p.departamento,
      modalidad: p.modalidad, fase: p.fase,
      estado: p.estado || raw.estado_del_procedimiento,
      descripcion: p.descripcion || raw.descripci_n_del_procedimiento || raw.nombre_del_procedimiento,
      valor_proceso: p.valor_proceso, score_riesgo: p.score_riesgo,
      alertas_count: p.alertas_count, fecha_publicacion: p.fecha_publicacion,
      url_proceso: p.url_proceso, codigo_unspsc: p.codigo_unspsc,
      contratista: raw.nombre_del_proveedor || raw.proveedor_adjudicado || null,
      nit_contratista: raw.nit_del_proveedor_adjudicado || null,
      tipo_contrato: raw.tipo_de_contrato || null,
      valor_adjudicado: raw.valor_total_adjudicacion ? parseFloat(raw.valor_total_adjudicacion) : null,
    };
  });

  res.json(enriched);
});

app.get('/data/proceso/:idProceso', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('secop_procesos').select('*').eq('id', req.params.idProceso).single();
  if (error || !data) return res.status(404).json({ error: 'Proceso no encontrado' });

  const raw = data.raw || {};
  const { data: pliegos } = await supabase
    .from('secop_cola_descarga')
    .select('url, tipo_doc, estado, created_at')
    .eq('id_proceso', data.id);

  res.json({
    id: data.id, entidad: data.entidad, nit_entidad: data.nit_entidad,
    departamento: data.departamento, ciudad: raw.municipio || raw.ciudad || null,
    modalidad: data.modalidad, fase: data.fase,
    estado: data.estado || raw.estado_del_procedimiento,
    descripcion: data.descripcion || raw.descripci_n_del_procedimiento,
    objeto_contratar: raw.objeto_a_contratar || raw.descripci_n_del_procedimiento,
    tipo_contrato: raw.tipo_de_contrato,
    valor_proceso: data.valor_proceso,
    valor_adjudicado: raw.valor_total_adjudicacion ? parseFloat(raw.valor_total_adjudicacion) : null,
    codigo_unspsc: data.codigo_unspsc,
    descripcion_unspsc: raw.descripcion_del_proceso_de_compra || null,
    fecha_publicacion: data.fecha_publicacion,
    fecha_limite_oferta: raw.fecha_de_presentacion_de_ofertas || null,
    fecha_adjudicacion: raw.fecha_de_adjudicacion || null,
    fecha_inicio: raw.fecha_de_inicio_del_contrato || null,
    fecha_fin: raw.fecha_de_fin_del_contrato || null,
    duracion_contrato: raw.duraci_n_del_contrato || null,
    contratista: raw.nombre_del_proveedor || raw.proveedor_adjudicado || null,
    nit_contratista: raw.nit_del_proveedor_adjudicado || null,
    num_oferentes: raw.numero_de_oferentes ? Number(raw.numero_de_oferentes) : null,
    justificacion_modalidad: raw.justificacion_modalidad || raw.justificaci_n_modalidad_de_selecci_n || null,
    url_proceso: data.url_proceso,
    score_riesgo: data.score_riesgo,
    alertas_count: data.alertas_count,
    pliegos: pliegos || [],
  });
});

app.get('/data/alertas/:idProceso', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('secop_alertas').select('*').eq('id_proceso', req.params.idProceso)
    .order('score_contribucion', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/data/grafo/:nit', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('secop_relaciones').select('*')
    .or(`nodo_origen_id.eq.${req.params.nit},nodo_destino_id.eq.${req.params.nit}`)
    .limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/re-analizar/:idProceso', auth, async (req, res) => {
  const { idProceso } = req.params;
  const { data: proc, error } = await supabase
    .from('secop_procesos').select('*').eq('id', idProceso).single();
  if (error || !proc) return res.status(404).json({ error: 'Proceso no encontrado' });
  try {
    let historial = [];
    if (proc.nit_entidad) {
      const hace1anio = new Date(Date.now() - 365 * 86_400_000).toISOString();
      const { data } = await supabase.from('secop_contratos')
        .select('nit_contratista').eq('nit_entidad', proc.nit_entidad).gte('fecha_firma', hace1anio);
      historial = data || [];
    }
    const precioRef = await getPrecioReferencia(proc.codigo_unspsc);
    const { data: alertasPdfRows } = await supabase.from('secop_alertas').select('*').eq('id_proceso', idProceso);
    const alertasPdf = (alertasPdfRows || []).filter(a => a.evidencia?.fuente === 'pliego_pdf');
    const alertas = detectarAlertas(proc, historial, precioRef, alertasPdf);
    const score = alertas.reduce((s, a) => s + a.score_contribucion, 0);
    await supabase.from('secop_alertas').delete().eq('id_proceso', idProceso)
      .or('evidencia->fuente.is.null,evidencia->fuente.neq.pliego_pdf');
    const alertasNuevas = alertas.filter(a => a.evidencia?.fuente !== 'pliego_pdf');
    if (alertasNuevas.length > 0) {
      await supabase.from('secop_alertas').insert(alertasNuevas.map(a => ({ ...a, id_proceso: idProceso })));
    }
    await supabase.from('secop_procesos')
      .update({ score_riesgo: score, alertas_count: alertas.length, procesado_at: new Date().toISOString() })
      .eq('id', idProceso);
    res.json({ ok: true, alertas_count: alertas.length, score_riesgo: score });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Debug ─────────────────────────────────────────────────────────────────────
app.get('/debug/prueba', auth, async (_req, res) => {
  try {
    const url = secopUrl(EP_PROCESOS, { $offset: '0', $where: 'precio_base > 50000000', $order: 'fecha_de_publicacion_del DESC', $limit: '2' });
    const rows = await httpGet(url);
    if (!Array.isArray(rows)) return res.json({ error: 'API no devolvió array', raw: rows });
    const p = normalizarProceso(rows[0]);
    const { error: upsertErr } = await supabase.from('secop_procesos').upsert(p, { onConflict: 'id' });
    res.json({ filas_api: rows.length, proceso_normalizado: p, upsert_error: upsertErr?.message ?? null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Membrete endpoints ────────────────────────────────────────────────────────
app.get('/veeduria/membrete', auth, (_req, res) => {
  res.json(getMembrete());
});

app.post('/veeduria/membrete', auth, (req, res) => {
  try {
    writeFileSync(MEMBRETE_FILE, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Update actuacion (save denuncia edits) ────────────────────────────────────
app.put('/veeduria/actuacion/:id', auth, async (req, res) => {
  const { contenido_html } = req.body;
  if (!contenido_html) return res.status(400).json({ error: 'contenido_html requerido' });
  const { error } = await supabase.from('veeduria_actuaciones')
    .update({ contenido_html, estado: 'revisado' })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Send denuncia by email ────────────────────────────────────────────────────
app.post('/veeduria/expediente/:id/enviar-denuncia', auth, async (req, res) => {
  const { destinatario, asunto, actuacion_id } = req.body;
  if (!destinatario || !actuacion_id) return res.status(400).json({ error: 'destinatario y actuacion_id requeridos' });

  try {
    const { data: actuacion, error: e1 } = await supabase.from('veeduria_actuaciones')
      .select('contenido_html').eq('id', actuacion_id).single();
    if (e1 || !actuacion) return res.status(404).json({ error: 'Actuación no encontrada' });

    const membrete = getMembrete();
    const htmlEmail = buildEmailHtml(membrete, actuacion.contenido_html);

    const RESEND_KEY = process.env.RESEND_API_KEY;
    if (!RESEND_KEY) {
      return res.status(503).json({
        ok: false,
        error: 'RESEND_API_KEY no configurado en el .env del servidor.'
      });
    }

    const fromAddr = process.env.RESEND_FROM
      || (membrete.email_remitente ? `${membrete.nombre_org || 'Veeduría'} <${membrete.email_remitente}>` : 'Veeduría NUMA <veedor@numa.la>');

    const rRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: fromAddr,
        to: [destinatario],
        subject: asunto || 'Denuncia ciudadana por irregularidades en contratación pública',
        html: htmlEmail,
      }),
    });
    if (!rRes.ok) {
      const rErr = await rRes.text();
      throw new Error(`Resend: ${rErr.slice(0, 200)}`);
    }

    // Mark expediente as sent
    await supabase.from('veeduria_actuaciones')
      .update({ estado: 'enviada' }).eq('id', actuacion_id);
    await supabase.from('veeduria_expedientes')
      .update({ estado: 'denuncia_enviada', updated_at: new Date().toISOString() })
      .eq('id', req.params.id);

    console.log(`[VEEDOR] Denuncia enviada a ${destinatario} (exp ${req.params.id})`);
    res.json({ ok: true, mensaje: `Denuncia enviada a ${destinatario}` });
  } catch (e) {
    console.error('[VEEDOR] Error enviando denuncia:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Módulo de veeduría (buscar · grafo · auditar · denuncia) ─────────────────
// Aditivo: monta rutas nuevas bajo /veeduria sin tocar las existentes.
import('./endpoints-veeduria.mjs')
  .then(({ montarVeeduria }) => montarVeeduria(app, { auth, supabase }))
  .catch(e => console.warn('[VEEDOR] módulo de veeduría no montado:', e.message));

app.listen(PORT, () => {
  console.log(`[VEEDOR] Servidor en puerto ${PORT}`);
  console.log(`[VEEDOR] Pipeline: /pipeline | Fases: /ingestar /contratos /pliegos /scorear`);

  // ── IMAP Poller — solo si hay SMTP_ENC_KEY configurado ───────────────────
  if (process.env.SMTP_ENC_KEY) {
    import('./imap-poller.mjs')
      .then(({ iniciarImapPoller }) => iniciarImapPoller(supabase))
      .catch(e => console.warn('[VEEDOR] IMAP poller no iniciado:', e.message));
  } else {
    console.log('[VEEDOR] SMTP_ENC_KEY no configurado — IMAP poller desactivado');
  }
});
