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
    try { ok(res, { senales: await repLegalMultiple(req.query) }); }
    catch (e) { err(res, e); }
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
      // Timeout de 22s — da resultado parcial en vez de 504 del proxy Netlify.
      const TIMEOUT_MS = 22000;
      const timeout = new Promise(resolve => setTimeout(() => resolve([]), TIMEOUT_MS));
      const carruseles = await Promise.race([detectarCarruseles(opts), timeout]);
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

      if (modoGlobal) {
        // Modo global: 3 motores que no necesitan filtro de entidad
        //   · carruselPorConcentracion — detecta entidades que rotan contratos entre favoritos (HHI)
        //   · detectarCarruseles       — rep legal detrás de múltiples cáscaras (top 30)
        //   · repLegalMultiple         — señal individual por (rep, entidad)
        [resConc, resCarruseles, resRepMultiple] = await Promise.allSettled([
          carruselPorConcentracion({ ambito: opts.ambito, dias: opts.dias || 730, topN: 60 }),
          detectarCarruseles({ ambito: opts.ambito, dias: opts.dias, topN: 30 }),
          repLegalMultiple({ dias: opts.dias }),
        ]);
        resSuper = resCruz = resClones = resActas = resFrac = { status: 'fulfilled', value: [] };
      } else {
        // Modo entidad: 8 motores en paralelo. Si alguno falla, el radar sigue.
        [resSuper, resCruz, resClones, resActas, resCarruseles, resRepMultiple, resFrac, resConc] =
          await Promise.allSettled([
            concentracionSupervisores(opts),
            cruzamientoSupervisores(opts),
            objetosDuplicados(opts),
            actasAntesDeRegistro(opts),
            detectarCarruseles({ nitEntidad: opts.nitEntidad, entidad: opts.entidad, ambito: opts.ambito, dias: opts.dias }),
            repLegalMultiple({ nitEntidad: opts.nitEntidad, dias: opts.dias }),
            opts.nitEntidad
              ? fraccionamiento({ nitEntidad: opts.nitEntidad, dias: opts.dias })
              : Promise.resolve([]),
            carruselPorConcentracion({ nitEntidad: opts.nitEntidad, entidad: opts.entidad, ambito: opts.ambito, dias: opts.dias }),
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

  // ── CRONOGRAMA ───────────────────────────────────────────────────────────────

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

  // POST /veeduria/admin/orgs — crear organización
  app.post('/veeduria/admin/orgs', auth, async (req, res) => {
    const { nombre, tipo, ciudad, pipeline_tipo } = req.body ?? {};
    if (!nombre || !tipo) return err(res, new Error('nombre y tipo son requeridos'));
    const TIPOS_VALIDOS = ['veeduria', 'contraloria', 'ong', 'academia'];
    if (!TIPOS_VALIDOS.includes(tipo)) return err(res, new Error('tipo inválido'));
    try {
      const { data, error } = await supabase
        .from('veedor_orgs')
        .insert({
          nombre:        String(nombre).slice(0, 200),
          tipo,
          ciudad:        ciudad ? String(ciudad).slice(0, 100) : null,
          pipeline_tipo: pipeline_tipo || tipo,
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
                     'dominio', 'dominio_verificado', 'logo_url'];
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

  console.log('[VEEDOR] endpoints de veeduría montados: /veeduria/{buscar,buscar-async,grafo,auditar,expedientes,denuncia,enviar,requerimientos,notas,tutela,analizar-respuesta,fallo,cerrar,cronograma,config/smtp,contacto,leads}');
}
