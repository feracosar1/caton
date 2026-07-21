/**
 * CatonApp.tsx
 *
 * Componente raíz de CATÓN. Gestiona el ciclo auth → onboarding → app.
 * Maneja el routing interno de /caton/* con react-router-dom.
 *
 * Flujo:
 *   loading    → spinner centrado
 *   sin user   → <CatonAuthPage>
 *   user sin org → <CatonOnboarding>
 *   user con org → <CatonLayout> + rutas
 */
import { Suspense, lazy } from 'react'
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { useCatonAuth } from './useCatonAuth.js'
import { CatonAuthPage } from './CatonAuthPage.js'
import { CatonOnboarding } from './CatonOnboarding.js'
import { CatonLayout } from './CatonLayout.js'
import { CatonRequerimientos } from './CatonRequerimientos.js'
import { CatonAdminPage } from './CatonAdminPage.js'
import { CatonConfigPage } from './CatonConfigPage.js'
import { CATON_URL, CATON_ANON } from './catonClient.js'

// ── Lazy imports para páginas pesadas ────────────────────────────────────────
const VeeduriaExpedientes = lazy(() =>
  import('./VeeduriaExpedientes.js').then(m => ({ default: m.VeeduriaExpedientes }))
)

// ── Paleta mínima ─────────────────────────────────────────────────────────────
const DKGRN = '#0F3D2E'
const CREAM  = '#F5F3EF'
const GOLD   = '#C6A15B'

// ── Placeholders para páginas no implementadas aún ───────────────────────────

function PlaceholderPage({ titulo, descripcion }: { titulo: string; descripcion: string }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', height: '100%', minHeight: 400,
      gap: 12, padding: 32, textAlign: 'center',
    }}>
      <div style={{
        width: 64, height: 64, borderRadius: 16,
        background: 'rgba(15,61,46,0.08)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 28, marginBottom: 4,
      }}>
        🚧
      </div>
      <h2 style={{ fontSize: 18, fontWeight: 800, color: DKGRN, margin: 0 }}>
        {titulo}
      </h2>
      <p style={{ fontSize: 13, color: 'rgba(11,31,26,0.55)', margin: 0, maxWidth: 320 }}>
        {descripcion}
      </p>
    </div>
  )
}

// ── Componente principal ──────────────────────────────────────────────────────

export function CatonApp() {
  const { user, loading, signIn, signUp, signOut, token, reload } = useCatonAuth()

  // 1. Cargando sesión
  if (loading) {
    return (
      <div style={{
        height: '100dvh', background: CREAM,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: 16,
      }}>
        <Loader2 size={32} color={DKGRN} className="animate-spin" />
        <span style={{ fontSize: 13, color: 'rgba(11,31,26,0.55)' }}>
          Cargando CATÓN…
        </span>
      </div>
    )
  }

  // 2. Sin sesión → pantalla de login
  if (!user) {
    return <CatonAuthPage onSignIn={signIn} onSignUp={signUp} />
  }

  // 3. Usuario sin organización → no debería pasar (invitación crea la membresía)
  //    Admins lo saltan; cualquier otro ve mensaje de espera
  if (!user.orgId && !user.esAdmin) {
    return (
      <div style={{
        height: '100dvh', background: '#F5F3EF',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: 12, padding: 32, textAlign: 'center',
      }}>
        <div style={{
          width: 48, height: 48, borderRadius: 12,
          background: 'rgba(15,61,46,0.08)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 22,
        }}>
          🔒
        </div>
        <h2 style={{ fontSize: 17, fontWeight: 800, color: '#0B1F1A', margin: 0 }}>
          Sin organización asignada
        </h2>
        <p style={{ fontSize: 13, color: 'rgba(11,31,26,0.55)', margin: 0, maxWidth: 300 }}>
          Tu cuenta aún no tiene una organización. Contacta al administrador de CATÓN para que te asigne una.
        </p>
        <button
          onClick={signOut}
          style={{
            marginTop: 8, padding: '8px 20px', fontSize: 13, fontWeight: 700,
            borderRadius: 8, border: '1px solid rgba(11,31,26,0.15)',
            background: 'white', cursor: 'pointer', color: '#0B1F1A',
          }}
        >
          Cerrar sesión
        </button>
      </div>
    )
  }

  // 4. Usuario autenticado con org → shell principal + rutas
  return (
    <CatonLayout user={user} onSignOut={signOut}>
      <Suspense fallback={
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          height: '100%', minHeight: 300,
        }}>
          <Loader2 size={24} color={DKGRN} className="animate-spin" />
        </div>
      }>
        <Routes>
          {/* Redirige la raíz a expedientes */}
          <Route path="/" element={<Navigate to="expedientes" replace />} />

          {/*
           * Expedientes — motor principal de CATÓN.
           * Pasamos el token de CATÓN y las credenciales de CATÓN
           * para que VeeduriaExpedientes use su propio Supabase.
           */}
          <Route
            path="/expedientes"
            element={
              <VeeduriaExpedientes
                token={token}
                veedor_org_id={user.orgId ?? undefined}
                sbUrl={CATON_URL}
                sbAnon={CATON_ANON}
              />
            }
          />

          {/* Requerimientos — bandeja de entrada */}
          <Route
            path="/requerimientos"
            element={<CatonRequerimientos user={user} />}
          />

          {/* Cronograma — pendiente de implementar */}
          <Route
            path="/cronograma"
            element={
              <PlaceholderPage
                titulo="Cronograma"
                descripcion="Vista de seguimiento de plazos y fechas críticas de cada expediente. Próximamente."
              />
            }
          />

          {/* Equipo — solo director/coordinador */}
          <Route
            path="/equipo"
            element={
              (user.rol === 'director' || user.rol === 'coordinador') ? (
                <PlaceholderPage
                  titulo="Gestión de equipo"
                  descripcion="Administra los miembros de tu organización, sus roles e invitaciones pendientes. Próximamente."
                />
              ) : (
                <Navigate to="expedientes" replace />
              )
            }
          />

          {/* Panel analítico — solo director/coordinador */}
          <Route
            path="/panel"
            element={
              (user.rol === 'director' || user.rol === 'coordinador') ? (
                <PlaceholderPage
                  titulo="Panel de control"
                  descripcion="Estadísticas de expedientes, requerimientos y actividad del equipo. Próximamente."
                />
              ) : (
                <Navigate to="expedientes" replace />
              )
            }
          />

          {/* Configuración */}
          <Route
            path="/configuracion"
            element={<CatonConfigPage user={user} />}
          />

          {/* Administración — solo super admins de CATÓN */}
          <Route
            path="/admin"
            element={
              user.esAdmin ? (
                <CatonAdminPage user={user} />
              ) : (
                <Navigate to="expedientes" replace />
              )
            }
          />

          {/* Fallback */}
          <Route path="*" element={<Navigate to="expedientes" replace />} />
        </Routes>
      </Suspense>
    </CatonLayout>
  )
}
