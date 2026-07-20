/**
 * CAPTCHA SOLVER — 2captcha.com
 *
 * Resuelve reCAPTCHA v2 via API de 2captcha.
 * Costo: ~$0.001 por captcha (~$0.10/día para 100 pliegos)
 *
 * Variable requerida: CAPTCHA_API_KEY (de 2captcha.com)
 */

import https from 'https';

let API_KEY = process.env.CAPTCHA_API_KEY;
const IN_URL  = 'https://2captcha.com/in.php';
const RES_URL = 'https://2captcha.com/res.php';
const MAX_WAIT_MS = 120_000; // 2 min máximo

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Veedor-SECOP/1.0' } }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * Resuelve un reCAPTCHA v2.
 * @param {string} siteKey  - data-sitekey del elemento g-recaptcha
 * @param {string} pageUrl  - URL completa de la página donde está el captcha
 * @returns {string} token  - valor para g-recaptcha-response
 */
export async function resolverRecaptcha(siteKey, pageUrl) {
  // Leer en tiempo de ejecución por si dotenv se cargó después del import
  if (!API_KEY) API_KEY = process.env.CAPTCHA_API_KEY;
  if (!API_KEY) throw new Error('CAPTCHA_API_KEY no configurada en .env');

  // 1. Enviar el captcha a 2captcha
  const submitUrl = `${IN_URL}?key=${API_KEY}&method=userrecaptcha&googlekey=${encodeURIComponent(siteKey)}&pageurl=${encodeURIComponent(pageUrl)}&json=1`;
  const submitRes = await httpGet(submitUrl);
  const submitData = JSON.parse(submitRes);

  if (submitData.status !== 1) {
    throw new Error(`2captcha submit error: ${submitData.request}`);
  }

  const taskId = submitData.request;
  console.log(`[CAPTCHA] Task ${taskId} enviada a 2captcha...`);

  // 2. Polling hasta que esté resuelto (normalmente 15-30 seg)
  const started = Date.now();
  while (Date.now() - started < MAX_WAIT_MS) {
    await new Promise(r => setTimeout(r, 5_000)); // esperar 5s entre intentos

    const pollUrl = `${RES_URL}?key=${API_KEY}&action=get&id=${taskId}&json=1`;
    const pollRes = await httpGet(pollUrl);
    const pollData = JSON.parse(pollRes);

    if (pollData.status === 1) {
      console.log(`[CAPTCHA] Resuelta en ${Math.round((Date.now()-started)/1000)}s`);
      return pollData.request; // el token reCAPTCHA
    }

    if (pollData.request !== 'CAPCHA_NOT_READY') {
      throw new Error(`2captcha poll error: ${pollData.request}`);
    }
  }

  throw new Error('2captcha timeout — no resolvió en 2 minutos');
}
