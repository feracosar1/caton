/**
 * CatonLayout.tsx
 *
 * Shell principal de la aplicación CATÓN.
 * Sidebar oscuro izquierdo + área de contenido principal.
 * Diseño: papel notarial / tinta oscura / sello dorado.
 */
import { type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  FileText, Inbox, Calendar, Users, BarChart2,
  Settings, LogOut, Shield, ShieldAlert,
} from 'lucide-react'
import type { CatonUser } from './useCatonAuth.js'

// ── Paleta CATÓN ──────────────────────────────────────────────────────────────
const PANTALLA  = '#0A241A'   // sidebar bg — verde muy oscuro
const PAPEL     = '#F5F1E8'   // fondo principal — papel envejecido
const TINTA     = '#0A2E22'   // texto principal
const SELLO     = '#96712A'   // dorado sello notarial
const ORO_CLARO = '#E3C57E'   // dorado claro — acentos activos
const HALLAZGO  = '#B0392C'   // rojo hallazgo
const OK        = '#1E7F4E'   // verde OK
const WHITE     = '#FFFFFF'
const W8        = 'rgba(255,255,255,0.08)'
const W12       = 'rgba(255,255,255,0.12)'
const W25       = 'rgba(255,255,255,0.25)'
const W55       = 'rgba(255,255,255,0.55)'
const W80       = 'rgba(255,255,255,0.80)'

// ── Tipos ─────────────────────────────────────────────────────────────────────

interface NavItem {
  path: string
  label: string
  icon: ReactNode
  /** Solo visible para ciertos roles */
  soloRoles?: Array<CatonUser['rol']>
  /** Solo visible para admins CATÓN */
  soloAdmin?: boolean
  /** Badge con número de pendientes */
  badge?: number
  /** Grupo de sección en el sidebar */
  section: 'operacion' | 'organizacion'
}

interface CatonLayoutProps {
  children: ReactNode
  user: CatonUser
  onSignOut: () => void
  /** Número de requerimientos pendientes para el badge */
  pendientes?: number
}

// ── NavButton ─────────────────────────────────────────────────────────────────

function NavBtn({ item, active, onClick }: { item: NavItem; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 16px', border: 'none', cursor: 'pointer', marginBottom: 1,
        background: 'transparent',
        color: active ? WHITE : W55,
        fontSize: 13, fontWeight: active ? 600 : 400,
        textAlign: 'left', transition: 'color 0.1s',
        position: 'relative',
        borderLeft: active ? `2px solid ${ORO_CLARO}` : '2px solid transparent',
        borderRadius: 0,
      }}
      onMouseEnter={e => {
        if (!active) (e.currentTarget as HTMLButtonElement).style.color = W80
      }}
      onMouseLeave={e => {
        if (!active) (e.currentTarget as HTMLButtonElement).style.color = W55
      }}
    >
      <span style={{ color: active ? ORO_CLARO : W55, flexShrink: 0, transition: 'color 0.1s' }}>
        {item.icon}
      </span>
      <span style={{ flex: 1, letterSpacing: '0.01em' }}>{item.label}</span>
      {item.badge !== undefined && (
        <span style={{
          background: HALLAZGO, color: WHITE,
          fontSize: 10, fontWeight: 800,
          borderRadius: 10, padding: '1px 7px',
          minWidth: 20, textAlign: 'center',
        }}>
          {item.badge > 99 ? '99+' : item.badge}
        </span>
      )}
    </button>
  )
}

// ── Componente principal ──────────────────────────────────────────────────────

export function CatonLayout({ children, user, onSignOut, pendientes = 0 }: CatonLayoutProps) {
  const location = useLocation()
  const navigate = useNavigate()

  const navItems: NavItem[] = [
    { path: '/app/expedientes', label: 'Expedientes', icon: <FileText size={15} />, section: 'operacion' },
    { path: '/app/requerimientos', label: 'Requerimientos', icon: <Inbox size={15} />, badge: pendientes > 0 ? pendientes : undefined, section: 'operacion' },
    { path: '/app/cronograma', label: 'Cronograma', icon: <Calendar size={15} />, section: 'operacion' },
    { path: '/app/equipo', label: 'Equipo', icon: <Users size={15} />, soloRoles: ['director', 'coordinador'], section: 'organizacion' },
    { path: '/app/panel', label: 'Panel', icon: <BarChart2 size={15} />, soloRoles: ['director', 'coordinador'], section: 'organizacion' },
    { path: '/app/admin', label: 'Administración', icon: <ShieldAlert size={15} />, soloAdmin: true, section: 'organizacion' },
  ]

  const itemsVisibles = navItems.filter(item => {
    if (item.soloAdmin && !user.esAdmin) return false
    if (!item.soloRoles) return true
    return item.soloRoles.includes(user.rol)
  })

  const operacion = itemsVisibles.filter(i => i.section === 'operacion')
  const organizacion = itemsVisibles.filter(i => i.section === 'organizacion')

  function isActive(path: string) {
    return location.pathname.startsWith(path)
  }

  const inicial = (user.nombre || user.email).charAt(0).toUpperCase()

  return (
    <div style={{ display: 'flex', height: '100dvh', overflow: 'hidden', fontFamily: 'Inter, system-ui, sans-serif' }}>
      {/* ── Sidebar ── */}
      <aside style={{
        width: 220, flexShrink: 0,
        background: PANTALLA,
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
        borderRight: `1px solid ${W8}`,
      }}>
        {/* Logo */}
        <div style={{ padding: '22px 16px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
            <Shield size={16} color={ORO_CLARO} strokeWidth={1.5} />
            <span style={{
              fontFamily: '"Marcellus", "Georgia", serif',
              fontSize: 18, fontWeight: 400,
              letterSpacing: '0.18em', color: WHITE,
              lineHeight: 1,
            }}>
              CAT<span style={{ color: ORO_CLARO, fontWeight: 400 }}>Ó</span>N
            </span>
          </div>
          {user.orgNombre && (
            <p style={{
              fontSize: 10, color: SELLO, fontWeight: 600,
              margin: '6px 0 0 24px', letterSpacing: '0.04em',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              textTransform: 'uppercase',
            }}>
              {user.orgNombre}
            </p>
          )}
        </div>

        {/* Divisor */}
        <div style={{ height: 1, background: W8, margin: '0 0 12px' }} />

        {/* Navegación */}
        <nav style={{ flex: 1, overflow: 'auto' }}>
          {/* Sección: Operación */}
          {operacion.length > 0 && (
            <>
              <div style={{
                padding: '0 16px 6px',
                fontSize: 9, fontWeight: 700, color: W25,
                letterSpacing: '0.14em', textTransform: 'uppercase',
              }}>
                Operación
              </div>
              {operacion.map(item => (
                <NavBtn key={item.path} item={item} active={isActive(item.path)} onClick={() => navigate(item.path)} />
              ))}
            </>
          )}

          {/* Sección: Organización */}
          {organizacion.length > 0 && (
            <>
              <div style={{
                padding: '12px 16px 6px',
                fontSize: 9, fontWeight: 700, color: W25,
                letterSpacing: '0.14em', textTransform: 'uppercase',
              }}>
                Organización
              </div>
              {organizacion.map(item => (
                <NavBtn key={item.path} item={item} active={isActive(item.path)} onClick={() => navigate(item.path)} />
              ))}
            </>
          )}
        </nav>

        {/* Footer */}
        <div style={{ borderTop: `1px solid ${W8}`, padding: '8px 0 4px' }}>
          {/* Configuración */}
          <NavBtn
            item={{ path: '/app/configuracion', label: 'Configuración', icon: <Settings size={15} />, section: 'operacion' }}
            active={isActive('/app/configuracion')}
            onClick={() => navigate('/app/configuracion')}
          />

          {/* Usuario */}
          <div style={{
            margin: '6px 12px 8px',
            padding: '8px 10px',
            background: W8,
            borderRadius: 8,
            display: 'flex', alignItems: 'center', gap: 9,
          }}>
            {/* Avatar cuadrado con borde sello */}
            <div style={{
              width: 28, height: 28,
              borderRadius: 6,
              background: TINTA,
              border: `1.5px solid ${SELLO}`,
              color: ORO_CLARO,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, fontWeight: 700, flexShrink: 0,
              fontFamily: '"Marcellus", serif',
            }}>
              {inicial}
            </div>
            <div style={{ flex: 1, overflow: 'hidden' }}>
              <div style={{
                fontSize: 11, fontWeight: 600, color: W80,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {user.nombre || user.email}
              </div>
              {user.rol && (
                <div style={{ fontSize: 10, color: SELLO, textTransform: 'capitalize', letterSpacing: '0.02em' }}>
                  {user.rol}
                </div>
              )}
            </div>
            <button
              onClick={onSignOut}
              title="Cerrar sesión"
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: W25, padding: 3, borderRadius: 4,
                display: 'flex', alignItems: 'center', transition: 'color 0.1s',
              }}
              onMouseEnter={e => (e.currentTarget.style.color = W80)}
              onMouseLeave={e => (e.currentTarget.style.color = W25)}
            >
              <LogOut size={13} />
            </button>
          </div>
        </div>
      </aside>

      {/* ── Área de contenido ── */}
      <main style={{
        flex: 1, overflow: 'auto',
        background: PAPEL,
      }}>
        {children}
      </main>
    </div>
  )
}
