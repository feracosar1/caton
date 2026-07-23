# CLAUDE.md — Veedor / Catón

Este directorio es el proyecto **Veedor / Catón** — herramienta de veeduría ciudadana. Es completamente independiente de NUMA.

---

## Deploy del frontend de Catón → Netlify vía git

**Catón tiene su propio sitio en Netlify**, conectado al repo `feracosar1/caton` en GitHub.

### ✅ La forma correcta de deployar:
```bash
git add <archivos>
git commit -m "..."
git push origin main   # ← Netlify detecta el push y buildea automáticamente
```

### ⛔ NUNCA usar el CLI de Netlify manualmente:
```bash
netlify deploy          # ← PROHIBIDO — el CLI local puede estar vinculado a NUMA
netlify deploy --prod   # ← PROHIBIDO
netlify link            # ← PROHIBIDO sin verificar el site_id
```

**Por qué:** el CLI de Netlify en esta máquina podría estar vinculado a `numa180` (numa.la = producción de NUMA). Ejecutar `netlify deploy` manualmente desde aquí puede reemplazar NUMA con Catón — eso ya pasó y es un incidente crítico. El deploy **siempre** va por git push.

---

## Deploy del backend de Catón (Azure VM)

---

El backend (Node.js/Express) corre en Azure VM. Usar el script existente:

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
