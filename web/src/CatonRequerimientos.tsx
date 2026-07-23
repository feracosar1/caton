/**
 * CatonRequerimientos.tsx
 *
 * Bandeja de entrada de requerimientos enviados por la veeduría.
 * Lista los registros de veedor_requerimientos de la org actual.
 *
 * Estados posibles de un requerimiento:
 *   - enviado       → ámbar (esperando respuesta)
 *   - respondido    → verde
 *   - vencido       → rojo (fecha_limite_respuesta superada sin respuesta)
 */
import { useState, useEffect } from 'react'
import { Inbox, Clock, CheckCircle, AlertCircle, RefreshCw, FileText, Radar } from 'lucide-react'
import { catonGet } from './catonClient.js'
import type { CatonUser } from './useCatonAuth.js'

// ── Paleta ────────────────────────────────────────────────────────────────────
const DKGRN = '#0F3D2E'
const GREEN  = '#1D9E75'
const INK    = '#0B1F1A'
const CREAM  = '#F5F3EF'
const GOLD   = '#C6A15B'
const WHITE  = '#FFFFFF'
const RED    = '#DC2626'
const AMBER  = '#D97706'
const INK12  = 'rgba(11,31,26,0.12)'
const INK06  = 'rgba(11,31,26,0.06)'
const INK55  = 'rgba(11,31,26,0.55)'

// ── Tipos ─────────────────────────────────────────────────────────────────────

interface Requerimiento {
  id: string
  tipo: 'derecho_peticion' | 'tutela' | string
  estado: 'enviado' | 'respondido' | 'vencido' | string
  entidad_nombre: string
  entidad_email: string | null
  fecha_envio: string | null
  fecha_limite_respuesta: string | null
  fecha_respuesta: string | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function diasRestantes(fechaLimite: string | null): number | null {
  if (!fechaLimite) return null
  const limite = new Date(fechaLimite)
  const hoy = new Date()
  const diff = Math.ceil((limite.getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24))
  return diff
}

function fmtFecha(s: string | null): string {
  if (!s) return '—'
  return new Date(s).toLocaleDateString('es-CO', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
}

function calcEstado(r: Requerimiento): 'respondido' | 'vencido' | 'enviado' {
  if (r.estado === 'respondido' || r.fecha_respuesta) return 'respondido'
  const dias = diasRestantes(r.fecha_limite_respuesta)
  if (dias !== null && dias < 0) return 'vencido'
  return 'enviado'
}

// ── Componente principal ──────────────────────────────────────────────────────

interface CatonRequerimientosProps {
  user: CatonUser
}

export function CatonRequerimientos({ user }: CatonRequerimientosProps) {
  const [requerimientos, setRequerimientos] = useState<Requerimiento[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filtroEstado, setFiltroEstado] = useState<'todos' | 'enviado' | 'respondido' | 'vencido'>('todos')

  const orgId = user.orgId

  async function cargar() {
    if (!orgId) { setLoading(false); return }
    setLoading(true)
    setError('')
    try {
      const rows = await catonGet(
        `veedor_requerimientos?select=id,tipo,estado,entidad_nombre,entidad_email,fecha_envio,fecha_limite_respuesta,fecha_respuesta&veedor_org_id=eq.${orgId}&order=created_at.desc&limit=50`
      ) as Requerimiento[]
      setRequerimientos(rows ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar requerimientos')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void cargar()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId])

  // ── Filtrado ──────────────────────────────────────────────────────────────
  const requerimientosFiltrados = requerimientos.filter(r => {
    if (filtroEstado === 'todos') return true
    return calcEstado(r) === filtroEstado
  })

  // ── Contadores para los chips de filtro ───────────────────────────────────
  const contadores = {
    todos: requerimientos.length,
    enviado: requerimientos.filter(r => calcEstado(r) === 'enviado').length,
    respondido: requerimientos.filter(r => calcEstado(r) === 'respondido').length,
    vencido: requerimientos.filter(r => calcEstado(r) === 'vencido').length,
  }

  // ── Badge de estado ───────────────────────────────────────────────────────
  function BadgeEstado({ r }: { r: Requerimiento }) {
    const estado = calcEstado(r)
    const config = {
      respondido: { color: GREEN, bg: '#D1FAE5', icon: <CheckCircle size={12} />, label: 'Respondido' },
      vencido:    { color: RED,   bg: '#FEE2E2', icon: <AlertCircle size={12} />, label: 'Vencido' },
      enviado:    { color: AMBER, bg: '#FEF3C7', icon: <Clock size={12} />,        label: 'Esperando' },
    }
    const c = config[estado]
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 999,
        color: c.color, background: c.bg,
      }}>
        {c.icon} {c.label}
      </span>
    )
  }

  return (
    <div style={{ padding: '32px 32px 48px', maxWidth: 900 }}>
      {/* Encabezado */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: INK, margin: '0 0 4px' }}>
            Requerimientos
          </h1>
          <p style={{ fontSize: 13, color: INK55, margin: 0 }}>
            Derechos de petición y tutelas enviados a entidades públicas
          </p>
        </div>
        <button
          onClick={cargar}
          disabled={loading}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 14px', borderRadius: 8,
            border: `1px solid ${INK12}`, background: WHITE,
            color: DKGRN, fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Actualizar
        </button>
      </div>

      {/* Chips de filtro */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {(['todos', 'enviado', 'respondido', 'vencido'] as const).map(f => {
          const activo = filtroEstado === f
          const labelMap = { todos: 'Todos', enviado: 'Esperando', respondido: 'Respondidos', vencido: 'Vencidos' }
          const colorMap = { todos: DKGRN, enviado: AMBER, respondido: GREEN, vencido: RED }
          return (
            <button
              key={f}
              onClick={() => setFiltroEstado(f)}
              style={{
                padding: '6px 14px', borderRadius: 999, border: 'none',
                cursor: 'pointer', fontSize: 13, fontWeight: activo ? 700 : 500,
                background: activo ? colorMap[f] : INK06,
                color: activo ? WHITE : INK55,
                transition: 'all 0.12s',
              }}
            >
              {labelMap[f]} ({contadores[f]})
            </button>
          )
        })}
      </div>

      {/* Error */}
      {error && (
        <div style={{
          background: '#FEF2F2', border: '1px solid #FECACA',
          borderRadius: 8, padding: '12px 16px', marginBottom: 16,
          fontSize: 13, color: RED,
        }}>
          {error}
        </div>
      )}

      {/* Loading — animación Catón */}
      {loading && (
        <div style={{ padding: '48px 0 32px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
          <div style={{ position: 'relative', width: 56, height: 56 }}>
            <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: `3px solid ${INK}`, opacity: 0.08 }} />
            <div style={{
              position: 'absolute', inset: 0, borderRadius: '50%',
              border: `3px solid transparent`, borderTopColor: GOLD, borderRightColor: GOLD,
              animation: 'spin 1s linear infinite',
            }} />
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Radar size={20} color={INK} style={{ opacity: 0.6 }} />
            </div>
          </div>
          <span style={{ fontSize: 13, fontWeight: 600, color: INK55 }}>Consultando requerimientos…</span>
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        </div>
      )}

      {/* Lista vacía */}
      {!loading && requerimientosFiltrados.length === 0 && (
        <div style={{
          background: WHITE, border: `1px solid ${INK12}`, borderRadius: 12,
          padding: '48px 32px', textAlign: 'center',
        }}>
          <Inbox size={40} color={INK55} style={{ marginBottom: 12 }} />
          <p style={{ fontSize: 15, fontWeight: 700, color: INK, margin: '0 0 6px' }}>
            {filtroEstado === 'todos' ? 'Sin requerimientos aún' : `Sin requerimientos ${filtroEstado === 'enviado' ? 'en espera' : filtroEstado === 'respondido' ? 'respondidos' : 'vencidos'}`}
          </p>
          <p style={{ fontSize: 13, color: INK55, margin: 0 }}>
            Los requerimientos enviados desde la vista de expedientes aparecerán aquí.
          </p>
        </div>
      )}

      {/* Tarjetas de requerimientos */}
      {!loading && requerimientosFiltrados.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {requerimientosFiltrados.map(r => {
            const estado = calcEstado(r)
            const dias = diasRestantes(r.fecha_limite_respuesta)
            const borderColor = estado === 'respondido' ? '#86EFAC' : estado === 'vencido' ? '#FCA5A5' : '#FDE68A'

            return (
              <div
                key={r.id}
                style={{
                  background: WHITE, borderRadius: 12,
                  border: `1px solid ${INK12}`,
                  borderLeft: `4px solid ${borderColor}`,
                  padding: '16px 20px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
                  <div style={{ flex: 1 }}>
                    {/* Entidad + tipo */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 15, fontWeight: 700, color: INK }}>
                        {r.entidad_nombre}
                      </span>
                      <span style={{
                        fontSize: 11, fontWeight: 700, padding: '2px 8px',
                        borderRadius: 999, background: INK06, color: INK55,
                        textTransform: 'capitalize',
                      }}>
                        {r.tipo === 'derecho_peticion' ? 'Derecho de petición'
                          : r.tipo === 'tutela' ? 'Tutela'
                          : r.tipo}
                      </span>
                      <BadgeEstado r={r} />
                    </div>

                    {/* Metadatos */}
                    <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, color: INK55 }}>
                        <span style={{ fontWeight: 600 }}>Enviado:</span> {fmtFecha(r.fecha_envio)}
                      </span>
                      {r.fecha_limite_respuesta && (
                        <span style={{
                          fontSize: 12,
                          color: estado === 'vencido' ? RED : estado === 'enviado' && dias !== null && dias <= 3 ? AMBER : INK55,
                          fontWeight: estado !== 'respondido' ? 600 : 400,
                        }}>
                          {estado === 'respondido'
                            ? `Respondido: ${fmtFecha(r.fecha_respuesta)}`
                            : estado === 'vencido'
                            ? `Venció: ${fmtFecha(r.fecha_limite_respuesta)} (hace ${Math.abs(dias!)} días)`
                            : `Límite: ${fmtFecha(r.fecha_limite_respuesta)} (${dias} días)`}
                        </span>
                      )}
                      {r.entidad_email && (
                        <span style={{ fontSize: 12, color: INK55 }}>
                          {r.entidad_email}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Acciones */}
                  <div style={{ display: 'flex', gap: 8 }}>
                    {r.fecha_respuesta && (
                      <button
                        style={{
                          display: 'flex', alignItems: 'center', gap: 6,
                          padding: '6px 12px', borderRadius: 8,
                          border: `1px solid ${INK12}`, background: WHITE,
                          color: DKGRN, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                        }}
                      >
                        <FileText size={13} /> Ver respuesta
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
