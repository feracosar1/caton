/**
 * imap-poller.mjs — Polling IMAP para respuestas entrantes de veedurías
 *
 * Cada 5 minutos, por cada org con SMTP configurado:
 *   1. Conecta al IMAP de la veeduría
 *   2. Busca emails NO vistos en los últimos 30 días
 *   3. Si el In-Reply-To coincide con un message_id_enviado → es respuesta a un DP
 *   4. Guarda la respuesta en veedor_requerimientos y actualiza el expediente
 *   5. Dispara veedor-analizar-respuesta (async, no bloquea)
 *
 * Dependencia: imapflow (ya en package.json)
 */

import { ImapFlow } from 'imapflow';
import { decrypt } from './smtp-utils.mjs';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutos
const LOOKAHEAD_DAYS   = 30;             // busca en los últimos 30 días

// ─── Estado compartido ────────────────────────────────────────────────────────
let supabase = null;
let pollerTimer = null;
let isRunning   = false;

/**
 * Inicializa el poller con el cliente de Supabase.
 * Llama esto una sola vez al arrancar el servidor.
 */
export function iniciarImapPoller(supabaseClient) {
  if (pollerTimer) return; // ya está corriendo
  supabase = supabaseClient;
  console.log('[IMAP] Poller iniciado — corre cada 5 min');
  pollerTimer = setInterval(pollAll, POLL_INTERVAL_MS);
  // Primera pasada diferida 30s para no bloquear el arranque
  setTimeout(pollAll, 30_000);
}

export function detenerImapPoller() {
  if (pollerTimer) {
    clearInterval(pollerTimer);
    pollerTimer = null;
    console.log('[IMAP] Poller detenido');
  }
}

// ─── Loop principal ────────────────────────────────────────────────────────────

async function pollAll() {
  if (isRunning) return; // evitar solapamiento
  isRunning = true;
  try {
    // Obtener todas las orgs con SMTP/IMAP activo y que tengan host IMAP configurado
    const { data: configs, error } = await supabase
      .from('veedor_org_smtp')
      .select('org_id, smtp_pass_enc, imap_host, imap_port, imap_secure, smtp_user')
      .eq('activo', true)
      .not('imap_host', 'is', null);

    if (error) {
      console.error('[IMAP] Error cargando configs:', error.message);
      return;
    }

    if (!configs || configs.length === 0) return;

    for (const cfg of configs) {
      try {
        await pollOrg(cfg);
      } catch (e) {
        console.error(`[IMAP] Error polling org ${cfg.org_id}:`, e.message);
      }
    }
  } finally {
    isRunning = false;
  }
}

// ─── Polling de una org ────────────────────────────────────────────────────────

async function pollOrg(cfg) {
  let imapPass;
  try {
    imapPass = decrypt(cfg.smtp_pass_enc);
  } catch {
    console.warn(`[IMAP] Contraseña inválida para org ${cfg.org_id}`);
    return;
  }

  const client = new ImapFlow({
    host:   cfg.imap_host,
    port:   cfg.imap_port ?? 993,
    secure: cfg.imap_secure ?? true,
    auth: {
      user: cfg.smtp_user,
      pass: imapPass,
    },
    logger: false,
    tls: { rejectUnauthorized: false },
  });

  try {
    await client.connect();

    // Abrir INBOX en solo lectura
    await client.mailboxOpen('INBOX', { readOnly: true });

    // Buscar mensajes no vistos de los últimos LOOKAHEAD_DAYS días
    const since = new Date();
    since.setDate(since.getDate() - LOOKAHEAD_DAYS);

    const uids = await client.search({ since, seen: false }, { uid: true });
    if (!uids || uids.length === 0) {
      await client.logout();
      await actualizarPoll(cfg.org_id);
      return;
    }

    // Cargar los message-ids enviados de esta org para hacer el match
    const { data: reqs } = await supabase
      .from('veedor_requerimientos')
      .select('id, id_proceso, message_id_enviado, consecutivo')
      .eq('org_id', cfg.org_id)
      .not('message_id_enviado', 'is', null)
      .is('respuesta_html', null); // solo los que aún no tienen respuesta

    if (!reqs || reqs.length === 0) {
      await client.logout();
      await actualizarPoll(cfg.org_id);
      return;
    }

    const messageIdMap = new Map(reqs.map(r => [r.message_id_enviado, r]));
    const consecutivoRe = /\[VEE-\d{4}-\d+\]/;

    // Procesar cada mensaje
    for await (const msg of client.fetch(uids, {
      envelope:   true,
      bodyParts:  ['TEXT'],
      source:     false,
    }, { uid: true })) {
      try {
        await procesarMensaje(msg, messageIdMap, consecutivoRe, cfg.org_id, reqs);
      } catch (e) {
        console.error(`[IMAP] Error procesando mensaje ${msg.uid}:`, e.message);
      }
    }

    await client.logout();
    await actualizarPoll(cfg.org_id);
  } catch (e) {
    console.error(`[IMAP] Error conectando a ${cfg.imap_host} para org ${cfg.org_id}:`, e.message);
    try { await client.logout(); } catch {}
  }
}

// ─── Procesar un mensaje IMAP ─────────────────────────────────────────────────

async function procesarMensaje(msg, messageIdMap, consecutivoRe, orgId, reqs) {
  const inReplyTo = msg.envelope?.inReplyTo;
  const subject   = msg.envelope?.subject || '';
  const fromAddr  = msg.envelope?.from?.[0];
  const fromStr   = fromAddr
    ? `${fromAddr.name || ''} <${fromAddr.address || ''}>`.trim()
    : 'desconocido';

  let req = null;

  // Buscar por In-Reply-To primero
  if (inReplyTo) {
    const cleanId = inReplyTo.replace(/^<|>$/g, '').trim();
    req = messageIdMap.get(`<${cleanId}>`) || messageIdMap.get(cleanId);
  }

  // Fallback: buscar consecutivo en el asunto [VEE-2026-00001]
  if (!req && consecutivoRe.test(subject)) {
    const match = subject.match(/\[VEE-(\d{4}-\d+)\]/);
    if (match) {
      const cons = `VEE-${match[1]}`;
      req = reqs.find(r => r.consecutivo === cons) || null;
    }
  }

  if (!req) return; // este email no es respuesta a ningún DP nuestro

  // Extraer el cuerpo del email
  let cuerpoHtml = '';
  try {
    const textPart = msg.bodyParts?.get('TEXT');
    if (textPart) {
      cuerpoHtml = Buffer.isBuffer(textPart) ? textPart.toString('utf8') : String(textPart);
    }
  } catch {}

  if (!cuerpoHtml) cuerpoHtml = `<p>Respuesta recibida de: ${fromStr}</p><p>Asunto: ${subject}</p>`;

  // Guardar la respuesta en veedor_requerimientos
  const { error: updErr } = await supabase
    .from('veedor_requerimientos')
    .update({
      respuesta_html:    cuerpoHtml,
      respuesta_from:    fromStr,
      respuesta_subject: subject,
      fecha_respuesta:   new Date().toISOString(),
      estado:            'respuesta_recibida',
    })
    .eq('id', req.id);

  if (updErr) {
    console.error('[IMAP] Error actualizando requerimiento:', updErr.message);
    return;
  }

  // Actualizar el expediente asociado
  if (req.id_proceso) {
    await supabase
      .from('veeduria_expedientes')
      .update({ estado: 'respuesta_recibida', updated_at: new Date().toISOString() })
      .eq('id_contrato', req.id_proceso);
  }

  console.log(`[IMAP] Respuesta recibida — DP ${req.consecutivo} de ${fromStr}`);

  // Disparar análisis async (no bloquea el polling)
  dispararAnalisis(req.id).catch(e =>
    console.warn('[IMAP] veedor-analizar-respuesta no disparado:', e.message)
  );
}

async function dispararAnalisis(requerimientoId) {
  await supabase.functions.invoke('veedor-analizar-respuesta', {
    body: { requerimiento_id: String(requerimientoId) },
  });
}

async function actualizarPoll(orgId) {
  await supabase
    .from('veedor_org_smtp')
    .update({ last_imap_poll: new Date().toISOString() })
    .eq('org_id', orgId);
}
