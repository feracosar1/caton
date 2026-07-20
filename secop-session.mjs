/**
 * SECOP SESSION MANAGER
 *
 * Flujo completo sin browser:
 *   1. Login con usuario/clave → STSAuthenticationCookie
 *   2. Si SECOP pide reCAPTCHA → 2captcha resuelve → token enviado a SECOP
 *   3. Con cookies válidas → descarga cualquier PDF directamente
 *
 * Variables de entorno:
 *   SECOP_USER        — usuario SECOP II
 *   SECOP_PASS        — contraseña
 *   CAPTCHA_API_KEY   — clave de 2captcha.com
 */

import https from 'https';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolverRecaptcha } from './captcha-solver.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COOKIES_FILE = join(__dirname, '.secop-session.json');
const SECOP_HOST   = 'community.secop.gov.co';
const RECAPTCHA_SITEKEY = '6LcMmakZAAAAAB157Q90hORUGtNd790TCws4vBNw';

// ── Estado de sesión ──────────────────────────────────────────────────────────
let session = { cookies: {}, loggedIn: false, lastLogin: null };

// ── Circuit breaker de login ──────────────────────────────────────────────────
// Sin esto, un login fallido no detiene la cola: cada item vuelve a llamar a
// login(), y 500 items = 500 intentos contra el STS → SECOP bloquea la cuenta.
// El breaker corta al 3er fallo consecutivo y obliga a esperar antes de
// reintentar. Los errores SECOP_* son fatales: la cola debe abortar, no seguir.
const MAX_FALLOS_LOGIN = 3;
const COOLDOWN_BASE_MS = 15 * 60 * 1000;   // 15 min tras la primera tanda de fallos

let fallosLogin  = 0;
let cooldownHasta = 0;
let loginEnCurso  = null;   // single-flight: un solo login concurrente

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Throttle entre peticiones: SECOP tolera navegación humana, no ráfagas.
const MIN_GAP_MS = 3_000;
let ultimaPeticion = 0;

async function throttle() {
  const desde = Date.now() - ultimaPeticion;
  if (desde < MIN_GAP_MS) {
    // jitter ±40% para no marcar un patrón de reloj
    const espera = (MIN_GAP_MS - desde) * (0.8 + Math.random() * 0.4);
    await sleep(Math.round(espera));
  }
  ultimaPeticion = Date.now();
}

if (existsSync(COOKIES_FILE)) {
  try {
    session = JSON.parse(readFileSync(COOKIES_FILE, 'utf8'));
    const edad = Date.now() - (session.lastLogin || 0);
    if (edad < 3 * 60 * 60 * 1000) console.log('[SECOP] Sesión previa cargada (válida)');
    else session.loggedIn = false; // expirada
  } catch { /* ignorar */ }
}

function guardar() {
  try { writeFileSync(COOKIES_FILE, JSON.stringify(session)); } catch { /**/ }
}

function parseCookies(headers) {
  const result = {};
  for (const h of (headers['set-cookie'] || [])) {
    const eq = h.indexOf('='), sc = h.indexOf(';');
    if (eq > 0) result[h.slice(0, eq).trim()] = h.slice(eq + 1, sc > 0 ? sc : undefined).trim();
  }
  return result;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
async function httpReq(method, host, path, body, cookies, extra) {
  await throttle();
  return new Promise((resolve, reject) => {
    const cookieStr = Object.entries(cookies || {}).map(([k, v]) => `${k}=${v}`).join('; ');
    const headers = {
      'Host': host,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-CO,es;q=0.9',
      ...(extra || {}),
    };
    if (cookieStr) headers['Cookie'] = cookieStr;
    if (body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body).toString();
    }
    const req = https.request({ hostname: host, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString(),
        bodyBuf: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => { req.destroy(); reject(new Error('HTTP timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

// ── Seguir redirects ──────────────────────────────────────────────────────────
async function fetchFollowing(host, path, cookies, maxRedirects = 5) {
  let h = host, p = path, c = { ...cookies };
  for (let i = 0; i < maxRedirects; i++) {
    const res = await httpReq('GET', h, p, null, c);
    Object.assign(c, parseCookies(res.headers));

    // Si SECOP redirige al captcha → cargarlo, extraer mkey, resolver y hacer GET a CaptchaCheck
    if (res.headers.location?.includes('GoogleReCaptcha') || res.body.includes('g-recaptcha')) {
      console.log('[SECOP] reCAPTCHA detectado → resolviendo con 2captcha...');

      // 1. Obtener la URL de la página de captcha
      const captchaRelPath = res.headers.location
        ? (res.headers.location.startsWith('http') ? new URL(res.headers.location).pathname + new URL(res.headers.location).search : res.headers.location)
        : p; // si ya estamos en la página captcha (body tiene g-recaptcha)

      // 2. GET la página del captcha para obtener su mkey
      const captchaPage = await httpReq('GET', SECOP_HOST, captchaRelPath, null, c);
      Object.assign(c, parseCookies(captchaPage.headers));

      // Extraer mkey del botón: onclick="...CaptchaCheck...&mkey=XXX"
      // El onclick tiene comillas JS intercaladas, usar [\s\S]*? para cruzarlas
      const captchaMkey = (captchaPage.body.match(/CaptchaCheck[\s\S]*?mkey=([a-f0-9_-]+)/) || [])[1];
      if (!captchaMkey) throw new Error('No se pudo extraer mkey de la página de captcha');

      // 3. Resolver el captcha con 2captcha
      const captchaPageUrl = `https://${SECOP_HOST}${captchaRelPath}`;
      const token = await resolverRecaptcha(RECAPTCHA_SITEKEY, captchaPageUrl);

      // 4. GET CaptchaCheck?responseKey={token}&mkey={mkey}  ← así lo hace el navegador
      const checkPath = `/Public/Common/GoogleReCaptcha/CaptchaCheck?responseKey=${encodeURIComponent(token)}&mkey=${captchaMkey}`;
      const checkRes = await httpReq('GET', SECOP_HOST, checkPath, null, c);
      Object.assign(c, parseCookies(checkRes.headers));

      // 5. Seguir redirect de CaptchaCheck → debería llevarnos a la página original
      if (checkRes.status >= 300 && checkRes.status < 400 && checkRes.headers.location) {
        const loc = checkRes.headers.location;
        if (loc.startsWith('http')) { const u = new URL(loc); h = u.hostname; p = u.pathname + u.search; }
        else p = loc;
      }
      // Si no hubo redirect, reintentar la URL original en la siguiente iteración
      continue;
    }

    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      const loc = res.headers.location;
      if (loc.startsWith('http')) { const u = new URL(loc); h = u.hostname; p = u.pathname + u.search; }
      else p = loc;
    } else {
      return { ...res, cookies: c };
    }
  }
  throw new Error('Demasiados redirects');
}

// ── Login (con circuit breaker + single-flight) ──────────────────────────────
export async function login() {
  if (Date.now() < cooldownHasta) {
    const min = Math.ceil((cooldownHasta - Date.now()) / 60_000);
    throw new Error(`SECOP_COOLDOWN: ${fallosLogin} logins fallidos seguidos — en pausa ${min} min para no bloquear la cuenta`);
  }
  // Si ya hay un login en vuelo, esperar ese en vez de lanzar otro.
  if (loginEnCurso) return loginEnCurso;

  loginEnCurso = _login()
    .then(() => { fallosLogin = 0; })
    .catch((err) => {
      // Cuenta ya bloqueada por SECOP → fatal inmediato, no reintentar jamás
      if (String(err.message).startsWith('SECOP_ACCOUNT_LOCKED')) {
        cooldownHasta = Date.now() + 24 * 60 * 60 * 1000;
        throw err;
      }
      fallosLogin++;
      if (fallosLogin >= MAX_FALLOS_LOGIN) {
        cooldownHasta = Date.now() + COOLDOWN_BASE_MS * fallosLogin;
        throw new Error(`SECOP_COOLDOWN: ${fallosLogin} logins fallidos seguidos (último: ${err.message}) — pausa para no bloquear la cuenta`);
      }
      throw err;
    })
    .finally(() => { loginEnCurso = null; });

  return loginEnCurso;
}

async function _login() {
  const user = process.env.SECOP_USER;
  const pass = process.env.SECOP_PASS;
  if (!user || !pass) throw new Error('SECOP_USER y SECOP_PASS requeridos');

  console.log(`[SECOP] Login como ${user}...`);

  // 1. GET login page → cookies iniciales + mkey
  const page = await httpReq('GET', SECOP_HOST, '/STS/Users/Login/Index', null, {});
  const c0 = parseCookies(page.headers);
  const mkey = (page.body.match(/LoginAuthenticate\?mkey=([a-f0-9_]+)/) || [])[1];
  if (!mkey) throw new Error('No se pudo obtener mkey del formulario de login');

  // 2. Resolver reCAPTCHA del login si está activo (no solo presente en el HTML)
  //    SECOP incluye el div en el HTML siempre pero lo muestra (sin display:none)
  //    solo cuando el captcha es requerido para la sesión/IP.
  //    Flujo correcto (2 pasos):
  //      a. Resolver captcha con 2captcha → token
  //      b. GET /STS/Users/Login/CaptchaCheck?responseKey=<token>&mkey=<mkey>
  //      c. POST LoginAuthenticate SIN g-recaptcha-response en el body
  const captchaDivStyle = (page.body.match(/id="divGoogleReCaptchaDiv"[^>]*style="([^"]*)"/) || [])[1] ?? '';
  const captchaRequired = (page.body.includes('g-recaptcha') || page.body.includes('recaptcha'))
    && !captchaDivStyle.includes('display:none');

  if (captchaRequired) {
    console.log('[SECOP] reCAPTCHA activo en login → resolviendo con 2captcha...');
    try {
      const token = await resolverRecaptcha(RECAPTCHA_SITEKEY, `https://${SECOP_HOST}/STS/Users/Login/Index`);
      console.log('[SECOP] CAPTCHA resuelto OK → verificando con CaptchaCheck...');

      // Llamar al endpoint de verificación de captcha (paso b)
      const checkPath = `/STS/Users/Login/CaptchaCheck?responseKey=${encodeURIComponent(token)}&mkey=${mkey}`;
      const checkRes = await httpReq('GET', SECOP_HOST, checkPath, null, c0, {
        'Referer': `https://${SECOP_HOST}/STS/Users/Login/Index`,
        'X-Requested-With': 'XMLHttpRequest',
      });
      // Mezclar cookies que devuelva CaptchaCheck
      Object.assign(c0, parseCookies(checkRes.headers));
      console.log('[SECOP] CaptchaCheck OK (status', checkRes.status, ')');
    } catch (e) {
      console.warn('[SECOP] CAPTCHA/CaptchaCheck falló:', e.message, '— intentando login sin verificación');
    }
  }

  // 3. POST credenciales (SIN g-recaptcha-response — el captcha ya fue verificado por separado)
  const bodyParams = new URLSearchParams({
    VB_txtUserName: user,
    VB_txtPassword: pass,
    VB_txttxtCaptcha: '',
    Post_Back_Action_Name_Hidden: 'LoginAuthenticate',
    Post_Back_Arguments_Hidden: '',
    hdnAtLoginPage: '',
    username: user,
    password: pass,
  });

  const loginRes = await httpReq('POST', SECOP_HOST, `/STS/Users/Login/LoginAuthenticate?mkey=${mkey}`, bodyParams.toString(), c0, {
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': `https://${SECOP_HOST}/STS/Users/Login/Index`,
  });

  const authCookies = { ...c0, ...parseCookies(loginRes.headers) };
  if (!authCookies.STSAuthenticationCookie) {
    // Detectar cuenta bloqueada: el span de bloqueo existe y no tiene display:none propio
    const lockedCtx = (loginRes.body.match(/id="spnlblAccountLocked"[^>]*>([^<]*)/) || [])[0] ?? '';
    const locked = lockedCtx.length > 0 && !lockedCtx.includes('display:none');
    if (locked) throw new Error('SECOP_ACCOUNT_LOCKED: Cuenta bloqueada por intentos fallidos — debes desbloquearla en https://community.secop.gov.co/STS/Users/Login/Index');
    const errMsg = (loginRes.body.match(/spnlblFailureText[^>]*>([^<]+)/) || [])[1]?.trim();
    throw new Error(`Login fallido — ${errMsg || 'no se obtuvo STSAuthenticationCookie'}`);
  }

  session.cookies  = authCookies;
  session.loggedIn = true;
  session.lastLogin = Date.now();
  guardar();
  console.log('[SECOP] Login OK ✓');
}

// ── Obtener documentos de un proceso ─────────────────────────────────────────
export async function obtenerDocumentosDeProceso(noticeUID) {
  if (!session.loggedIn) await login();

  console.log(`[SECOP] Buscando documentos para ${noticeUID}...`);
  const path = `/Public/Tendering/OpportunityDetail/Index?noticeUID=${encodeURIComponent(noticeUID)}`;
  const res = await fetchFollowing(SECOP_HOST, path, session.cookies);
  Object.assign(session.cookies, res.cookies);
  guardar();

  if (res.status !== 200) throw new Error(`HTTP ${res.status} al obtener detalle de proceso`);

  // ── Extraer documentos por documentFileId + mkey (patrón real de SECOP II) ──
  const links = [];
  const seenIds = new Set();

  // Patron: documentFileId=' + '783898404' + '&mkey=282fc659_9cf9_4b1f_9c37_0cf32bd09a45'
  const mkeysFound = new Set();
  for (const m of res.body.matchAll(/documentFileId=(?:' \+ ')?(\d{6,12})(?:' \+ ')?&mkey=([a-f0-9_-]{20,})/g)) {
    const fileId = m[1];
    const mkey   = m[2];
    if (seenIds.has(fileId)) continue;
    seenIds.add(fileId);
    mkeysFound.add(mkey);

    // Intentar encontrar nombre del documento en el contexto cercano
    const idx = res.body.indexOf(fileId);
    const ctx = res.body.slice(Math.max(0, idx - 400), idx + 200);
    const nombreMatch = ctx.match(/title="([^"]{3,100})"|data-title="([^"]{3,100})"|<span[^>]*>([^<]{3,80})<\/span>/i);
    const nombre = nombreMatch ? (nombreMatch[1] || nombreMatch[2] || nombreMatch[3] || '').trim() : '';

    // URL directa al archivo (bypasa el JS redirect de DownloadFile)
    const url = `https://${SECOP_HOST}/Public/Archive/RetrieveFile/Index?DocumentId=${fileId}&InCommunity=False&InPaymentGateway=False&DocUniqueIdentifier=`;
    links.push({ nombre, url, fileId, tipo: clasificar(nombre + ' ' + url) });
  }

  // Fallback: links directos en href
  if (links.length === 0) {
    for (const m of res.body.matchAll(/href="([^"]{10,400})"/gi)) {
      const href = m[1];
      if (seenIds.has(href)) continue;
      seenIds.add(href);
      const l = href.toLowerCase();
      if (l.includes('download') || l.includes('.pdf') || l.includes('documento') || l.includes('pliego')) {
        const fullUrl = href.startsWith('http') ? href : `https://${SECOP_HOST}${href}`;
        links.push({ url: fullUrl, tipo: clasificar(href) });
      }
    }
  }

  console.log(`[SECOP] ${links.length} documentos encontrados para ${noticeUID}`);
  return links;
}

// ── Descargar PDF con sesión activa ───────────────────────────────────────────
export async function descargarConSesion(url) {
  const cuatroHoras = 4 * 60 * 60 * 1000;
  if (!session.loggedIn || !session.lastLogin || Date.now() - session.lastLogin > cuatroHoras) {
    await login();
  }

  const parsed = new URL(url);
  const res = await fetchFollowing(parsed.hostname, parsed.pathname + parsed.search, session.cookies);
  Object.assign(session.cookies, res.cookies);
  guardar();

  if (res.status !== 200) throw new Error(`HTTP ${res.status} descargando ${url}`);
  return res.bodyBuf;
}

function clasificar(url) {
  const u = url.toLowerCase();
  if (u.includes('pliego')) return 'pliego';
  if (u.includes('estudio')) return 'estudios_previos';
  if (u.includes('adenda')) return 'adenda';
  if (u.includes('anexo')) return 'anexo';
  return 'otro';
}

export { login as ensureSession };
