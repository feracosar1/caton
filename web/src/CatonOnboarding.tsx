/**
 * CatonOnboarding.tsx
 *
 * Wizard de onboarding para nuevos usuarios de CATÓN.
 * Se muestra cuando el usuario está autenticado pero NO tiene organización.
 *
 * Flujo:
 *   Paso 1 → Tipo de organización (veeduría / contraloría)
 *   Paso 2 → Datos de la organización (nombre, ciudad, departamento)
 *   Paso 3 → Invitar equipo (opcional)
 */
import { useState, type FormEvent } from 'react'
import { Loader2, Users, Building2, Shield, ChevronRight, Plus, X, Check } from 'lucide-react'
import type { CatonUser } from './useCatonAuth.js'
import { catonPost } from './catonClient.js'

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

// ── Departamentos de Colombia ─────────────────────────────────────────────────
const DEPARTAMENTOS = [
  'Amazonas','Antioquia','Arauca','Atlántico','Bolívar','Boyacá','Caldas',
  'Caquetá','Casanare','Cauca','Cesar','Chocó','Córdoba','Cundinamarca',
  'Guainía','Guaviare','Huila','La Guajira','Magdalena','Meta','Nariño',
  'Norte de Santander','Putumayo','Quindío','Risaralda','San Andrés y Providencia',
  'Santander','Sucre','Tolima','Valle del Cauca','Vaupés','Vichada',
]

interface Invitado {
  email: string
  rol: 'auditor' | 'coordinador'
}

interface CatonOnboardingProps {
  user: CatonUser
  onComplete: () => void
}

export function CatonOnboarding({ user, onComplete }: CatonOnboardingProps) {
  const [paso, setPaso] = useState<1 | 2 | 3>(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Paso 1
  const [orgTipo, setOrgTipo] = useState<'veeduria' | 'contraloria' | null>(null)

  // Paso 2
  const [orgNombre, setOrgNombre] = useState('')
  const [ciudad, setCiudad] = useState('')
  const [departamento, setDepartamento] = useState('')
  const [descripcion, setDescripcion] = useState('')
  const [orgId, setOrgId] = useState<string | null>(null)

  // Paso 3
  const [invEmail, setInvEmail] = useState('')
  const [invRol, setInvRol] = useState<'auditor' | 'coordinador'>('auditor')
  const [invitados, setInvitados] = useState<Invitado[]>([])
  const [invitandoLoading, setInvitandoLoading] = useState(false)

  // ── Estilos compartidos ───────────────────────────────────────────────────
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

  // ── Paso 2: Crear organización ────────────────────────────────────────────
  async function handleCrearOrg(e: FormEvent) {
    e.preventDefault()
    if (!orgTipo) return
    setError('')
    setLoading(true)
    try {
      // Crear la organización
      const orgRows = await catonPost('veedor_orgs', {
        nombre: orgNombre.trim(),
        tipo: orgTipo,
        ciudad: ciudad.trim(),
        departamento,
        descripcion: descripcion.trim() || null,
        activa: true,
        created_by: user.id,
      }) as Array<{ id: string }>

      const nuevoOrgId = Array.isArray(orgRows) ? orgRows[0]?.id : (orgRows as { id: string }).id
      setOrgId(nuevoOrgId)

      // Crear la membresía como director
      await catonPost('veedor_memberships', {
        org_id: nuevoOrgId,
        user_id: user.id,
        rol: 'director',
        activo: true,
      })

      setPaso(3)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al crear la organización')
    } finally {
      setLoading(false)
    }
  }

  // ── Paso 3: Agregar invitado a la lista local ─────────────────────────────
  function agregarInvitado() {
    const emailTrim = invEmail.trim().toLowerCase()
    if (!emailTrim) return
    if (invitados.some(i => i.email === emailTrim)) return
    setInvitados(prev => [...prev, { email: emailTrim, rol: invRol }])
    setInvEmail('')
  }

  function quitarInvitado(email: string) {
    setInvitados(prev => prev.filter(i => i.email !== email))
  }

  // ── Paso 3: Enviar invitaciones y terminar ────────────────────────────────
  async function handleFinalizar() {
    if (!orgId) { onComplete(); return }
    setInvitandoLoading(true)
    try {
      // Enviamos las invitaciones pendientes
      await Promise.allSettled(
        invitados.map(inv =>
          catonPost('veedor_invitaciones', {
            org_id: orgId,
            email: inv.email,
            rol: inv.rol,
            invitado_por: user.id,
            usado: false,
          })
        )
      )
    } catch {
      // Fallo silencioso — no bloqueamos el onboarding por invitaciones fallidas
    } finally {
      setInvitandoLoading(false)
      onComplete()
    }
  }

  // ── Render indicador de pasos ─────────────────────────────────────────────
  function PasoIndicador() {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 32 }}>
        {([1, 2, 3] as const).map((p, i) => (
          <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              width: 28, height: 28, borderRadius: '50%',
              background: paso >= p ? DKGRN : INK12,
              color: paso >= p ? WHITE : INK55,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 13, fontWeight: 700,
              transition: 'all 0.2s',
            }}>
              {paso > p ? <Check size={14} /> : p}
            </div>
            {i < 2 && (
              <div style={{
                width: 32, height: 2,
                background: paso > p ? DKGRN : INK12,
                transition: 'all 0.2s',
              }} />
            )}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div style={{
      minHeight: '100dvh', background: CREAM,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '24px 16px',
    }}>
      <div style={{
        width: '100%', maxWidth: 520,
        background: WHITE, borderRadius: 16,
        border: `1px solid ${INK12}`,
        boxShadow: `0 4px 24px rgba(11,31,26,0.08)`,
        padding: '40px 32px',
      }}>

        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 8 }}>
          <p style={{ fontSize: 12, color: INK55, margin: '0 0 4px', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700 }}>
            Bienvenido, {user.nombre.split(' ')[0]}
          </p>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: INK, margin: 0 }}>
            Configura tu organización
          </h1>
        </div>

        <PasoIndicador />

        {/* ── PASO 1: Tipo de organización ── */}
        {paso === 1 && (
          <div>
            <p style={{ fontSize: 14, color: INK55, marginBottom: 20, textAlign: 'center' }}>
              ¿Qué tipo de organización representa?
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              {([
                {
                  key: 'veeduria' as const,
                  icon: <Users size={32} color={orgTipo === 'veeduria' ? WHITE : DKGRN} />,
                  title: 'Veeduría Ciudadana',
                  desc: 'Organización civil que vigila la contratación pública en su municipio o región.',
                },
                {
                  key: 'contraloria' as const,
                  icon: <Shield size={32} color={orgTipo === 'contraloria' ? WHITE : DKGRN} />,
                  title: 'Contraloría',
                  desc: 'Entidad de control fiscal con facultades para auditar el gasto público.',
                },
              ]).map(opt => (
                <button
                  key={opt.key}
                  onClick={() => setOrgTipo(opt.key)}
                  style={{
                    padding: '20px 16px', borderRadius: 12,
                    border: `2px solid ${orgTipo === opt.key ? DKGRN : INK12}`,
                    background: orgTipo === opt.key ? DKGRN : WHITE,
                    cursor: 'pointer', textAlign: 'left',
                    transition: 'all 0.15s',
                  }}
                >
                  <div style={{ marginBottom: 10 }}>{opt.icon}</div>
                  <div style={{
                    fontSize: 14, fontWeight: 700,
                    color: orgTipo === opt.key ? WHITE : INK,
                    marginBottom: 6,
                  }}>
                    {opt.title}
                  </div>
                  <div style={{
                    fontSize: 12, color: orgTipo === opt.key ? 'rgba(255,255,255,0.75)' : INK55,
                    lineHeight: 1.4,
                  }}>
                    {opt.desc}
                  </div>
                </button>
              ))}
            </div>
            <button
              onClick={() => orgTipo && setPaso(2)}
              disabled={!orgTipo}
              style={{
                marginTop: 24, width: '100%', padding: '11px 0',
                fontSize: 14, fontWeight: 700, borderRadius: 8, border: 'none',
                cursor: orgTipo ? 'pointer' : 'not-allowed',
                background: orgTipo ? GREEN : INK12, color: orgTipo ? WHITE : INK55,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              }}
            >
              Continuar <ChevronRight size={16} />
            </button>
          </div>
        )}

        {/* ── PASO 2: Datos de la organización ── */}
        {paso === 2 && (
          <form onSubmit={handleCrearOrg} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {error && (
              <div style={{
                background: '#FEF2F2', border: '1px solid #FECACA',
                borderRadius: 8, padding: '10px 14px', fontSize: 13, color: RED,
              }}>
                {error}
              </div>
            )}
            <div>
              <label style={labelStyle}>Nombre de la organización *</label>
              <input
                type="text" required value={orgNombre}
                onChange={e => setOrgNombre(e.target.value)}
                placeholder={orgTipo === 'veeduria' ? 'Veeduría Ciudadana del Norte' : 'Contraloría Municipal de…'}
                style={inputStyle}
              />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={labelStyle}>Ciudad *</label>
                <input
                  type="text" required value={ciudad}
                  onChange={e => setCiudad(e.target.value)}
                  placeholder="Bogotá"
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={labelStyle}>Departamento *</label>
                <select
                  required value={departamento}
                  onChange={e => setDepartamento(e.target.value)}
                  style={{ ...inputStyle, cursor: 'pointer' }}
                >
                  <option value="">Seleccionar…</option>
                  {DEPARTAMENTOS.map(d => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label style={labelStyle}>Descripción (opcional)</label>
              <textarea
                value={descripcion}
                onChange={e => setDescripcion(e.target.value)}
                placeholder="Breve descripción del objeto de la organización…"
                rows={3}
                style={{ ...inputStyle, resize: 'vertical' as const, fontFamily: 'inherit' }}
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
              {loading ? 'Creando…' : 'Crear organización'}
            </button>
          </form>
        )}

        {/* ── PASO 3: Invitar equipo ── */}
        {paso === 3 && (
          <div>
            <p style={{ fontSize: 13, color: INK55, marginBottom: 20, textAlign: 'center' }}>
              Puedes invitar miembros de tu equipo ahora o hacerlo más tarde desde Configuración.
            </p>

            {/* Formulario de invitación */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <input
                type="email" value={invEmail}
                onChange={e => setInvEmail(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), agregarInvitado())}
                placeholder="correo@email.com"
                style={{ ...inputStyle, flex: 1 }}
              />
              <select
                value={invRol}
                onChange={e => setInvRol(e.target.value as 'auditor' | 'coordinador')}
                style={{ ...inputStyle, width: 'auto', minWidth: 120 }}
              >
                <option value="auditor">Auditor</option>
                <option value="coordinador">Coordinador</option>
              </select>
              <button
                type="button" onClick={agregarInvitado}
                style={{
                  padding: '10px 14px', borderRadius: 8, border: `1px solid ${INK12}`,
                  background: INK06, cursor: 'pointer', color: DKGRN,
                  display: 'flex', alignItems: 'center',
                }}
              >
                <Plus size={16} />
              </button>
            </div>

            {/* Lista de invitados */}
            {invitados.length > 0 && (
              <div style={{
                border: `1px solid ${INK12}`, borderRadius: 8,
                overflow: 'hidden', marginBottom: 16,
              }}>
                {invitados.map(inv => (
                  <div key={inv.email} style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '10px 12px', borderBottom: `1px solid ${INK06}`,
                  }}>
                    <div>
                      <span style={{ fontSize: 13, color: INK }}>{inv.email}</span>
                      <span style={{
                        marginLeft: 8, fontSize: 11, fontWeight: 700,
                        color: GOLD, textTransform: 'uppercase' as const,
                      }}>
                        {inv.rol}
                      </span>
                    </div>
                    <button
                      onClick={() => quitarInvitado(inv.email)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: INK55, padding: 4 }}
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button
                onClick={handleFinalizar}
                disabled={invitandoLoading}
                style={{
                  width: '100%', padding: '11px 0', fontSize: 14, fontWeight: 700,
                  borderRadius: 8, border: 'none', cursor: invitandoLoading ? 'not-allowed' : 'pointer',
                  background: invitandoLoading ? '#6BA88C' : DKGRN, color: WHITE,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                }}
              >
                {invitandoLoading && <Loader2 size={16} className="animate-spin" />}
                {invitandoLoading ? 'Enviando…' : invitados.length > 0 ? `Invitar ${invitados.length} persona${invitados.length > 1 ? 's' : ''} y comenzar` : 'Comenzar'}
              </button>
              {invitados.length === 0 && (
                <button
                  onClick={handleFinalizar}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: INK55, fontSize: 13, textDecoration: 'underline',
                    padding: 4,
                  }}
                >
                  Continuar sin invitar
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
