/**
 * CatonAuthPage.tsx
 *
 * Página de autenticación exclusiva de CATÓN.
 * Completamente independiente del auth de NUMA.
 *
 * Tabs: "Ingresar" / "Registrarse" / magic link para olvido de contraseña.
 */
import { useState, type FormEvent } from 'react'
// onSignUp se mantiene en la interfaz para no romper CatonApp, pero no se expone en UI
import { Loader2, Shield } from 'lucide-react'
import type { CatonUser } from './useCatonAuth.js'
import { catonMagicLink } from './catonClient.js'

// ── Paleta ────────────────────────────────────────────────────────────────────
const DKGRN = '#0F3D2E'
const GREEN  = '#1D9E75'
const INK    = '#0B1F1A'
const CREAM  = '#F5F3EF'
const GOLD   = '#C6A15B'
const WHITE  = '#FFFFFF'
const RED    = '#DC2626'
const INK12  = 'rgba(11,31,26,0.12)'
const INK06  = 'rgba(11,31,26,0.06)'
const INK55  = 'rgba(11,31,26,0.55)'

interface CatonAuthPageProps {
  onSignIn: (email: string, password: string) => Promise<void>
  onSignUp: (email: string, password: string, nombre: string) => Promise<void>
}

type MagicState = 'idle' | 'sending' | 'sent'

export function CatonAuthPage({ onSignIn }: CatonAuthPageProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [magicState, setMagicState] = useState<MagicState>('idle')
  const [showMagic, setShowMagic] = useState(false)

  // ── Campos login ─────────────────────────────────────────────────────────
  const [loginEmail, setLoginEmail] = useState('')
  const [loginPassword, setLoginPassword] = useState('')

  async function handleLogin(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await onSignIn(loginEmail.trim(), loginPassword)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error de autenticación')
    } finally {
      setLoading(false)
    }
  }

  // ── Magic link ────────────────────────────────────────────────────────────
  async function handleMagicLink(e: FormEvent) {
    e.preventDefault()
    setMagicState('sending')
    try {
      await catonMagicLink(loginEmail.trim())
      setMagicState('sent')
    } catch {
      setMagicState('idle')
      setError('No se pudo enviar el enlace. Verifica el email.')
    }
  }

  // ── Estilos ───────────────────────────────────────────────────────────────
  const inputStyle = {
    width: '100%', padding: '10px 12px', fontSize: 14,
    border: `1px solid ${INK12}`, borderRadius: 8,
    background: WHITE, color: INK, outline: 'none',
    boxSizing: 'border-box' as const,
  }
  const labelStyle = {
    display: 'block', fontSize: 12, fontWeight: 700 as const,
    color: INK55, marginBottom: 4,
  }

  return (
    <div style={{
      minHeight: '100dvh', background: CREAM,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '24px 16px',
    }}>
      <div style={{
        width: '100%', maxWidth: 400,
        background: WHITE, borderRadius: 16,
        border: `1px solid ${INK12}`,
        boxShadow: `0 4px 24px rgba(11,31,26,0.08)`,
        padding: '40px 32px',
      }}>

        {/* ── Encabezado ── */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 8 }}>
            <Shield size={28} color={DKGRN} strokeWidth={2} />
            <span style={{
              fontFamily: 'monospace', fontSize: 28, fontWeight: 900,
              letterSpacing: '0.12em', color: DKGRN,
            }}>
              CATÓN
            </span>
          </div>
          <p style={{ fontSize: 13, color: INK55, margin: 0 }}>
            Sistema de Control de Contratación Pública
          </p>
        </div>

        {/* ── Error global ── */}
        {error && (
          <div style={{
            background: '#FEF2F2', border: '1px solid #FECACA',
            borderRadius: 8, padding: '10px 14px', marginBottom: 16,
            fontSize: 13, color: RED,
          }}>
            {error}
          </div>
        )}

        {/* ── Login ── */}
        {!showMagic && (
          <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label style={labelStyle}>Correo electrónico</label>
              <input
                type="email" required value={loginEmail}
                onChange={e => setLoginEmail(e.target.value)}
                placeholder="tu@email.com"
                style={inputStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>Contraseña</label>
              <input
                type="password" required value={loginPassword}
                onChange={e => setLoginPassword(e.target.value)}
                placeholder="••••••••"
                style={inputStyle}
              />
            </div>
            <button
              type="submit" disabled={loading}
              style={{
                width: '100%', padding: '11px 0', fontSize: 14, fontWeight: 700,
                borderRadius: 8, border: 'none', cursor: loading ? 'not-allowed' : 'pointer',
                background: loading ? '#6BA88C' : GREEN, color: WHITE,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              }}
            >
              {loading && <Loader2 size={16} className="animate-spin" />}
              {loading ? 'Ingresando…' : 'Ingresar'}
            </button>
            <button
              type="button"
              onClick={() => { setShowMagic(true); setError('') }}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: DKGRN, fontSize: 13, textDecoration: 'underline',
                padding: 0, textAlign: 'center',
              }}
            >
              ¿Olvidaste tu contraseña? Recibir enlace de acceso
            </button>
          </form>
        )}

        {/* ── Magic link ── */}
        {showMagic && (
          <div>
            {magicState === 'sent' ? (
              <div style={{ textAlign: 'center', padding: '16px 0' }}>
                <div style={{
                  width: 48, height: 48, borderRadius: '50%',
                  background: '#D1FAE5', display: 'flex',
                  alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px',
                  fontSize: 22,
                }}>
                  ✓
                </div>
                <p style={{ fontSize: 14, color: INK, margin: '0 0 4px', fontWeight: 600 }}>
                  Enlace enviado
                </p>
                <p style={{ fontSize: 13, color: INK55, margin: 0 }}>
                  Revisa tu correo y haz clic en el enlace para ingresar.
                </p>
                <button
                  onClick={() => { setShowMagic(false); setMagicState('idle') }}
                  style={{
                    marginTop: 16, background: 'none', border: 'none',
                    cursor: 'pointer', color: DKGRN, fontSize: 13, textDecoration: 'underline',
                  }}
                >
                  Volver al login
                </button>
              </div>
            ) : (
              <form onSubmit={handleMagicLink} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <p style={{ fontSize: 13, color: INK55, margin: 0 }}>
                  Ingresa tu correo y te enviaremos un enlace de acceso sin contraseña.
                </p>
                <div>
                  <label style={labelStyle}>Correo electrónico</label>
                  <input
                    type="email" required value={loginEmail}
                    onChange={e => setLoginEmail(e.target.value)}
                    placeholder="tu@email.com"
                    style={inputStyle}
                  />
                </div>
                <button
                  type="submit" disabled={magicState === 'sending'}
                  style={{
                    width: '100%', padding: '11px 0', fontSize: 14, fontWeight: 700,
                    borderRadius: 8, border: 'none', cursor: magicState === 'sending' ? 'not-allowed' : 'pointer',
                    background: magicState === 'sending' ? '#6BA88C' : GREEN, color: WHITE,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  }}
                >
                  {magicState === 'sending' && <Loader2 size={16} className="animate-spin" />}
                  {magicState === 'sending' ? 'Enviando…' : 'Enviar enlace'}
                </button>
                <button
                  type="button"
                  onClick={() => { setShowMagic(false); setError('') }}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: INK55, fontSize: 13, textDecoration: 'underline',
                    padding: 0, textAlign: 'center',
                  }}
                >
                  Cancelar
                </button>
              </form>
            )}
          </div>
        )}

        {/* ── Footer ── */}
        <div style={{ marginTop: 28, paddingTop: 20, borderTop: `1px solid ${INK06}`, textAlign: 'center' }}>
          <p style={{ fontSize: 11, color: INK55, margin: 0 }}>
            Sistema de veeduría ciudadana sobre contratación pública colombiana.
            <br />
            Datos abiertos de <span style={{ color: GOLD, fontWeight: 600 }}>SECOP II</span>.
          </p>
        </div>
      </div>
    </div>
  )
}
