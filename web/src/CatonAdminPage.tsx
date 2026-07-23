/**
 * CatonAdminPage.tsx
 *
 * Panel de super administrador de CATÓN.
 * Solo accesible cuando user.esAdmin === true.
 *
 * Tabs:
 *   Usuarios      — lista de todos los miembros con org y rol
 *   Organizaciones — lista de orgs + config de ámbito/features/plan/entidades
 *   Entidades     — catálogo de sujetos vigilados
 *   Invitar       — formulario para invitar un nuevo usuario
 */
import { useState, useEffect, useCallback, type FormEvent } from 'react'
import {
  Users, Building2, UserPlus, Loader2,
  CheckCircle2, XCircle, RefreshCw, Settings,
  Database, ToggleLeft, ToggleRight, ChevronDown,
  ChevronUp, Plus, Trash2, Shield, Globe, Mail,
  UserCheck, ChevronRight,
} from 'lucide-react'
import type { CatonUser } from './useCatonAuth.js'
import { catonRpc, catonGet, catonPost, catonPatch, CATON_URL, catonToken } from './catonClient.js'
import { veedorFetch } from './veedorApi.js'

// ── Paleta ────────────────────────────────────────────────────────────────────
const PANTALLA = '#0A241A'
const PAPEL    = '#F5F1E8'
const TINTA    = '#0A2E22'
const SELLO    = '#96712A'
const ORO      = '#E3C57E'
const HALLAZGO = '#B0392C'
const OK       = '#1E7F4E'
const WHITE    = '#FFFFFF'
const INK06    = 'rgba(10,46,34,0.06)'
const INK12    = 'rgba(10,46,34,0.12)'
const INK35    = 'rgba(10,46,34,0.35)'
const INK55    = 'rgba(10,46,34,0.55)'

// ── Tipos ─────────────────────────────────────────────────────────────────────

interface UsuarioRow {
  user_id:         string
  email:           string
  nombre:          string | null
  org_id:          string
  org_nombre:      string
  org_tipo:        string
  rol:             string
  activo:          boolean
  user_created_at: string
}

interface OrgRow {
  id:                  string
  nombre:              string
  tipo:                string
  ciudad:              string | null
  activa:              boolean
  created_at:          string
  // Migración 002
  pipeline_tipo:       string
  alcance_tipo:        string
  alcance_deptos:      string[]
  alcance_municipios:  string[]
  tiene_radar:         boolean
  tiene_carruseles:    boolean
  plan_tipo:           string
  token_multiplier:    number
  // Migración 003
  dominio_propio:      string | null
  email_from_name:     string | null
  email_from_address:  string | null
  resend_domain_id:    string | null
  dominio_verificado:  boolean
}

interface EntidadRow {
  id:         string
  nit:        string
  nombre:     string
  sigla:      string | null
  deptos:     string[]
  municipios: string[]
  nivel:      string
  activa:     boolean
  created_at: string
}

interface OrgEntidadRow {
  id:         string
  org_id:     string
  entidad_id: string
  activo:     boolean
  entidad_nit:    string
  entidad_nombre: string
  entidad_sigla:  string | null
}

type Tab = 'usuarios' | 'orgs' | 'entidades' | 'invitar' | 'leads'

interface LeadRow {
  id:             string
  nombre:         string
  email:          string
  cargo:          string | null
  organizacion:   string | null
  tipo_org:       string | null
  telefono:       string | null
  mensaje:        string | null
  fuente:         string
  estado:         string
  notas_internas: string | null
  created_at:     string
  updated_at:     string
}

const ROL_LABEL: Record<string, string> = {
  auditor:     'Auditor',
  coordinador: 'Coordinador',
  director:    'Director',
}

const TIPO_ORG_LABEL: Record<string, string> = {
  veeduria:    'Veeduría',
  contraloria: 'Contraloría',
  ong:         'ONG',
  academia:    'Academia',
}

const ALCANCE_LABEL: Record<string, string> = {
  nacional:      'Nacional',
  departamental: 'Departamental',
  municipal:     'Municipal',
  sujetos:       'Sujetos vigilados',
}

const PLAN_LABEL: Record<string, string> = {
  por_contrato:   'Por contrato auditado',
  mensual_tokens: 'Mensualidad + tokens IA',
  byok:           'BYOK (llave propia)',
}

// ── Componente principal ──────────────────────────────────────────────────────

interface Props { user: CatonUser }

export function CatonAdminPage({ user }: Props) {
  const [tab, setTab] = useState<Tab>('usuarios')

  const tabs: [Tab, React.ReactNode, string][] = [
    ['usuarios',  <Users size={15} />,      'Usuarios'],
    ['orgs',      <Building2 size={15} />,  'Organizaciones'],
    ['entidades', <Database size={15} />,   'Entidades'],
    ['invitar',   <UserPlus size={15} />,   'Invitar'],
    ['leads',     <UserCheck size={15} />,  'Prospectos'],
  ]

  return (
    <div style={{ padding: '32px 40px', maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <Shield size={18} color={SELLO} />
          <h1 style={{ fontSize: 22, fontWeight: 800, color: TINTA, margin: 0 }}>
            Administración CATÓN
          </h1>
        </div>
        <p style={{ fontSize: 13, color: INK55, margin: 0 }}>
          Gestión de usuarios, organizaciones, sujetos vigilados e invitaciones.
        </p>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, borderBottom: `2px solid ${INK12}`, marginBottom: 28 }}>
        {tabs.map(([key, icon, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            style={{
              display: 'flex', alignItems: 'center', gap: 7,
              padding: '9px 18px', fontSize: 13.5, fontWeight: 600,
              border: 'none', cursor: 'pointer', borderRadius: '8px 8px 0 0',
              background: tab === key ? WHITE : 'transparent',
              color: tab === key ? TINTA : INK55,
              borderBottom: tab === key ? `2px solid ${SELLO}` : '2px solid transparent',
              marginBottom: -2, transition: 'all 0.12s',
            }}
          >
            {icon} {label}
          </button>
        ))}
      </div>

      {tab === 'usuarios'  && <TabUsuarios />}
      {tab === 'orgs'      && <TabOrgs />}
      {tab === 'entidades' && <TabEntidades />}
      {tab === 'invitar'   && <TabInvitar user={user} />}
      {tab === 'leads'     && <TabLeads />}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// Tab Usuarios
// ══════════════════════════════════════════════════════════════════════════════

function TabUsuarios() {
  const [usuarios, setUsuarios] = useState<UsuarioRow[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const rows = await catonRpc('get_caton_usuarios') as UsuarioRow[]
      setUsuarios(rows ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  async function toggleActivo(userId: string, orgId: string, activo: boolean) {
    try {
      await catonPatch('veedor_memberships', `user_id=eq.${userId}&org_id=eq.${orgId}`, { activo: !activo })
      setUsuarios(prev => prev.map(u =>
        u.user_id === userId && u.org_id === orgId ? { ...u, activo: !activo } : u
      ))
    } catch (e) { alert(e instanceof Error ? e.message : 'Error') }
  }

  if (loading) return <LoadingState label="Cargando usuarios…" />
  if (error)   return <ErrorState msg={error} onRetry={load} />

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <p style={{ fontSize: 13, color: INK55, margin: 0 }}>
          {usuarios.length} {usuarios.length === 1 ? 'usuario' : 'usuarios'}
        </p>
        <button onClick={load} style={btnSecondaryStyle}><RefreshCw size={14} /> Actualizar</button>
      </div>

      <TableCard>
        <thead>
          <tr style={{ background: INK06 }}>
            {['Email', 'Nombre', 'Organización', 'Rol', 'Estado', 'Creado', ''].map(h => (
              <Th key={h}>{h}</Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {usuarios.length === 0 ? (
            <tr><td colSpan={7} style={emptyTdStyle}>No hay usuarios. Invita el primero →</td></tr>
          ) : usuarios.map((u, i) => (
            <tr key={`${u.user_id}-${u.org_id}`} style={{ borderTop: i > 0 ? `1px solid ${INK06}` : 'none' }}>
              <Td bold>{u.email}</Td>
              <Td dim>{u.nombre || '—'}</Td>
              <Td>
                <span style={{ background: INK06, color: TINTA, padding: '3px 8px', borderRadius: 6, fontSize: 12 }}>
                  {u.org_nombre}
                </span>
                <span style={{ fontSize: 11, color: INK35, marginLeft: 6 }}>
                  {TIPO_ORG_LABEL[u.org_tipo] ?? u.org_tipo}
                </span>
              </Td>
              <Td><RolBadge rol={u.rol} /></Td>
              <Td>
                <span style={{ fontSize: 12, fontWeight: 700, color: u.activo ? OK : HALLAZGO }}>
                  {u.activo ? '● Activo' : '○ Inactivo'}
                </span>
              </Td>
              <Td dim small>{new Date(u.user_created_at).toLocaleDateString('es-CO')}</Td>
              <Td>
                <button
                  onClick={() => void toggleActivo(u.user_id, u.org_id, u.activo)}
                  style={{ background: 'none', border: `1px solid ${INK12}`, borderRadius: 6, padding: '4px 8px', cursor: 'pointer', fontSize: 12, color: INK55, display: 'flex', alignItems: 'center', gap: 4 }}
                >
                  {u.activo
                    ? <><XCircle size={13} color={HALLAZGO} /> Desactivar</>
                    : <><CheckCircle2 size={13} color={OK} /> Activar</>}
                </button>
              </Td>
            </tr>
          ))}
        </tbody>
      </TableCard>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// Tab Organizaciones
// ══════════════════════════════════════════════════════════════════════════════

function TabOrgs() {
  const [orgs, setOrgs]             = useState<OrgRow[]>([])
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState('')
  const [showForm, setShowForm]     = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const rows = await catonGet('veedor_orgs?select=*&order=created_at.desc') as OrgRow[]
      setOrgs(rows ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  async function toggleActiva(org: OrgRow) {
    try {
      await veedorFetch(`/veeduria/admin/orgs/${org.id}`, 'PATCH', { activa: !org.activa })
      setOrgs(prev => prev.map(o => o.id === org.id ? { ...o, activa: !org.activa } : o))
    } catch (e) { alert(e instanceof Error ? e.message : 'Error') }
  }

  function onOrgUpdated(updated: OrgRow) {
    setOrgs(prev => prev.map(o => o.id === updated.id ? updated : o))
  }

  if (loading) return <LoadingState label="Cargando organizaciones…" />
  if (error)   return <ErrorState msg={error} onRetry={load} />

  const selectedOrg = orgs.find(o => o.id === selectedId) ?? null

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <p style={{ fontSize: 13, color: INK55, margin: 0 }}>
          {orgs.length} {orgs.length === 1 ? 'organización' : 'organizaciones'}
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load} style={btnSecondaryStyle}><RefreshCw size={14} /> Actualizar</button>
          <button onClick={() => setShowForm(f => !f)} style={btnPrimaryStyle}><Building2 size={14} /> Nueva organización</button>
        </div>
      </div>

      {showForm && (
        <FormNuevaOrg
          onCreated={org => { setOrgs(prev => [org, ...prev]); setShowForm(false) }}
          onCancel={() => setShowForm(false)}
        />
      )}

      <TableCard style={{ marginTop: showForm ? 16 : 0 }}>
        <thead>
          <tr style={{ background: INK06 }}>
            {['Nombre', 'Tipo', 'Pipeline', 'Alcance', 'Features', 'Estado', ''].map(h => <Th key={h}>{h}</Th>)}
          </tr>
        </thead>
        <tbody>
          {orgs.length === 0 ? (
            <tr><td colSpan={7} style={emptyTdStyle}>No hay organizaciones. Crea la primera.</td></tr>
          ) : orgs.map((o, i) => (
            <>
              <tr
                key={o.id}
                style={{
                  borderTop: i > 0 ? `1px solid ${INK06}` : 'none',
                  cursor: 'pointer',
                  background: selectedId === o.id ? `${SELLO}08` : WHITE,
                }}
                onClick={() => setSelectedId(selectedId === o.id ? null : o.id)}
              >
                <Td bold>{o.nombre}</Td>
                <Td>
                  <span style={{ background: `${TINTA}10`, color: TINTA, padding: '3px 8px', borderRadius: 6, fontSize: 12, fontWeight: 600 }}>
                    {TIPO_ORG_LABEL[o.tipo] ?? o.tipo}
                  </span>
                </Td>
                <Td dim small>{o.pipeline_tipo === 'contraloria' ? 'Contraloría' : 'Veeduría'}</Td>
                <Td dim small>{ALCANCE_LABEL[o.alcance_tipo] ?? o.alcance_tipo}</Td>
                <Td>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {o.tiene_radar     && <Badge color={OK}>Radar</Badge>}
                    {o.tiene_carruseles && <Badge color={SELLO}>Carruseles</Badge>}
                    {!o.tiene_radar && !o.tiene_carruseles && <span style={{ fontSize: 11, color: INK35 }}>—</span>}
                  </div>
                </Td>
                <Td>
                  <span style={{ fontSize: 12, fontWeight: 700, color: o.activa ? OK : HALLAZGO }}>
                    {o.activa ? '● Activa' : '○ Inactiva'}
                  </span>
                </Td>
                <Td>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <button
                      onClick={e => { e.stopPropagation(); void toggleActiva(o) }}
                      style={{ background: 'none', border: `1px solid ${INK12}`, borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12, color: INK55 }}
                    >
                      {o.activa ? 'Desactivar' : 'Activar'}
                    </button>
                    {selectedId === o.id
                      ? <ChevronUp size={16} color={INK55} />
                      : <ChevronDown size={16} color={INK35} />}
                  </div>
                </Td>
              </tr>
              {selectedId === o.id && (
                <tr key={`${o.id}-panel`}>
                  <td colSpan={7} style={{ padding: '0 0 8px', background: `${SELLO}05` }}>
                    <OrgConfigPanel org={o} onUpdated={onOrgUpdated} />
                  </td>
                </tr>
              )}
            </>
          ))}
        </tbody>
      </TableCard>
    </div>
  )
}

// ── OrgConfigPanel ────────────────────────────────────────────────────────────

function OrgConfigPanel({ org, onUpdated }: { org: OrgRow; onUpdated: (o: OrgRow) => void }) {
  const [saving, setSaving] = useState(false)
  const [msg, setMsg]       = useState('')

  // State local editable
  const [pipeline,       setPipeline]       = useState(org.pipeline_tipo)
  const [alcanceTipo,    setAlcanceTipo]    = useState(org.alcance_tipo)
  const [deptos,         setDeptos]         = useState((org.alcance_deptos ?? []).join(', '))
  const [municipios,     setMunicipios]     = useState((org.alcance_municipios ?? []).join(', '))
  const [radar,          setRadar]          = useState(org.tiene_radar)
  const [carruseles,     setCarruseles]     = useState(org.tiene_carruseles)
  const [planTipo,       setPlanTipo]       = useState(org.plan_tipo)
  const [multiplier,     setMultiplier]     = useState(String(org.token_multiplier ?? 2))
  // Dominio
  const [dominio,        setDominio]        = useState(org.dominio_propio ?? '')
  const [fromName,       setFromName]       = useState(org.email_from_name ?? '')
  const [fromAddress,    setFromAddress]    = useState(org.email_from_address ?? '')
  const [resendDomainId, setResendDomainId] = useState(org.resend_domain_id ?? '')
  const [dominioVerif,   setDominioVerif]   = useState(org.dominio_verificado ?? false)

  async function save() {
    setSaving(true); setMsg('')
    const patch = {
      pipeline_tipo:       pipeline,
      alcance_tipo:        alcanceTipo,
      alcance_deptos:      deptos.split(',').map(s => s.trim()).filter(Boolean),
      alcance_municipios:  municipios.split(',').map(s => s.trim()).filter(Boolean),
      tiene_radar:         radar,
      tiene_carruseles:    carruseles,
      plan_tipo:           planTipo,
      token_multiplier:    parseFloat(multiplier) || 2,
      dominio_propio:      dominio.trim() || null,
      email_from_name:     fromName.trim() || null,
      email_from_address:  fromAddress.trim() || null,
      resend_domain_id:    resendDomainId.trim() || null,
      dominio_verificado:  dominioVerif,
    }
    try {
      const updated = await veedorFetch(`/veeduria/admin/orgs/${org.id}`, 'PATCH', patch) as OrgRow
      if (updated) onUpdated(updated)
      setMsg('Guardado ✓')
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Error guardando')
    } finally { setSaving(false) }
  }

  return (
    <div style={{
      margin: '0 16px 8px',
      background: WHITE,
      border: `1px solid ${INK12}`,
      borderRadius: 10,
      padding: '20px 24px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
        <Settings size={15} color={SELLO} />
        <span style={{ fontSize: 13, fontWeight: 800, color: TINTA }}>
          Configuración — {org.nombre}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 20 }}>

        {/* Columna 1: Pipeline + Alcance */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <label style={labelStyle}>Pipeline</label>
            <select value={pipeline} onChange={e => setPipeline(e.target.value)} style={inputStyle}>
              <option value="veeduria">Veeduría — denuncia → tutela → fallo</option>
              <option value="contraloria">Contraloría — investigación / muestreo</option>
            </select>
          </div>
          <div>
            <label style={labelStyle}>Tipo de ámbito</label>
            <select value={alcanceTipo} onChange={e => setAlcanceTipo(e.target.value)} style={inputStyle}>
              <option value="nacional">Nacional — todo el país</option>
              <option value="departamental">Departamental</option>
              <option value="municipal">Municipal</option>
              <option value="sujetos">Sujetos vigilados (NIT)</option>
            </select>
          </div>
          {alcanceTipo === 'departamental' && (
            <div>
              <label style={labelStyle}>Departamentos (separados por coma)</label>
              <input value={deptos} onChange={e => setDeptos(e.target.value)} placeholder="Córdoba, Sucre" style={inputStyle} />
              <p style={{ fontSize: 11, color: INK35, margin: '4px 0 0' }}>Ej: Córdoba, Sucre, Bolívar</p>
            </div>
          )}
          {alcanceTipo === 'municipal' && (
            <div>
              <label style={labelStyle}>Municipios (separados por coma)</label>
              <input value={municipios} onChange={e => setMunicipios(e.target.value)} placeholder="Montería, Lorica" style={inputStyle} />
            </div>
          )}
        </div>

        {/* Columna 2: Features activos */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label style={labelStyle}>Features activos</label>

          <ToggleRow
            label="Radar de patrones"
            description="HHI, fraccionamiento, rep. legal múltiple"
            active={radar}
            onToggle={() => setRadar(v => !v)}
          />
          <ToggleRow
            label="Carruseles de contratistas"
            description="Patrones de concentración por contratista"
            active={carruseles}
            onToggle={() => setCarruseles(v => !v)}
          />
        </div>

        {/* Columna 3: Modelo de cobro */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <label style={labelStyle}>Modelo de cobro</label>
            <select value={planTipo} onChange={e => setPlanTipo(e.target.value)} style={inputStyle}>
              <option value="por_contrato">Por contrato auditado</option>
              <option value="mensual_tokens">Mensualidad + tokens IA</option>
              <option value="byok">BYOK — trae su propia llave</option>
            </select>
          </div>
          {planTipo === 'mensual_tokens' && (
            <div>
              <label style={labelStyle}>Multiplicador de tokens</label>
              <input
                type="number" min="1" max="10" step="0.5"
                value={multiplier} onChange={e => setMultiplier(e.target.value)}
                style={{ ...inputStyle, width: 100 }}
              />
              <p style={{ fontSize: 11, color: INK35, margin: '4px 0 0' }}>
                ×{multiplier} sobre el costo real. Ej: $100 → ${(parseFloat(multiplier||'2')*100).toFixed(0)} cobrado
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ── Dominio y correo saliente ── */}
      <div style={{ marginTop: 24, paddingTop: 20, borderTop: `1px solid ${INK12}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <Globe size={14} color={SELLO} />
          <span style={{ fontSize: 12, fontWeight: 800, color: TINTA, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            Dominio propio y correo saliente
          </span>
        </div>

        {/* Banner explicativo */}
        <div style={{
          background: `${SELLO}12`, border: `1px solid ${SELLO}30`,
          borderRadius: 8, padding: '10px 14px', fontSize: 12, color: INK55,
          marginBottom: 16, lineHeight: 1.5,
        }}>
          <strong style={{ color: TINTA }}>¿Cómo funciona?</strong> La org compra su dominio
          (ej: <code style={{ background: INK06, padding: '1px 5px', borderRadius: 4 }}>contraloria-cordoba.gov.co</code>),
          lo agrega en <strong>Resend → Domains</strong> y verifica los DNS.
          Una vez activo, pega el <strong>Domain ID</strong> aquí y activa el switch.
          Todos los correos de automatización de esa org saldrán desde ese dominio.
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <div>
            <label style={labelStyle}>Dominio propio</label>
            <input
              value={dominio}
              onChange={e => setDominio(e.target.value)}
              placeholder="contraloria-cordoba.gov.co"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Nombre del remitente (From name)</label>
            <input
              value={fromName}
              onChange={e => setFromName(e.target.value)}
              placeholder="Contraloría de Córdoba"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Dirección From</label>
            <input
              value={fromAddress}
              onChange={e => setFromAddress(e.target.value)}
              placeholder="notificaciones@contraloria-cordoba.gov.co"
              style={inputStyle}
            />
            <p style={{ fontSize: 11, color: INK35, margin: '4px 0 0' }}>
              Debe ser del dominio propio configurado arriba.
            </p>
          </div>
          <div>
            <label style={labelStyle}>Resend Domain ID</label>
            <input
              value={resendDomainId}
              onChange={e => setResendDomainId(e.target.value)}
              placeholder="4a1f9e2b-..."
              style={{ ...inputStyle, fontFamily: '"IBM Plex Mono", monospace', fontSize: 12 }}
            />
            <p style={{ fontSize: 11, color: INK35, margin: '4px 0 0' }}>
              Resend Dashboard → Domains → click en el dominio → ID en la URL.
            </p>
          </div>
        </div>

        {/* Toggle verificado */}
        <div style={{ marginTop: 14 }}>
          <ToggleRow
            label="Dominio verificado y activo"
            description={dominioVerif
              ? `Los correos de ${org.nombre} salen por ${dominio || '(dominio sin configurar)'}`
              : 'Activar solo cuando el dominio esté verificado en Resend y los DNS hayan propagado'}
            active={dominioVerif}
            onToggle={() => setDominioVerif(v => !v)}
          />
        </div>

        {/* Preview del correo */}
        {fromName && fromAddress && (
          <div style={{
            marginTop: 12, padding: '10px 14px',
            background: `${OK}08`, border: `1px solid ${OK}30`,
            borderRadius: 8, display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <Mail size={14} color={OK} />
            <span style={{ fontSize: 12, color: TINTA }}>
              Los correos se verán como:{' '}
              <strong>{fromName}</strong>{' '}
              <span style={{ color: INK55 }}>&lt;{fromAddress}&gt;</span>
            </span>
          </div>
        )}
      </div>

      {/* Acciones */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 20, paddingTop: 16, borderTop: `1px solid ${INK12}` }}>
        <button onClick={() => void save()} disabled={saving} style={btnPrimaryStyle}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
          {saving ? 'Guardando…' : 'Guardar cambios'}
        </button>
        {msg && (
          <span style={{ fontSize: 13, color: msg.includes('✓') ? OK : HALLAZGO, fontWeight: 600 }}>
            {msg}
          </span>
        )}
      </div>

      {/* Sujetos vigilados — solo si alcance = sujetos */}
      {(alcanceTipo === 'sujetos' || org.tipo === 'contraloria') && (
        <SujetosVigiladosPanel orgId={org.id} />
      )}
    </div>
  )
}

// ── SujetosVigiladosPanel ─────────────────────────────────────────────────────

function SujetosVigiladosPanel({ orgId }: { orgId: string }) {
  const [links, setLinks]       = useState<OrgEntidadRow[]>([])
  const [catalog, setCatalog]   = useState<EntidadRow[]>([])
  const [loading, setLoading]   = useState(true)
  const [adding, setAdding]     = useState(false)
  const [selected, setSelected] = useState('')

  const loadLinks = useCallback(async () => {
    setLoading(true)
    try {
      const rows = await catonGet(
        `caton_org_entidades?select=id,org_id,entidad_id,activo,caton_entidades(nit,nombre,sigla)&org_id=eq.${orgId}&activo=eq.true`
      ) as Array<{ id: string; org_id: string; entidad_id: string; activo: boolean; caton_entidades: { nit: string; nombre: string; sigla: string | null } }>

      setLinks(rows.map(r => ({
        id: r.id,
        org_id: r.org_id,
        entidad_id: r.entidad_id,
        activo: r.activo,
        entidad_nit: r.caton_entidades?.nit ?? '',
        entidad_nombre: r.caton_entidades?.nombre ?? '',
        entidad_sigla: r.caton_entidades?.sigla ?? null,
      })))
    } catch { /* silencioso */ }
    setLoading(false)
  }, [orgId])

  const loadCatalog = useCallback(async () => {
    try {
      const rows = await catonGet('caton_entidades?select=*&activa=eq.true&order=nombre.asc') as EntidadRow[]
      setCatalog(rows ?? [])
    } catch { /* silencioso */ }
  }, [])

  useEffect(() => { void loadLinks(); void loadCatalog() }, [loadLinks, loadCatalog])

  const assignedIds = new Set(links.map(l => l.entidad_id))
  const available = catalog.filter(e => !assignedIds.has(e.id))

  async function addEntidad() {
    if (!selected) return
    try {
      await veedorFetch('/veeduria/admin/org-entidades', 'POST', { org_id: orgId, entidad_id: selected })
      setSelected('')
      setAdding(false)
      void loadLinks()
    } catch (e) { alert(e instanceof Error ? e.message : 'Error') }
  }

  async function removeEntidad(linkId: string) {
    try {
      await veedorFetch(`/veeduria/admin/org-entidades/${linkId}`, 'PATCH', { activo: false })
      setLinks(prev => prev.filter(l => l.id !== linkId))
    } catch (e) { alert(e instanceof Error ? e.message : 'Error') }
  }

  return (
    <div style={{ marginTop: 24, paddingTop: 20, borderTop: `1px solid ${INK12}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <label style={{ ...labelStyle, margin: 0 }}>
          Sujetos vigilados autorizados ({links.length})
        </label>
        <button onClick={() => setAdding(a => !a)} style={btnSecondaryStyle}>
          <Plus size={13} /> Agregar entidad
        </button>
      </div>

      {adding && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <select value={selected} onChange={e => setSelected(e.target.value)} style={inputStyle}>
              <option value="">Seleccionar entidad del catálogo…</option>
              {available.map(e => (
                <option key={e.id} value={e.id}>
                  {e.nombre} — NIT {e.nit}
                </option>
              ))}
            </select>
          </div>
          <button onClick={() => void addEntidad()} disabled={!selected} style={btnPrimaryStyle}>
            Agregar
          </button>
          <button onClick={() => { setAdding(false); setSelected('') }} style={btnSecondaryStyle}>
            Cancelar
          </button>
        </div>
      )}

      {loading ? (
        <div style={{ fontSize: 13, color: INK35, padding: '8px 0' }}>Cargando…</div>
      ) : links.length === 0 ? (
        <div style={{ fontSize: 13, color: INK35, padding: '12px 0', fontStyle: 'italic' }}>
          Ninguna entidad asignada. Agrega las entidades que esta organización puede auditar.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {links.map(l => (
            <div key={l.id} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '8px 12px', background: INK06, borderRadius: 8,
            }}>
              <div>
                <span style={{ fontSize: 13, fontWeight: 600, color: TINTA }}>{l.entidad_nombre}</span>
                {l.entidad_sigla && <span style={{ fontSize: 12, color: INK55, marginLeft: 8 }}>({l.entidad_sigla})</span>}
                <span style={{ fontSize: 11, color: INK35, marginLeft: 8, fontFamily: '"IBM Plex Mono", monospace' }}>
                  NIT {l.entidad_nit}
                </span>
              </div>
              <button
                onClick={() => void removeEntidad(l.id)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: HALLAZGO, padding: 4 }}
                title="Quitar"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── ToggleRow ─────────────────────────────────────────────────────────────────

function ToggleRow({ label, description, active, onToggle }: {
  label: string; description: string; active: boolean; onToggle: () => void
}) {
  return (
    <div
      onClick={onToggle}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
        background: active ? `${OK}10` : INK06,
        border: `1px solid ${active ? OK : INK12}`,
        transition: 'all 0.15s',
      }}
    >
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: active ? OK : TINTA }}>{label}</div>
        <div style={{ fontSize: 11, color: INK55 }}>{description}</div>
      </div>
      {active
        ? <ToggleRight size={22} color={OK} />
        : <ToggleLeft size={22} color={INK35} />}
    </div>
  )
}

// ── FormNuevaOrg ──────────────────────────────────────────────────────────────

function FormNuevaOrg({ onCreated, onCancel }: { onCreated: (o: OrgRow) => void; onCancel: () => void }) {
  const [nombre,   setNombre]   = useState('')
  const [tipo,     setTipo]     = useState('veeduria')
  const [ciudad,   setCiudad]   = useState('')
  const [pipeline, setPipeline] = useState('veeduria')
  const [planTipo, setPlanTipo] = useState('mensual_tokens')
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')

  // Sincronizar pipeline con tipo por defecto
  function handleTipo(v: string) {
    setTipo(v)
    if (v === 'contraloria') setPipeline('contraloria')
    else setPipeline('veeduria')
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setLoading(true); setError('')
    try {
      const created = await veedorFetch('/veeduria/admin/orgs', 'POST', {
        nombre:        nombre.trim(),
        tipo,
        ciudad:        ciudad.trim() || null,
        pipeline_tipo: pipeline,
        plan_tipo:     planTipo,
      }) as OrgRow
      onCreated(created)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error')
    } finally { setLoading(false) }
  }

  return (
    <div style={{ background: WHITE, borderRadius: 12, border: `1px solid ${INK12}`, padding: '24px 28px', marginBottom: 16 }}>
      <h3 style={{ fontSize: 15, fontWeight: 800, color: TINTA, margin: '0 0 18px' }}>Nueva organización</h3>
      {error && <div style={{ ...errorStyle, marginBottom: 14 }}>{error}</div>}
      <form onSubmit={e => void handleSubmit(e)} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ flex: 2, minWidth: 200 }}>
          <label style={labelStyle}>Nombre *</label>
          <input required value={nombre} onChange={e => setNombre(e.target.value)} placeholder="Veeduría Ciudadana de Córdoba" style={inputStyle} />
        </div>
        <div style={{ flex: 1, minWidth: 140 }}>
          <label style={labelStyle}>Tipo *</label>
          <select value={tipo} onChange={e => handleTipo(e.target.value)} style={inputStyle}>
            <option value="veeduria">Veeduría</option>
            <option value="contraloria">Contraloría</option>
            <option value="ong">ONG</option>
            <option value="academia">Academia</option>
          </select>
        </div>
        <div style={{ flex: 1, minWidth: 140 }}>
          <label style={labelStyle}>Pipeline *</label>
          <select value={pipeline} onChange={e => setPipeline(e.target.value)} style={inputStyle}>
            <option value="veeduria">Veeduría</option>
            <option value="contraloria">Contraloría</option>
          </select>
        </div>
        <div style={{ flex: 1, minWidth: 130 }}>
          <label style={labelStyle}>Ciudad</label>
          <input value={ciudad} onChange={e => setCiudad(e.target.value)} placeholder="Montería" style={inputStyle} />
        </div>
        <div style={{ flex: 1, minWidth: 160 }}>
          <label style={labelStyle}>Plan IA *</label>
          <select value={planTipo} onChange={e => setPlanTipo(e.target.value)} style={inputStyle}>
            <option value="mensual_tokens">Mensualidad + tokens</option>
            <option value="por_contrato">Por contrato auditado</option>
            <option value="byok">BYOK — llave propia</option>
          </select>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={onCancel} style={btnSecondaryStyle}>Cancelar</button>
          <button type="submit" disabled={loading} style={btnPrimaryStyle}>
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Building2 size={14} />}
            Crear
          </button>
        </div>
      </form>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// Tab Entidades (catálogo de sujetos vigilados)
// ══════════════════════════════════════════════════════════════════════════════

function TabEntidades() {
  const [entidades, setEntidades] = useState<EntidadRow[]>([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState('')
  const [showForm, setShowForm]   = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const rows = await catonGet('caton_entidades?select=*&order=nombre.asc') as EntidadRow[]
      setEntidades(rows ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  async function toggleActiva(e: EntidadRow) {
    try {
      await veedorFetch(`/veeduria/admin/entidades/${e.id}`, 'PATCH', { activa: !e.activa })
      setEntidades(prev => prev.map(x => x.id === e.id ? { ...x, activa: !e.activa } : x))
    } catch (err) { alert(err instanceof Error ? err.message : 'Error') }
  }

  if (loading) return <LoadingState label="Cargando entidades…" />
  if (error)   return <ErrorState msg={error} onRetry={load} />

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <p style={{ fontSize: 13, color: INK55, margin: '0 0 8px' }}>
          Catálogo de entidades públicas que pueden ser auditadas. Las contralorías solo ven contratos
          de las entidades que les asignes desde el panel de cada organización.
        </p>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <p style={{ fontSize: 13, color: INK55, margin: 0 }}>
          {entidades.length} {entidades.length === 1 ? 'entidad' : 'entidades'}
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load} style={btnSecondaryStyle}><RefreshCw size={14} /> Actualizar</button>
          <button onClick={() => setShowForm(f => !f)} style={btnPrimaryStyle}><Plus size={14} /> Nueva entidad</button>
        </div>
      </div>

      {showForm && (
        <FormNuevaEntidad
          onCreated={e => { setEntidades(prev => [...prev, e].sort((a,b) => a.nombre.localeCompare(b.nombre))); setShowForm(false) }}
          onCancel={() => setShowForm(false)}
        />
      )}

      <TableCard style={{ marginTop: showForm ? 16 : 0 }}>
        <thead>
          <tr style={{ background: INK06 }}>
            {['NIT', 'Nombre', 'Sigla', 'Nivel', 'Departamentos', 'Estado', ''].map(h => <Th key={h}>{h}</Th>)}
          </tr>
        </thead>
        <tbody>
          {entidades.length === 0 ? (
            <tr><td colSpan={7} style={emptyTdStyle}>No hay entidades. Agrega la primera.</td></tr>
          ) : entidades.map((e, i) => (
            <tr key={e.id} style={{ borderTop: i > 0 ? `1px solid ${INK06}` : 'none' }}>
              <Td>
                <span style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 12, color: SELLO }}>
                  {e.nit}
                </span>
              </Td>
              <Td bold>{e.nombre}</Td>
              <Td dim small>{e.sigla || '—'}</Td>
              <Td dim small>
                <span style={{ textTransform: 'capitalize' }}>{e.nivel}</span>
              </Td>
              <Td dim small>
                {(e.deptos ?? []).join(', ') || '—'}
              </Td>
              <Td>
                <span style={{ fontSize: 12, fontWeight: 700, color: e.activa ? OK : HALLAZGO }}>
                  {e.activa ? '● Activa' : '○ Inactiva'}
                </span>
              </Td>
              <Td>
                <button
                  onClick={() => void toggleActiva(e)}
                  style={{ background: 'none', border: `1px solid ${INK12}`, borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12, color: INK55 }}
                >
                  {e.activa ? 'Desactivar' : 'Activar'}
                </button>
              </Td>
            </tr>
          ))}
        </tbody>
      </TableCard>
    </div>
  )
}

function FormNuevaEntidad({ onCreated, onCancel }: { onCreated: (e: EntidadRow) => void; onCancel: () => void }) {
  const [nit,    setNit]    = useState('')
  const [nombre, setNombre] = useState('')
  const [sigla,  setSigla]  = useState('')
  const [nivel,  setNivel]  = useState('municipal')
  const [deptos, setDeptos] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setLoading(true); setError('')
    try {
      const created = await veedorFetch('/veeduria/admin/entidades', 'POST', {
        nit:    nit.trim().replace(/\D/g, ''),
        nombre: nombre.trim(),
        sigla:  sigla.trim() || null,
        nivel,
        deptos: deptos.split(',').map((s: string) => s.trim()).filter(Boolean),
      }) as EntidadRow
      onCreated(created)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error')
    } finally { setLoading(false) }
  }

  return (
    <div style={{ background: WHITE, borderRadius: 12, border: `1px solid ${INK12}`, padding: '24px 28px', marginBottom: 16 }}>
      <h3 style={{ fontSize: 15, fontWeight: 800, color: TINTA, margin: '0 0 18px' }}>Nueva entidad</h3>
      {error && <div style={{ ...errorStyle, marginBottom: 14 }}>{error}</div>}
      <form onSubmit={e => void handleSubmit(e)} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ flex: 1, minWidth: 130 }}>
          <label style={labelStyle}>NIT *</label>
          <input required value={nit} onChange={e => setNit(e.target.value)} placeholder="800123456" style={inputStyle} />
        </div>
        <div style={{ flex: 3, minWidth: 220 }}>
          <label style={labelStyle}>Nombre *</label>
          <input required value={nombre} onChange={e => setNombre(e.target.value)} placeholder="Gobernación de Córdoba" style={inputStyle} />
        </div>
        <div style={{ flex: 1, minWidth: 100 }}>
          <label style={labelStyle}>Sigla</label>
          <input value={sigla} onChange={e => setSigla(e.target.value)} placeholder="GOB-COR" style={inputStyle} />
        </div>
        <div style={{ flex: 1, minWidth: 130 }}>
          <label style={labelStyle}>Nivel</label>
          <select value={nivel} onChange={e => setNivel(e.target.value)} style={inputStyle}>
            <option value="nacional">Nacional</option>
            <option value="departamental">Departamental</option>
            <option value="municipal">Municipal</option>
          </select>
        </div>
        <div style={{ flex: 2, minWidth: 180 }}>
          <label style={labelStyle}>Departamentos (coma)</label>
          <input value={deptos} onChange={e => setDeptos(e.target.value)} placeholder="Córdoba, Sucre" style={inputStyle} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={onCancel} style={btnSecondaryStyle}>Cancelar</button>
          <button type="submit" disabled={loading} style={btnPrimaryStyle}>
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            Crear
          </button>
        </div>
      </form>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// Tab Invitar
// ══════════════════════════════════════════════════════════════════════════════

function TabInvitar({ user: _user }: { user: CatonUser }) {
  const [email,       setEmail]       = useState('')
  const [nombre,      setNombre]      = useState('')
  const [orgId,       setOrgId]       = useState('')
  const [rol,         setRol]         = useState('auditor')
  const [orgs,        setOrgs]        = useState<OrgRow[]>([])
  const [loading,     setLoading]     = useState(false)
  const [orgsLoading, setOrgsLoading] = useState(true)
  const [error,       setError]       = useState('')
  const [success,     setSuccess]     = useState('')

  useEffect(() => {
    catonGet('veedor_orgs?select=id,nombre,tipo&activa=eq.true&order=nombre.asc')
      .then(rows => setOrgs((rows as OrgRow[]) ?? []))
      .catch(() => {})
      .finally(() => setOrgsLoading(false))
  }, [])

  async function handleInvite(e: FormEvent) {
    e.preventDefault()
    if (!orgId) { setError('Selecciona una organización'); return }
    setLoading(true); setError(''); setSuccess('')
    try {
      const res = await fetch(`${CATON_URL}/functions/v1/caton-invite-user`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${catonToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), nombre: nombre.trim(), org_id: orgId, rol }),
      })
      const data = await res.json() as { ok?: boolean; error?: string }
      if (!res.ok || !data.ok) throw new Error(data.error ?? 'Error enviando invitación')
      setSuccess(`Invitación enviada a ${email}. Recibirá un correo de acceso.`)
      setEmail(''); setNombre(''); setOrgId(''); setRol('auditor')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error')
    } finally { setLoading(false) }
  }

  return (
    <div style={{ maxWidth: 520 }}>
      <div style={{ background: WHITE, borderRadius: 12, border: `1px solid ${INK12}`, padding: '28px 32px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: `${TINTA}10`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <UserPlus size={20} color={TINTA} />
          </div>
          <div>
            <h3 style={{ fontSize: 15, fontWeight: 800, color: TINTA, margin: 0 }}>Invitar usuario</h3>
            <p style={{ fontSize: 12, color: INK55, margin: 0 }}>Recibirá un correo con enlace de acceso.</p>
          </div>
        </div>

        {error   && <div style={{ ...errorStyle,   marginBottom: 16 }}>{error}</div>}
        {success && <div style={{ ...successStyle, marginBottom: 16 }}>{success}</div>}

        <form onSubmit={e => void handleInvite(e)} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <label style={labelStyle}>Correo *</label>
            <input type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="usuario@organización.gov.co" style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Nombre completo</label>
            <input value={nombre} onChange={e => setNombre(e.target.value)} placeholder="María González" style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Organización *</label>
            {orgsLoading ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: INK55, fontSize: 13 }}>
                <Loader2 size={14} className="animate-spin" /> Cargando…
              </div>
            ) : (
              <select value={orgId} onChange={e => setOrgId(e.target.value)} style={inputStyle} required>
                <option value="">Seleccionar…</option>
                {orgs.map(o => (
                  <option key={o.id} value={o.id}>{o.nombre} ({TIPO_ORG_LABEL[o.tipo] ?? o.tipo})</option>
                ))}
              </select>
            )}
          </div>
          <div>
            <label style={labelStyle}>Rol *</label>
            <select value={rol} onChange={e => setRol(e.target.value)} style={inputStyle}>
              <option value="auditor">Auditor — consulta y reportes</option>
              <option value="coordinador">Coordinador — gestiona expedientes del equipo</option>
              <option value="director">Director — acceso completo + panel</option>
            </select>
            <p style={{ fontSize: 11, color: INK35, margin: '4px 0 0' }}>Modificable después desde la pestaña Usuarios.</p>
          </div>
          <button type="submit" disabled={loading || orgsLoading} style={{ ...btnPrimaryStyle, justifyContent: 'center', padding: '11px 0' }}>
            {loading ? <><Loader2 size={15} className="animate-spin" /> Enviando…</> : <><UserPlus size={15} /> Enviar invitación</>}
          </button>
        </form>
      </div>

      <div style={{ marginTop: 16, padding: '12px 16px', background: `${SELLO}15`, borderRadius: 10, border: `1px solid ${SELLO}40`, fontSize: 12, color: INK55 }}>
        <strong style={{ color: TINTA }}>¿Cómo funciona?</strong> El usuario recibe un enlace mágico.
        Al hacer clic queda autenticado con el rol asignado. Las cuentas no pueden crearse públicamente — solo desde este panel.
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// Tab Prospectos / Leads
// ══════════════════════════════════════════════════════════════════════════════

const ESTADO_LEAD: Record<string, { label: string; color: string; bg: string }> = {
  nuevo:          { label: 'Nuevo',          color: SELLO,    bg: `${SELLO}18` },
  contactado:     { label: 'Contactado',     color: TINTA,    bg: `${TINTA}12` },
  demo_agendada:  { label: 'Demo agendada',  color: OK,       bg: `${OK}15` },
  cliente:        { label: 'Cliente ✓',      color: OK,       bg: `${OK}25` },
  descartado:     { label: 'Descartado',     color: INK35,    bg: INK06 },
}

const TIPO_LEAD: Record<string, string> = {
  veeduria:    'Veeduría',
  contraloria: 'Contraloría',
  auditoria:   'Auditoría',
  ong:         'ONG',
  academia:    'Academia',
  otro:        'Otro',
}

function TabLeads() {
  const [leads, setLeads]         = useState<LeadRow[]>([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState('')
  const [filtroEstado, setFiltro] = useState('todos')
  const [busqueda, setBusqueda]   = useState('')
  const [showForm, setShowForm]   = useState(false)
  const [expanded, setExpanded]   = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const params = new URLSearchParams()
      if (filtroEstado !== 'todos') params.set('estado', filtroEstado)
      if (busqueda.trim()) params.set('q', busqueda.trim())
      const rows = await veedorFetch<{ leads: LeadRow[] }>(`/veeduria/leads?${params}`)
      setLeads(rows.leads ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error')
    } finally { setLoading(false) }
  }, [filtroEstado, busqueda])

  useEffect(() => { void load() }, [load])

  async function actualizarEstado(id: string, estado: string) {
    try {
      const data = await veedorFetch<{ lead?: LeadRow }>(`/veeduria/leads/${id}`, 'PATCH', { estado })
      if (data.lead) setLeads(prev => prev.map(l => l.id === id ? data.lead! : l))
    } catch (e) { alert(e instanceof Error ? e.message : 'Error') }
  }

  async function guardarNotas(id: string, notas_internas: string) {
    try {
      await veedorFetch(`/veeduria/leads/${id}`, 'PATCH', { notas_internas })
    } catch { /* silencioso */ }
  }

  const contadores = leads.reduce((acc, l) => {
    acc[l.estado] = (acc[l.estado] ?? 0) + 1
    return acc
  }, {} as Record<string, number>)

  if (loading) return <LoadingState label="Cargando prospectos…" />
  if (error)   return <ErrorState msg={error} onRetry={load} />

  return (
    <div>
      {/* KPIs rápidos */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        {Object.entries(ESTADO_LEAD).map(([key, cfg]) => (
          <div
            key={key}
            onClick={() => setFiltro(filtroEstado === key ? 'todos' : key)}
            style={{
              padding: '8px 16px', borderRadius: 20, cursor: 'pointer',
              background: filtroEstado === key ? cfg.color : cfg.bg,
              color: filtroEstado === key ? WHITE : cfg.color,
              fontSize: 12, fontWeight: 700, transition: 'all 0.12s',
              border: `1px solid ${cfg.color}40`,
            }}
          >
            {cfg.label} {contadores[key] != null ? `(${contadores[key]})` : ''}
          </div>
        ))}
        {filtroEstado !== 'todos' && (
          <div
            onClick={() => setFiltro('todos')}
            style={{ padding: '8px 16px', borderRadius: 20, cursor: 'pointer', background: INK06, color: INK55, fontSize: 12 }}
          >
            × Todos
          </div>
        )}
      </div>

      {/* Barra de acciones */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center' }}>
        <input
          value={busqueda}
          onChange={e => setBusqueda(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && void load()}
          placeholder="Buscar por nombre, email u organización…"
          style={{ ...inputStyle, maxWidth: 320 }}
        />
        <button onClick={() => void load()} style={btnSecondaryStyle}><RefreshCw size={14} /> Buscar</button>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: INK35 }}>{leads.length} registro{leads.length !== 1 ? 's' : ''}</span>
        <button onClick={() => setShowForm(f => !f)} style={btnPrimaryStyle}><Plus size={14} /> Nuevo prospecto</button>
      </div>

      {/* Formulario manual */}
      {showForm && (
        <FormNuevoLead
          onCreated={lead => { setLeads(prev => [lead, ...prev]); setShowForm(false) }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {/* Tabla */}
      {leads.length === 0 ? (
        <div style={{
          textAlign: 'center', padding: '48px 0', color: INK35,
          background: WHITE, borderRadius: 12, border: `1px solid ${INK12}`,
        }}>
          <UserCheck size={32} color={INK12} style={{ marginBottom: 12 }} />
          <p style={{ fontSize: 14, margin: 0 }}>Sin prospectos aún.</p>
          <p style={{ fontSize: 12, margin: '4px 0 0' }}>
            Agrégalos manualmente o comparte el formulario de contacto de la landing.
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {leads.map(lead => (
            <LeadCard
              key={lead.id}
              lead={lead}
              isExpanded={expanded === lead.id}
              onToggle={() => setExpanded(expanded === lead.id ? null : lead.id)}
              onEstado={actualizarEstado}
              onGuardarNotas={guardarNotas}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function LeadCard({ lead, isExpanded, onToggle, onEstado, onGuardarNotas }: {
  lead:            LeadRow
  isExpanded:      boolean
  onToggle:        () => void
  onEstado:        (id: string, estado: string) => void
  onGuardarNotas:  (id: string, notas: string) => void
}) {
  const [notas, setNotas]   = useState(lead.notas_internas ?? '')
  const [saved, setSaved]   = useState(false)
  const cfg = ESTADO_LEAD[lead.estado] ?? ESTADO_LEAD.nuevo

  async function saveNotas() {
    await onGuardarNotas(lead.id, notas)
    setSaved(true); setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div style={{
      background: WHITE, border: `1px solid ${INK12}`, borderRadius: 10,
      overflow: 'hidden',
    }}>
      {/* Fila resumen */}
      <div
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px',
          cursor: 'pointer', transition: 'background 0.1s',
        }}
      >
        {/* Estado badge */}
        <span style={{
          fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 20,
          background: cfg.bg, color: cfg.color, whiteSpace: 'nowrap',
          minWidth: 90, textAlign: 'center',
        }}>
          {cfg.label}
        </span>

        {/* Nombre + org */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: TINTA, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
            {lead.nombre}
          </div>
          {lead.organizacion && (
            <div style={{ fontSize: 11.5, color: INK55 }}>
              {lead.organizacion}
              {lead.tipo_org && ` · ${TIPO_LEAD[lead.tipo_org] ?? lead.tipo_org}`}
            </div>
          )}
        </div>

        {/* Email */}
        <a
          href={`mailto:${lead.email}`}
          onClick={e => e.stopPropagation()}
          style={{ fontSize: 12.5, color: SELLO, textDecoration: 'none', whiteSpace: 'nowrap' }}
        >
          {lead.email}
        </a>

        {/* Fuente */}
        <span style={{ fontSize: 11, color: INK35, whiteSpace: 'nowrap' }}>
          {lead.fuente === 'manual' ? '✏️ manual' : '🌐 landing'}
        </span>

        {/* Fecha */}
        <span style={{ fontSize: 11, color: INK35, whiteSpace: 'nowrap' }}>
          {new Date(lead.created_at).toLocaleDateString('es-CO')}
        </span>

        <ChevronRight
          size={16} color={INK35}
          style={{ transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', flexShrink: 0 }}
        />
      </div>

      {/* Panel expandible */}
      {isExpanded && (
        <div style={{ borderTop: `1px solid ${INK06}`, padding: '16px 20px', background: `${SELLO}04` }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>

            {/* Datos de contacto */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: INK55, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
                Datos
              </div>
              <dl style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {lead.cargo && <DRow label="Cargo" value={lead.cargo} />}
                {lead.telefono && <DRow label="Teléfono" value={lead.telefono} />}
                {lead.mensaje && <DRow label="Mensaje" value={lead.mensaje} />}
              </dl>

              {/* Cambiar estado */}
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: INK55, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                  Estado
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {Object.entries(ESTADO_LEAD).map(([key, c]) => (
                    <button
                      key={key}
                      onClick={() => onEstado(lead.id, key)}
                      style={{
                        padding: '5px 12px', borderRadius: 16, fontSize: 11.5, fontWeight: 700, cursor: 'pointer', border: 'none',
                        background: lead.estado === key ? c.color : c.bg,
                        color: lead.estado === key ? WHITE : c.color,
                        opacity: lead.estado === key ? 1 : 0.8,
                      }}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Notas internas */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: INK55, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                Notas internas
              </div>
              <textarea
                value={notas}
                onChange={e => { setNotas(e.target.value); setSaved(false) }}
                rows={5}
                placeholder="Contexto de la llamada, próximos pasos, observaciones…"
                style={{
                  ...inputStyle, resize: 'vertical', fontFamily: 'inherit',
                  fontSize: 13, lineHeight: 1.5,
                }}
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
                <button onClick={() => void saveNotas()} style={btnPrimaryStyle}>
                  <CheckCircle2 size={13} /> Guardar notas
                </button>
                {saved && <span style={{ fontSize: 12, color: OK, fontWeight: 600 }}>Guardado ✓</span>}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function DRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 13 }}>
      <dt style={{ color: INK55, minWidth: 80, fontWeight: 600 }}>{label}</dt>
      <dd style={{ margin: 0, color: TINTA }}>{value}</dd>
    </div>
  )
}

function FormNuevoLead({ onCreated, onCancel }: { onCreated: (l: LeadRow) => void; onCancel: () => void }) {
  const [nombre,       setNombre]       = useState('')
  const [email,        setEmail]        = useState('')
  const [cargo,        setCargo]        = useState('')
  const [organizacion, setOrganizacion] = useState('')
  const [tipo_org,     setTipoOrg]      = useState('veeduria')
  const [telefono,     setTelefono]     = useState('')
  const [mensaje,      setMensaje]      = useState('')
  const [notas,        setNotas]        = useState('')
  const [loading,      setLoading]      = useState(false)
  const [error,        setError]        = useState('')

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setLoading(true); setError('')
    try {
      const data = await veedorFetch<{ lead?: LeadRow; error?: string }>('/veeduria/leads', 'POST', {
        nombre: nombre.trim(), email: email.trim(),
        cargo: cargo.trim() || null, organizacion: organizacion.trim() || null,
        tipo_org, telefono: telefono.trim() || null,
        mensaje: mensaje.trim() || null, notas_internas: notas.trim() || null,
      })
      if (!data.lead) throw new Error(data.error ?? 'Error guardando')
      onCreated(data.lead)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error')
    } finally { setLoading(false) }
  }

  return (
    <div style={{ background: WHITE, borderRadius: 12, border: `1px solid ${INK12}`, padding: '24px 28px', marginBottom: 16 }}>
      <h3 style={{ fontSize: 15, fontWeight: 800, color: TINTA, margin: '0 0 18px' }}>Nuevo prospecto</h3>
      {error && <div style={{ ...errorStyle, marginBottom: 14 }}>{error}</div>}
      <form onSubmit={e => void handleSubmit(e)}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14, marginBottom: 14 }}>
          <div>
            <label style={labelStyle}>Nombre *</label>
            <input required value={nombre} onChange={e => setNombre(e.target.value)} placeholder="María García" style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Email *</label>
            <input type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="mgarcia@contraloria.gov.co" style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Teléfono</label>
            <input value={telefono} onChange={e => setTelefono(e.target.value)} placeholder="+57 300 000 0000" style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Cargo</label>
            <input value={cargo} onChange={e => setCargo(e.target.value)} placeholder="Contralor departamental" style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Organización</label>
            <input value={organizacion} onChange={e => setOrganizacion(e.target.value)} placeholder="Contraloría de Córdoba" style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Tipo de organización</label>
            <select value={tipo_org} onChange={e => setTipoOrg(e.target.value)} style={inputStyle}>
              <option value="veeduria">Veeduría</option>
              <option value="contraloria">Contraloría</option>
              <option value="auditoria">Auditoría General</option>
              <option value="ong">ONG</option>
              <option value="academia">Academia</option>
              <option value="otro">Otro</option>
            </select>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 16 }}>
          <div>
            <label style={labelStyle}>Mensaje / contexto</label>
            <textarea value={mensaje} onChange={e => setMensaje(e.target.value)} rows={3} placeholder="¿Qué les interesa de CATÓN?" style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
          </div>
          <div>
            <label style={labelStyle}>Notas internas</label>
            <textarea value={notas} onChange={e => setNotas(e.target.value)} rows={3} placeholder="Cómo llegó, próximos pasos…" style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={onCancel} style={btnSecondaryStyle}>Cancelar</button>
          <button type="submit" disabled={loading} style={btnPrimaryStyle}>
            {loading ? <><Loader2 size={14} className="animate-spin" /> Guardando…</> : <><UserCheck size={14} /> Agregar prospecto</>}
          </button>
        </div>
      </form>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// Helpers de UI
// ══════════════════════════════════════════════════════════════════════════════

function TableCard({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ background: WHITE, borderRadius: 12, border: `1px solid ${INK12}`, overflow: 'hidden', ...style }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        {children}
      </table>
    </div>
  )
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 700, color: INK55, fontSize: 11, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
      {children}
    </th>
  )
}

function Td({ children, bold, dim, small }: { children: React.ReactNode; bold?: boolean; dim?: boolean; small?: boolean }) {
  return (
    <td style={{ padding: '12px 16px', color: dim ? INK55 : TINTA, fontWeight: bold ? 700 : 400, fontSize: small ? 12 : 13 }}>
      {children}
    </td>
  )
}

function Badge({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <span style={{ background: `${color}18`, color, fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 10 }}>
      {children}
    </span>
  )
}

function RolBadge({ rol }: { rol: string }) {
  const colors: Record<string, { bg: string; color: string }> = {
    director:    { bg: `${ORO}30`,    color: SELLO },
    coordinador: { bg: `${TINTA}12`,  color: TINTA },
    auditor:     { bg: INK06,          color: INK55 },
  }
  const c = colors[rol] ?? colors.auditor
  return (
    <span style={{ background: c.bg, color: c.color, fontSize: 11.5, fontWeight: 700, padding: '3px 9px', borderRadius: 20, letterSpacing: '0.02em' }}>
      {ROL_LABEL[rol] ?? rol}
    </span>
  )
}

function LoadingState({ label }: { label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: INK55, padding: '32px 0' }}>
      <Loader2 size={18} className="animate-spin" color={TINTA} />
      <span>{label}</span>
    </div>
  )
}

function ErrorState({ msg, onRetry }: { msg: string; onRetry: () => void }) {
  return (
    <div style={{ padding: '16px 20px', background: '#FEF2F2', borderRadius: 10, border: '1px solid #FECACA' }}>
      <p style={{ fontSize: 13, color: HALLAZGO, margin: '0 0 10px' }}>{msg}</p>
      <button onClick={onRetry} style={btnSecondaryStyle}><RefreshCw size={14} /> Reintentar</button>
    </div>
  )
}

// ── Estilos compartidos ───────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 12px', fontSize: 13.5,
  border: `1px solid ${INK12}`, borderRadius: 8,
  background: WHITE, color: TINTA, outline: 'none',
  boxSizing: 'border-box',
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 11.5, fontWeight: 700,
  color: INK55, marginBottom: 4, letterSpacing: '0.03em',
  textTransform: 'uppercase',
}

const btnPrimaryStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 7,
  padding: '8px 16px', fontSize: 13, fontWeight: 700,
  borderRadius: 8, border: 'none', cursor: 'pointer',
  background: PANTALLA, color: WHITE,
}

const btnSecondaryStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 7,
  padding: '8px 14px', fontSize: 13, fontWeight: 600,
  borderRadius: 8, border: `1px solid ${INK12}`, cursor: 'pointer',
  background: WHITE, color: INK55,
}

const errorStyle: React.CSSProperties = {
  background: '#FEF2F2', border: '1px solid #FECACA',
  borderRadius: 8, padding: '10px 14px', fontSize: 13, color: HALLAZGO,
}

const successStyle: React.CSSProperties = {
  background: '#F0FDF4', border: '1px solid #BBF7D0',
  borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#166534',
}

const emptyTdStyle: React.CSSProperties = {
  padding: '32px 16px', textAlign: 'center', color: INK35,
}
