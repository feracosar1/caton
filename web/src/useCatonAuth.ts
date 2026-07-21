/**
 * useCatonAuth.ts
 *
 * Hook de autenticación exclusivo para CATÓN.
 * Maneja su propio estado de sesión, completamente independiente de NUMA.
 *
 * Al montar:
 *  1. Llama catonGetUser() para validar el token almacenado.
 *  2. Si hay usuario, carga su membresía desde veedor_memberships JOIN veedor_orgs.
 */
import { useState, useEffect, useCallback } from 'react'
import {
  catonGetUser,
  catonSignIn,
  catonSignUp,
  clearCatonToken,
  catonGet,
  catonRpc,
  catonToken,
} from './catonClient.js'

// ── Tipos ─────────────────────────────────────────────────────────────────────

export interface CatonUser {
  /** UUID del usuario en Supabase Auth de CATÓN */
  id: string
  email: string
  /** Nombre tomado de auth.user.user_metadata.nombre */
  nombre: string
  /** ID de la organización activa del usuario */
  orgId: string | null
  /** Nombre de la organización */
  orgNombre: string | null
  /** Tipo de organización */
  orgTipo: 'veeduria' | 'contraloria' | null
  /** Rol del usuario dentro de la organización */
  rol: 'auditor' | 'coordinador' | 'director' | null
  /** true si el usuario está en caton_admin_allowlist */
  esAdmin: boolean
}

// ── Tipos internos de la DB de CATÓN ─────────────────────────────────────────

interface AuthUserRaw {
  id: string
  email: string
  user_metadata?: { nombre?: string }
}

interface MembershipRow {
  rol: string
  activo: boolean
  veedor_orgs: {
    id: string
    nombre: string
    tipo: string
  }
}

// ── Hook principal ────────────────────────────────────────────────────────────

export function useCatonAuth(): {
  user: CatonUser | null
  loading: boolean
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string, nombre: string) => Promise<void>
  signOut: () => void
  token: string
  reload: () => void
} {
  const [user, setUser] = useState<CatonUser | null>(null)
  const [loading, setLoading] = useState(true)

  /**
   * Dada la data cruda del usuario de GoTrue, carga su membresía
   * y construye el objeto CatonUser completo.
   */
  const buildUser = useCallback(async (raw: AuthUserRaw): Promise<CatonUser> => {
    const base: CatonUser = {
      id: raw.id,
      email: raw.email ?? '',
      nombre: raw.user_metadata?.nombre ?? raw.email ?? '',
      orgId: null,
      orgNombre: null,
      orgTipo: null,
      rol: null,
      esAdmin: false,
    }

    // Cargamos membresía y estado de admin en paralelo
    await Promise.all([
      (async () => {
        try {
          const rows = await catonGet(
            `veedor_memberships?select=rol,activo,veedor_orgs(id,nombre,tipo)&user_id=eq.${raw.id}&activo=eq.true&limit=1`
          ) as MembershipRow[]

          if (rows && rows.length > 0) {
            const m = rows[0]
            base.orgId    = m.veedor_orgs?.id   ?? null
            base.orgNombre = m.veedor_orgs?.nombre ?? null
            base.orgTipo  = (m.veedor_orgs?.tipo ?? null) as CatonUser['orgTipo']
            base.rol      = (m.rol ?? null) as CatonUser['rol']
          }
        } catch {
          // Si falla la carga de membresía, el onboarding guiará al usuario
        }
      })(),
      (async () => {
        try {
          // is_caton_admin() es SECURITY DEFINER — no depende de grants de PostgREST
          const result = await catonRpc('is_caton_admin', {}) as boolean
          base.esAdmin = result === true
        } catch {
          base.esAdmin = false
        }
      })(),
    ])

    return base
  }, [])

  /** Verifica la sesión actual y puebla el estado. */
  const checkSession = useCallback(async () => {
    setLoading(true)
    try {
      const raw = await catonGetUser() as unknown as AuthUserRaw | null
      if (!raw) {
        setUser(null)
        return
      }
      const builtUser = await buildUser(raw)
      setUser(builtUser)
    } catch {
      setUser(null)
    } finally {
      setLoading(false)
    }
  }, [buildUser])

  // Al montar el hook, verificamos la sesión guardada
  useEffect(() => {
    void checkSession()
  }, [checkSession])

  /** Login con email y contraseña. */
  const signIn = useCallback(async (email: string, password: string): Promise<void> => {
    setLoading(true)
    try {
      await catonSignIn(email, password)
      await checkSession()
    } finally {
      setLoading(false)
    }
  }, [checkSession])

  /** Registro de usuario nuevo. */
  const signUp = useCallback(async (
    email: string,
    password: string,
    nombre: string,
  ): Promise<void> => {
    // catonSignUp no guarda tokens — el usuario debe confirmar email primero
    await catonSignUp(email, password, nombre)
  }, [])

  /** Cierra la sesión limpiando los tokens. */
  const signOut = useCallback(() => {
    clearCatonToken()
    setUser(null)
  }, [])

  return {
    user,
    loading,
    signIn,
    signUp,
    signOut,
    token: catonToken(),
    reload: checkSession,
  }
}
