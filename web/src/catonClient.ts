/**
 * catonClient.ts
 *
 * Cliente REST directo para el Supabase de CATÓN.
 * NO usa @supabase/supabase-js para evitar múltiples instancias de GoTrueClient
 * en la misma página (conflicto con el Supabase de NUMA).
 *
 * Todas las llamadas van con Authorization: Bearer {token} y apikey en header.
 */

// ── Credenciales CATÓN ────────────────────────────────────────────────────────
export const CATON_URL  = 'https://sedldbxesnsyohkidrtm.supabase.co'
export const CATON_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNlZGxkYnhlc25zeW9oa2lkcnRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5Mjg3NDMsImV4cCI6MjA5NjUwNDc0M30.d6l2CEPv_QKK1wVfHrPBzWP4btJ1rssDfxderLvngIs'

// ── Manejo de tokens en localStorage ─────────────────────────────────────────

/** Lee el access token actual de CATÓN. Retorna string vacío si no hay sesión. */
export function catonToken(): string {
  return localStorage.getItem('caton_access_token') ?? ''
}

/** Persiste los tokens de sesión de CATÓN. */
export function setCatonToken(accessToken: string, refreshToken: string): void {
  localStorage.setItem('caton_access_token', accessToken)
  localStorage.setItem('caton_refresh_token', refreshToken)
}

/** Elimina todos los tokens de CATÓN del localStorage. */
export function clearCatonToken(): void {
  localStorage.removeItem('caton_access_token')
  localStorage.removeItem('caton_refresh_token')
}

// ── Headers comunes ───────────────────────────────────────────────────────────

function authHeaders(token?: string): HeadersInit {
  const t = token ?? catonToken()
  return {
    'apikey': CATON_ANON,
    'Authorization': `Bearer ${t || CATON_ANON}`,
    'Content-Type': 'application/json',
  }
}

// ── GoTrue — Auth endpoints ───────────────────────────────────────────────────

/** Obtiene el usuario autenticado actual. Retorna null si el token es inválido o no hay sesión.
 *  Si el token expiró (401/403), intenta refresh automático antes de rendirse. */
export async function catonGetUser(): Promise<Record<string, unknown> | null> {
  const token = catonToken()
  if (!token) return null
  try {
    const res = await fetch(`${CATON_URL}/auth/v1/user`, {
      headers: {
        'apikey': CATON_ANON,
        'Authorization': `Bearer ${token}`,
      },
    })
    // Token expirado → intentar refresh y reintentar
    if (res.status === 401 || res.status === 403) {
      const refreshed = await catonRefreshToken()
      if (!refreshed) return null
      const res2 = await fetch(`${CATON_URL}/auth/v1/user`, {
        headers: {
          'apikey': CATON_ANON,
          'Authorization': `Bearer ${catonToken()}`,
        },
      })
      if (!res2.ok) return null
      return await res2.json() as Record<string, unknown>
    }
    if (!res.ok) return null
    return await res.json() as Record<string, unknown>
  } catch {
    return null
  }
}

/** Login con email y contraseña. Guarda los tokens y retorna los datos del usuario. */
export async function catonSignIn(email: string, password: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${CATON_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'apikey': CATON_ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as Record<string, unknown>
    throw new Error((err.error_description as string) || (err.msg as string) || 'Error de autenticación')
  }
  const data = await res.json() as Record<string, unknown>
  setCatonToken(data.access_token as string, data.refresh_token as string)
  return data
}

/** Registro con email, contraseña y nombre. El email necesita confirmación. */
export async function catonSignUp(
  email: string,
  password: string,
  nombre: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${CATON_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: { 'apikey': CATON_ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, data: { nombre } }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as Record<string, unknown>
    throw new Error((err.msg as string) || (err.error_description as string) || 'Error al registrar')
  }
  return await res.json() as Record<string, unknown>
}

/** Envía un magic link al email indicado (OTP passwordless). */
export async function catonMagicLink(email: string): Promise<void> {
  const res = await fetch(`${CATON_URL}/auth/v1/otp`, {
    method: 'POST',
    headers: { 'apikey': CATON_ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as Record<string, unknown>
    throw new Error((err.msg as string) || 'No se pudo enviar el enlace mágico')
  }
}

/** Refresca el access token usando el refresh token guardado. */
export async function catonRefreshToken(): Promise<boolean> {
  const refreshToken = localStorage.getItem('caton_refresh_token')
  if (!refreshToken) return false
  try {
    const res = await fetch(`${CATON_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'apikey': CATON_ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    })
    if (!res.ok) {
      clearCatonToken()
      return false
    }
    const data = await res.json() as Record<string, unknown>
    setCatonToken(data.access_token as string, data.refresh_token as string)
    return true
  } catch {
    clearCatonToken()
    return false
  }
}

// ── REST — PostgREST endpoints ────────────────────────────────────────────────

/** Intenta refresh si la respuesta REST es 401. Retorna la nueva respuesta o la original. */
async function withRefresh(fetchFn: () => Promise<Response>): Promise<Response> {
  const res = await fetchFn()
  if (res.status === 401 || res.status === 403) {
    const refreshed = await catonRefreshToken()
    if (refreshed) return fetchFn()
  }
  return res
}

/** GET a una tabla o vista PostgREST. Incluye el token de autenticación. */
export async function catonGet(path: string): Promise<unknown> {
  const res = await withRefresh(() => fetch(`${CATON_URL}/rest/v1/${path}`, {
    headers: authHeaders(),
  }))
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as Record<string, unknown>
    throw new Error((err.message as string) || `Error ${res.status}`)
  }
  return res.json()
}

/**
 * POST a una tabla PostgREST.
 * Usa Prefer: return=representation para que la DB devuelva la fila creada.
 */
export async function catonPost(path: string, body: Record<string, unknown>): Promise<unknown> {
  const bodyStr = JSON.stringify(body)
  const res = await withRefresh(() => fetch(`${CATON_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Prefer': 'return=representation' },
    body: bodyStr,
  }))
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as Record<string, unknown>
    throw new Error((err.message as string) || `Error ${res.status}`)
  }
  return res.json()
}

/**
 * PATCH a filas que cumplan el query (ej: `tabla?id=eq.123`).
 * Usa Prefer: return=representation para obtener las filas actualizadas.
 */
export async function catonPatch(
  path: string,
  query: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const bodyStr = JSON.stringify(body)
  const res = await withRefresh(() => fetch(`${CATON_URL}/rest/v1/${path}?${query}`, {
    method: 'PATCH',
    headers: { ...authHeaders(), 'Prefer': 'return=representation' },
    body: bodyStr,
  }))
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as Record<string, unknown>
    throw new Error((err.message as string) || `Error ${res.status}`)
  }
  return res.json()
}

/** DELETE a filas que cumplan el query (ej: `tabla?id=eq.123`). */
export async function catonDelete(path: string, query: string): Promise<void> {
  const res = await fetch(`${CATON_URL}/rest/v1/${path}?${query}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as Record<string, unknown>
    throw new Error((err.message as string) || `Error ${res.status}`)
  }
}

/** Llama a una Edge Function del Supabase de CATÓN. */
export async function catonFunction(
  name: string,
  body: Record<string, unknown> = {},
): Promise<unknown> {
  const res = await fetch(`${CATON_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      'apikey': CATON_ANON,
      'Authorization': `Bearer ${catonToken() || CATON_ANON}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as Record<string, unknown>
    throw new Error((err.error as string) || `Error ${res.status}`)
  }
  return res.json()
}

/** Llama a una función RPC (stored procedure) de Supabase. */
export async function catonRpc(
  fn: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const res = await fetch(`${CATON_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(params),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as Record<string, unknown>
    throw new Error((err.message as string) || `Error ${res.status}`)
  }
  return res.json()
}
