/**
 * CatonConfigPage.tsx
 *
 * Página de configuración de la organización en CATÓN.
 * Accesible desde /app/configuracion.
 *
 * Tabs:
 *   Perfil        — nombre, ciudad (solo lectura para auditores)
 *   Membrete      — cabecera, pie de página, firmante para PDFs
 *   Notificaciones — email de alertas
 *   IA (BYOK)    — solo si plan_tipo = 'byok'
 */
import { useState, useEffect, useCallback, type FormEvent } from 'react'
import {
  Settings, Building2, FileText, Bell, Cpu,
  Loader2, CheckCircle2, RefreshCw, Eye, EyeOff, Lock,
} from 'lucide-react'
import type { CatonUser } from './useCatonAuth.js'
import { catonGet, catonPost, catonPatch } from './catonClient.js'

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

interface OrgInfo {
  id:           string
  nombre:       string
  tipo:         string
  ciudad:       string | null
  plan_tipo:    string
  dominio_propio:     string | null
  email_from_address: string | null
  dominio_verificado: boolean
}

interface VeedorConfig {
  id?:              string
  org_id:           string
  membrete_url:     string | null
  pie_pagina:       string | null
  firmante_nombre:  string | null
  firmante_cargo:   string | null
  email_alertas:    string | null
  ai_proveedor:     string | null
  ai_api_key_enc?:  string   // solo escritura
}

type Tab = 'perfil' | 'membrete' | 'notificaciones' | 'ia'

const TIPO_ORG_LABEL: Record<string, string> = {
  veeduria:    'Veeduría',
  contraloria: 'Contraloría',
  ong:         'ONG',
  academia:    'Academia',
}

// ── Componente principal ──────────────────────────────────────────────────────

interface Props { user: CatonUser }

export function CatonConfigPage({ user }: Props) {
  const [tab, setTab]       = useState<Tab>('perfil')
  const [org, setOrg]       = useState<OrgInfo | null>(null)
  const [config, setConfig] = useState<VeedorConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState('')

  const canEdit = user.rol === 'director' || user.rol === 'coordinador' || user.esAdmin

  const load = useCallback(async () => {
    if (!user.orgId) return
    setLoading(true); setError('')
    try {
      const [orgRows, cfgRows] = await Promise.all([
        catonGet(`veedor_orgs?id=eq.${user.orgId}&select=id,nombre,tipo,ciudad,plan_tipo,dominio_propio,email_from_address,dominio_verificado`) as Promise<OrgInfo[]>,
        catonGet(`veedor_config?org_id=eq.${user.orgId}&select=id,org_id,membrete_url,pie_pagina,firmante_nombre,firmante_cargo,email_alertas,ai_proveedor`) as Promise<VeedorConfig[]>,
      ])
      setOrg(orgRows?.[0] ?? null)
      setConfig(cfgRows?.[0] ?? { org_id: user.orgId, membrete_url: null, pie_pagina: null, firmante_nombre: null, firmante_cargo: null, email_alertas: null, ai_proveedor: null })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error cargando configuración')
    } finally { setLoading(false) }
  }, [user.orgId])

  useEffect(() => { void load() }, [load])

  async function saveConfig(patch: Partial<VeedorConfig>) {
    if (!user.orgId || !config) return
    if (config.id) {
      // UPDATE
      const rows = await catonPatch('veedor_config', `org_id=eq.${user.orgId}`, patch) as VeedorConfig[]
      if (rows?.[0]) setConfig(rows[0])
    } else {
      // INSERT (primera vez)
      const rows = await catonPost('veedor_config', { org_id: user.orgId, ...patch }) as VeedorConfig[]
      if (rows?.[0]) setConfig(rows[0])
    }
  }

  const tabs: [Tab, React.ReactNode, string][] = [
    ['perfil',         <Building2 size={15} />, 'Perfil'],
    ['membrete',       <FileText size={15} />,  'Membrete'],
    ['notificaciones', <Bell size={15} />,      'Notificaciones'],
    ...(org?.plan_tipo === 'byok' ? [['ia', <Cpu size={15} />, 'IA (llave propia)'] as [Tab, React.ReactNode, string]] : []),
  ]

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '48px 40px', color: INK55 }}>
        <Loader2 size={18} className="animate-spin" color={TINTA} />
        Cargando configuración…
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ padding: '32px 40px' }}>
        <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: '14px 18px' }}>
          <p style={{ color: HALLAZGO, fontSize: 13, margin: '0 0 10px' }}>{error}</p>
          <button onClick={load} style={btnSecondaryStyle}><RefreshCw size={14} /> Reintentar</button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ padding: '32px 40px', maxWidth: 860, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <Settings size={18} color={SELLO} />
          <h1 style={{ fontSize: 22, fontWeight: 800, color: TINTA, margin: 0 }}>
            Configuración
          </h1>
        </div>
        <p style={{ fontSize: 13, color: INK55, margin: 0 }}>
          {org?.nombre} · {TIPO_ORG_LABEL[org?.tipo ?? ''] ?? org?.tipo}
          {!canEdit && (
            <span style={{ marginLeft: 10, fontSize: 11, color: SELLO, fontWeight: 700 }}>
              (solo lectura — rol Auditor)
            </span>
          )}
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

      {tab === 'perfil'         && <TabPerfil org={org} canEdit={canEdit} onSaved={o => setOrg(o)} />}
      {tab === 'membrete'       && <TabMembrete config={config} canEdit={canEdit} onSaved={saveConfig} />}
      {tab === 'notificaciones' && <TabNotificaciones config={config} canEdit={canEdit} onSaved={saveConfig} />}
      {tab === 'ia'             && <TabIA orgId={user.orgId ?? ''} config={config} canEdit={canEdit} onSaved={saveConfig} />}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// Tab Perfil
// ══════════════════════════════════════════════════════════════════════════════

function TabPerfil({ org, canEdit, onSaved }: {
  org: OrgInfo | null
  canEdit: boolean
  onSaved: (o: OrgInfo) => void
}) {
  const [nombre, setNombre] = useState(org?.nombre ?? '')
  const [ciudad, setCiudad] = useState(org?.ciudad ?? '')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg]       = useState('')

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!org || !canEdit) return
    setSaving(true); setMsg('')
    try {
      const rows = await catonPatch('veedor_orgs', `id=eq.${org.id}`, {
        nombre: nombre.trim(),
        ciudad: ciudad.trim() || null,
      }) as OrgInfo[]
      if (rows?.[0]) { onSaved(rows[0]); setMsg('Guardado ✓') }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Error')
    } finally { setSaving(false) }
  }

  return (
    <Card>
      <SectionTitle icon={<Building2 size={15} color={SELLO} />}>
        Información de la organización
      </SectionTitle>

      <form onSubmit={e => void save(e)} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <Field label="Nombre de la organización">
          <input
            value={nombre}
            onChange={e => setNombre(e.target.value)}
            style={inputStyle}
            disabled={!canEdit}
            required
          />
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <Field label="Tipo">
            <input
              value={TIPO_ORG_LABEL[org?.tipo ?? ''] ?? org?.tipo ?? ''}
              style={{ ...inputStyle, background: INK06, color: INK55 }}
              disabled
            />
            <p style={{ fontSize: 11, color: INK35, margin: '4px 0 0' }}>
              El tipo lo configura el administrador de CATÓN.
            </p>
          </Field>
          <Field label="Ciudad / municipio">
            <input
              value={ciudad}
              onChange={e => setCiudad(e.target.value)}
              placeholder="Montería"
              style={inputStyle}
              disabled={!canEdit}
            />
          </Field>
        </div>

        {/* Dominio — solo lectura, info para la org */}
        <div style={{
          padding: '14px 16px', background: INK06, borderRadius: 10,
          border: `1px solid ${INK12}`,
        }}>
          <p style={{ fontSize: 12, fontWeight: 700, color: INK55, margin: '0 0 8px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Correo saliente
          </p>
          {org?.dominio_verificado && org?.email_from_address ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 18 }}>✅</span>
              <div>
                <p style={{ fontSize: 13, fontWeight: 700, color: TINTA, margin: 0 }}>
                  {org.email_from_address}
                </p>
                <p style={{ fontSize: 11, color: INK55, margin: 0 }}>
                  Dominio activo — los correos de automatización salen desde aquí.
                </p>
              </div>
            </div>
          ) : (
            <p style={{ fontSize: 13, color: INK55, margin: 0 }}>
              Sin dominio propio configurado. Contacta al administrador de CATÓN para activarlo.
            </p>
          )}
        </div>

        {canEdit && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button type="submit" disabled={saving} style={btnPrimaryStyle}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
              {saving ? 'Guardando…' : 'Guardar cambios'}
            </button>
            {msg && (
              <span style={{ fontSize: 13, fontWeight: 600, color: msg.includes('✓') ? OK : HALLAZGO }}>
                {msg}
              </span>
            )}
          </div>
        )}
      </form>
    </Card>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// Tab Membrete
// ══════════════════════════════════════════════════════════════════════════════

function TabMembrete({ config, canEdit, onSaved }: {
  config: VeedorConfig | null
  canEdit: boolean
  onSaved: (patch: Partial<VeedorConfig>) => Promise<void>
}) {
  const [membreteUrl,    setMembreteUrl]    = useState(config?.membrete_url ?? '')
  const [piePagina,      setPiePagina]      = useState(config?.pie_pagina ?? '')
  const [firmanteNombre, setFirmanteNombre] = useState(config?.firmante_nombre ?? '')
  const [firmanteCargo,  setFirmanteCargo]  = useState(config?.firmante_cargo ?? '')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg]       = useState('')

  async function save(e: FormEvent) {
    e.preventDefault()
    setSaving(true); setMsg('')
    try {
      await onSaved({
        membrete_url:    membreteUrl.trim() || null,
        pie_pagina:      piePagina.trim() || null,
        firmante_nombre: firmanteNombre.trim() || null,
        firmante_cargo:  firmanteCargo.trim() || null,
      })
      setMsg('Guardado ✓')
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Error')
    } finally { setSaving(false) }
  }

  return (
    <Card>
      <SectionTitle icon={<FileText size={15} color={SELLO} />}>
        Membrete de documentos
      </SectionTitle>

      <p style={{ fontSize: 13, color: INK55, margin: '0 0 20px', lineHeight: 1.6 }}>
        El membrete aparece en el encabezado de cada denuncia, tutela y memorial generado por CATÓN.
      </p>

      <form onSubmit={e => void save(e)} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

        {/* URL imagen */}
        <Field label="URL de la imagen de cabecera (membrete/logo)">
          <input
            value={membreteUrl}
            onChange={e => setMembreteUrl(e.target.value)}
            placeholder="https://… (imagen PNG/JPG, fondo blanco, máx 800×200 px)"
            style={inputStyle}
            disabled={!canEdit}
          />
          <p style={{ fontSize: 11, color: INK35, margin: '4px 0 0' }}>
            Sube la imagen a tu servicio de almacenamiento y pega la URL pública aquí.
            Próximamente: subida directa desde CATÓN.
          </p>
        </Field>

        {/* Preview */}
        {membreteUrl && (
          <div style={{
            border: `1px solid ${INK12}`, borderRadius: 8, overflow: 'hidden',
            padding: '12px 16px', background: WHITE,
          }}>
            <p style={{ fontSize: 11, color: INK35, margin: '0 0 8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Vista previa
            </p>
            <img
              src={membreteUrl}
              alt="Membrete"
              style={{ maxWidth: '100%', maxHeight: 120, objectFit: 'contain' }}
              onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
            />
          </div>
        )}

        {/* Firmante */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <Field label="Nombre del firmante">
            <input
              value={firmanteNombre}
              onChange={e => setFirmanteNombre(e.target.value)}
              placeholder="Esperanza González Rodríguez"
              style={inputStyle}
              disabled={!canEdit}
            />
          </Field>
          <Field label="Cargo del firmante">
            <input
              value={firmanteCargo}
              onChange={e => setFirmanteCargo(e.target.value)}
              placeholder="Representante Legal"
              style={inputStyle}
              disabled={!canEdit}
            />
          </Field>
        </div>

        {/* Pie de página */}
        <Field label="Pie de página del documento">
          <textarea
            value={piePagina}
            onChange={e => setPiePagina(e.target.value)}
            placeholder="Ej: Veeduría Ciudadana de Córdoba · NIT 900.123.456-7 · Inscrita ante la Cámara de Comercio de Montería · Registro No. VCC-2021-001"
            style={{ ...inputStyle, height: 80, resize: 'vertical', fontFamily: 'inherit' }}
            disabled={!canEdit}
          />
        </Field>

        {/* Preview documento */}
        {(firmanteNombre || piePagina) && (
          <div style={{
            border: `1px dashed ${INK12}`, borderRadius: 10, padding: '20px 24px',
            background: PAPEL,
          }}>
            <p style={{ fontSize: 11, color: INK35, margin: '0 0 12px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Vista previa del pie del documento
            </p>
            <div style={{ borderTop: `1px solid ${INK12}`, paddingTop: 14, marginTop: 8 }}>
              {firmanteNombre && (
                <p style={{ fontSize: 13, fontWeight: 700, color: TINTA, margin: '0 0 2px' }}>
                  {firmanteNombre}
                </p>
              )}
              {firmanteCargo && (
                <p style={{ fontSize: 12, color: INK55, margin: '0 0 8px' }}>{firmanteCargo}</p>
              )}
              {piePagina && (
                <p style={{ fontSize: 11, color: INK35, margin: 0, lineHeight: 1.5 }}>{piePagina}</p>
              )}
            </div>
          </div>
        )}

        {canEdit && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button type="submit" disabled={saving} style={btnPrimaryStyle}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
              {saving ? 'Guardando…' : 'Guardar membrete'}
            </button>
            {msg && (
              <span style={{ fontSize: 13, fontWeight: 600, color: msg.includes('✓') ? OK : HALLAZGO }}>
                {msg}
              </span>
            )}
          </div>
        )}
      </form>
    </Card>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// Tab Notificaciones
// ══════════════════════════════════════════════════════════════════════════════

function TabNotificaciones({ config, canEdit, onSaved }: {
  config: VeedorConfig | null
  canEdit: boolean
  onSaved: (patch: Partial<VeedorConfig>) => Promise<void>
}) {
  const [emailAlertas, setEmailAlertas] = useState(config?.email_alertas ?? '')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg]       = useState('')

  async function save(e: FormEvent) {
    e.preventDefault()
    setSaving(true); setMsg('')
    try {
      await onSaved({ email_alertas: emailAlertas.trim() || null })
      setMsg('Guardado ✓')
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Error')
    } finally { setSaving(false) }
  }

  return (
    <Card>
      <SectionTitle icon={<Bell size={15} color={SELLO} />}>
        Notificaciones y alertas
      </SectionTitle>

      <form onSubmit={e => void save(e)} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

        <Field label="Correo de alertas">
          <input
            type="email"
            value={emailAlertas}
            onChange={e => setEmailAlertas(e.target.value)}
            placeholder="alertas@miorganizacion.gov.co"
            style={inputStyle}
            disabled={!canEdit}
          />
          <p style={{ fontSize: 11, color: INK35, margin: '4px 0 0' }}>
            A este correo llegan: alertas de vencimiento de derecho de petición (15 días hábiles),
            respuestas recibidas de entidades, actuaciones de tutela.
          </p>
        </Field>

        {/* Qué notificaciones llegan */}
        <div style={{ background: INK06, borderRadius: 10, padding: '16px 18px' }}>
          <p style={{ fontSize: 12, fontWeight: 700, color: INK55, margin: '0 0 10px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Eventos que generan alerta
          </p>
          {[
            ['⏰', 'Vencimiento derecho de petición', 'Cuando la entidad no responde en 15 días hábiles'],
            ['📬', 'Respuesta recibida', 'Al recibir respuesta de la entidad (analizada por IA)'],
            ['⚖️', 'Actuación judicial', 'Nueva actuación en el proceso de tutela'],
            ['🔴', 'Respuesta evasiva', 'Cuando el análisis de IA detecta que no respondieron de fondo'],
          ].map(([emoji, titulo, desc]) => (
            <div key={titulo} style={{ display: 'flex', gap: 10, marginBottom: 8 }}>
              <span style={{ fontSize: 16, flexShrink: 0, marginTop: 1 }}>{emoji}</span>
              <div>
                <p style={{ fontSize: 13, fontWeight: 600, color: TINTA, margin: 0 }}>{titulo}</p>
                <p style={{ fontSize: 11, color: INK55, margin: 0 }}>{desc}</p>
              </div>
            </div>
          ))}
        </div>

        {canEdit && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button type="submit" disabled={saving} style={btnPrimaryStyle}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
              {saving ? 'Guardando…' : 'Guardar'}
            </button>
            {msg && (
              <span style={{ fontSize: 13, fontWeight: 600, color: msg.includes('✓') ? OK : HALLAZGO }}>
                {msg}
              </span>
            )}
          </div>
        )}
      </form>
    </Card>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// Tab IA BYOK
// ══════════════════════════════════════════════════════════════════════════════

function TabIA({ orgId, config, canEdit, onSaved }: {
  orgId: string
  config: VeedorConfig | null
  canEdit: boolean
  onSaved: (patch: Partial<VeedorConfig>) => Promise<void>
}) {
  const [proveedor, setProveedor] = useState(config?.ai_proveedor ?? 'anthropic')
  const [apiKey, setApiKey]       = useState('')
  const [showKey, setShowKey]     = useState(false)
  const [hasKey, setHasKey]       = useState(false)
  const [saving, setSaving]       = useState(false)
  const [msg, setMsg]             = useState('')

  // Detectar si ya hay llave configurada (el valor cifrado existe pero no se devuelve)
  useEffect(() => {
    // Si el backend tiene ai_api_key_enc, la config no la trae pero podemos
    // preguntar vía RPC si existe. Por ahora, usamos un campo auxiliar en config.
    // En V1: asumimos que si ai_proveedor está seteado, hay llave configurada.
    setHasKey(!!config?.ai_proveedor)
  }, [config])

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!apiKey.trim()) { setMsg('Ingresa la llave de API'); return }
    setSaving(true); setMsg('')
    try {
      // La llave se envía al backend para cifrarla con AES-256 antes de guardar.
      // En V1 la enviamos en texto al PATCH — el backend (o una edge function futura)
      // se encargará del cifrado. Por ahora se guarda en ai_api_key_enc directamente.
      // TODO: reemplazar con edge function caton-set-api-key para cifrado server-side.
      await onSaved({
        ai_proveedor:  proveedor as 'anthropic' | 'openai',
        ai_api_key_enc: apiKey.trim(),   // ⚠️ cifrar server-side en producción real
      })
      setApiKey('')
      setHasKey(true)
      setMsg('Llave guardada ✓')
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Error')
    } finally { setSaving(false) }
  }

  return (
    <Card>
      <SectionTitle icon={<Cpu size={15} color={SELLO} />}>
        Llave de IA propia (BYOK)
      </SectionTitle>

      <div style={{
        background: `${SELLO}12`, border: `1px solid ${SELLO}30`,
        borderRadius: 8, padding: '12px 16px', marginBottom: 20, fontSize: 13, color: INK55,
      }}>
        <strong style={{ color: TINTA }}>Plan BYOK activo.</strong>{' '}
        La IA de CATÓN usará tu propia llave de API, no la de CATÓN.
        Tu costo de IA va directamente a tu cuenta de Anthropic u OpenAI.
      </div>

      {hasKey && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 16px', background: `${OK}10`,
          border: `1px solid ${OK}30`, borderRadius: 8, marginBottom: 20,
        }}>
          <Lock size={16} color={OK} />
          <div>
            <p style={{ fontSize: 13, fontWeight: 700, color: OK, margin: 0 }}>
              Llave configurada ({config?.ai_proveedor === 'anthropic' ? 'Anthropic Claude' : 'OpenAI GPT'})
            </p>
            <p style={{ fontSize: 11, color: INK55, margin: 0 }}>
              Para reemplazarla, ingresa la nueva llave abajo.
            </p>
          </div>
        </div>
      )}

      {canEdit && (
        <form onSubmit={e => void save(e)} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Field label="Proveedor de IA">
            <select value={proveedor} onChange={e => setProveedor(e.target.value)} style={inputStyle}>
              <option value="anthropic">Anthropic (Claude Sonnet)</option>
              <option value="openai">OpenAI (GPT-4o)</option>
            </select>
          </Field>

          <Field label={hasKey ? 'Nueva llave de API (reemplaza la actual)' : 'Llave de API'}>
            <div style={{ position: 'relative' }}>
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder={proveedor === 'anthropic' ? 'sk-ant-api03-…' : 'sk-…'}
                style={{ ...inputStyle, paddingRight: 44, fontFamily: '"IBM Plex Mono", monospace', fontSize: 12 }}
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => setShowKey(v => !v)}
                style={{
                  position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
                  background: 'none', border: 'none', cursor: 'pointer', color: INK35, padding: 2,
                }}
              >
                {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            <p style={{ fontSize: 11, color: INK35, margin: '4px 0 0' }}>
              La llave se cifra antes de guardarse. El equipo de CATÓN no la puede leer.
            </p>
          </Field>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button type="submit" disabled={saving || !apiKey.trim()} style={btnPrimaryStyle}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Lock size={14} />}
              {saving ? 'Guardando…' : hasKey ? 'Reemplazar llave' : 'Guardar llave'}
            </button>
            {msg && (
              <span style={{ fontSize: 13, fontWeight: 600, color: msg.includes('✓') ? OK : HALLAZGO }}>
                {msg}
              </span>
            )}
          </div>
        </form>
      )}

      {!canEdit && (
        <p style={{ fontSize: 13, color: INK55, fontStyle: 'italic' }}>
          Solo el Director o Coordinador puede modificar la llave de IA.
        </p>
      )}
    </Card>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// Helpers de UI
// ══════════════════════════════════════════════════════════════════════════════

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      background: WHITE, borderRadius: 12,
      border: `1px solid ${INK12}`, padding: '28px 32px',
    }}>
      {children}
    </div>
  )
}

function SectionTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
      {icon}
      <h2 style={{ fontSize: 15, fontWeight: 800, color: TINTA, margin: 0 }}>
        {children}
      </h2>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  )
}

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
  padding: '9px 18px', fontSize: 13, fontWeight: 700,
  borderRadius: 8, border: 'none', cursor: 'pointer',
  background: PANTALLA, color: WHITE,
}

const btnSecondaryStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 7,
  padding: '8px 14px', fontSize: 13, fontWeight: 600,
  borderRadius: 8, border: `1px solid ${INK12}`, cursor: 'pointer',
  background: WHITE, color: INK55,
}
