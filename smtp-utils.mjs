/**
 * smtp-utils.mjs — Utilidades de email para Veedor
 *
 * - encrypt / decrypt: AES-256-GCM para guardar contraseñas SMTP en DB
 * - sendViaSmtp: envío con nodemailer usando las credenciales de la org
 * - sendViaResend: fallback a Resend cuando no hay SMTP configurado
 *
 * Clave de cifrado: process.env.SMTP_ENC_KEY (hex de 32 bytes = 64 chars)
 * Genera con: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import nodemailer from 'nodemailer';

// ── Cifrado AES-256-GCM ───────────────────────────────────────────────────────

function getKey() {
  const raw = process.env.SMTP_ENC_KEY;
  if (!raw || raw.length !== 64) {
    throw new Error('SMTP_ENC_KEY debe ser hex de 32 bytes (64 chars). Genera con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  return Buffer.from(raw, 'hex');
}

/**
 * Cifra un texto con AES-256-GCM.
 * Retorna: "<iv_hex>:<tag_hex>:<ciphertext_hex>"
 */
export function encrypt(plaintext) {
  const key = getKey();
  const iv  = randomBytes(12); // 96-bit nonce estándar para GCM
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

/**
 * Descifra un valor cifrado con encrypt().
 */
export function decrypt(encoded) {
  if (!encoded) return null;
  const [ivHex, tagHex, encHex] = encoded.split(':');
  if (!ivHex || !tagHex || !encHex) throw new Error('smtp_pass_enc tiene formato inválido');
  const key = getKey();
  const iv  = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const enc = Buffer.from(encHex, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(enc, undefined, 'utf8') + decipher.final('utf8');
}

// ── Envío via SMTP (nodemailer) ────────────────────────────────────────────────

/**
 * Crea un transporter de nodemailer a partir de la config de la org.
 * La contraseña llega ya descifrada.
 *
 * @param {object} cfg — fila de veedor_org_smtp (con smtp_pass_enc ya descifrado en smtp_pass)
 */
function crearTransport(cfg) {
  return nodemailer.createTransport({
    host:   cfg.smtp_host,
    port:   cfg.smtp_port ?? 587,
    secure: cfg.smtp_secure ?? false,    // true = TLS directo en 465
    auth: {
      user: cfg.smtp_user,
      pass: cfg.smtp_pass,               // descifrado por el caller
    },
    tls: {
      // Permite certs auto-firmados (Zoho Private, servidores locales)
      rejectUnauthorized: false,
    },
    // Timeout generoso para servidores lentos
    connectionTimeout: 15_000,
    greetingTimeout:   10_000,
    socketTimeout:     30_000,
  });
}

/**
 * Envía un email via SMTP propio de la veeduría.
 *
 * @param {object} cfg     — fila de veedor_org_smtp (con smtp_pass_enc ya descifrado en smtp_pass)
 * @param {object} options — { to, subject, html, messageId, replyTo, headers }
 * @returns {string} messageId efectivo usado
 */
export async function sendViaSmtp(cfg, { to, subject, html, messageId, replyTo, headers = {} }) {
  const transport = crearTransport(cfg);
  const fromAddr = cfg.from_name
    ? `${cfg.from_name} <${cfg.from_email || cfg.smtp_user}>`
    : (cfg.from_email || cfg.smtp_user);

  const info = await transport.sendMail({
    from:      fromAddr,
    to,
    replyTo:   replyTo || fromAddr,
    subject,
    html,
    messageId, // nodemailer lo pone en el header Message-ID
    headers,
  });

  return info.messageId || messageId;
}

/**
 * Fallback: envía via Resend cuando la veeduría no tiene SMTP configurado.
 *
 * @param {object} options — { from, to, subject, html, messageId, replyTo }
 */
export async function sendViaResend({ from, to, subject, html, messageId, replyTo }) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) throw new Error('RESEND_API_KEY no configurado y no hay SMTP propio');

  const rRes = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      from:     from || process.env.RESEND_FROM || 'Veeduría Ciudadana <veedor@numa.la>',
      to:       Array.isArray(to) ? to : [to],
      reply_to: replyTo || 'veedor@numa.la',
      subject,
      html,
      headers:  { 'Message-ID': messageId },
    }),
  });

  if (!rRes.ok) {
    const txt = await rRes.text();
    throw new Error(`Resend ${rRes.status}: ${txt.slice(0, 300)}`);
  }

  return messageId;
}

/**
 * Obtiene la config SMTP de una org (con contraseña descifrada).
 * Retorna null si la org no tiene SMTP configurado o está inactivo.
 *
 * @param {object} supabase — cliente Supabase (service role)
 * @param {string} orgId    — org_id de la veeduría
 */
export async function obtenerSmtpOrg(supabase, orgId) {
  const { data, error } = await supabase
    .from('veedor_org_smtp')
    .select('*')
    .eq('org_id', orgId)
    .eq('activo', true)
    .maybeSingle();

  if (error || !data) return null;

  try {
    const smtpPass = decrypt(data.smtp_pass_enc);
    return { ...data, smtp_pass: smtpPass };
  } catch (e) {
    console.warn(`[SMTP] No se pudo descifrar la contraseña de org ${orgId}:`, e.message);
    return null;
  }
}
