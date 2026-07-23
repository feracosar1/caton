# CLAUDE.md — Veedor / Catón

Este directorio es el proyecto **Veedor / Catón** — herramienta de veeduría ciudadana. Es completamente independiente de NUMA.

---

## ⛔ PROHIBICIÓN ABSOLUTA — NUNCA deployar a Netlify desde este directorio

**El CLI de Netlify en esta máquina está vinculado al sitio `numa180` (numa.la = PRODUCCIÓN de NUMA).**

Si corres `netlify deploy` desde este directorio, **reemplazas la app de producción de NUMA con el frontend de Catón**. Eso es un incidente crítico.

### NUNCA hacer:
```bash
netlify deploy          # ← NUNCA
netlify deploy --prod   # ← NUNCA
netlify link            # ← NUNCA sin confirmar el site correcto
netlify build           # ← NUNCA (buildea para Netlify)
```

El archivo `netlify.toml` en este directorio existe solo para configurar el proxy `/api/veedor/*` — no es para deployar.

---

## Deploy del frontend de Catón

El frontend de Catón se sirve desde el **Azure VM** (no Netlify):

```bash
# 1. Build local
cd /Users/fernandoaraujo/numa-sesion/veedor/web
npm run build

# 2. Copiar a Azure VM
scp -i "/Users/fernandoaraujo/Downloads/numa-scraper_key.pem" \
  -r dist/* azureuser@20.84.48.138:~/caton/public/
```

El VM sirve los archivos estáticos con Express o Nginx desde `~/caton/public/`.

---

## Deploy del backend de Catón

Usar el script existente:

```bash
cd /Users/fernandoaraujo/numa-sesion/veedor
./deploy.sh
```

O manualmente:
```bash
scp -i "/Users/fernandoaraujo/Downloads/numa-scraper_key.pem" \
  endpoints-veeduria.mjs azureuser@20.84.48.138:~/veedor/
# Luego SSH y: pm2 restart veedor-api
```

---

## Estructura del proyecto

```
veedor/
  web/              → Frontend React (Catón UI)
    src/
      VeeduriaExpedientes.tsx  → Componente principal
      exportDenuncia.ts        → Export Word (.docx) — usar Packer.toBlob (NO toBuffer)
      exportDocx.ts            → Helpers docx compartidos
  endpoints-veeduria.mjs       → Backend Express (API REST)
  deploy.sh                    → Script deploy backend a Azure VM
  netlify.toml                 → SOLO para proxy config — NO para deployar
```

---

## Azure VM — Datos de conexión

```bash
# SSH
ssh -i "/Users/fernandoaraujo/Downloads/numa-scraper_key.pem" azureuser@20.84.48.138

# IP del VM
20.84.48.138

# Usuario
azureuser

# Key
/Users/fernandoaraujo/Downloads/numa-scraper_key.pem
```

---

## Bugs conocidos y fixes aplicados

### ✅ Word export — usar `Packer.toBlob` no `Packer.toBuffer`
`toBuffer()` es Node.js-only. En el browser usar `Packer.toBlob(doc)`.

### ✅ 401 en buscar-async — token síncrono
Los efectos de hijos React corren ANTES que los del padre. `api.setAuthToken(token)` debe llamarse **sincrónicamente** en el render del padre, no en `useEffect`.

### ✅ 500 en /grafo/rep-multiple — timeout graceful
Socrata puede tardar. Usar `Promise.race` con timeout de 22s y retornar `{ senales: [], timeout: true }` en lugar de 500.

### ✅ 500 en /grafo/carruseles — catch antes del race
Si `detectarCarruseles` falla, el reject bypasa el timeout en `Promise.race`. Fix: `.catch(() => [])` antes del race.

---

## Supabase del proyecto Catón

- URL: `sedldbxesnsyohkidrtm.supabase.co`
- Cliente: `src/features/caton/catonClient.ts` (en el repo de NUMA, no en este repo)
- Es un Supabase separado — no es el de NUMA

---

## Reglas generales

- Responder siempre en español
- No tocar archivos de NUMA desde este directorio
- El `netlify.toml` es solo configuración del proxy — no para CI/CD
