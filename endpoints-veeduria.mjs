/**
 * ENDPOINTS de veeduría — se montan sobre el Express del veedor-server.
 *
 * Aditivo: no toca ninguna ruta existente. En veedor-server.mjs, al final:
 *
 *   import { montarVeeduria } from './endpoints-veeduria.mjs';
 *   montarVeeduria(app, { auth, supabase });
 *
 * Expone el flujo completo para la UI: buscar → grafo → auditar → hallazgos →
 * denuncia. El humano decide en cada compuerta; el servidor nunca envía nada.
 */

import { buscarContratos, resumenBusqueda } from './busqueda.mjs';
import { scorearContrato } from './score-contrato.mjs';
import { contratistaRecurrente, repLegalMultiple, fraccionamiento, perfilContratista, barridoRed, barridoRedMultiple, detectarCarruseles, evolucionRed, carruselPorConcentracion } from './grafo-contratistas.mjs';
import { auditarContrato } from './pipeline.mjs';
import { analisisDeterminista } from './analisis-determinista.mjs';
import { crearRepo } from './repo-veeduria.mjs';
import { concentracionSupervisores, cruzamientoSupervisores } from './motor-supervisores.mjs';
import { objetosDuplicados, actasAntesDeRegistro } from './motor-similitud.mjs';
import { encrypt, obtenerSmtpOrg, sendViaSmtp, sendViaResend } from './smtp-utils.mjs';

/**
 * Busca contratos en la tabla local secop_contratos (ingesta previa).
 * Evita ir a Socrata en tiempo real y sortea el timeout de 26s de Netlify.
 * Filtra sobre columnas indexadas + raw JSONB para estado/tipo/modalidad/depto.
 */
async function resumenLocal(supabase, filtros = {}) {
  let q = supabase.from('secop_contratos')
    .select('id, valor_contrato, raw')
    .limit(20000);

  if (filtros.entidad)        q = q.ilike('entidad', `%${filtros.entidad}%`);
  if (filtros.nitEntidad)     q = q.eq('nit_entidad', filtros.nitEntidad);
  if (filtros.contratista)    q = q.ilike('contratista', `%${filtros.contratista}%`);
  if (filtros.objeto)         q = q.ilike('objeto', `%${filtros.objeto}%`);
  if (filtros.valorMin != null) q = q.gte('valor_contrato', Number(filtros.valorMin));
  if (filtros.desde)          q = q.gte('fecha_firma', filtros.desde);
  if (filtros.hasta)          q = q.lte('fecha_firma', filtros.hasta + 'T23:59:59');
  if (filtros.sinRuido)       q = q.gt('valor_contrato', 0);

  const { data, error } = await q;
  if (error) throw error;

  let rows = data || [];
  // Filtros post-query sobre raw (estado, tipo, soloEmpresas):
  if (filtros.estado && filtros.estado !== 'todos') {
    rows = rows.filter(c => (c.raw?.estado_contrato) === filtros.estado);
  } else if (!filtros.estado) {
    rows = rows.filter(c => (c.raw?.estado_contrato) === 'En ejecución');
  }
  if (filtros.soloEmpresas) rows = rows.filter(c => c.raw?.tipodocproveedor === 'NIT');
  if (filtros.sinServiciosPersonales) {
    rows = rows.filter(c => {
      const t = (c.raw?.tipo_de_contrato || '').toUpperCase();
      return !(t.startsWith('PRESTACI') && t.includes('SERVICIOS') && c.raw?.tipodocproveedor !== 'NIT');
    });
  }

  const valor_total = rows.reduce((s, c) => s + (Number(c.valor_contrato) || 0), 0);
  return { contratos: rows.length, valor_total };
}

async function buscarLocal(supabase, filtros = {}) {
  let q = supabase.from('secop_contratos')
    .select('id, id_proceso, entidad, nit_entidad, contratista, nit_contratista, valor_contrato, fecha_firma, objeto, raw')
    .order('fecha_firma', { ascending: false })
    .limit(Number(filtros.limite) || 100);

  if (filtros.entidad)        q = q.ilike('entidad', `%${filtros.entidad}%`);
  if (filtros.nitEntidad)     q = q.eq('nit_entidad', filtros.nitEntidad);
  if (filtros.contratista)    q = q.ilike('contratista', `%${filtros.contratista}%`);
  if (filtros.nitContratista) q = q.eq('nit_contratista', filtros.nitContratista);
  if (filtros.objeto)         q = q.ilike('objeto', `%${filtros.objeto}%`);
  if (filtros.valorMin != null) q = q.gte('valor_contrato', Number(filtros.valorMin));
  if (filtros.valorMax != null) q = q.lte('valor_contrato', Number(filtros.valorMax));
  if (filtros.desde)          q = q.gte('fecha_firma', filtros.desde);
  if (filtros.hasta)          q = q.lte('fecha_firma', filtros.hasta + 'T23:59:59');
  if (filtros.sinRuido)       q = q.gt('valor_contrato', 0);

  const { data, error } = await q;
  if (error) throw error;

  const out = (data || []).map(c => {
    const r = c.raw || {};
    const obj = {
      id_contrato:          c.id,
      referencia:           r.referencia_del_contrato || null,
      proceso:              c.id_proceso,
      entidad:              c.entidad,
      nit_entidad:          c.nit_entidad,
      contratista:          c.contratista,
      nit_contratista:      c.nit_contratista,
      representante_legal:  r.nombre_representante_legal || null,
      valor:                Number(c.valor_contrato) || 0,
      fecha_firma:          c.fecha_firma?.slice(0, 10),
      estado:               r.estado_contrato,
      tipo:                 r.tipo_de_contrato,
      modalidad:            r.modalidad_de_contratacion,
      objeto:               (c.objeto || '').slice(0, 180),
      departamento:         r.departamento,
      ciudad:               r.ciudad,
      orden:                r.orden,
      sector:               r.sector,
      tipo_doc:             r.tipodocproveedor,
      _auditar:             c.id,
      _grafo:               c.nit_contratista,
    };
    return { ...obj, ...scorearContrato(obj) };
  });

  // Filtros post-query sobre raw (no tienen columna propia):
  let res = out;
  if (filtros.estado && filtros.estado !== 'todos') {
    res = res.filter(c => c.estado === filtros.estado);
  } else if (!filtros.estado) {
    // Por defecto solo "En ejecución" — espejo de busqueda.mjs
    res = res.filter(c => c.estado === 'En ejecución');
  }
  if (filtros.tipo)       res = res.filter(c => c.tipo?.toUpperCase().includes(filtros.tipo.toUpperCase()));
  if (filtros.modalidad)  res = res.filter(c => c.modalidad?.toUpperCase().includes(filtros.modalidad.toUpperCase()));
  if (filtros.soloEmpresas) res = res.filter(c => c.tipo_doc === 'NIT');
  if (filtros.sinServiciosPersonales) res = res.filter(c => !(c.tipo?.toUpperCase().startsWith('PRESTACI') && c.tipo?.toUpperCase().includes('SERVICIOS') && c.tipo_doc !== 'NIT'));

  return res.sort((a, b) => b.score - a.score);
}

export function montarVeeduria(app, { auth, supabase }) {
  const repo = crearRepo(supabase);
  const ok  = (res, data) => res.json({ ok: true, ...data });
  const err = (res, e) => res.status(500).json({ ok: false, error: e.message });
  // Ámbito de competencia. DEMO: llega en el request (el súper admin elige "ver
  // como X"). En producción vendrá del cliente autenticado, NO del request.
  const parseAmbito = (req) => {
    const raw = req.query?.ambito ?? req.body?.ambito;
    if (!raw) return undefined;
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch { return undefined; }
  };

  // ── BÚSQUEDA (paso 3) ──
  // Siempre va a Socrata (datos.gov.co) — la búsqueda interactiva cubre TODO SECOP.
  // La tabla local secop_contratos es para el radar de patrones, no para búsquedas.
  app.get('/veeduria/buscar', auth, async (req, res) => {
    try {
      const contratos = await buscarContratos({ ...req.query, ambito: parseAmbito(req) });
      ok(res, { contratos, fuente: 'secop' });
    } catch (e) { err(res, e); }
  });
  app.get('/veeduria/resumen', auth, async (req, res) => {
    try {
      ok(res, await resumenBusqueda({ ...req.query, ambito: parseAmbito(req) }));
    } catch (e) { err(res, e); }
  });

  // ── GRAFO Y AMAÑO (paso 2) ──
  app.get('/veeduria/grafo/rep-multiple', auth, async (req, res) => {
    try {
      const timeoutMs = 22_000;
      const result = await Promise.race([
        repLegalMultiple(req.query),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${timeoutMs}ms`)), timeoutMs)),
      ]);
      ok(res, { senales: result });
    } catch (e) {
      const msg = e?.message ?? String(e);
      if (msg.includes('timeout') || msg.includes('Socrata timeout')) {
        ok(res, { senales: [], timeout: true, mensaje: 'Socrata tardó demasiado — intenta de nuevo en unos minutos' });
      } else {
        err(res, e);
      }
    }
  });
  app.get('/veeduria/grafo/recurrente', auth, async (req, res) => {
    try { ok(res, { senales: await contratistaRecurrente(req.query) }); }
    catch (e) { err(res, e); }
  });
  app.get('/veeduria/grafo/fraccionamiento', auth, async (req, res) => {
    try { ok(res, { senales: await fraccionamiento(req.query) }); }
    catch (e) { err(res, e); }
  });
  app.get('/veeduria/grafo/perfil/:nit', auth, async (req, res) => {
    try { ok(res, { perfil: await perfilContratista(req.params.nit, req.query) }); }
    catch (e) { err(res, e); }
  });

  // Barrido de red por sujeto vigilado: ?nit=<contratista> o ?repId=<cédula>.
  // Teje la red hacia afuera (empresas → representante → empresas hermanas →
  // entidades) y devuelve el grafo + las "manos comunes".
  app.get('/veeduria/grafo/barrido', auth, async (req, res) => {
    try {
      const { nit, repId, saltos, dias } = req.query;
      const semilla = nit ? { nit } : repId ? { repId } : null;
      if (!semilla) return err(res, new Error('barrido requiere nit o repId'));
      const opts = { ambito: parseAmbito(req) };
      if (saltos) opts.saltos = Number(saltos);
      if (dias)   opts.dias   = Number(dias);
      ok(res, { red: await barridoRed(semilla, opts) });
    } catch (e) { err(res, e); }
  });

  // Evolución temporal de una red (la vida del carrusel): ?nit= o ?repId=.
  app.get('/veeduria/grafo/evolucion', auth, async (req, res) => {
    try {
      const { nit, repId, dias } = req.query;
      const semilla = nit ? { nit } : repId ? { repId } : null;
      if (!semilla) return err(res, new Error('evolucion requiere nit o repId'));
      const opts = { ambito: parseAmbito(req) };
      if (dias) opts.dias = Number(dias);
      ok(res, { evolucion: await evolucionRed(semilla, opts) });
    } catch (e) { err(res, e); }
  });

  // Detección proactiva de carruseles: barre los sospechosos y los rankea por score.
  app.get('/veeduria/grafo/carruseles', auth, async (req, res) => {
    try {
      const opts = { ambito: parseAmbito(req) };
      if (req.query.topN)        opts.topN = Number(req.query.topN);
      if (req.query.dias)        opts.dias = Number(req.query.dias);
      if (req.query.minEmpresas) opts.minEmpresas = Number(req.query.minEmpresas);
      if (req.query.desde)       opts.desde = req.query.desde;
      if (req.query.hasta)       opts.hasta = req.query.hasta;
      if (req.query.nitEntidad)  opts.nitEntidad = req.query.nitEntidad;
      if (req.query.tipo)        opts.tipoContrato = req.query.tipo;
      if (req.query.entidad)     opts.entidad = req.query.entidad;
      // Timeout de 22s + catch de errores Socrata → resultado parcial en vez de 500/504.
      const TIMEOUT_MS = 22000;
      const safeDetect = detectarCarruseles(opts).catch(() => []);
      const timeout = new Promise(resolve => setTimeout(() => resolve([]), TIMEOUT_MS));
      const carruseles = await Promise.race([safeDetect, timeout]);
      ok(res, { carruseles });
    } catch (e) { err(res, e); }
  });

  // Análisis completo de un contratista: perfil + red + evolución en paralelo.
  // ?nit=<NIT>  — responde aunque alguna fuente falle (errores en campo errores[]).
  app.get('/veeduria/grafo/analisis-completo', auth, async (req, res) => {
    try {
      const { nit } = req.query;
      if (!nit) return err(res, new Error('analisis-completo requiere nit'));
      const ambito = parseAmbito(req);
      const [resPerfil, resRed, resEvol] = await Promise.allSettled([
        perfilContratista(nit, { ambito }),
        barridoRed({ nit }, { ambito }),
        evolucionRed({ nit }, { ambito }),
      ]);
      ok(res, {
        perfil:    resPerfil.status === 'fulfilled' ? resPerfil.value  : null,
        red:       resRed.status    === 'fulfilled' ? resRed.value     : null,
        evolucion: resEvol.status   === 'fulfilled' ? resEvol.value    : null,
        errores: [
          resPerfil.status === 'rejected' ? { fuente: 'perfil',    error: resPerfil.reason?.message } : null,
          resRed.status    === 'rejected' ? { fuente: 'red',       error: resRed.reason?.message }    : null,
          resEvol.status   === 'rejected' ? { fuente: 'evolucion', error: resEvol.reason?.message }   : null,
        ].filter(Boolean),
      });
    } catch (e) { err(res, e); }
  });

  // Barrido por VARIOS sujetos vigilados + cruces. Body: { semillas:[{nit|repId}], saltos?, dias? }
  app.post('/veeduria/grafo/barrido-multiple', auth, async (req, res) => {
    try {
      const { semillas, saltos, dias } = req.body ?? {};
      if (!Array.isArray(semillas) || !semillas.length) return err(res, new Error('semillas debe ser un arreglo no vacío'));
      const opts = { ambito: parseAmbito(req) };
      if (saltos) opts.saltos = Number(saltos);
      if (dias)   opts.dias   = Number(dias);
      ok(res, await barridoRedMultiple(semillas, opts));
    } catch (e) { err(res, e); }
  });

  // ── AUDITORÍA (pasos 1 + orquestador) ──
  // ⚑ El humano dispara esta acción eligiendo un contrato. Corre el pipeline
  //    completo y persiste el expediente hasta 'auditado'. NO envía nada.
  app.post('/veeduria/auditar/:idContrato', auth, async (req, res) => {
    try {
      const r = await auditarContrato(req.params.idContrato, { repo });
      // El veredicto determinista SIEMPRE viaja — auditar nunca vuelve vacío,
      // haya informe o no. Mejor esfuerzo: si falla, no tumba la respuesta.
      let analisis = null;
      try { analisis = await analisisDeterminista(req.params.idContrato); } catch (e) { console.error('[VEEDOR] analisis:', e.message); }
      ok(res, { expedienteId: r.expedienteId, estado: r.estado, hallazgos: r.hallazgos.length, analisis });
    } catch (e) { err(res, e); }
  });

  // ── EXPEDIENTES (lectura para la UI) ──
  app.get('/veeduria/expedientes', auth, async (req, res) => {
    try { ok(res, { expedientes: await repo.listarExpedientes(req.query) }); }
    catch (e) { err(res, e); }
  });
  // ── CRONOGRAMA (antes del :id genérico para evitar shadowing) ─────────────────

  // GET hitos del proceso (si ya fueron extraídos)
  app.get('/veeduria/expediente/cronograma/:idProceso', auth, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('veedor_cronograma')
        .select('*')
        .eq('id_proceso', req.params.idProceso)
        .order('fecha_inicio', { ascending: true, nullsLast: true });
      if (error) throw new Error(error.message);
      ok(res, { hitos: data ?? [] });
    } catch (e) { err(res, e); }
  });

  // POST extraer cronograma desde texto de pliego (dispara edge function async)
  // Body: { idProceso, textoPliegos, procesoDatos? }
  app.post('/veeduria/expediente/cronograma/extraer', auth, async (req, res) => {
    const { idProceso, textoPliegos, procesoDatos } = req.body;
    if (!idProceso || !textoPliegos) {
      return err(res, new Error('idProceso y textoPliegos requeridos'));
    }
    try {
      const { data, error } = await supabase.functions.invoke('veedor-extraer-cronograma', {
        body: { id_proceso: String(idProceso), texto_pliegos: textoPliegos, proceso_datos: procesoDatos ?? {} },
      });
      if (error) throw new Error(typeof error === 'object' ? (error.message ?? String(error)) : String(error));
      ok(res, data ?? { procesando: true });
    } catch (e) { err(res, e); }
  });

  // PATCH actualizar un hito (marcar como verificado, cambiar estado, agregar alerta)
  // Body: { estado?, verificado?, alerta_activa?, notas? }
  app.patch('/veeduria/expediente/cronograma/hito/:id', auth, async (req, res) => {
    const allowed = ['estado', 'verificado', 'alerta_activa', 'notas'];
    const updates = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    }
    if (!Object.keys(updates).length) {
      return err(res, new Error('Sin campos para actualizar'));
    }
    try {
      const { data, error } = await supabase
        .from('veedor_cronograma')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .select('*')
        .single();
      if (error) throw new Error(error.message);
      ok(res, { hito: data });
    } catch (e) { err(res, e); }
  });

  app.get('/veeduria/expediente/:id', auth, async (req, res) => {
    try {
      const data = await repo.obtenerExpediente(req.params.id);
      // Recalcula el veredicto determinista (barato) para que el detalle nunca
      // se vea vacío aunque el expediente no tenga hallazgos ni documentos.
      let analisis = null;
      try { if (data?.expediente?.id_contrato) analisis = await analisisDeterminista(data.expediente.id_contrato); }
      catch (e) { console.error('[VEEDOR] analisis:', e.message); }
      ok(res, { ...data, analisis });
    } catch (e) { err(res, e); }
  });

  // ── RADAR AUTOMÁTICO (nuevo) ──
  // Combina todos los motores en un solo barrido. Requiere nitEntidad o entidad.
  // Parámetros: nitEntidad?, entidad?, desde?, hasta?, dias?, tipo?
  // Responde en ~10-30s (7 consultas en paralelo).
  app.get('/veeduria/radar', auth, async (req, res) => {
    try {
      const opts = {
        nitEntidad:  req.query.nitEntidad,
        entidad:     req.query.entidad,
        desde:       req.query.desde,
        hasta:       req.query.hasta,
        dias:        req.query.dias ? Number(req.query.dias) : undefined,
        tipo:        req.query.tipo,
        ambito:      parseAmbito(req),
      };
      // Modo global: sin nitEntidad ni entidad, solo corre los motores que no necesitan filtro de entidad.
      const modoGlobal = !opts.nitEntidad && !opts.entidad;

      let resSuper, resCruz, resClones, resActas, resCarruseles, resRepMultiple, resFrac, resConc;

      // Cada motor tiene 18s de timeout — el endpoint responde en < 22s (dentro del proxy Netlify)
      const withTimeout = (p, ms = 18_000) =>
        Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms))]);

      if (modoGlobal) {
        // Modo global: 3 motores que no necesitan filtro de entidad
        //   · carruselPorConcentracion — detecta entidades que rotan contratos entre favoritos (HHI)
        //   · detectarCarruseles       — rep legal detrás de múltiples cáscaras (top 30)
        //   · repLegalMultiple         — señal individual por (rep, entidad)
        [resConc, resCarruseles, resRepMultiple] = await Promise.allSettled([
          withTimeout(carruselPorConcentracion({ ambito: opts.ambito, dias: opts.dias || 730, topN: 20 })),
          withTimeout(detectarCarruseles({ ambito: opts.ambito, dias: opts.dias, topN: 10 })),
          withTimeout(repLegalMultiple({ dias: opts.dias })),
        ]);
        resSuper = resCruz = resClones = resActas = resFrac = { status: 'fulfilled', value: [] };
      } else {
        // Modo entidad: 8 motores en paralelo. Si alguno falla, el radar sigue.
        [resSuper, resCruz, resClones, resActas, resCarruseles, resRepMultiple, resFrac, resConc] =
          await Promise.allSettled([
            withTimeout(concentracionSupervisores(opts)),
            withTimeout(cruzamientoSupervisores(opts)),
            withTimeout(objetosDuplicados(opts)),
            withTimeout(actasAntesDeRegistro(opts)),
            withTimeout(detectarCarruseles({ nitEntidad: opts.nitEntidad, entidad: opts.entidad, ambito: opts.ambito, dias: opts.dias })),
            withTimeout(repLegalMultiple({ nitEntidad: opts.nitEntidad, dias: opts.dias })),
            withTimeout(opts.nitEntidad
              ? fraccionamiento({ nitEntidad: opts.nitEntidad, dias: opts.dias })
              : Promise.resolve([])),
            withTimeout(carruselPorConcentracion({ nitEntidad: opts.nitEntidad, entidad: opts.entidad, ambito: opts.ambito, dias: opts.dias })),
          ]);
      }

      // Normalizamos hallazgos en un array unificado con fuente
      const hallazgos = [];
      const errores = [];

      const add = (res_, fuente) => {
        if (res_.status === 'fulfilled') {
          const data = res_.value;
          if (Array.isArray(data)) data.forEach(h => hallazgos.push({ ...h, fuente }));
          else if (data?.perfil_cruzado) {
            data.perfil_cruzado.forEach(h => hallazgos.push({ ...h, fuente: 'cruzamiento' }));
            data.pares_cruzados.forEach(h => hallazgos.push({ ...h, fuente: 'cruzamiento' }));
          }
        } else {
          errores.push({ fuente, error: res_.reason?.message });
        }
      };

      add(resConc,        'carrusel_concentracion');
      add(resSuper,       'supervisores_concentracion');
      add(resCruz,        'supervisores_cruzamiento');
      add(resClones,      'objetos_clonados');
      add(resActas,       'actas_irregulares');
      add(resCarruseles,  'carruseles');
      add(resRepMultiple, 'rep_legal_multiple');
      add(resFrac,        'fraccionamiento');

      // Ordenar por severidad: alto primero, luego por valor
      const orden = { alto: 0, medio: 1, bajo: 2 };
      hallazgos.sort((a, b) =>
        (orden[a.severidad] ?? 1) - (orden[b.severidad] ?? 1) ||
        ((b.valor_total ?? b.valor ?? 0) - (a.valor_total ?? a.valor ?? 0))
      );

      ok(res, {
        n_hallazgos: hallazgos.length,
        alto: hallazgos.filter(h => h.severidad === 'alto').length,
        medio: hallazgos.filter(h => h.severidad === 'medio').length,
        hallazgos,
        errores,
      });
    } catch (e) { err(res, e); }
  });

  // ── SUPERVISORES (motores individuales) ──
  app.get('/veeduria/supervisores/concentracion', auth, async (req, res) => {
    try {
      const opts = {
        nitEntidad: req.query.nitEntidad, entidad: req.query.entidad,
        desde: req.query.desde, hasta: req.query.hasta,
        dias: req.query.dias ? Number(req.query.dias) : undefined,
        minContratos: req.query.minContratos ? Number(req.query.minContratos) : undefined,
        ambito: parseAmbito(req),
      };
      ok(res, { supervisores: await concentracionSupervisores(opts) });
    } catch (e) { err(res, e); }
  });

  app.get('/veeduria/supervisores/cruzamiento', auth, async (req, res) => {
    try {
      const opts = {
        nitEntidad: req.query.nitEntidad, entidad: req.query.entidad,
        desde: req.query.desde, hasta: req.query.hasta,
        dias: req.query.dias ? Number(req.query.dias) : undefined,
        ambito: parseAmbito(req),
      };
      if (!opts.nitEntidad && !opts.entidad) return err(res, new Error('cruzamiento requiere nitEntidad o entidad'));
      ok(res, await cruzamientoSupervisores(opts));
    } catch (e) { err(res, e); }
  });

  // ── SIMILITUD / CLONES ──
  app.get('/veeduria/contratos/clones', auth, async (req, res) => {
    try {
      const opts = {
        nitEntidad: req.query.nitEntidad, entidad: req.query.entidad,
        desde: req.query.desde, hasta: req.query.hasta,
        dias: req.query.dias ? Number(req.query.dias) : undefined,
        tipo: req.query.tipo,
        umbralSimilitud: req.query.umbral ? Number(req.query.umbral) : undefined,
        ambito: parseAmbito(req),
      };
      if (!opts.nitEntidad && !opts.entidad) return err(res, new Error('clones requiere nitEntidad o entidad'));
      ok(res, { grupos: await objetosDuplicados(opts) });
    } catch (e) { err(res, e); }
  });

  app.get('/veeduria/contratos/actas-irregulares', auth, async (req, res) => {
    try {
      const opts = {
        nitEntidad: req.query.nitEntidad, entidad: req.query.entidad,
        desde: req.query.desde, hasta: req.query.hasta,
        dias: req.query.dias ? Number(req.query.dias) : undefined,
        ambito: parseAmbito(req),
      };
      if (!opts.nitEntidad && !opts.entidad) return err(res, new Error('actas-irregulares requiere nitEntidad o entidad'));
      ok(res, { hallazgos: await actasAntesDeRegistro(opts) });
    } catch (e) { err(res, e); }
  });

  // ── DENUNCIA (fase 4) ── ASÍNCRONA
  // ⚑ El humano la dispara; el redactor tarda 2-4 min (fundamentar + hasta 2
  //    intentos de Claude con validación de citas). No se bloquea el request:
  //    responde al toque, genera en background, guarda la actuación. La UI hace
  //    polling a GET /expediente/:id hasta que aparezca la denuncia. El envío es
  //    otra acción, aparte — esto solo deja el BORRADOR.
  app.post('/veeduria/expediente/:id/denuncia', auth, async (req, res) => {
    const id = req.params.id;
    try {
      const { hallazgos } = await repo.obtenerExpediente(id);
      if (!hallazgos.length) return err(res, new Error('El expediente no tiene hallazgos'));
    } catch (e) { return err(res, e); }

    ok(res, { procesando: true, mensaje: 'Generando denuncia. Consultá el expediente en 1-2 min.' });

    // Background — no bloquea el response ya enviado.
    (async () => {
      try {
        const { fundamentar, redactarDenuncia } = await import('./redactor.mjs');
        const { expediente, documentos, hallazgos } = await repo.obtenerExpediente(id);
        const { normas, sinCorpus } = await fundamentar(hallazgos);
        const r = await redactarDenuncia({ expediente, hallazgos, documentos, normas, sinCorpus });
        await repo.guardarActuacion(id, {
          tipo: 'denuncia', contenidoHtml: r.html,
          evaluacion: { citas: r.citas, sinCorpus, revisionHumana: r.revisionHumana ?? null },
        });
        await repo.actualizarEstado(id, 'denuncia_borrador');
        console.log(`[VEEDOR] denuncia lista exp ${id}: ${r.citas.total} citas · ${r.citas.sinRespaldo.length} sin respaldo · corpus=${!sinCorpus}`);
      } catch (e) { console.error(`[VEEDOR] error redactando denuncia exp ${id}:`, e.message); }
    })();
  });

  // ── PATCH denuncia — guardar ediciones del editor TipTap
  app.patch('/veeduria/expediente/:id/denuncia', auth, async (req, res) => {
    const id = req.params.id;
    const { contenido_html } = req.body;
    if (!contenido_html) return err(res, new Error('contenido_html requerido'));
    try {
      await repo.actualizarActuacion(id, 'denuncia', { contenidoHtml: contenido_html });
      ok(res, { ok: true });
    } catch (e) { err(res, e); }
  });

  // ── POST /enviar — envío formal con consecutivo + threading + 15 días hábiles
  // Body: { destinatario_email, destinatario_nombre, org_id, contenido_html? }
  // Usa SMTP propio de la org si está configurado, cae en Resend si no.
  app.post('/veeduria/expediente/:id/enviar', auth, async (req, res) => {
    const expedienteId = req.params.id;
    const { destinatario_email, destinatario_nombre, org_id, contenido_html, canal: canalForzado } = req.body;
    if (!destinatario_email || !org_id) {
      return err(res, new Error('destinatario_email y org_id requeridos'));
    }

    try {
      // 1. Obtener el expediente y la denuncia si no viene el HTML
      const detail = await repo.obtenerExpediente(expedienteId);
      const denuncia = detail.actuaciones?.find(a => a.tipo === 'denuncia');
      const htmlBody = contenido_html || denuncia?.contenido_html;
      if (!htmlBody) return err(res, new Error('Sin contenido de denuncia para enviar'));

      const exp = detail.expediente;

      // 2. Consecutivo desde Supabase RPC
      const { data: consRaw, error: consErr } = await supabase.rpc('next_veedor_consecutivo', {
        p_org_id: org_id,
      });
      if (consErr) throw new Error(`consecutivo: ${consErr.message}`);
      const consecutivo = consRaw;

      // 3. Message-ID único para threading
      const { randomUUID } = await import('crypto');
      const msgUuid = randomUUID();
      const messageId = `<${msgUuid}@veedor.numa.la>`;

      // 4. Pixel de apertura — insertamos en veedor_email_log
      const { data: logRow, error: logErr } = await supabase.from('veedor_email_log')
        .insert({
          org_id,
          expediente_id:       String(expedienteId),
          message_id:          messageId,
          tipo:                'derecho_peticion',
          canal:               canalForzado || null,
          destinatario_email,
          destinatario_nombre: destinatario_nombre || destinatario_email,
          consecutivo,
        })
        .select('pixel_id').single();
      if (logErr) throw new Error(`email_log: ${logErr.message}`);

      const CATON_SUPABASE_URL = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
      const pixelUrl = `${CATON_SUPABASE_URL}/functions/v1/veedor-email-pixel?id=${logRow.pixel_id}`;

      const subject = `[${consecutivo}] Derecho de Petición — ${exp.entidad || 'Entidad contratante'}`;

      const emailHtml = `
        ${htmlBody}
        <br><br>
        <p style="font-size:11px;color:#888">
          Este documento constituye un derecho de petición formal al amparo de la Ley 1755 de 2015.
          Ref: ${consecutivo} | ID contrato: ${exp.id_contrato || ''}
        </p>
        <img src="${pixelUrl}" width="1" height="1" style="display:none" alt="" />
      `;

      const toAddr = destinatario_nombre
        ? `${destinatario_nombre} <${destinatario_email}>`
        : destinatario_email;

      // 5. Canal de envío: SMTP propio o Resend.
      //    canalForzado = 'smtp' | 'resend' | undefined (undefined = auto SMTP-first).
      const smtpCfg = (canalForzado !== 'resend') ? await obtenerSmtpOrg(supabase, org_id) : null;
      let canal;
      if (smtpCfg && canalForzado !== 'resend') {
        await sendViaSmtp(smtpCfg, {
          to:        toAddr,
          subject,
          html:      emailHtml,
          messageId,
          replyTo:   smtpCfg.from_email || smtpCfg.smtp_user,
        });
        canal = 'smtp';
        console.log(`[VEEDOR] SMTP propio → ${destinatario_email} (${smtpCfg.smtp_host})`);
      } else {
        if (canalForzado === 'smtp' && !smtpCfg) {
          throw new Error('SMTP propio no configurado. Configúralo en Configuración → Envío o usa Resend.');
        }
        const fromAddr = process.env.RESEND_FROM || 'Veeduría Ciudadana <veedor@numa.la>';
        await sendViaResend({
          from:    fromAddr,
          to:      toAddr,
          subject,
          html:    emailHtml,
          messageId,
          replyTo: 'veedor@numa.la',
        });
        canal = 'resend';
        console.log(`[VEEDOR] Resend → ${destinatario_email}`);
      }

      // 6. Fecha de vencimiento (15 días hábiles)
      const hoy = new Date().toISOString().slice(0, 10);
      const { data: vencRaw, error: vencErr } = await supabase.rpc('fecha_vencimiento_habiles', {
        p_fecha_inicio: hoy,
        p_n_dias:       15,
      });
      if (vencErr) console.warn('[VEEDOR] fecha_vencimiento_habiles:', vencErr.message);
      const fechaVencimiento = vencRaw || null;

      // 7. Upsert veedor_requerimientos
      await supabase.from('veedor_requerimientos').upsert({
        id_proceso:          String(exp.id_contrato || expedienteId),
        org_id,
        consecutivo,
        tipo:                'derecho_peticion',
        estado:              'enviado',
        message_id_enviado:  messageId,
        fecha_envio:         new Date().toISOString(),
        fecha_vencimiento:   fechaVencimiento,
        destinatario_email,
        destinatario_nombre: destinatario_nombre || destinatario_email,
      }, { onConflict: 'id_proceso' }).select('id');

      // 8. Actualizar canal real en el log (ahora que sabemos cuál se usó)
      await supabase.from('veedor_email_log')
        .update({ canal })
        .eq('message_id', messageId);

      // 9. Actualizar estado del expediente
      await repo.actualizarEstado(expedienteId, 'denuncia_enviada');

      console.log(`[VEEDOR] Enviado ${consecutivo} → ${destinatario_email} (exp ${expedienteId}, canal: ${canal})`);
      ok(res, { consecutivo, message_id: messageId, fecha_vencimiento: fechaVencimiento, canal });

    } catch (e) {
      console.error('[VEEDOR] error enviar:', e.message);
      err(res, e);
    }
  });

  // ── GET requerimientos del expediente ────────────────────────────────────────
  app.get('/veeduria/expediente/:id/requerimientos', auth, async (req, res) => {
    try {
      const detail = await repo.obtenerExpediente(req.params.id);
      const id_proceso = String(detail.expediente?.id_contrato ?? req.params.id);
      const { data, error } = await supabase.from('veedor_requerimientos')
        .select('*').eq('id_proceso', id_proceso).order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      ok(res, { requerimientos: data ?? [] });
    } catch (e) { err(res, e); }
  });

  // ── GET notas internas ────────────────────────────────────────────────────
  app.get('/veeduria/expediente/:id/notas', auth, async (req, res) => {
    try {
      const { data, error } = await supabase.from('veedor_notas')
        .select('id,contenido,es_interna,created_at')
        .eq('expediente_id', String(req.params.id))
        .order('created_at', { ascending: true });
      if (error) throw new Error(error.message);
      ok(res, { notas: data ?? [] });
    } catch (e) { err(res, e); }
  });

  // ── POST nota interna ─────────────────────────────────────────────────────
  app.post('/veeduria/expediente/:id/nota', auth, async (req, res) => {
    const { contenido, es_interna = false, org_id } = req.body;
    if (!contenido) return err(res, new Error('contenido requerido'));
    try {
      const { data, error } = await supabase.from('veedor_notas')
        .insert({ expediente_id: String(req.params.id), org_id: org_id || null, contenido, es_interna })
        .select('id,contenido,es_interna,created_at').single();
      if (error) throw new Error(error.message);
      ok(res, { nota: data });
    } catch (e) { err(res, e); }
  });

  // ── POST tutela — genera borrador via edge function ───────────────────────
  app.post('/veeduria/expediente/:id/tutela', auth, async (req, res) => {
    try {
      // 1. Cargar expediente (entidad, hallazgos)
      const detail = await repo.obtenerExpediente(req.params.id);
      const { expediente, hallazgos } = detail;

      // 2. Buscar el DP enviado en CATÓN (consecutivo, fechas, destinatario)
      const { data: dpReqs } = await supabase.from('veedor_requerimientos')
        .select('consecutivo,fecha_envio,fecha_vencimiento,destinatario_nombre,destinatario_email')
        .eq('id_proceso', String(expediente.id_contrato ?? req.params.id))
        .eq('tipo', 'derecho_peticion')
        .order('created_at', { ascending: false })
        .limit(1);
      const dp = dpReqs?.[0] ?? null;

      // 3. Resumen de hallazgos (máx. 10 bullets)
      const hallazgosResumen = (hallazgos ?? [])
        .slice(0, 10)
        .map(h => `• ${h.evidencia_textual || h.detalle || 'Irregularidad detectada en auditoría'}`)
        .join('\n') || '• Se detectaron irregularidades en la ejecución del contrato';

      const { data, error } = await supabase.functions.invoke('veedor-generar-tutela', {
        body: {
          expediente_id:        String(req.params.id),
          entidad_accionada:    expediente.entidad || '',
          nit_entidad:          expediente.nit_entidad || '',
          contrato_ref:         expediente.referencia_contrato || expediente.id_contrato || '',
          consecutivo_dp:       dp?.consecutivo || '',
          fecha_envio_dp:       dp?.fecha_envio ? String(dp.fecha_envio).slice(0, 10) : '',
          fecha_vencimiento_dp: dp?.fecha_vencimiento ? String(dp.fecha_vencimiento).slice(0, 10) : '',
          destinatario_nombre:  dp?.destinatario_nombre || '',
          hallazgos_resumen:    hallazgosResumen,
        },
      });
      if (error) throw new Error(typeof error === 'object' ? (error.message ?? String(error)) : String(error));
      ok(res, data ?? { procesando: true });
    } catch (e) { err(res, e); }
  });

  // ── POST analizar-respuesta — analiza si la entidad respondió de fondo ─────
  app.post('/veeduria/expediente/:id/analizar-respuesta', auth, async (req, res) => {
    const { requerimiento_id } = req.body;
    if (!requerimiento_id) return err(res, new Error('requerimiento_id requerido'));
    try {
      const { data, error } = await supabase.functions.invoke('veedor-analizar-respuesta', {
        body: { requerimiento_id: String(requerimiento_id) },
      });
      if (error) throw new Error(typeof error === 'object' ? (error.message ?? String(error)) : String(error));
      if (data?.respondio_fondo) {
        await repo.actualizarEstado(req.params.id, 'respuesta_recibida');
      } else if (data?.respondio_fondo === false) {
        await repo.actualizarEstado(req.params.id, 'respuesta_evasiva');
      }
      ok(res, data ?? { ok: false });
    } catch (e) { err(res, e); }
  });

  // ── POST radicado-tutela — registrar número de radicado ──────────────────
  app.post('/veeduria/expediente/:id/radicado-tutela', auth, async (req, res) => {
    const { numero_radicado, juzgado, ciudad_radicado, id_proceso } = req.body;
    if (!numero_radicado || !juzgado) return err(res, new Error('numero_radicado y juzgado requeridos'));
    try {
      // Upsert el requerimiento de tutela
      const { error } = await supabase.from('veedor_requerimientos').upsert({
        id_proceso:       String(id_proceso || req.params.id),
        tipo:             'tutela',
        estado:           'radicada',
        numero_radicado,
        juzgado,
        ciudad_radicado:  ciudad_radicado || null,
        fecha_radicado:   new Date().toISOString(),
      }, { onConflict: 'id_proceso' });
      if (error) throw new Error(error.message);
      await repo.actualizarEstado(req.params.id, 'tutela_radicada');
      ok(res, { ok: true });
    } catch (e) { err(res, e); }
  });

  // ── POST fallo — analizar fallo de tutela con Claude ────────────────────────
  app.post('/veeduria/expediente/:id/fallo', auth, async (req, res) => {
    const { requerimiento_id, fallo_texto } = req.body;
    if (!fallo_texto) return err(res, new Error('fallo_texto requerido'));
    try {
      const { data, error } = await supabase.functions.invoke('veedor-analizar-fallo', {
        body: { requerimiento_id: String(requerimiento_id || ''), fallo_texto },
      });
      if (error) throw new Error(typeof error === 'object' ? (error.message ?? String(error)) : String(error));

      // Actualizar estado del expediente según resultado
      const resultado = data?.resultado;
      if (resultado) {
        const estadoMap = { favorable: 'fallo_favorable', desfavorable: 'fallo_desfavorable', parcial: 'fallo_parcial', inhibitorio: 'fallo_desfavorable' };
        const nuevoEstado = estadoMap[resultado] ?? 'fallo_parcial';
        await repo.actualizarEstado(req.params.id, nuevoEstado);
      }

      ok(res, data ?? { ok: false });
    } catch (e) { err(res, e); }
  });

  // ── POST cerrar — cerrar expediente (favorable o archivado) ─────────────────
  app.post('/veeduria/expediente/:id/cerrar', auth, async (req, res) => {
    const { estado = 'cerrado', notas: notaTexto } = req.body;
    try {
      await repo.actualizarEstado(req.params.id, estado);
      if (notaTexto) {
        await supabase.from('veedor_notas').insert({
          expediente_id: String(req.params.id), contenido: notaTexto, es_interna: true,
        });
      }
      ok(res, { ok: true });
    } catch (e) { err(res, e); }
  });

  // ── SMTP config — GET / POST para la org activa ───────────────────────────────
  // GET /veeduria/config/smtp?org_id=<uuid>
  // Devuelve la config sin la contraseña (smtp_pass_enc omitido).
  app.get('/veeduria/config/smtp', auth, async (req, res) => {
    const { org_id } = req.query;
    if (!org_id) return err(res, new Error('org_id requerido'));
    try {
      const { data, error } = await supabase
        .from('veedor_org_smtp')
        .select('org_id, smtp_host, smtp_port, smtp_user, smtp_secure, imap_host, imap_port, imap_secure, from_name, from_email, activo, last_imap_poll')
        .eq('org_id', org_id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      ok(res, { config: data ?? null });
    } catch (e) { err(res, e); }
  });

  // POST /veeduria/config/smtp
  // Body: { org_id, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure,
  //         imap_host, imap_port, imap_secure, from_name, from_email }
  // smtp_pass llega en texto plano → se cifra antes de guardar.
  app.post('/veeduria/config/smtp', auth, async (req, res) => {
    const {
      org_id, smtp_host, smtp_port, smtp_user, smtp_pass,
      smtp_secure, imap_host, imap_port, imap_secure, from_name, from_email,
    } = req.body;

    if (!org_id || !smtp_host || !smtp_user) {
      return err(res, new Error('org_id, smtp_host y smtp_user son requeridos'));
    }

    // Si smtp_pass está vacío, verificar que ya exista config (actualización sin cambio de clave).
    let smtp_pass_enc;
    if (smtp_pass) {
      try {
        smtp_pass_enc = encrypt(smtp_pass);
      } catch (e) {
        return err(res, new Error(`Error cifrando contraseña: ${e.message}. ¿Está configurado SMTP_ENC_KEY?`));
      }
    } else {
      // Recuperar la contraseña cifrada existente
      const { data: existing } = await supabase
        .from('veedor_org_smtp').select('smtp_pass_enc').eq('org_id', org_id).maybeSingle();
      if (!existing?.smtp_pass_enc) {
        return err(res, new Error('smtp_pass es requerido para crear la configuración'));
      }
      smtp_pass_enc = existing.smtp_pass_enc;
    }

    try {
      const { data, error } = await supabase
        .from('veedor_org_smtp')
        .upsert({
          org_id,
          smtp_host,
          smtp_port:   smtp_port ? Number(smtp_port) : 587,
          smtp_user,
          smtp_pass_enc,
          smtp_secure: !!smtp_secure,
          imap_host:   imap_host || null,
          imap_port:   imap_port ? Number(imap_port) : 993,
          imap_secure: imap_secure !== false,
          from_name:   from_name || null,
          from_email:  from_email || smtp_user,
          activo:      true,
        }, { onConflict: 'org_id' })
        .select('org_id, smtp_host, smtp_user, from_name, from_email, activo')
        .single();

      if (error) throw new Error(error.message);
      ok(res, { config: data });
    } catch (e) { err(res, e); }
  });

  // DELETE /veeduria/config/smtp?org_id=<uuid> — desactiva (soft delete)
  app.delete('/veeduria/config/smtp', auth, async (req, res) => {
    const { org_id } = req.query;
    if (!org_id) return err(res, new Error('org_id requerido'));
    try {
      const { error } = await supabase
        .from('veedor_org_smtp')
        .update({ activo: false })
        .eq('org_id', org_id);
      if (error) throw new Error(error.message);
      ok(res, { desactivado: true });
    } catch (e) { err(res, e); }
  });

  // ── POST /veeduria/contacto — lead desde landing o externo (SIN auth) ────────
  app.post('/veeduria/contacto', async (req, res) => {
    const { nombre, email, cargo, organizacion, tipo_org, telefono, mensaje, fuente = 'landing' } = req.body ?? {};
    if (!nombre || !email) return err(res, new Error('nombre y email son requeridos'));

    // Validación básica de email
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return err(res, new Error('email inválido'));
    }

    try {
      const { data, error } = await supabase
        .from('caton_leads')
        .insert({
          nombre:       String(nombre).slice(0, 120),
          email:        String(email).slice(0, 200).toLowerCase().trim(),
          cargo:        cargo  ? String(cargo).slice(0, 100)  : null,
          organizacion: organizacion ? String(organizacion).slice(0, 200) : null,
          tipo_org:     ['veeduria','contraloria','auditoria','ong','academia','otro'].includes(tipo_org) ? tipo_org : 'otro',
          telefono:     telefono ? String(telefono).slice(0, 30) : null,
          mensaje:      mensaje  ? String(mensaje).slice(0, 1000) : null,
          fuente:       ['landing','manual','referido','evento'].includes(fuente) ? fuente : 'landing',
          estado:       'nuevo',
        })
        .select('id, created_at')
        .single();

      if (error) throw new Error(error.message);
      console.log(`[CATON] Nuevo lead: ${email} (${organizacion ?? 'sin org'})`);
      ok(res, { ok: true, id: data?.id });

      // Notificación a Fernando — fire and forget
      const ADMIN_EMAIL = process.env.CATON_ADMIN_EMAIL || 'feracosar1@gmail.com';
      const fromAddr = process.env.RESEND_FROM || 'Catón <argos@caton.la>';
      const msgHtml = mensaje ? `<p style="margin:0 0 8px;color:#5A6472;font-size:14px;line-height:1.6;white-space:pre-line">${String(mensaje).replace(/</g,'&lt;')}</p>` : '<p style="margin:0;color:#9CA3AF;font-size:13px">Sin mensaje.</p>';
      sendViaResend({
        from: fromAddr,
        to: [ADMIN_EMAIL],
        subject: `Catón — nuevo contacto: ${String(nombre).slice(0,60)} (${organizacion ?? 'sin org'})`,
        html: `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F5F3EF;font-family:'Helvetica Neue',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F3EF;padding:28px 16px">
  <tr><td align="center">
    <table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%">
      <tr><td style="background:#0F3D2E;border-radius:10px 10px 0 0;padding:24px 28px 18px;text-align:center">
        <h1 style="color:#C6A15B;margin:0;font-size:22px;font-weight:700;letter-spacing:0.04em">CATÓN</h1>
        <p style="color:#E4EDE9;margin:4px 0 0;font-size:11px;letter-spacing:0.12em;text-transform:uppercase">Nuevo mensaje de contacto</p>
      </td></tr>
      <tr><td style="background:#C6A15B;height:2px"></td></tr>
      <tr><td style="background:#ffffff;padding:28px 28px 20px;border-left:1px solid #E4EDE9;border-right:1px solid #E4EDE9">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="padding-bottom:16px;border-bottom:1px solid #E4EDE9">
            <p style="margin:0 0 4px;color:#5A6472;font-size:11px;text-transform:uppercase;letter-spacing:0.08em">Nombre</p>
            <p style="margin:0;color:#0B0B0B;font-size:15px;font-weight:700">${String(nombre)}</p>
          </td></tr>
          <tr><td style="padding:14px 0 16px;border-bottom:1px solid #E4EDE9">
            <p style="margin:0 0 4px;color:#5A6472;font-size:11px;text-transform:uppercase;letter-spacing:0.08em">Correo</p>
            <p style="margin:0;color:#0B0B0B;font-size:14px"><a href="mailto:${String(email)}" style="color:#0F3D2E">${String(email)}</a></p>
          </td></tr>
          ${cargo ? `<tr><td style="padding:14px 0 16px;border-bottom:1px solid #E4EDE9">
            <p style="margin:0 0 4px;color:#5A6472;font-size:11px;text-transform:uppercase;letter-spacing:0.08em">Cargo</p>
            <p style="margin:0;color:#0B0B0B;font-size:14px">${String(cargo)}</p>
          </td></tr>` : ''}
          ${organizacion ? `<tr><td style="padding:14px 0 16px;border-bottom:1px solid #E4EDE9">
            <p style="margin:0 0 4px;color:#5A6472;font-size:11px;text-transform:uppercase;letter-spacing:0.08em">Organización</p>
            <p style="margin:0;color:#0B0B0B;font-size:14px">${String(organizacion)}</p>
          </td></tr>` : ''}
          ${telefono ? `<tr><td style="padding:14px 0 16px;border-bottom:1px solid #E4EDE9">
            <p style="margin:0 0 4px;color:#5A6472;font-size:11px;text-transform:uppercase;letter-spacing:0.08em">Teléfono</p>
            <p style="margin:0;color:#0B0B0B;font-size:14px">${String(telefono)}</p>
          </td></tr>` : ''}
          <tr><td style="padding-top:16px">
            <p style="margin:0 0 8px;color:#5A6472;font-size:11px;text-transform:uppercase;letter-spacing:0.08em">Mensaje</p>
            ${msgHtml}
          </td></tr>
        </table>
      </td></tr>
      <tr><td style="background:#0F3D2E;border-radius:0 0 10px 10px;padding:16px 28px;text-align:center">
        <a href="https://caton.la/app/admin" style="color:#C6A15B;text-decoration:none;font-size:12px">Ver en panel de administración →</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`,
      }).catch(e => console.error('[CATON] notif lead email error:', e.message));
    } catch (e) { err(res, e); }
  });

  // ── GET /veeduria/leads — lista de prospectos (auth requerida) ─────────────
  app.get('/veeduria/leads', auth, async (req, res) => {
    const { estado, q } = req.query;
    try {
      let query = supabase
        .from('caton_leads')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(500);

      if (estado && estado !== 'todos') query = query.eq('estado', estado);
      if (q) {
        const like = `%${q}%`;
        query = query.or(`nombre.ilike.${like},email.ilike.${like},organizacion.ilike.${like}`);
      }

      const { data, error } = await query;
      if (error) throw new Error(error.message);
      ok(res, { leads: data ?? [] });
    } catch (e) { err(res, e); }
  });

  // ── PATCH /veeduria/leads/:id — actualizar estado o notas ─────────────────
  app.patch('/veeduria/leads/:id', auth, async (req, res) => {
    const allowed = ['estado', 'notas_internas', 'cargo', 'organizacion', 'tipo_org', 'telefono'];
    const updates = { updated_at: new Date().toISOString() };
    for (const k of allowed) {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    }
    try {
      const { data, error } = await supabase
        .from('caton_leads')
        .update(updates)
        .eq('id', req.params.id)
        .select('*')
        .single();
      if (error) throw new Error(error.message);
      ok(res, { lead: data });
    } catch (e) { err(res, e); }
  });

  // ── POST /veeduria/leads — crear lead manualmente desde el admin ───────────
  app.post('/veeduria/leads', auth, async (req, res) => {
    const { nombre, email, cargo, organizacion, tipo_org, telefono, mensaje, notas_internas } = req.body ?? {};
    if (!nombre || !email) return err(res, new Error('nombre y email son requeridos'));
    try {
      const { data, error } = await supabase
        .from('caton_leads')
        .insert({
          nombre:         String(nombre).slice(0, 120),
          email:          String(email).slice(0, 200).toLowerCase().trim(),
          cargo:          cargo  ? String(cargo).slice(0, 100)  : null,
          organizacion:   organizacion ? String(organizacion).slice(0, 200) : null,
          tipo_org:       ['veeduria','contraloria','auditoria','ong','academia','otro'].includes(tipo_org) ? tipo_org : 'otro',
          telefono:       telefono ? String(telefono).slice(0, 30) : null,
          mensaje:        mensaje  ? String(mensaje).slice(0, 1000) : null,
          notas_internas: notas_internas ? String(notas_internas).slice(0, 2000) : null,
          fuente:         'manual',
          estado:         'nuevo',
        })
        .select('*')
        .single();
      if (error) throw new Error(error.message);
      ok(res, { lead: data });
    } catch (e) { err(res, e); }
  });

  // ── ADMIN: veedor_orgs / caton_entidades / caton_org_entidades ───────────────
  // Estas tablas tienen RLS sin policy de INSERT para authenticated — se accede
  // desde el backend (service_role) para evitar el 403 en el frontend.

  // GET /veeduria/admin/orgs — listar todas las organizaciones (service_role bypasa RLS)
  app.get('/veeduria/admin/orgs', auth, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('veedor_orgs')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      ok(res, { orgs: data ?? [] });
    } catch (e) { err(res, e); }
  });

  // POST /veeduria/admin/orgs — crear organización
  app.post('/veeduria/admin/orgs', auth, async (req, res) => {
    const { nombre, tipo, ciudad, pipeline_tipo, plan_tipo } = req.body ?? {};
    if (!nombre || !tipo) return err(res, new Error('nombre y tipo son requeridos'));
    const TIPOS_VALIDOS = ['veeduria', 'contraloria', 'ong', 'academia'];
    if (!TIPOS_VALIDOS.includes(tipo)) return err(res, new Error('tipo inválido'));
    const PLANES_VALIDOS = ['mensual_tokens', 'por_contrato', 'byok'];
    const planFinal = PLANES_VALIDOS.includes(plan_tipo) ? plan_tipo : 'mensual_tokens';
    try {
      const { data, error } = await supabase
        .from('veedor_orgs')
        .insert({
          nombre:        String(nombre).slice(0, 200),
          tipo,
          ciudad:        ciudad ? String(ciudad).slice(0, 100) : null,
          pipeline_tipo: pipeline_tipo || tipo,
          plan_tipo:     planFinal,
        })
        .select('*')
        .single();
      if (error) throw new Error(error.message);
      ok(res, data);
    } catch (e) { err(res, e); }
  });

  // PATCH /veeduria/admin/orgs/:id — actualizar campos de la org
  app.patch('/veeduria/admin/orgs/:id', auth, async (req, res) => {
    const allowed = ['nombre', 'tipo', 'ciudad', 'pipeline_tipo', 'activa',
                     'dominio', 'dominio_verificado', 'logo_url',
                     'plan_tipo', 'token_multiplier', 'tiene_radar', 'tiene_carruseles',
                     'alcance_tipo', 'alcance_deptos', 'alcance_municipios',
                     'dominio_propio', 'email_from_name', 'email_from_address',
                     'resend_domain_id', 'contratos_mes', 'nota_cuenta',
                     'ai_provider', 'ai_api_key_enc'];
    const updates = { updated_at: new Date().toISOString() };
    for (const k of allowed) {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    }
    try {
      const { data, error } = await supabase
        .from('veedor_orgs')
        .update(updates)
        .eq('id', req.params.id)
        .select('*')
        .single();
      if (error) throw new Error(error.message);
      ok(res, data);
    } catch (e) { err(res, e); }
  });

  // POST /veeduria/admin/entidades — crear entidad en el catálogo
  app.post('/veeduria/admin/entidades', auth, async (req, res) => {
    const { nit, nombre, sigla, nivel, deptos } = req.body ?? {};
    if (!nit || !nombre) return err(res, new Error('nit y nombre son requeridos'));
    const NIVELES = ['nacional', 'departamental', 'municipal'];
    try {
      const { data, error } = await supabase
        .from('caton_entidades')
        .insert({
          nit:    String(nit).replace(/\D/g, '').slice(0, 20),
          nombre: String(nombre).slice(0, 300),
          sigla:  sigla ? String(sigla).slice(0, 30) : null,
          nivel:  NIVELES.includes(nivel) ? nivel : 'municipal',
          deptos: Array.isArray(deptos) ? deptos : [],
        })
        .select('*')
        .single();
      if (error) throw new Error(error.message);
      ok(res, data);
    } catch (e) { err(res, e); }
  });

  // PATCH /veeduria/admin/entidades/:id — actualizar entidad (activa, etc.)
  app.patch('/veeduria/admin/entidades/:id', auth, async (req, res) => {
    const allowed = ['nombre', 'sigla', 'nivel', 'deptos', 'activa'];
    const updates = { updated_at: new Date().toISOString() };
    for (const k of allowed) {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    }
    try {
      const { data, error } = await supabase
        .from('caton_entidades')
        .update(updates)
        .eq('id', req.params.id)
        .select('*')
        .single();
      if (error) throw new Error(error.message);
      ok(res, data);
    } catch (e) { err(res, e); }
  });

  // POST /veeduria/admin/org-entidades — vincular entidad a una org
  app.post('/veeduria/admin/org-entidades', auth, async (req, res) => {
    const { org_id, entidad_id } = req.body ?? {};
    if (!org_id || !entidad_id) return err(res, new Error('org_id y entidad_id son requeridos'));
    try {
      const { data, error } = await supabase
        .from('caton_org_entidades')
        .insert({ org_id, entidad_id, activo: true })
        .select('*')
        .single();
      if (error) throw new Error(error.message);
      ok(res, data);
    } catch (e) { err(res, e); }
  });

  // PATCH /veeduria/admin/org-entidades/:id — desactivar vínculo (soft delete)
  app.patch('/veeduria/admin/org-entidades/:id', auth, async (req, res) => {
    const { activo } = req.body ?? {};
    try {
      const { data, error } = await supabase
        .from('caton_org_entidades')
        .update({ activo: activo !== undefined ? !!activo : false })
        .eq('id', req.params.id)
        .select('*')
        .single();
      if (error) throw new Error(error.message);
      ok(res, data);
    } catch (e) { err(res, e); }
  });

  // ── POST /veeduria/buscar-async — escanea TODO el universo SECOP en background
  // Body: { email_destino, ...mismos filtros que /buscar }
  // Responde inmediatamente con { job_id }. El job pagina Socrata ($limit=1000)
  // hasta agotar resultados (max 10.000). Al terminar envía un email de notificación
  // simple ("ya está listo, entra a revisar") — sin tabla de contratos en el correo.
  //
  // REQUIERE tabla en el Supabase de CATÓN — ver schema-async-search.sql
  app.post('/veeduria/buscar-async', auth, async (req, res) => {
    const { email_destino, ...filtros } = req.body ?? {};
    if (!email_destino) return err(res, new Error('email_destino requerido'));

    // Crear registro del job
    const { data: job, error: jobErr } = await supabase
      .from('veedor_busquedas_async')
      .insert({ filtros, email_destino, estado: 'corriendo' })
      .select('id').single();
    if (jobErr) return err(res, new Error(`No se pudo crear el job: ${jobErr.message}`));

    ok(res, { job_id: job.id, mensaje: 'Búsqueda en curso. Te notificamos por correo cuando termine.' });

    // Background — fire and forget (no bloquea la respuesta ya enviada)
    (async () => {
      const LIMIT  = 1000;
      const MAX    = 10_000;  // tope de seguridad
      let   offset = 0;
      const todos  = [];

      try {
        const { clausulasSoQL } = await import('./ambito.mjs');
        const { scorearContrato } = await import('./score-contrato.mjs');
        const httpsModule = (await import('https')).default;

        const escF = (s) => String(s).replace(/'/g, "''");
        const isoF = (d) => `${d}T00:00:00.000`;

        // Rearmar cláusulas WHERE — espejo de buscarContratos()
        const w = [];
        if (filtros.entidad)        w.push(`upper(nombre_entidad) like '%${escF(filtros.entidad).toUpperCase()}%'`);
        if (filtros.nitEntidad)     w.push(`nit_entidad = '${escF(filtros.nitEntidad)}'`);
        if (filtros.contratista)    w.push(`upper(proveedor_adjudicado) like '%${escF(filtros.contratista).toUpperCase()}%'`);
        if (filtros.nitContratista) w.push(`documento_proveedor = '${escF(filtros.nitContratista)}'`);
        if (filtros.objeto)         w.push(`upper(objeto_del_contrato) like '%${escF(filtros.objeto).toUpperCase()}%'`);
        if (filtros.valorMin != null) w.push(`valor_del_contrato >= '${filtros.valorMin}'`);
        if (filtros.valorMax != null) w.push(`valor_del_contrato <= '${filtros.valorMax}'`);
        if (filtros.desde)          w.push(`fecha_de_firma >= '${isoF(filtros.desde)}'`);
        if (filtros.hasta)          w.push(`fecha_de_firma <= '${isoF(filtros.hasta)}'`);
        if (filtros.estado && filtros.estado !== 'todos') {
          w.push(`estado_contrato = '${escF(filtros.estado)}'`);
        } else if (!filtros.estado) {
          w.push(`estado_contrato = 'En ejecuci\u00f3n'`);
        }
        if (filtros.tipo)      w.push(`upper(tipo_de_contrato) like '%${escF(filtros.tipo).toUpperCase()}%'`);
        if (filtros.modalidad) w.push(`upper(modalidad_de_contratacion) like '%${escF(filtros.modalidad).toUpperCase()}%'`);
        if (filtros.sinRuido)  w.push(`valor_del_contrato > '0'`);
        if (filtros.soloEmpresas) w.push(`tipodocproveedor = 'NIT'`);
        if (filtros.sinServiciosPersonales) {
          w.push(`not (upper(tipo_de_contrato) like 'PRESTACI%SERVICIOS' and tipodocproveedor != 'NIT')`);
        }
        w.push(...clausulasSoQL(filtros.ambito));

        // Función que trae UNA página de Socrata
        const socrataPage = (off) => new Promise((resolve, reject) => {
          const params = new URLSearchParams({
            $select: 'id_contrato,referencia_del_contrato,proceso_de_compra,nombre_entidad,nit_entidad,'
                   + 'proveedor_adjudicado,documento_proveedor,nombre_representante_legal,'
                   + 'valor_del_contrato,fecha_de_firma,estado_contrato,tipo_de_contrato,'
                   + 'modalidad_de_contratacion,objeto_del_contrato,departamento,ciudad,orden,sector,tipodocproveedor',
            $order:  'fecha_de_firma DESC',
            $limit:  String(LIMIT),
            $offset: String(off),
          });
          if (w.length) params.set('$where', w.join(' AND '));
          if (process.env.SOCRATA_APP_TOKEN) params.set('$$app_token', process.env.SOCRATA_APP_TOKEN);

          const r = httpsModule.get(
            { hostname: 'www.datos.gov.co', path: `/resource/jbjy-vk9h.json?${params}`, headers: { Accept: 'application/json' } },
            (resp) => {
              const chunks = [];
              resp.on('data', d => chunks.push(d));
              resp.on('end', () => {
                try {
                  const data = JSON.parse(Buffer.concat(chunks).toString());
                  if (!Array.isArray(data)) return reject(new Error(data?.message ?? 'respuesta no iterable'));
                  resolve(data);
                } catch (e) { reject(e); }
              });
            });
          r.on('error', reject);
          r.setTimeout(60_000, () => { r.destroy(); reject(new Error('timeout Socrata')); });
        });

        // Loop de paginación
        while (offset < MAX) {
          const rows = await socrataPage(offset);
          for (const r of rows) {
            const c = {
              id_contrato: r.id_contrato, referencia: r.referencia_del_contrato,
              proceso: r.proceso_de_compra, entidad: r.nombre_entidad, nit_entidad: r.nit_entidad,
              contratista: r.proveedor_adjudicado, nit_contratista: r.documento_proveedor,
              representante_legal: r.nombre_representante_legal,
              valor: Number(r.valor_del_contrato) || 0,
              fecha_firma: r.fecha_de_firma?.slice(0, 10),
              estado: r.estado_contrato, tipo: r.tipo_de_contrato,
              modalidad: r.modalidad_de_contratacion,
              objeto: (r.objeto_del_contrato ?? '').slice(0, 180),
              departamento: r.departamento, ciudad: r.ciudad,
            };
            todos.push({ ...c, ...scorearContrato(c) });
          }
          console.log(`[ASYNC] job ${job.id}: offset=${offset}, batch=${rows.length}, acumulado=${todos.length}`);
          if (rows.length < LIMIT) break; // última página — fin
          offset += LIMIT;
        }

        // Actualizar job como completado
        await supabase.from('veedor_busquedas_async').update({
          estado:          'completada',
          total_contratos: todos.length,
          top_score:       todos.length ? Math.max(...todos.slice(0, 200).map(c => c.score ?? 0)) : 0,
          completado_at:   new Date().toISOString(),
        }).eq('id', job.id);

        // Email de notificación — simple, sin tabla de contratos
        const filtrosDesc = [
          filtros.entidad      && `entidad: "${filtros.entidad}"`,
          filtros.objeto       && `objeto: "${filtros.objeto}"`,
          filtros.contratista  && `contratista: "${filtros.contratista}"`,
          filtros.nitEntidad   && `NIT entidad: ${filtros.nitEntidad}`,
          filtros.desde        && `desde ${filtros.desde}`,
          filtros.hasta        && `hasta ${filtros.hasta}`,
        ].filter(Boolean).join(' · ') || 'todos los contratos en ejecución';

        const appUrl   = (process.env.APP_URL ?? 'https://caton.la').replace(/\/+$/, '');
        const fromAddr = process.env.RESEND_FROM || 'Catón <argos@caton.la>';

        await sendViaResend({
          from:    fromAddr,
          to:      email_destino,
          subject: `Catón encontró ${todos.length.toLocaleString('es-CO')} contratos — tu escaneo SECOP está listo`,
          html: `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F5F3EF;font-family:'Helvetica Neue',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F3EF;padding:32px 16px">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">

      <!-- HEADER con ojo -->
      <tr><td style="background:#0F3D2E;border-radius:12px 12px 0 0;padding:32px 32px 24px;text-align:center">
        <!-- El ojo que todo lo ve (SVG inline) -->
        <div style="margin-bottom:16px">
          <svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
            <!-- Arco superior del ojo -->
            <path d="M8 32 C8 32 18 14 32 14 C46 14 56 32 56 32" stroke="#C6A15B" stroke-width="2.5" fill="none" stroke-linecap="round"/>
            <!-- Arco inferior del ojo -->
            <path d="M8 32 C8 32 18 50 32 50 C46 50 56 32 56 32" stroke="#C6A15B" stroke-width="2.5" fill="none" stroke-linecap="round"/>
            <!-- Iris -->
            <circle cx="32" cy="32" r="10" stroke="#C6A15B" stroke-width="2.5" fill="none"/>
            <!-- Pupila -->
            <circle cx="32" cy="32" r="5" fill="#C6A15B"/>
            <!-- Brillo -->
            <circle cx="35" cy="29" r="1.5" fill="#0F3D2E"/>
            <!-- Pestañas superiores -->
            <line x1="32" y1="14" x2="32" y2="10" stroke="#C6A15B" stroke-width="1.5" stroke-linecap="round"/>
            <line x1="22" y1="17" x2="20" y2="13" stroke="#C6A15B" stroke-width="1.5" stroke-linecap="round"/>
            <line x1="42" y1="17" x2="44" y2="13" stroke="#C6A15B" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </div>
        <h1 style="color:#C6A15B;margin:0 0 4px;font-size:26px;font-weight:700;letter-spacing:0.04em">CATÓN</h1>
        <p style="color:#E4EDE9;margin:0;font-size:12px;letter-spacing:0.12em;text-transform:uppercase">Veeduría Ciudadana</p>
      </td></tr>

      <!-- FRANJA DORADA -->
      <tr><td style="background:#C6A15B;height:3px"></td></tr>

      <!-- CUERPO -->
      <tr><td style="background:#ffffff;padding:36px 32px 28px;border-left:1px solid #E4EDE9;border-right:1px solid #E4EDE9">
        <p style="color:#5A6472;font-size:13px;margin:0 0 8px;text-transform:uppercase;letter-spacing:0.08em">Escaneo completado</p>
        <h2 style="color:#0B0B0B;margin:0 0 20px;font-size:22px;font-weight:700;line-height:1.3">
          Tu escaneo de SECOP<br>está listo para revisar
        </h2>
        <p style="color:#5A6472;font-size:15px;line-height:1.6;margin:0 0 24px">
          Escaneamos el universo completo de contratos públicos con los filtros que configuraste.
          Los resultados ya están en Catón, ordenados por score de riesgo.
        </p>

        <!-- FILTROS -->
        <div style="background:#F5F3EF;border-radius:8px;padding:14px 16px;margin-bottom:24px;border-left:3px solid #C6A15B">
          <p style="margin:0 0 4px;color:#5A6472;font-size:11px;text-transform:uppercase;letter-spacing:0.08em">Filtros aplicados</p>
          <p style="margin:0;color:#0B0B0B;font-size:14px;font-weight:600">${filtrosDesc}</p>
        </div>

        <!-- NÚMERO GRANDE -->
        <div style="background:#0F3D2E;border-radius:10px;padding:28px 24px;margin-bottom:28px;text-align:center">
          <span style="display:block;color:#C6A15B;font-size:48px;font-weight:800;line-height:1;letter-spacing:-0.02em">${todos.length.toLocaleString('es-CO')}</span>
          <span style="display:block;color:#E4EDE9;font-size:14px;margin-top:6px">contratos encontrados</span>
          ${topScore > 0 ? `<div style="margin-top:16px;padding-top:16px;border-top:1px solid rgba(196,161,91,0.3)">
            <span style="display:block;color:#C6A15B;font-size:22px;font-weight:700">${topScore} / 100</span>
            <span style="display:block;color:#E4EDE9;font-size:12px;margin-top:2px">score más alto detectado</span>
          </div>` : ''}
        </div>

        <!-- CTA -->
        <div style="text-align:center;margin-bottom:28px">
          <a href="${appUrl}" style="display:inline-block;background:#C6A15B;color:#0B0B0B;padding:15px 40px;border-radius:8px;text-decoration:none;font-size:15px;font-weight:700;letter-spacing:0.02em">
            Entrar a Catón a revisar →
          </a>
        </div>

        <p style="color:#9CA3AF;font-size:12px;margin:0;text-align:center;line-height:1.6">
          Los contratos con mayor score de riesgo aparecen primero.<br>
          Catón — El ojo que todo lo ve.
        </p>
      </td></tr>

      <!-- FOOTER -->
      <tr><td style="background:#0F3D2E;border-radius:0 0 12px 12px;padding:20px 32px;text-align:center">
        <p style="color:#E4EDE9;font-size:12px;margin:0;opacity:0.7">
          Recibiste este correo porque solicitaste un escaneo en Catón.<br>
          <a href="${appUrl}" style="color:#C6A15B;text-decoration:none">caton.la</a>
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`,
          replyTo: 'veedor@caton.la',
        });

        console.log(`[ASYNC] job ${job.id} DONE: ${todos.length} contratos → notificación enviada a ${email_destino}`);

      } catch (e) {
        console.error(`[ASYNC] job ${job.id} ERROR:`, e.message);
        await supabase.from('veedor_busquedas_async').update({
          estado:        'error',
          error_msg:     e.message,
          completado_at: new Date().toISOString(),
        }).eq('id', job.id).catch(() => {});

        // Email de error también
        const appUrl   = (process.env.APP_URL ?? 'https://caton.la').replace(/\/+$/, '');
        const fromAddrErr = process.env.RESEND_FROM || 'Catón <argos@caton.la>';
        await sendViaResend({
          from:    fromAddrErr,
          to:      email_destino,
          subject: 'Catón — hubo un error en tu escaneo SECOP',
          html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 16px">
                   <div style="background:#0F3D2E;border-radius:8px 8px 0 0;padding:24px;text-align:center">
                     <p style="color:#C6A15B;font-size:20px;font-weight:700;margin:0">CATÓN</p>
                   </div>
                   <div style="background:#fff;border:1px solid #E4EDE9;border-top:none;border-radius:0 0 8px 8px;padding:28px 24px">
                     <h2 style="color:#0B0B0B;margin:0 0 12px">Hubo un error en tu escaneo</h2>
                     <p style="color:#5A6472;font-size:15px">El escaneo no pudo completarse. Por favor intenta de nuevo desde Catón.</p>
                     <p style="color:#bbb;font-size:11px;font-family:monospace">Error: ${e.message}</p>
                     <a href="${appUrl}" style="display:inline-block;background:#0F3D2E;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600">Volver a Catón →</a>
                   </div>
                 </div>`,
          replyTo: 'argos@caton.la',
        }).catch(() => {});
      }
    })();
  });

  // ── GET /veeduria/buscar-async — lista de jobs recientes ──────────────────
  app.get('/veeduria/buscar-async', auth, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('veedor_busquedas_async')
        .select('id,filtros,estado,total_contratos,top_score,error_msg,created_at,completado_at')
        .order('created_at', { ascending: false })
        .limit(10);
      if (error) throw new Error(error.message);
      ok(res, { jobs: data ?? [] });
    } catch (e) { err(res, e); }
  });

  // ── GET /veeduria/buscar-async/:id — estado de un job ────────────────────
  app.get('/veeduria/buscar-async/:id', auth, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('veedor_busquedas_async')
        .select('id,filtros,estado,total_contratos,top_score,error_msg,created_at,completado_at')
        .eq('id', req.params.id)
        .single();
      if (error) throw new Error(error.message);
      ok(res, { job: data });
    } catch (e) { err(res, e); }
  });

  // ── EQUIPO (membresías de la org del usuario autenticado) ──────────────────

  // GET /veeduria/equipo?org_id=xxx — listar miembros de la org
  app.get('/veeduria/equipo', auth, async (req, res) => {
    const { org_id } = req.query;
    if (!org_id) return err(res, new Error('org_id es requerido'));
    try {
      const { data, error } = await supabase
        .from('veedor_memberships')
        .select('id, user_id, rol, estado, nombre, activo, created_at')
        .eq('org_id', org_id)
        .order('created_at', { ascending: false });
      if (error) throw new Error(error.message);

      // Enriquecer con email desde Supabase Auth (service_role)
      const CATON_URL   = process.env.SUPABASE_URL;
      const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
      const miembros = await Promise.all((data ?? []).map(async m => {
        try {
          const r = await fetch(`${CATON_URL}/auth/v1/admin/users/${m.user_id}`, {
            headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
          });
          if (r.ok) {
            const u = await r.json();
            return { ...m, email: u.email ?? null };
          }
        } catch { /* sin email */ }
        return { ...m, email: null };
      }));

      ok(res, { miembros });
    } catch (e) { err(res, e); }
  });

  // PATCH /veeduria/equipo/:id — cambiar rol o desactivar un miembro
  app.patch('/veeduria/equipo/:id', auth, async (req, res) => {
    const { org_id } = req.body ?? {};
    if (!org_id) return err(res, new Error('org_id es requerido'));
    const ROLES_VALIDOS = ['admin', 'auditor', 'coordinador', 'visualizador', 'director'];
    const updates = {};
    if (req.body.rol !== undefined && ROLES_VALIDOS.includes(req.body.rol)) updates.rol = req.body.rol;
    if (req.body.activo !== undefined) updates.activo = Boolean(req.body.activo);
    if (Object.keys(updates).length === 0) return err(res, new Error('Nada que actualizar'));
    try {
      const { data, error } = await supabase
        .from('veedor_memberships')
        .update(updates)
        .eq('id', req.params.id)
        .eq('org_id', org_id)
        .select('*')
        .single();
      if (error) throw new Error(error.message);
      ok(res, data);
    } catch (e) { err(res, e); }
  });

  // POST /veeduria/admin/invitar — crear usuario en Supabase Auth + vincularlo a veedor_memberships
  app.post('/veeduria/admin/invitar', auth, async (req, res) => {
    const { email, nombre, org_id, rol } = req.body ?? {};
    if (!email || !org_id) return err(res, new Error('email y org_id son requeridos'));
    const ROLES_VALIDOS = ['admin', 'auditor', 'coordinador', 'visualizador', 'director'];
    const rolFinal = ROLES_VALIDOS.includes(rol) ? rol : 'auditor';
    const CATON_URL  = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      // 1. Crear usuario en Supabase Auth (email ya confirmado)
      const createRes = await fetch(`${CATON_URL}/auth/v1/admin/users`, {
        method: 'POST',
        headers: {
          'apikey': SERVICE_KEY,
          'Authorization': `Bearer ${SERVICE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          email_confirm: true,
          user_metadata: { nombre: nombre ? String(nombre).trim() : '' },
        }),
      });
      const createData = await createRes.json();
      let userId = createData?.id;

      // Si ya existe, buscarlo por email
      if (!userId) {
        const listRes = await fetch(`${CATON_URL}/auth/v1/admin/users?page=1&per_page=100`, {
          headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` },
        });
        const listData = await listRes.json();
        const found = (listData?.users ?? []).find(u => u.email?.toLowerCase() === email.trim().toLowerCase());
        userId = found?.id;
      }
      if (!userId) throw new Error(createData?.msg ?? createData?.message ?? 'No se pudo crear el usuario');

      // 2. Upsert en veedor_memberships
      const { error: memErr } = await supabase
        .from('veedor_memberships')
        .upsert({ user_id: userId, org_id, rol: rolFinal, activo: true, estado: 'activo', nombre: nombre ? String(nombre).trim() : null }, { onConflict: 'user_id,org_id' });
      if (memErr) throw new Error(memErr.message);

      // 3. Generar magic link
      const linkRes = await fetch(`${CATON_URL}/auth/v1/admin/generate_link`, {
        method: 'POST',
        headers: {
          'apikey': SERVICE_KEY,
          'Authorization': `Bearer ${SERVICE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ type: 'magiclink', email: email.trim().toLowerCase() }),
      });
      const linkData = await linkRes.json();
      const magicLink = linkData?.action_link;

      // 4. Enviar correo via Resend si está configurado
      const RESEND_KEY = process.env.RESEND_API_KEY;
      if (RESEND_KEY && magicLink) {
        const { data: orgData } = await supabase.from('veedor_orgs').select('nombre').eq('id', org_id).single();
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'CATÓN <no-reply@caton.la>',
            to: [email.trim()],
            subject: `Invitación a CATÓN — ${orgData?.nombre ?? 'Veeduría'}`,
            html: `<p>Hola${nombre ? ' ' + nombre : ''},</p>
<p>Has sido invitado a <strong>${orgData?.nombre ?? 'una veeduría'}</strong> en la plataforma CATÓN con el rol de <strong>${rolFinal}</strong>.</p>
<p><a href="${magicLink}" style="background:#0F3D2E;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Acceder a CATÓN</a></p>
<p style="color:#666;font-size:12px;">Este enlace expira en 24 horas.</p>`,
          }),
        });
      }

      ok(res, { ok: true, user_id: userId, magic_link: magicLink ?? null });
    } catch (e) { err(res, e); }
  });

  // GET /veeduria/admin/panel-stats?org_id=xxx — estadísticas para el panel de control
  app.get('/veeduria/admin/panel-stats', auth, async (req, res) => {
    const { org_id } = req.query;
    if (!org_id) return err(res, new Error('org_id es requerido'));
    try {
      // Consultas en paralelo
      const [expResult, reqResult, actResult, memResult, hallResult] = await Promise.allSettled([
        // 1. Expedientes por estado
        supabase.from('veeduria_expedientes').select('estado').eq('org_id', org_id),
        // 2. Requerimientos
        supabase.from('veedor_requerimientos').select('estado, fecha_vencimiento, fecha_respuesta').eq('org_id', org_id),
        // 3. Actuaciones recientes
        supabase.from('veeduria_actuaciones')
          .select('id, tipo, descripcion, created_at, expediente_id')
          .eq('org_id', org_id)
          .order('created_at', { ascending: false })
          .limit(8),
        // 4. Miembros del equipo
        supabase.from('veedor_memberships').select('rol, nombre, activo').eq('org_id', org_id).eq('activo', true),
        // 5. Hallazgos recientes
        supabase.from('veeduria_hallazgos')
          .select('id, tipo, severidad, descripcion, created_at, expediente_id')
          .eq('org_id', org_id)
          .order('created_at', { ascending: false })
          .limit(6),
      ]);

      // Expedientes por estado
      const expData = expResult.status === 'fulfilled' ? (expResult.value.data ?? []) : [];
      const expedientes_por_estado = {};
      for (const e of expData) {
        expedientes_por_estado[e.estado] = (expedientes_por_estado[e.estado] ?? 0) + 1;
      }

      // Requerimientos
      const reqData = reqResult.status === 'fulfilled' ? (reqResult.value.data ?? []) : [];
      const ahora = new Date();
      const requerimientos = {
        total: reqData.length,
        enviados: reqData.filter(r => r.estado === 'enviado').length,
        esperando: reqData.filter(r => r.estado === 'esperando_respuesta').length,
        respondidos: reqData.filter(r => r.estado === 'respondido').length,
        vencidos: reqData.filter(r => {
          if (r.estado !== 'enviado' && r.estado !== 'esperando_respuesta') return false;
          if (!r.fecha_vencimiento) return false;
          return new Date(r.fecha_vencimiento) < ahora;
        }).length,
      };

      // Actuaciones
      const actuaciones = actResult.status === 'fulfilled' ? (actResult.value.data ?? []) : [];

      // Miembros
      const memData = memResult.status === 'fulfilled' ? (memResult.value.data ?? []) : [];
      const equipo_por_rol = {};
      for (const m of memData) {
        equipo_por_rol[m.rol] = (equipo_por_rol[m.rol] ?? 0) + 1;
      }

      // Hallazgos
      const hallazgos = hallResult.status === 'fulfilled' ? (hallResult.value.data ?? []) : [];

      ok(res, {
        total_expedientes: expData.length,
        expedientes_por_estado,
        requerimientos,
        actuaciones_recientes: actuaciones,
        hallazgos_recientes: hallazgos,
        equipo: memData,
        equipo_por_rol,
        total_miembros: memData.length,
      });
    } catch (e) { err(res, e); }
  });

  // POST /veeduria/expediente/:id/importar-secop
  // Importa el cronograma oficial del proceso SECOP a veedor_cronograma.
  // Toma las fechas precontractuales del proceso (publicación, observaciones, cierre,
  // adjudicación, firma, inicio) y crea hitos. Si el proceso ya está en secop_procesos
  // lo lee de ahí; si no, lo busca en la API de datos.gov.co.
  app.post('/veeduria/expediente/:id/importar-secop', auth, async (req, res) => {
    const { id } = req.params;
    const { org_id } = req.body;

    try {
      // 1. Obtener el expediente
      const { data: exp, error: expErr } = await supabase
        .from('veeduria_expedientes')
        .select('id, id_contrato, id_proceso, entidad, veedor_org_id')
        .eq('id', id)
        .single();
      if (expErr || !exp) throw new Error(expErr?.message || 'Expediente no encontrado');

      const idProceso = exp.id_proceso || exp.id_contrato;
      if (!idProceso) throw new Error('El expediente no tiene un id_proceso vinculado');

      // 2. Buscar el proceso (primero en DB local, luego en Socrata)
      let raw = null;
      const { data: localProc } = await supabase
        .from('secop_procesos')
        .select('*')
        .eq('id', idProceso)
        .maybeSingle();

      if (localProc) {
        raw = localProc.raw || localProc;
      } else {
        // Fallback: consultar Socrata directo
        const EP_PROCESOS_LOCAL = 'https://www.datos.gov.co/resource/p6dx-8zbt.json';
        const params = new URLSearchParams({
          '$limit': '5',
          '$where': `id_del_proceso = '${idProceso}'`,
        });
        const secopRes = await fetch(`${EP_PROCESOS_LOCAL}?${params}`, {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(15000),
        });
        if (!secopRes.ok) throw new Error(`SECOP API error ${secopRes.status}`);
        const rows = await secopRes.json();
        if (!rows || rows.length === 0) {
          // ── Fallback para Contratación Directa ────────────────────────────────
          // La CD no tiene proceso precontractual en el dataset p6dx-8zbt.
          // Buscamos el contrato directamente en jbjy-vk9h (SECOP contratos)
          // para extraer las fechas del contrato mismo (firma, inicio, fin).
          const idContrato = exp.id_contrato || idProceso;
          const EP_CONTRATOS = 'https://www.datos.gov.co/resource/jbjy-vk9h.json';
          const pcd = new URLSearchParams({
            '$where': `id_contrato = '${idContrato}'`,
            '$select': 'id_contrato,fecha_de_firma,fecha_de_inicio_del_contrato,fecha_de_fin_del_contrato,modalidad_de_contratacion,nombre_entidad,estado_contrato',
            '$limit': '1',
          });
          let rawContrato = null;
          try {
            const cRes = await fetch(`${EP_CONTRATOS}?${pcd}`, {
              headers: { 'Accept': 'application/json' },
              signal: AbortSignal.timeout(12000),
            });
            if (cRes.ok) {
              const cRows = await cRes.json();
              if (cRows && cRows.length > 0) rawContrato = cRows[0];
            }
          } catch (_) { /* continua sin fechas del contrato */ }

          if (!rawContrato) throw new Error(`Proceso "${idProceso}" no encontrado en SECOP. Para contratación directa, asegúrese de que el id_contrato esté disponible.`);

          // Armar hitos solo con fechas del contrato (sin fase precontractual)
          const ahora = new Date();
          const hitosCD = [];
          const fechasCD = [
            { tipo: 'firma_contrato',   label: 'Firma del contrato',           fecha: rawContrato.fecha_de_firma },
            { tipo: 'inicio_ejecucion', label: 'Inicio de ejecución',           fecha: rawContrato.fecha_de_inicio_del_contrato },
            { tipo: 'fin_ejecucion',    label: 'Fin de ejecución (vencimiento)', fecha: rawContrato.fecha_de_fin_del_contrato },
          ];
          for (const h of fechasCD) {
            if (!h.fecha) continue;
            const pasado = new Date(h.fecha) < ahora;
            hitosCD.push({
              id_proceso: idProceso,
              tipo: h.tipo, nombre: h.label, fecha_inicio: h.fecha, fecha_fin: null,
              estado: pasado ? 'completado' : 'pendiente',
              verificado: false, alerta_activa: false,
              notas: 'Contratación directa — sin fase precontractual',
              updated_at: new Date().toISOString(),
            });
          }

          if (hitosCD.length === 0) {
            return ok(res, { ok: true, hitos: [], mensaje: 'Contratación directa: no se encontraron fechas en SECOP para este contrato' });
          }

          await supabase.from('veedor_cronograma').delete().eq('id_proceso', idProceso);
          const { data: hitosInsCD, error: insErrCD } = await supabase
            .from('veedor_cronograma').insert(hitosCD).select('*');
          if (insErrCD) throw new Error(insErrCD.message);

          return ok(res, {
            ok: true,
            hitos: hitosInsCD ?? hitosCD,
            proceso: {
              id: idProceso,
              entidad: rawContrato.nombre_entidad || exp.entidad,
              modalidad: rawContrato.modalidad_de_contratacion || 'Contratación Directa',
              estado: rawContrato.estado_contrato || null,
            },
            es_contratacion_directa: true,
          });
        }
        raw = rows[0];
      }

      // 3. Extraer fechas del proceso precontractual
      // Las fechas de SECOP pueden venir en distintos campos según el dataset
      const fechas = {
        publicacion:  raw.fecha_de_publicacion_del || raw.fecha_publicacion || null,
        observaciones_inicio: raw.fecha_de_inicio_de_respuesta || raw.fecha_inicio_observaciones || null,
        observaciones_fin: raw.fecha_fin_observaciones || null,
        adendas:      raw.fecha_adenda || null,
        audiencia:    raw.fecha_audiencia || raw.fecha_de_audiencia || null,
        cierre:       raw.fecha_de_recepcion_de || raw.fecha_de_apertura_de_respuesta || raw.fecha_limite_de_recepcion || raw.fecha_limite || null,
        evaluacion_inicio: raw.fecha_inicio_evaluacion || null,
        evaluacion_fin: raw.fecha_fin_evaluacion || null,
        adjudicacion: raw.fecha_adjudicacion || raw.fecha_de_adjudicacion || null,
        firma:        raw.fecha_de_firma || raw.fecha_firma || null,
        inicio_ejecucion: raw.fecha_de_inicio_del_contrato || raw.fecha_inicio || null,
        fin_ejecucion: raw.fecha_de_fin_del_contrato || raw.fecha_fin || null,
      };

      // 4. Construir hitos — solo los que tienen fecha
      const TIPOS_HITO = [
        { tipo: 'publicacion_pliego',      label: 'Publicación del pliego',               key: 'publicacion' },
        { tipo: 'observaciones_inicio',    label: 'Inicio período de observaciones',       key: 'observaciones_inicio' },
        { tipo: 'observaciones_fin',       label: 'Fin período de observaciones',          key: 'observaciones_fin' },
        { tipo: 'adendas',                 label: 'Adenda / modificación del pliego',      key: 'adendas' },
        { tipo: 'audiencia',               label: 'Audiencia de aclaraciones',             key: 'audiencia' },
        { tipo: 'cierre_recepcion_ofertas',label: 'Cierre recepción de ofertas',           key: 'cierre' },
        { tipo: 'evaluacion_inicio',       label: 'Inicio evaluación de propuestas',       key: 'evaluacion_inicio' },
        { tipo: 'evaluacion_fin',          label: 'Fin evaluación de propuestas',          key: 'evaluacion_fin' },
        { tipo: 'adjudicacion',            label: 'Adjudicación del contrato',             key: 'adjudicacion' },
        { tipo: 'firma_contrato',          label: 'Firma del contrato',                    key: 'firma' },
        { tipo: 'inicio_ejecucion',        label: 'Inicio de ejecución',                   key: 'inicio_ejecucion' },
        { tipo: 'fin_ejecucion',           label: 'Fin de ejecución (vencimiento)',        key: 'fin_ejecucion' },
      ];

      const ahora = new Date();
      const hitosACrear = [];

      for (const h of TIPOS_HITO) {
        const fecha = fechas[h.key];
        if (!fecha) continue;
        const fechaObj = new Date(fecha);
        const pasado = fechaObj < ahora;
        hitosACrear.push({
          id_proceso: idProceso,
          tipo: h.tipo,
          nombre: h.label,
          fecha_inicio: fecha,
          fecha_fin: null,
          estado: pasado ? 'completado' : 'pendiente',
          verificado: false,
          alerta_activa: false,
          notas: null,
          updated_at: new Date().toISOString(),
        });
      }

      if (hitosACrear.length === 0) {
        return ok(res, { ok: true, hitos: [], mensaje: 'El proceso no tiene fechas precontractuales disponibles en SECOP' });
      }

      // 5. Borrar hitos existentes para este proceso y recriar
      // (import completo: las fechas SECOP reemplazan las anteriores)
      await supabase
        .from('veedor_cronograma')
        .delete()
        .eq('id_proceso', idProceso);

      const { data: hitosInsertados, error: insertErr } = await supabase
        .from('veedor_cronograma')
        .insert(hitosACrear)
        .select('*');

      if (insertErr) throw new Error(insertErr.message);

      // 6. Guardar id_proceso en el expediente si no lo tenía
      if (!exp.id_proceso && exp.id_contrato) {
        await supabase
          .from('veeduria_expedientes')
          .update({ id_proceso: idProceso })
          .eq('id', id);
      }

      ok(res, {
        ok: true,
        hitos: hitosInsertados ?? hitosACrear,
        proceso: {
          id: idProceso,
          entidad: raw.entidad || raw.nombre_entidad || exp.entidad,
          modalidad: raw.modalidad_de_contratacion || raw.modalidad || null,
          estado: raw.estado_del_procedimiento || raw.estado || null,
        },
      });
    } catch (e) { err(res, e); }
  });

  // GET /veeduria/admin/cronograma-org?org_id=xxx — plazos y fechas críticas de la org
  app.get('/veeduria/admin/cronograma-org', auth, async (req, res) => {
    const { org_id } = req.query;
    if (!org_id) return err(res, new Error('org_id es requerido'));
    try {
      const [expResult, reqResult] = await Promise.allSettled([
        // Expedientes con sus fechas
        supabase.from('veeduria_expedientes')
          .select('id, id_contrato, id_proceso, entidad, estado, created_at, updated_at, asignado_a')
          .eq('veedor_org_id', org_id)
          .order('updated_at', { ascending: false })
          .limit(100),
        // Requerimientos con fechas de vencimiento
        supabase.from('veedor_requerimientos')
          .select('id, expediente_id, tipo, estado, fecha_envio, fecha_vencimiento, fecha_respuesta')
          .eq('org_id', org_id)
          .order('fecha_vencimiento', { ascending: true, nullsLast: false }),
      ]);

      const expedientes = expResult.status === 'fulfilled' ? (expResult.value.data ?? []) : [];
      const requerimientos = reqResult.status === 'fulfilled' ? (reqResult.value.data ?? []) : [];

      // Mapa expediente_id → requerimientos
      const reqPorExpediente = {};
      for (const r of requerimientos) {
        if (!reqPorExpediente[r.expediente_id]) reqPorExpediente[r.expediente_id] = [];
        reqPorExpediente[r.expediente_id].push(r);
      }

      const ahora = new Date();
      const eventos = [];

      // Eventos desde expedientes
      for (const exp of expedientes) {
        const reqs = reqPorExpediente[exp.id] ?? [];
        for (const r of reqs) {
          if (r.fecha_vencimiento) {
            const venc = new Date(r.fecha_vencimiento);
            const diasRestantes = Math.ceil((venc - ahora) / (1000 * 60 * 60 * 24));
            eventos.push({
              tipo: 'vencimiento_dp',
              expediente_id: exp.id,
              entidad: exp.entidad,
              estado_expediente: exp.estado,
              requerimiento_id: r.id,
              requerimiento_tipo: r.tipo ?? 'derecho_peticion',
              requerimiento_estado: r.estado,
              fecha: r.fecha_vencimiento,
              fecha_envio: r.fecha_envio,
              dias_restantes: diasRestantes,
              vencido: diasRestantes < 0 && r.estado !== 'respondido',
            });
          }
        }
      }

      // Ordenar: vencidos primero (por urgencia), luego próximos por fecha
      eventos.sort((a, b) => {
        if (a.vencido && !b.vencido) return -1;
        if (!a.vencido && b.vencido) return 1;
        return new Date(a.fecha) - new Date(b.fecha);
      });

      // Enriquecer requerimientos con dias_restantes
      const requerimientosEnriquecidos = requerimientos.map(r => {
        const diasRestantes = r.fecha_vencimiento
          ? Math.ceil((new Date(r.fecha_vencimiento) - ahora) / (1000 * 60 * 60 * 24))
          : 9999;
        return {
          ...r,
          dias_restantes: diasRestantes,
          vencido: r.fecha_vencimiento ? (diasRestantes < 0 && r.estado !== 'respondido') : false,
        };
      });

      const vencidos = requerimientosEnriquecidos.filter(r => r.vencido);
      const proximos7 = requerimientosEnriquecidos.filter(r => !r.vencido && r.dias_restantes <= 7);
      const proximos30 = requerimientosEnriquecidos.filter(r => !r.vencido && r.dias_restantes <= 30);

      ok(res, {
        expedientes,
        requerimientos: requerimientosEnriquecidos,
        eventos,
        por_estado: {
          vencidos: vencidos.length,
          proximos_7d: proximos7.length,
          proximos_30d: proximos30.length,
        },
      });
    } catch (e) { err(res, e); }
  });

  console.log('[VEEDOR] endpoints de veeduría montados: /veeduria/{buscar,buscar-async,grafo,auditar,expedientes,denuncia,enviar,requerimientos,notas,tutela,analizar-respuesta,fallo,cerrar,cronograma,expediente/:id/importar-secop,config/smtp,contacto,leads,admin/cronograma-org,admin/invitar}');
}
