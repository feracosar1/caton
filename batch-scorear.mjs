/**
 * BATCH SCOREADOR
 * Corre detectarAlertas() en todos los procesos sin score.
 * Encola los que lleguen a score >= 15 con la URL del portal.
 */

import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '.env') });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { realtime: { transport: ws } },
);

const MODALIDADES_DIRECTAS = new Set([
  'Contratación directa',
  'Contratación Directa (con ofertas)',
  'Contratación régimen especial',
  'Contratación régimen especial (con ofertas)',
]);

const OBJETOS_VAGOS = /servicios profesionales|apoyo a la gesti[oó]n|consultor[ií]a\s+individual|asistencia t[eé]cnica/i;

// ── Precio de referencia por UNSPSC ──────────────────────────────────────────
async function getPrecioReferencia(codigoUnspsc) {
  if (!codigoUnspsc) return null;
  try {
    const hace1anio = new Date(Date.now() - 365 * 86_400_000).toISOString();
    const { data } = await supabase
      .from('secop_contratos')
      .select('valor_contrato')
      .eq('codigo_unspsc', codigoUnspsc)
      .gte('fecha_firma', hace1anio)
      .gt('valor_contrato', 0)
      .limit(200);

    if (!data || data.length < 5) return null;

    const valores = data.map(c => Number(c.valor_contrato)).sort((a, b) => a - b);
    const med = valores[Math.floor(valores.length / 2)];
    return { mediana: med, muestra: valores.length };
  } catch {
    return null;
  }
}

function detectarAlertas(p, historialNit = [], precioRef = null) {
  const alertas = [];
  const raw = p.raw || {};
  const valor = p.valor_proceso || 0;
  const modalidad = p.modalidad || '';
  const justificacion = raw.justificaci_n_modalidad_de || '';
  const descripcion = p.descripcion || raw.nombre_del_procedimiento || raw.descripci_n_del_procedimiento || '';
  const unicosConOferta = Number(raw.proveedores_unicos_con) || 0;
  const respuestas = Number(raw.respuestas_al_procedimiento) || 0;

  // R1 — Precio inflado vs mediana histórica UNSPSC
  if (precioRef && valor > 0) {
    const factor = valor / precioRef.mediana;
    if (factor >= 2.5) {
      alertas.push({
        tipo_alerta: 'PRECIO_INFLADO',
        severidad: 'alta',
        descripcion: `Precio $${(valor/1e6).toFixed(0)}M es ${factor.toFixed(1)}× la mediana histórica ($${(precioRef.mediana/1e6).toFixed(0)}M) para esta categoría`,
        evidencia: { valor_proceso: valor, mediana_historica: precioRef.mediana, factor, muestra: precioRef.muestra },
        score_contribucion: 30,
      });
    } else if (factor >= 1.75) {
      alertas.push({
        tipo_alerta: 'PRECIO_ELEVADO',
        severidad: 'media',
        descripcion: `Precio $${(valor/1e6).toFixed(0)}M es ${factor.toFixed(1)}× la mediana histórica ($${(precioRef.mediana/1e6).toFixed(0)}M) para esta categoría`,
        evidencia: { valor_proceso: valor, mediana_historica: precioRef.mediana, factor, muestra: precioRef.muestra },
        score_contribucion: 15,
      });
    }
  }

  // R2 — Contratista recurrente (historial)
  const recurrentes = {};
  historialNit.forEach(c => { if (c.nit_contratista) recurrentes[c.nit_contratista] = (recurrentes[c.nit_contratista] || 0) + 1; });
  for (const [nit, count] of Object.entries(recurrentes)) {
    if (count >= 3) alertas.push({
      tipo_alerta: 'CONTRATISTA_RECURRENTE',
      severidad: 'media',
      descripcion: `NIT ${nit} tiene ${count} contratos con esta entidad en 12 meses`,
      evidencia: { nit_contratista: nit, contratos_count: count },
      score_contribucion: 15,
    });
  }

  // R3 — Licitación con proveedor único (competencia simulada)
  if (!MODALIDADES_DIRECTAS.has(modalidad) && unicosConOferta === 1 && respuestas === 1 && valor > 100_000_000) {
    alertas.push({
      tipo_alerta: 'PROVEEDOR_UNICO_LICITACION',
      severidad: 'alta',
      descripcion: `Solo 1 proveedor en ${modalidad} de $${(valor/1e6).toFixed(0)}M — posible competencia simulada`,
      evidencia: { valor, modalidad, proveedores_con_oferta: unicosConOferta },
      score_contribucion: 30,
    });
  }

  // R4 — Contratación directa + señales combinadas (NO la directa sola)
  if (MODALIDADES_DIRECTAS.has(modalidad) && valor > 500_000_000) {
    const esVago = OBJETOS_VAGOS.test(justificacion || descripcion);
    const hayRecurrente = Object.values(recurrentes).some(c => c >= 3);
    const esPrecioInflado = precioRef && (valor / precioRef.mediana) >= 2;
    const señales = [esVago, hayRecurrente, esPrecioInflado].filter(Boolean).length;

    if (señales >= 1) {
      alertas.push({
        tipo_alerta: 'CONTRATACION_DIRECTA_RIESGO',
        severidad: señales >= 2 ? 'alta' : 'media',
        descripcion: `Contratación directa por $${(valor/1e6).toFixed(0)}M con ${señales} señal(es): ${[esVago && 'objeto vago', hayRecurrente && 'contratista recurrente', esPrecioInflado && 'precio inflado'].filter(Boolean).join(', ')}`,
        evidencia: { valor, modalidad, objeto_vago: esVago, contratista_recurrente: hayRecurrente, precio_inflado: esPrecioInflado },
        score_contribucion: señales >= 2 ? 25 : 12,
      });
    }
  }

  // R5 — Objeto vago + valor alto en modalidad competitiva
  if (!MODALIDADES_DIRECTAS.has(modalidad) && OBJETOS_VAGOS.test(justificacion || descripcion) && valor > 200_000_000) {
    alertas.push({
      tipo_alerta: 'OBJETO_VAGO_VALOR_ALTO',
      severidad: 'media',
      descripcion: `Objeto genérico "${(justificacion || descripcion).slice(0, 80)}" con valor $${(valor/1e6).toFixed(0)}M`,
      evidencia: { valor, objeto: (justificacion || descripcion).slice(0, 300) },
      score_contribucion: 15,
    });
  }

  return alertas;
}

async function main() {
  const BATCH = 50;
  let totalEncolados = 0, totalAlertas = 0;

  // Resetear procesado_at para re-evaluar con nuevas reglas
  await supabase.from('secop_procesos').update({ procesado_at: null, score_riesgo: 0, alertas_count: 0 }).neq('id', '');
  console.log('[BATCH] Reseteando scores para re-evaluar con nuevas reglas...');

  while (true) {
    const { data: procesos, error } = await supabase
      .from('secop_procesos')
      .select('*')
      .is('procesado_at', null)
      .limit(BATCH);  // Siempre desde el principio — el filtro avanza naturalmente

    if (error) { console.error('Error leyendo procesos:', error.message); break; }
    if (!procesos?.length) { console.log('Todos los procesos procesados.'); break; }

    console.log(`[BATCH] Procesando ${procesos.length} procesos...`);

    for (const p of procesos) {
      // Obtener historial de contratos de la entidad (último año)
      let historial = [];
      if (p.nit_entidad) {
        const hace1año = new Date(Date.now() - 365 * 86400 * 1000).toISOString();
        const { data: contratos } = await supabase
          .from('secop_contratos')
          .select('nit_contratista')
          .eq('nit_entidad', p.nit_entidad)
          .gte('fecha_firma', hace1año)
          .limit(100);
        historial = contratos || [];
      }

      const precioRef = await getPrecioReferencia(p.codigo_unspsc);
      const alertas = detectarAlertas(p, historial, precioRef);
      const score = alertas.reduce((s, a) => s + a.score_contribucion, 0);

      if (alertas.length > 0) {
        await supabase.from('secop_alertas').upsert(
          alertas.map(a => ({ ...a, id_proceso: p.id })),
          { onConflict: 'id_proceso,tipo_alerta' },
        );
        totalAlertas += alertas.length;
      }

      await supabase.from('secop_procesos').update({
        score_riesgo: score,
        alertas_count: alertas.length,
        procesado_at: new Date().toISOString(),
      }).eq('id', p.id);

      // Encolar si score >= 15 y tiene URL de portal
      if (score >= 15 && p.url_proceso) {
        await supabase.from('secop_cola_descarga').upsert(
          { id_proceso: p.id, url: p.url_proceso, tipo_doc: 'pliego', estado: 'pending' },
          { onConflict: 'id_proceso,tipo_doc' },
        );
        totalEncolados++;
        console.log(`  [+] ${p.id} score=${score} → cola`);
      }
    }

    // No incrementar offset — el filtro procesado_at=null avanza solo
  }

  console.log(`\n✓ Total alertas generadas: ${totalAlertas}`);
  console.log(`✓ Procesos encolados para análisis de pliego: ${totalEncolados}`);
}

main().catch(e => { console.error(e); process.exit(1); });
