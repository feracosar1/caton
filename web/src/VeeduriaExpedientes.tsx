// @ts-nocheck
/**
 * VEEDURÍA — flujo de expedientes (el motor puesto en pantallas).
 *
 *   Buscar contratos → [Auditar] corre el motor → Expediente con hallazgos →
 *   [Generar borrador de denuncia] → revisar citas y prosa.
 *
 * El humano decide en cada compuerta. Nada se envía: esto deja el BORRADOR.
 * Consume /veeduria/* del veedor-server (ya vivos y probados).
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  Search, Gavel, FileText, Loader, ChevronLeft, RefreshCw, ExternalLink,
  AlertTriangle, GitBranch, X, ShieldCheck, ScrollText, Clock, Radar,
  Send, Calendar, CheckCircle, MessageSquare, Inbox, FileCheck, ChevronDown, ChevronRight,
  Mail, Settings,
} from 'lucide-react'
import * as api from './veedorApi.js'
import { GrafoRadial, GraficoEvolucion } from './GrafoRadial.js'
import { EditorDenuncia } from './EditorDenuncia.js'

// ── Paleta CATÓN (papel notarial / tinta / sello) ──────────────────────────────
const INK    = '#0A2E22'   // --tinta
const PAPEL  = '#F5F1E8'   // --papel
const PAPEL2 = '#EFEAE0'   // --papel-2
const BLANCO = '#FBF9F4'   // --blanco-calido
const SELLO  = '#96712A'   // --sello (dorado oscuro)
const ORO    = '#E3C57E'   // --oro-claro
const HALLAZGO = '#B0392C' // --hallazgo (rojo)
const OK     = '#1E7F4E'   // --ok (verde)
const AMBER  = '#CA8A04'   // advertencia
const WHITE  = '#FFFFFF'
// Aliases de compatibilidad para el código existente
const GREEN  = OK
const DKGRN  = INK
const CREAM  = PAPEL
const GOLD   = SELLO
const RED    = HALLAZGO
const INK06  = 'rgba(10,46,34,0.06)'
const INK12  = 'rgba(10,46,34,0.10)'
const INK55  = 'rgba(10,46,34,0.50)'
const DORADO = '#C6A15B'

const fmtCOP = (n: number | null | undefined) =>
  n == null ? '—' : new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n)
const fmtFecha = (s: string | null | undefined) => (s ? String(s).slice(0, 10) : '—')

// Fallback client-side cuando el servidor no incluye score (versión desactualizada).
// Espejo de score-contrato.mjs — misma lógica, sin llamadas.
function computarScore(c: api.ContratoBusqueda): { score: number; nivel: 'alto' | 'medio' | 'bajo'; razones: string[] } {
  let s = 0
  const razones: string[] = []
  const val = Number(c.valor) || 0
  const modalidad = (c.modalidad || '').toLowerCase()
  const objeto = (c.objeto || '').trim()
  const esPN = c.tipo_doc && c.tipo_doc !== 'NIT'
  if (modalidad.includes('directa'))         { s += 25; razones.push('Contratación directa (sin licitar)') }
  else if (modalidad.includes('gimen especial')) { s += 12; razones.push('Régimen especial (menos control)') }
  else if (modalidad.includes('nima cuant')) { s += 6;  razones.push('Mínima cuantía') }
  if (esPN && val > 200_000_000)             { s += 30; razones.push('Persona natural con contrato alto') }
  if (val > 5_000_000_000)                   { s += 20; razones.push('Contrato de más de $5.000M') }
  else if (val > 1_000_000_000)              { s += 12; razones.push('Contrato de más de $1.000M') }
  else if (val > 500_000_000)                { s += 6 }
  if (objeto.length === 0) { s += 15; razones.push('Objeto del contrato no declarado') }
  else if (objeto.length < 40) { s += 10; razones.push('Objeto genérico o sin describir') }
  const repLegal = (c.representante_legal ?? '').trim()
  if (!repLegal && val > 100_000_000) { s += 8; razones.push('Sin representante legal identificado') }
  const score = Math.min(100, s)
  const nivel: 'alto' | 'medio' | 'bajo' = score >= 55 ? 'alto' : score >= 30 ? 'medio' : 'bajo'
  return { score, nivel, razones }
}

// Color del badge según el estado del expediente.
const ESTADO_COLOR: Record<string, string> = {
  seleccionado: INK55, auditado: DKGRN, denuncia_borrador: GOLD,
  enviada: GREEN, denuncia_enviada: GREEN, esperando_respuesta: AMBER,
  respuesta_recibida: GREEN, tutela_radicada: '#7C3AED',
  fallo_favorable: GREEN, fallo_parcial: AMBER, fallo_desfavorable: RED,
  cerrado_favorable: DKGRN, cerrado: INK55,
}
const nivelColor = (n: string) => (n === 'alto' ? RED : n === 'medio' ? AMBER : INK55)

const escHtml = (s: unknown) => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string))

// Informe imprimible de la red (el usuario guarda como PDF desde el diálogo).
function descargarInformeRed(red: api.RedBarrido, evolucion: api.EvolucionRed | null) {
  const r = red.resumen, rep = red.nodos.representantes[0]
  const filaEnt = red.nodos.entidades.map(e => `<tr><td>${escHtml(e.nombre)}</td><td style="text-align:center">${e.contratos}</td><td style="text-align:right">${fmtCOP(e.valor)}</td></tr>`).join('')
  const filaEmp = red.nodos.contratistas.map(c => `<tr><td>${escHtml(c.nombre)}</td><td>${escHtml(c.nit)}</td><td style="text-align:right">${fmtCOP(c.valor)}</td></tr>`).join('')
  const manos = red.manos_comunes.map(m => `<li>${escHtml(m.nota)}</li>`).join('')
  const evo = evolucion ? evolucion.serie.map(s => `<tr><td>${s.periodo}</td><td style="text-align:center">${s.empresas} (${s.empresas_nuevas} nuevas)</td><td style="text-align:center">${s.entidades}</td><td style="text-align:right">${fmtCOP(s.valor)}</td></tr>`).join('') : ''
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Informe de red — ${escHtml(rep?.nombre || '')}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;color:#0B1F1A;max-width:820px;margin:28px auto;padding:0 22px}
h1{font-size:20px;margin:0 0 2px}h2{font-size:13px;margin:22px 0 6px;color:#0F3D2E;text-transform:uppercase;letter-spacing:.03em}
.sub{color:#5A6472;font-size:12px}.chips{display:flex;gap:10px;margin:14px 0;flex-wrap:wrap}
.chip{border:1px solid #dcdcdc;border-radius:8px;padding:6px 12px;font-size:13px}
table{width:100%;border-collapse:collapse;font-size:12px}td,th{padding:5px 8px;border-bottom:1px solid #eee;text-align:left}
th{color:#5A6472;font-size:10px;text-transform:uppercase}ul{font-size:13px;margin:4px 0;padding-left:18px}
.nota{font-size:10px;color:#5A6472;margin-top:26px;border-top:1px solid #eee;padding-top:8px}@media print{body{margin:0}}</style></head><body>
<h1>Informe de red de contratación</h1>
<div class="sub">Sujeto vigilado: <b>${escHtml(rep?.nombre || '—')}</b>${rep ? ` &middot; cédula ${escHtml(rep.rep_id)}` : ''}</div>
<div class="chips"><div class="chip"><b>${r.contratistas}</b> empresas</div><div class="chip"><b>${r.entidades_alcanzadas}</b> entidades</div><div class="chip"><b>${r.empresas_hermanas}</b> empresas hermanas</div><div class="chip"><b>${fmtCOP(r.valor_total)}</b> movidos</div></div>
${manos ? `<h2>Señales</h2><ul>${manos}</ul>` : ''}
<h2>Dónde se derrama la red</h2><table><thead><tr><th>Entidad</th><th style="text-align:center">Contratos</th><th style="text-align:right">Valor</th></tr></thead><tbody>${filaEnt}</tbody></table>
<h2>Empresas de la red</h2><table><thead><tr><th>Empresa</th><th>NIT</th><th style="text-align:right">Valor</th></tr></thead><tbody>${filaEmp}</tbody></table>
${evo ? `<h2>Evolución en el tiempo</h2><table><thead><tr><th>Año</th><th style="text-align:center">Empresas</th><th style="text-align:center">Entidades</th><th style="text-align:right">Valor</th></tr></thead><tbody>${evo}</tbody></table>` : ''}
<div class="nota">Generado por el veedor de NUMA a partir de datos abiertos de SECOP II (contratación pública, datos.gov.co). Análisis determinista sobre datos públicos: los datos deciden. No constituye una acusación &mdash; es un insumo para revisión.</div>
</body></html>`
  const w = window.open('', '_blank')
  if (!w) return
  w.document.write(html); w.document.close()
  setTimeout(() => w.print(), 350)
}

const card: CSSProperties = { background: BLANCO, border: `1px solid ${INK12}`, borderRadius: 6, padding: 16 }
const th: CSSProperties = { textAlign: 'left', padding: '7px 12px', fontSize: 10, fontWeight: 700, color: INK55, textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: `1px solid ${INK12}`, whiteSpace: 'nowrap', fontFamily: 'inherit' }
const td: CSSProperties = { padding: '10px 12px', fontSize: 13, color: INK, borderBottom: `1px solid ${INK06}`, verticalAlign: 'top', fontFamily: 'inherit' }
// Input con underline — estilo notarial
const inp: CSSProperties = { padding: '7px 0', fontSize: 13, border: 'none', borderBottom: `1px solid ${INK12}`, borderRadius: 0, background: 'transparent', color: INK, width: '100%', outline: 'none' }
const lbl: CSSProperties = { fontSize: 10, fontWeight: 700, color: INK55, marginBottom: 4, display: 'block', letterSpacing: '0.05em', textTransform: 'uppercase' }

function Btn({ children, onClick, disabled, tone = 'green', small }: {
  children: ReactNode; onClick?: () => void; disabled?: boolean; tone?: 'green' | 'ghost' | 'gold' | 'ink'; small?: boolean
}) {
  const bg = tone === 'green' ? OK : tone === 'gold' ? SELLO : tone === 'ink' ? INK : 'transparent'
  const col = tone === 'ghost' ? INK : WHITE
  const border = tone === 'ghost' ? `1px solid ${INK12}` : 'none'
  return (
    <button onClick={onClick} disabled={disabled} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, cursor: disabled ? 'not-allowed' : 'pointer',
      padding: small ? '4px 10px' : '7px 14px', fontSize: small ? 12 : 13, fontWeight: 600,
      color: col, background: bg, border,
      borderRadius: 5, opacity: disabled ? 0.5 : 1, whiteSpace: 'nowrap',
      fontFamily: 'inherit', letterSpacing: '0.01em',
    }}>{children}</button>
  )
}

function Badge({ estado }: { estado: string }) {
  const c = ESTADO_COLOR[estado] ?? INK55
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, color: WHITE, background: c,
      padding: '2px 8px', borderRadius: 3, whiteSpace: 'nowrap',
      letterSpacing: '0.04em', textTransform: 'uppercase',
      fontFamily: '"IBM Plex Mono", "Menlo", monospace',
    }}>
      {estado}
    </span>
  )
}

// Semáforo de sospecha: el score determinista (0-100) + las señales que lo dispararon.
// Es lo que convierte la lista plana en un radar: rojo = mirar primero.
const NIVEL_COLOR: Record<string, string> = { alto: RED, medio: AMBER, bajo: INK55 }
function BadgeSospecha({ score, nivel, razones }: { score: number; nivel: string; razones?: string[] | null }) {
  const c = NIVEL_COLOR[nivel] ?? INK55
  const razonesArr = razones ?? []
  return (
    <div style={{ minWidth: 120 }}>
      <span style={{ fontSize: 12, fontWeight: 800, color: WHITE, background: c, padding: '2px 9px', borderRadius: 999, whiteSpace: 'nowrap' }}>
        {score} · {nivel}
      </span>
      {razonesArr.length > 0 && (
        <ul style={{ margin: '5px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {razonesArr.map((r, i) => (
            <li key={i} style={{ fontSize: 10.5, color: INK55, lineHeight: 1.25 }}>· {r}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function VeeduriaExpedientes({
  token,
  veedor_org_id,
  sbUrl,
  sbAnon,
}: {
  token: string
  veedor_org_id?: string
  /** URL del Supabase a usar (default: VITE_SUPABASE_URL de NUMA) */
  sbUrl?: string
  /** Anon key del Supabase a usar (default: VITE_SUPABASE_ANON_KEY de NUMA) */
  sbAnon?: string
}) {
  useEffect(() => { api.setAuthToken(token) }, [token])
  const orgId = veedor_org_id ?? ''  // scope de la veeduría — vacío = super-admin ve todo
  const [pantalla, setPantalla] = useState<'buscar' | 'expedientes' | 'detalle' | 'red' | 'radar' | 'bandeja'>('buscar')
  const [error, setError] = useState('')
  // Ámbito de competencia (demo: selector "ver como…").
  const [ambitoIdx, setAmbitoIdx] = useState(0)
  const ambito = api.AMBITOS_DEMO[ambitoIdx].ambito

  // Buscar
  const [filtros, setFiltros] = useState<api.FiltrosBusqueda>({ limite: 50 })
  const [resultados, setResultados] = useState<api.ContratoBusqueda[]>([])
  const [resumen, setResumen] = useState<{ contratos: number; valor_total: number } | null>(null)
  const [buscando, setBuscando] = useState(false)

  // Auditar
  const [auditando, setAuditando] = useState<string | null>(null)

  // Expedientes
  const [expedientes, setExpedientes] = useState<api.ExpedienteResumen[]>([])
  const [cargandoExp, setCargandoExp] = useState(false)

  // Detalle
  const [detalle, setDetalle] = useState<api.ExpedienteDetalle | null>(null)
  const [cargandoDetalle, setCargandoDetalle] = useState(false)
  const [generando, setGenerando] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Análisis completo del contratista (panel)
  const [analisisPanel, setAnalisisPanel] = useState<api.AnalisisCompleto | null>(null)
  const [cargandoPerfil, setCargandoPerfil] = useState(false)

  // Barrido de red (sujetos vigilados)
  const [red, setRed] = useState<api.RedBarrido | null>(null)
  const [barriendo, setBarriendo] = useState(false)
  const [candidatos, setCandidatos] = useState<api.SenalRepMultiple[]>([])
  const [cargandoCand, setCargandoCand] = useState(false)

  // Radar — detección automática de patrones Sierra Nevada
  const [radarResultado, setRadarResultado] = useState<api.RadarResultado | null>(null)
  const [radarCargando, setRadarCargando] = useState(false)
  const [radarFiltros, setRadarFiltros] = useState<api.RadarOpts>({ ambito: undefined })

  // Bandeja — requerimientos enviados
  interface Requerimiento {
    id: string; tipo: string; estado: string; destinatario_nombre: string | null
    destinatario_email: string | null; respuesta_html: string | null; respuesta_from: string | null
    fecha_envio: string | null; fecha_vencimiento: string | null; fecha_respuesta: string | null
    created_at: string
  }
  const [requerimientos, setRequerimientos] = useState<Requerimiento[]>([])
  const [cargandoBandeja, setCargandoBandeja] = useState(false)

  const cargarBandeja = useCallback(async () => {
    setCargandoBandeja(true)
    try {
      const base = (sbUrl ?? (import.meta.env.VITE_SUPABASE_URL as string)).replace(/\/+$/, '')
      const anon = sbAnon ?? (import.meta.env.VITE_SUPABASE_ANON_KEY as string)
      const res = await fetch(
        `${base}/rest/v1/veedor_requerimientos?select=id,tipo,estado,destinatario_nombre,destinatario_email,respuesta_html,respuesta_from,fecha_envio,fecha_vencimiento,fecha_respuesta,created_at&order=created_at.desc&limit=100`,
        { headers: { apikey: anon, Authorization: `Bearer ${token}` } }
      )
      if (res.ok) setRequerimientos(await res.json())
    } catch { /**/ }
    finally { setCargandoBandeja(false) }
  }, [token])

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  const setF = (k: keyof api.FiltrosBusqueda, v: string) =>
    setFiltros(f => ({ ...f, [k]: k === 'valorMin' || k === 'valorMax' || k === 'limite' ? (v ? Number(v) : undefined) : (v || undefined) }))

  const [sinRuido, setSinRuido] = useState(true)
  const [soloEmpresas, setSoloEmpresas] = useState(false)
  const [sinServPers, setSinServPers] = useState(false)
  const buscar = useCallback(async () => {
    setBuscando(true); setError('')
    try {
      const f = { ...filtros, ambito, sinRuido: sinRuido || undefined, soloEmpresas: soloEmpresas || undefined, sinServiciosPersonales: sinServPers || undefined }
      const [c, r] = await Promise.all([api.buscarContratos(f), api.resumenBusqueda(f)])
      // Ordena siempre por score descendente, calculando fallback si el servidor no lo trae.
      const ordenados = (c ?? []).map(x => (x.score != null && x.nivel) ? x : { ...x, ...computarScore(x) })
        .sort((a, b) => b.score - a.score)
      setResultados(ordenados); setResumen(r)
    } catch (e) { setError(`Búsqueda: ${(e as Error).message}`) }
    finally { setBuscando(false) }
  }, [filtros, ambito, sinRuido, soloEmpresas, sinServPers])

  const cargarExpedientes = useCallback(async () => {
    setCargandoExp(true); setError('')
    try { setExpedientes(await api.listarExpedientes()) }
    catch (e) { setError(`Expedientes: ${(e as Error).message}`) }
    finally { setCargandoExp(false) }
  }, [])

  const abrirExpediente = useCallback(async (id: number) => {
    setPantalla('detalle'); setCargandoDetalle(true); setDetalle(null); setError('')
    try { setDetalle(await api.obtenerExpediente(id)) }
    catch (e) { setError(`Expediente: ${(e as Error).message}`) }
    finally { setCargandoDetalle(false) }
  }, [])

  const auditar = useCallback(async (idContrato: string) => {
    setAuditando(idContrato); setError('')
    try {
      const r = await api.auditarContrato(idContrato)
      await abrirExpediente(r.expedienteId)
    } catch (e) { setError(`Auditoría: ${(e as Error).message}`) }
    finally { setAuditando(null) }
  }, [abrirExpediente])


  const verContratista = useCallback(async (nit: string) => {
    setCargandoPerfil(true); setAnalisisPanel(null); setError('')
    try { setAnalisisPanel(await api.analisisCompleto(nit, { ambito })) }
    catch (e) { setError(`Contratista: ${(e as Error).message}`) }
    finally { setCargandoPerfil(false) }
  }, [ambito])

  const barrer = useCallback(async (semilla: api.Semilla) => {
    setPantalla('red'); setBarriendo(true); setRed(null); setError('')
    try { setRed(await api.barridoRed(semilla, { ambito })) }
    catch (e) { setError(`Barrido: ${(e as Error).message}`) }
    finally { setBarriendo(false) }
  }, [ambito])

  const cargarCandidatos = useCallback(async () => {
    setCargandoCand(true); setError('')
    try { setCandidatos(await api.repLegalCandidatos()) }
    catch (e) { setError(`Candidatos: ${(e as Error).message}`) }
    finally { setCargandoCand(false) }
  }, [])

  // Denuncia: dispara y hace polling hasta que aparezca la actuación.
  const generarDenuncia = useCallback((id: number) => {
    setGenerando(true); setError('')
    api.generarDenuncia(id).catch(e => { setError(`Denuncia: ${(e as Error).message}`); setGenerando(false) })
    let intentos = 0
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      intentos++
      try {
        const d = await api.obtenerExpediente(id)
        const tieneDenuncia = d.actuaciones?.some(a => a.tipo === 'denuncia')
        if (tieneDenuncia || intentos > 38) {   // ~5 min máx
          if (pollRef.current) clearInterval(pollRef.current)
          setDetalle(d); setGenerando(false)
          if (!tieneDenuncia) setError('La denuncia no se generó en el tiempo esperado. Reintentá.')
        }
      } catch { /* reintenta en el próximo tick */ }
    }, 8_000)
  }, [])

  const guardarDenunciaHandler = useCallback(async (html: string) => {
    if (!detalle) return
    await api.guardarDenuncia(detalle.expediente.id, html)
  }, [detalle])

  const [enviando, setEnviando] = useState(false)
  const [envioOk, setEnvioOk] = useState<api.EnvioResult | null>(null)

  // SMTP/IMAP config modal
  const [smtpModalOpen, setSmtpModalOpen] = useState(false)
  const [smtpConfig, setSmtpConfig] = useState<api.SmtpConfig | null>(null)
  const [smtpCargando, setSmtpCargando] = useState(false)
  const [guardandoSmtp, setGuardandoSmtp] = useState(false)
  const [smtpForm, setSmtpForm] = useState({
    smtp_host: '', smtp_port: 587, smtp_user: '', smtp_pass: '',
    smtp_secure: false, imap_host: '', imap_port: 993, imap_secure: true,
    from_name: '', from_email: '',
  })
  const [smtpMsgOk, setSmtpMsgOk] = useState('')
  const [smtpMsgErr, setSmtpMsgErr] = useState('')

  const abrirSmtpModal = useCallback(async () => {
    if (!orgId) return
    setSmtpModalOpen(true)
    setSmtpMsgOk(''); setSmtpMsgErr('')
    setSmtpCargando(true)
    try {
      const cfg = await api.obtenerSmtpConfig(orgId)
      setSmtpConfig(cfg)
      if (cfg) {
        setSmtpForm({
          smtp_host: cfg.smtp_host ?? '',
          smtp_port: cfg.smtp_port ?? 587,
          smtp_user: cfg.smtp_user ?? '',
          smtp_pass: '',  // nunca se pre-rellena la contraseña
          smtp_secure: cfg.smtp_secure ?? false,
          imap_host: cfg.imap_host ?? '',
          imap_port: cfg.imap_port ?? 993,
          imap_secure: cfg.imap_secure ?? true,
          from_name: cfg.from_name ?? '',
          from_email: cfg.from_email ?? '',
        })
      }
    } catch { /**/ }
    finally { setSmtpCargando(false) }
  }, [orgId])

  const guardarSmtpConfig = useCallback(async () => {
    if (!orgId) return
    if (!smtpForm.smtp_host || !smtpForm.smtp_user) {
      setSmtpMsgErr('Completa servidor y usuario.')
      return
    }
    if (!smtpConfig && !smtpForm.smtp_pass) {
      setSmtpMsgErr('La contraseña es requerida para la primera configuración.')
      return
    }
    setGuardandoSmtp(true); setSmtpMsgOk(''); setSmtpMsgErr('')
    try {
      const cfg = await api.guardarSmtpConfig({
        org_id: orgId,
        smtp_host: smtpForm.smtp_host,
        smtp_port: smtpForm.smtp_port,
        smtp_user: smtpForm.smtp_user,
        smtp_pass: smtpForm.smtp_pass,
        smtp_secure: smtpForm.smtp_secure,
        imap_host: smtpForm.imap_host || undefined,
        imap_port: smtpForm.imap_port,
        imap_secure: smtpForm.imap_secure,
        from_name: smtpForm.from_name || undefined,
        from_email: smtpForm.from_email || undefined,
      })
      setSmtpConfig(cfg)
      setSmtpForm(f => ({ ...f, smtp_pass: '' }))
      setSmtpMsgOk('Configuración guardada. Los correos se enviarán desde tu cuenta.')
    } catch (e) { setSmtpMsgErr(`Error: ${(e as Error).message}`) }
    finally { setGuardandoSmtp(false) }
  }, [orgId, smtpForm])

  const enviarDenunciaHandler = useCallback(async (opts: {
    destinatario_email: string; destinatario_nombre: string; contenido_html?: string; canal?: 'smtp' | 'resend'
  }) => {
    if (!detalle) return
    if (!orgId) {
      setError('Tu cuenta no tiene una organización de veeduría asociada. Pídele al administrador que te asigne una.')
      return
    }
    setEnviando(true); setError('')
    try {
      const res = await api.enviarDenuncia(detalle.expediente.id, { ...opts, org_id: orgId, canal: opts.canal })
      setEnvioOk(res)
      // Refrescar el expediente para ver el nuevo estado
      const d = await api.obtenerExpediente(detalle.expediente.id)
      setDetalle(d)
    } catch (e) { setError(`Envío: ${(e as Error).message}`) }
    finally { setEnviando(false) }
  }, [detalle, orgId])

  const activarRadar = useCallback(async (opts: api.RadarOpts) => {
    setRadarCargando(true); setRadarResultado(null); setError('')
    try { setRadarResultado(await api.radar(opts)) }
    catch (e) { setError(`Radar: ${(e as Error).message}`) }
    finally { setRadarCargando(false) }
  }, [])

  const lanzarRadarEntidad = useCallback((nit: string) => {
    const opts: api.RadarOpts = { nitEntidad: nit }
    setRadarFiltros(opts)
    setPantalla('radar')
    activarRadar(opts)
  }, [activarRadar])

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg) } }
        .spin { animation: spin 1s linear infinite }
        @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.4 } }
        .pulse-dot { animation: pulse 2s ease-in-out infinite }
        input[style*="border-bottom"]:focus { border-bottom-color: #96712A !important; }
        select.inp-select { padding:7px 0; font-size:13px; border:none; border-bottom:1px solid rgba(10,46,34,0.10); border-radius:0; background:transparent; color:#0A2E22; width:100%; outline:none; cursor:pointer; }
        tr.row-hallazgo { box-shadow: inset 2px 0 0 #B0392C; }
        tr.row-medio { box-shadow: inset 2px 0 0 #CA8A04; }
      `}</style>

      {/* ── Barra de contexto ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '10px 20px',
        background: PAPEL2,
        borderBottom: `1px solid ${INK12}`,
        flexWrap: 'wrap',
      }}>
        <ShieldCheck size={14} style={{ color: SELLO, flexShrink: 0 }} />
        <span style={{ fontSize: 11, fontWeight: 700, color: INK55, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          Ámbito:
        </span>
        <select value={ambitoIdx} onChange={e => setAmbitoIdx(Number(e.target.value))}
          style={{ padding: '3px 6px', fontSize: 12, border: `1px solid ${INK12}`, borderRadius: 4, background: BLANCO, color: INK, fontWeight: 600, cursor: 'pointer' }}>
          {api.AMBITOS_DEMO.map((a, i) => <option key={i} value={i}>{a.label}</option>)}
        </select>
        {ambito && (
          <span style={{ fontSize: 11, color: SELLO, letterSpacing: '0.03em' }}>recorte activo</span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 7 }}>
          <span className="pulse-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: OK, display: 'inline-block' }} />
          <span style={{ fontSize: 11, color: INK55, letterSpacing: '0.03em' }}>Motor de auditoría activo</span>
        </div>
      </div>

      {/* ── Tabs de navegación ── */}
      {pantalla !== 'detalle' && (
        <div style={{
          display: 'flex', gap: 0, alignItems: 'stretch',
          borderBottom: `1px solid ${INK12}`,
          background: BLANCO,
          padding: '0 20px',
          overflowX: 'auto',
        }}>
          {([
            { id: 'buscar', label: 'Buscar contratos', icon: <Search size={13} /> },
            { id: 'expedientes', label: 'Mis expedientes', icon: <ScrollText size={13} />, onClick: () => { setPantalla('expedientes'); cargarExpedientes() } },
            { id: 'bandeja', label: 'Bandeja', icon: <Inbox size={13} />, onClick: () => { setPantalla('bandeja'); cargarBandeja() } },
            { id: 'red', label: 'Red', icon: <GitBranch size={13} /> },
            { id: 'radar', label: 'Radar', icon: <Radar size={13} /> },
          ] as Array<{ id: string; label: string; icon: ReactNode; onClick?: () => void }>).map(tab => {
            const active = pantalla === tab.id
            return (
              <button
                key={tab.id}
                onClick={tab.onClick ?? (() => setPantalla(tab.id as typeof pantalla))}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '11px 16px',
                  border: 'none', background: 'none', cursor: 'pointer',
                  fontSize: 13, fontWeight: active ? 700 : 400,
                  color: active ? INK : INK55,
                  borderBottom: active ? `2px solid ${SELLO}` : '2px solid transparent',
                  marginBottom: -1,
                  whiteSpace: 'nowrap', transition: 'color 0.1s',
                  fontFamily: 'inherit',
                }}
              >
                <span style={{ color: active ? SELLO : INK55 }}>{tab.icon}</span>
                {tab.label}
              </button>
            )
          })}
          {/* Botón configuración SMTP — solo si hay org */}
          {orgId && (
            <button
              onClick={abrirSmtpModal}
              title="Configurar correo de salida (SMTP)"
              style={{
                marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5,
                padding: '8px 12px', border: 'none', background: 'none', cursor: 'pointer',
                color: smtpConfig ? OK : INK55, fontSize: 11, fontWeight: 600,
                borderBottom: '2px solid transparent',
                whiteSpace: 'nowrap', fontFamily: 'inherit',
              }}
            >
              <Settings size={13} />
              {smtpConfig ? 'SMTP activo' : 'Configurar correo'}
            </button>
          )}
        </div>
      )}

      {/* Contenido de la pantalla activa */}
      <div style={{ flex: 1, padding: '20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {error && (
          <div style={{
            background: `${HALLAZGO}10`, border: `1px solid ${HALLAZGO}40`,
            borderLeft: `3px solid ${HALLAZGO}`,
            borderRadius: 4, padding: '10px 14px',
            color: HALLAZGO, display: 'flex', alignItems: 'center', gap: 8, fontSize: 13
          }}>
            <AlertTriangle size={15} /> {error}
            <span style={{ marginLeft: 'auto', cursor: 'pointer' }} onClick={() => setError('')}><X size={13} /></span>
          </div>
        )}

        {pantalla === 'buscar' && <PantallaBuscar {...{ filtros, setF, buscar, buscando, resultados, resumen, auditar, auditando, verContratista, lanzarRadarEntidad, sinRuido, setSinRuido, soloEmpresas, setSoloEmpresas, sinServPers, setSinServPers }} />}
        {pantalla === 'expedientes' && <PantallaExpedientes {...{ expedientes, cargandoExp, cargarExpedientes, abrirExpediente }} />}
        {pantalla === 'bandeja' && <PantallaBandeja requerimientos={requerimientos} cargando={cargandoBandeja} onRecargar={cargarBandeja} />}
        {pantalla === 'red' && <PantallaRed {...{ red, barriendo, barrer, candidatos, cargandoCand, cargarCandidatos, ambito }} />}
        {pantalla === 'radar' && <PantallaRadar resultado={radarResultado} cargando={radarCargando} filtros={radarFiltros} setFiltros={setRadarFiltros} onActivar={activarRadar} onAuditar={auditar} onVerContratista={verContratista} />}
        {pantalla === 'detalle' && (
          <PantallaDetalle
            detalle={detalle} cargando={cargandoDetalle} generando={generando}
            enviando={enviando} envioOk={envioOk} orgId={orgId}
            onVolver={() => { setPantalla('expedientes'); cargarExpedientes() }}
            onGenerar={generarDenuncia} onRecargar={abrirExpediente}
            onVerContratista={verContratista}
            onGuardarDenuncia={guardarDenunciaHandler}
            onEnviarDenuncia={enviarDenunciaHandler}
          />
        )}
      </div>

      {/* Overlay auditando */}
      {auditando && <Overlay texto={`Auditando ${auditando}`} sub="Descargando informes · extrayendo con IA · aplicando reglas. Hasta ~2 min." />}

      {/* Panel contratista */}
      {(analisisPanel || cargandoPerfil) && <PanelContratista analisis={analisisPanel} cargando={cargandoPerfil}
        onClose={() => { setAnalisisPanel(null); setCargandoPerfil(false) }}
        onBarrer={(nit) => { setAnalisisPanel(null); setCargandoPerfil(false); barrer({ nit }) }} />}

      {/* ── Modal configuración SMTP/IMAP ── */}
      {smtpModalOpen && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(10,46,34,0.45)', backdropFilter: 'blur(3px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 20,
        }} onClick={(e) => { if (e.target === e.currentTarget) setSmtpModalOpen(false) }}>
          <div style={{
            background: BLANCO, borderRadius: 8, padding: 28, width: '100%', maxWidth: 520,
            border: `1px solid ${INK12}`, boxShadow: '0 12px 40px rgba(0,0,0,0.18)',
            maxHeight: '90vh', overflowY: 'auto',
          }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
              <Mail size={18} style={{ color: SELLO }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 15, color: INK }}>Correo de salida (SMTP)</div>
                <div style={{ fontSize: 11, color: INK55, marginTop: 1 }}>
                  Los derechos de petición se envían desde tu propia cuenta de correo
                </div>
              </div>
              <button onClick={() => setSmtpModalOpen(false)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: INK55, padding: 4 }}>
                <X size={16} />
              </button>
            </div>

            {smtpCargando ? (
              <div style={{ textAlign: 'center', padding: 24, color: INK55, fontSize: 13 }}>
                <Loader size={18} className="spin" style={{ display: 'inline-block', marginBottom: 8 }} /><br />
                Cargando configuración…
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {/* Estado actual */}
                {smtpConfig && (
                  <div style={{ background: `${OK}12`, border: `1px solid ${OK}30`, borderRadius: 6, padding: '10px 14px', fontSize: 12, color: OK }}>
                    <CheckCircle size={13} style={{ display: 'inline', marginRight: 6 }} />
                    Configurado: <strong>{smtpConfig.smtp_user}</strong> vía {smtpConfig.smtp_host}
                    {smtpConfig.last_imap_poll && (
                      <span style={{ marginLeft: 8, color: INK55 }}>· IMAP chequeado {fmtFecha(smtpConfig.last_imap_poll)}</span>
                    )}
                  </div>
                )}

                {/* Aviso Gmail */}
                <div style={{ background: `${SELLO}10`, border: `1px solid ${SELLO}30`, borderRadius: 6, padding: '10px 14px', fontSize: 12, color: INK }}>
                  <strong style={{ color: SELLO }}>Gmail:</strong> Usa una <em>Contraseña de aplicación</em> (no tu contraseña normal).{' '}
                  Actívala en Google → Seguridad → Verificación en 2 pasos → Contraseñas de app.{' '}
                  Servidor: <code>smtp.gmail.com</code>, Puerto: <code>587</code>.
                </div>

                {/* Campos SMTP */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '12px 8px', alignItems: 'end' }}>
                  <div>
                    <label style={lbl}>Servidor SMTP</label>
                    <input style={inp} placeholder="smtp.gmail.com" value={smtpForm.smtp_host}
                      onChange={e => setSmtpForm(f => ({ ...f, smtp_host: e.target.value }))} />
                  </div>
                  <div style={{ width: 80 }}>
                    <label style={lbl}>Puerto</label>
                    <input style={inp} type="number" value={smtpForm.smtp_port}
                      onChange={e => setSmtpForm(f => ({ ...f, smtp_port: Number(e.target.value) }))} />
                  </div>
                </div>
                <div>
                  <label style={lbl}>Usuario (email)</label>
                  <input style={inp} type="email" placeholder="veedor@organismo.gov.co" value={smtpForm.smtp_user}
                    onChange={e => setSmtpForm(f => ({ ...f, smtp_user: e.target.value }))} />
                </div>
                <div>
                  <label style={lbl}>Contraseña{smtpConfig ? ' (dejar en blanco para conservar la actual)' : ''}</label>
                  <input style={inp} type="password" placeholder={smtpConfig ? '••••••••' : 'Contraseña de aplicación'}
                    value={smtpForm.smtp_pass}
                    onChange={e => setSmtpForm(f => ({ ...f, smtp_pass: e.target.value }))} />
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: INK, cursor: 'pointer' }}>
                  <input type="checkbox" checked={smtpForm.smtp_secure}
                    onChange={e => setSmtpForm(f => ({ ...f, smtp_secure: e.target.checked }))} />
                  Usar SSL/TLS (puerto 465) — para Outlook/Hotmail
                </label>

                <div style={{ marginTop: 4, borderTop: `1px solid ${INK12}`, paddingTop: 16 }}>
                  <div style={{ fontWeight: 600, fontSize: 12, color: INK55, marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    IMAP — recibir respuestas automáticamente (opcional)
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '12px 8px', alignItems: 'end' }}>
                    <div>
                      <label style={lbl}>Servidor IMAP</label>
                      <input style={inp} placeholder="imap.gmail.com" value={smtpForm.imap_host}
                        onChange={e => setSmtpForm(f => ({ ...f, imap_host: e.target.value }))} />
                    </div>
                    <div style={{ width: 80 }}>
                      <label style={lbl}>Puerto</label>
                      <input style={inp} type="number" value={smtpForm.imap_port}
                        onChange={e => setSmtpForm(f => ({ ...f, imap_port: Number(e.target.value) }))} />
                    </div>
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: INK, cursor: 'pointer', marginTop: 10 }}>
                    <input type="checkbox" checked={smtpForm.imap_secure}
                      onChange={e => setSmtpForm(f => ({ ...f, imap_secure: e.target.checked }))} />
                    IMAP seguro (TLS, recomendado)
                  </label>
                </div>

                <div style={{ borderTop: `1px solid ${INK12}`, paddingTop: 16 }}>
                  <div style={{ fontWeight: 600, fontSize: 12, color: INK55, marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Nombre del remitente (opcional)
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 8px' }}>
                    <div>
                      <label style={lbl}>Nombre</label>
                      <input style={inp} placeholder="Veeduría Ciudadana" value={smtpForm.from_name}
                        onChange={e => setSmtpForm(f => ({ ...f, from_name: e.target.value }))} />
                    </div>
                    <div>
                      <label style={lbl}>Email remitente</label>
                      <input style={inp} type="email" placeholder="(mismo que usuario)" value={smtpForm.from_email}
                        onChange={e => setSmtpForm(f => ({ ...f, from_email: e.target.value }))} />
                    </div>
                  </div>
                </div>

                {/* Mensajes */}
                {smtpMsgOk && (
                  <div style={{ background: `${OK}12`, border: `1px solid ${OK}30`, borderRadius: 5, padding: '9px 14px', fontSize: 12, color: OK }}>
                    <CheckCircle size={12} style={{ display: 'inline', marginRight: 6 }} />{smtpMsgOk}
                  </div>
                )}
                {smtpMsgErr && (
                  <div style={{ background: `${HALLAZGO}10`, border: `1px solid ${HALLAZGO}40`, borderRadius: 5, padding: '9px 14px', fontSize: 12, color: HALLAZGO }}>
                    <AlertTriangle size={12} style={{ display: 'inline', marginRight: 6 }} />{smtpMsgErr}
                  </div>
                )}

                {/* Acciones */}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
                  <Btn tone="ghost" onClick={() => setSmtpModalOpen(false)}>Cerrar</Btn>
                  <Btn tone="gold" onClick={guardarSmtpConfig} disabled={guardandoSmtp}>
                    {guardandoSmtp ? <><Loader size={13} className="spin" /> Guardando…</> : <><CheckCircle size={13} /> Guardar configuración</>}
                  </Btn>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Pantalla: Bandeja ─────────────────────────────────────────────────────────
interface RequerimientoRow {
  id: string; tipo: string; estado: string; destinatario_nombre: string | null
  destinatario_email: string | null; respuesta_html: string | null; respuesta_from: string | null
  fecha_envio: string | null; fecha_vencimiento: string | null; fecha_respuesta: string | null
  created_at: string
}
function PantallaBandeja({ requerimientos, cargando, onRecargar }: {
  requerimientos: RequerimientoRow[]; cargando: boolean; onRecargar: () => void
}) {
  const fmtF = (s: string | null) => (s ? String(s).slice(0, 10) : '—')
  const estadoColor: Record<string, string> = {
    enviado: AMBER, respondido: GREEN, vencido_sin_respuesta: RED,
    borrador: INK55, archivado: INK55,
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 13, color: INK55 }}>
          {cargando ? 'Cargando…' : `${requerimientos.length} requerimiento${requerimientos.length !== 1 ? 's' : ''}`}
        </div>
        <button onClick={onRecargar} disabled={cargando}
          style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', fontSize: 12, fontWeight: 600, background: 'none', border: `1px solid rgba(11,31,26,0.12)`, borderRadius: 8, cursor: 'pointer', color: '#0B1F1A' }}>
          <RefreshCw size={12} className={cargando ? 'spin' : ''} /> Actualizar
        </button>
      </div>

      {requerimientos.length === 0 && !cargando && (
        <div style={{ background: '#fff', border: '1px solid rgba(11,31,26,0.12)', borderRadius: 12, padding: '40px 24px', textAlign: 'center' }}>
          <Inbox size={32} color="rgba(11,31,26,0.20)" style={{ marginBottom: 12 }} />
          <div style={{ fontSize: 14, fontWeight: 600, color: '#0B1F1A', marginBottom: 6 }}>Sin requerimientos</div>
          <div style={{ fontSize: 13, color: 'rgba(11,31,26,0.55)' }}>Los derechos de petición y tutelas enviadas aparecerán aquí.</div>
        </div>
      )}

      {requerimientos.map(r => (
        <div key={r.id} style={{ background: WHITE, border: `1px solid rgba(11,31,26,0.12)`, borderRadius: 12, padding: '14px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <Mail size={14} color={DKGRN} />
                <span style={{ fontSize: 13, fontWeight: 700, color: '#0B1F1A' }}>{r.destinatario_nombre ?? '—'}</span>
                <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em',
                  background: `${estadoColor[r.estado] ?? INK55}18`, color: estadoColor[r.estado] ?? INK55,
                  borderRadius: 100, padding: '2px 8px' }}>{r.estado}</span>
                <span style={{ fontSize: 11, color: 'rgba(11,31,26,0.40)', textTransform: 'capitalize' }}>{r.tipo.replace(/_/g, ' ')}</span>
              </div>
              <div style={{ fontSize: 12, color: 'rgba(11,31,26,0.55)', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {r.fecha_envio && <span>Enviado: {fmtF(r.fecha_envio)}</span>}
                {r.fecha_vencimiento && <span>Vence: {fmtF(r.fecha_vencimiento)}</span>}
                {r.fecha_respuesta && <span style={{ color: GREEN }}>Respondido: {fmtF(r.fecha_respuesta)}</span>}
                {r.destinatario_email && <span>{r.destinatario_email}</span>}
              </div>
            </div>
            {r.respuesta_from && (
              <span style={{ fontSize: 11, background: `${GREEN}15`, color: GREEN, borderRadius: 100, padding: '3px 10px', fontWeight: 600, whiteSpace: 'nowrap' }}>
                <CheckCircle size={10} style={{ marginRight: 4, verticalAlign: 'middle' }} />Respuesta recibida
              </span>
            )}
          </div>

          {r.respuesta_html && (
            <details style={{ marginTop: 10 }}>
              <summary style={{ fontSize: 12, color: DKGRN, fontWeight: 600, cursor: 'pointer', userSelect: 'none' }}>
                Ver respuesta de {r.respuesta_from ?? 'la entidad'}
              </summary>
              <div style={{ marginTop: 8, padding: 12, background: 'rgba(11,31,26,0.03)', borderRadius: 8, fontSize: 13, lineHeight: 1.6, maxHeight: 300, overflow: 'auto' }}
                dangerouslySetInnerHTML={{ __html: r.respuesta_html }} />
            </details>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Pantalla: Buscar ───────────────────────────────────────────────────────────
function PantallaBuscar({ filtros, setF, buscar, buscando, resultados, resumen, auditar, auditando, verContratista, lanzarRadarEntidad, sinRuido, setSinRuido, soloEmpresas, setSoloEmpresas, sinServPers, setSinServPers }: {
  filtros: api.FiltrosBusqueda
  setF: (k: keyof api.FiltrosBusqueda, v: string) => void
  buscar: () => void; buscando: boolean
  resultados: api.ContratoBusqueda[]
  resumen: { contratos: number; valor_total: number } | null
  auditar: (id: string) => void; auditando: string | null
  verContratista: (nit: string) => void
  lanzarRadarEntidad: (nit: string) => void
  sinRuido: boolean; setSinRuido: (b: boolean) => void
  soloEmpresas: boolean; setSoloEmpresas: (b: boolean) => void
  sinServPers: boolean; setSinServPers: (b: boolean) => void
}) {
  const [showAsync, setShowAsync]     = useState(false)
  const [emailAsync, setEmailAsync]   = useState('')
  const [enviandoAsync, setEnviando]  = useState(false)
  const [asyncOk, setAsyncOk]         = useState('')
  const [jobs, setJobs]               = useState<api.JobAsync[]>([])

  // Carga escaneos recientes al montar
  useEffect(() => {
    api.listarJobsAsync().then(r => setJobs(r.jobs ?? [])).catch(() => {})
  }, [])

  const lanzarAsync = async () => {
    if (!emailAsync.trim()) return
    setEnviando(true); setAsyncOk('')
    try {
      const f = { ...filtros, sinRuido: sinRuido || undefined, soloEmpresas: soloEmpresas || undefined, sinServiciosPersonales: sinServPers || undefined }
      const r = await api.buscarAsync(f, emailAsync.trim())
      setAsyncOk(`Búsqueda en curso (job ${r.job_id?.slice(0, 8)}…). Te avisamos a ${emailAsync.trim()} cuando termine.`)
      setEmailAsync('')
      // Refrescar lista
      setTimeout(() => api.listarJobsAsync().then(r2 => setJobs(r2.jobs ?? [])).catch(() => {}), 800)
    } catch (e) { setAsyncOk(`Error: ${e.message}`) }
    finally { setEnviando(false) }
  }

  const aplicarFiltrosJob = (job: api.JobAsync) => {
    const f = job.filtros ?? {}
    Object.entries(f).forEach(([k, v]) => setF(k as keyof api.FiltrosBusqueda, v))
    setShowAsync(false)
    setTimeout(() => buscar(), 100)
  }

  const campo = (k: keyof api.FiltrosBusqueda, label: string, type = 'text', ph = '') => (
    <div>
      <label style={lbl}>{label}</label>
      <input style={inp} type={type} placeholder={ph} value={(filtros[k] as string | number | undefined) ?? ''} onChange={e => setF(k, e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') buscar() }} />
    </div>
  )
  // Campo de dinero: muestra los puntos de miles mientras se escribe (299.999.999),
  // pero guarda el número crudo. type="text" porque number no admite separadores.
  const campoMoneda = (k: 'valorMin' | 'valorMax', label: string) => (
    <div>
      <label style={lbl}>{label}</label>
      <input style={inp} type="text" inputMode="numeric" placeholder="$"
        value={filtros[k] != null ? Number(filtros[k]).toLocaleString('es-CO') : ''}
        onChange={e => setF(k, e.target.value.replace(/\D/g, ''))}
        onKeyDown={e => { if (e.key === 'Enter') buscar() }} />
    </div>
  )
  const selectCampo = (k: keyof api.FiltrosBusqueda, label: string, opciones: string[]) => (
    <div>
      <label style={lbl}>{label}</label>
      <select className="inp-select" value={(filtros[k] as string | undefined) ?? ''} onChange={e => setF(k, e.target.value)}>
        <option value="">Todos</option>
        {opciones.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  )
  return (
    <>
      <div style={{ ...card, background: BLANCO }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '14px 20px' }}>
          {campo('entidad', 'Entidad')}
          {campo('contratista', 'Contratista')}
          {campo('nitContratista', 'NIT / cédula')}
          {campo('objeto', 'Objeto contiene')}
          {campoMoneda('valorMin', 'Valor mínimo')}
          {campoMoneda('valorMax', 'Valor máximo')}
          {campo('desde', 'Firmado desde', 'date')}
          {campo('hasta', 'Firmado hasta', 'date')}
          {selectCampo('estado', 'Estado', api.ESTADOS_CONTRATO)}
          {selectCampo('tipo', 'Tipo', api.TIPOS_CONTRATO)}
          {campo('limite', 'Límite', 'number')}
        </div>
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${INK12}`, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <Btn onClick={buscar} disabled={buscando}>{buscando ? <Loader size={14} className="spin" /> : <Search size={14} />} Buscar</Btn>
          <Btn tone='ghost' onClick={() => { setShowAsync(v => !v); setAsyncOk('') }} title="Escanea TODO SECOP con estos filtros en background y te avisa por correo">
            <Mail size={14} /> Escanear todo SECOP
          </Btn>
          <div style={{ width: 1, height: 18, background: INK12 }} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: INK55, cursor: 'pointer' }}>
            <input type="checkbox" checked={sinRuido} onChange={e => setSinRuido(e.target.checked)} style={{ accentColor: OK, cursor: 'pointer' }} />
            Sin ruido
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: INK55, cursor: 'pointer' }}>
            <input type="checkbox" checked={sinServPers} onChange={e => setSinServPers(e.target.checked)} style={{ accentColor: OK, cursor: 'pointer' }} />
            Sin servicios personales
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: INK55, cursor: 'pointer' }}>
            <input type="checkbox" checked={soloEmpresas} onChange={e => setSoloEmpresas(e.target.checked)} style={{ accentColor: OK, cursor: 'pointer' }} />
            Solo empresas
          </label>
        </div>

        {/* Panel escaneo async */}
        {showAsync && (
          <div style={{ marginTop: 12, padding: '14px 16px', background: '#F0F5F2', borderRadius: 8, border: `1px solid ${INK12}` }}>
            <p style={{ margin: '0 0 10px', fontSize: 13, color: '#0F3D2E', fontWeight: 600 }}>
              Escanear todo el universo SECOP con estos filtros
            </p>
            <p style={{ margin: '0 0 10px', fontSize: 12, color: INK55 }}>
              El servidor pagina Socrata completo (hasta 10.000 contratos). Cuando termine te llegará un correo para que entres a revisar.
            </p>
            {asyncOk
              ? <p style={{ margin: 0, fontSize: 13, color: OK, fontWeight: 500 }}>{asyncOk}</p>
              : (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    style={{ ...inp, minWidth: 220, flex: 1 }}
                    type="email"
                    placeholder="tu@correo.com"
                    value={emailAsync}
                    onChange={e => setEmailAsync(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') lanzarAsync() }}
                  />
                  <Btn onClick={lanzarAsync} disabled={enviandoAsync || !emailAsync.trim()}>
                    {enviandoAsync ? <Loader size={13} className="spin" /> : <Send size={13} />} Iniciar escaneo
                  </Btn>
                </div>
              )
            }

            {/* Escaneos recientes */}
            {jobs.length > 0 && (
              <div style={{ marginTop: 16, borderTop: `1px solid ${INK12}`, paddingTop: 14 }}>
                <p style={{ margin: '0 0 10px', fontSize: 12, color: INK55, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
                  Escaneos anteriores
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {jobs.map(job => {
                    const fecha = new Date(job.created_at).toLocaleDateString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
                    const filtrosDesc = Object.entries(job.filtros ?? {})
                      .filter(([, v]) => v)
                      .map(([k, v]) => `${k}: "${v}"`)
                      .join(' · ') || 'todos los contratos'
                    const esCompletada = job.estado === 'completada'
                    const esError      = job.estado === 'error'
                    const esCorriendo  = job.estado === 'corriendo'
                    return (
                      <div key={job.id} style={{
                        display: 'flex', alignItems: 'center', gap: 12,
                        padding: '10px 12px', borderRadius: 6,
                        background: esCompletada ? '#fff' : esError ? '#FFF5F5' : '#FFFBF0',
                        border: `1px solid ${esCompletada ? INK12 : esError ? '#FFC9C9' : '#FFE8A3'}`,
                        fontSize: 12,
                      }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                            <span style={{
                              fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
                              background: esCompletada ? '#D1FAE5' : esError ? '#FEE2E2' : '#FEF3C7',
                              color: esCompletada ? '#065F46' : esError ? '#991B1B' : '#92400E',
                            }}>
                              {esCompletada ? '✓ Listo' : esError ? '✗ Error' : '⏳ Corriendo'}
                            </span>
                            <span style={{ color: INK55 }}>{fecha}</span>
                            {esCompletada && job.total_contratos != null && (
                              <span style={{ fontWeight: 700, color: '#0F3D2E' }}>
                                {job.total_contratos.toLocaleString('es-CO')} contratos
                              </span>
                            )}
                            {esCompletada && job.top_score != null && (
                              <span style={{ color: DORADO, fontWeight: 700 }}>· score {job.top_score}</span>
                            )}
                          </div>
                          <div style={{ color: INK55, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {filtrosDesc}
                          </div>
                        </div>
                        {esCompletada && (
                          <button
                            onClick={() => aplicarFiltrosJob(job)}
                            style={{ flexShrink: 0, background: '#0F3D2E', color: '#fff', border: 'none', borderRadius: 5, padding: '5px 12px', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
                          >
                            Ver resultados →
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Barra de resultados */}
      {resumen && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 16,
          padding: '8px 12px',
          background: PAPEL2,
          border: `1px solid ${INK12}`,
          borderRadius: 5,
          fontSize: 12, color: INK55,
        }}>
          <span><b style={{ color: INK, fontWeight: 700 }}>{resumen.contratos.toLocaleString('es-CO')}</b> contratos</span>
          <span>·</span>
          <span><b style={{ color: INK, fontWeight: 700 }}>{fmtCOP(resumen.valor_total)}</b> en total</span>
          {resultados.filter(r => r.nivel === 'alto').length > 0 && (
            <>
              <span>·</span>
              <span style={{ color: HALLAZGO, fontWeight: 600 }}>
                {resultados.filter(r => r.nivel === 'alto').length} con riesgo alto
              </span>
            </>
          )}
        </div>
      )}

      {resultados.length > 0 && (
        <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 960 }}>
              <thead>
                <tr style={{ background: PAPEL2 }}>
                  <th style={th}>Riesgo</th><th style={th}>Entidad</th><th style={th}>Contratista</th><th style={th}>Objeto</th>
                  <th style={th}>Valor</th><th style={th}>Firma</th><th style={th}>Estado</th><th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {resultados.map(c => (
                  <tr
                    key={c.id_contrato}
                    className={c.nivel === 'alto' ? 'row-hallazgo' : c.nivel === 'medio' ? 'row-medio' : ''}
                  >
                    <td style={td}><BadgeSospecha score={c.score} nivel={c.nivel} razones={c.razones} /></td>
                    <td style={td}>{c.entidad ?? '—'}<div style={{ fontSize: 10, color: INK55, fontFamily: '"IBM Plex Mono", monospace', marginTop: 2 }}>{c.id_contrato}</div></td>
                    <td style={td}>{c.contratista ?? '—'}{c.nit_contratista && <div style={{ fontSize: 11, fontWeight: c.tipo_doc !== 'NIT' && c.valor > 200_000_000 ? 700 : 400, color: c.tipo_doc === 'NIT' ? INK55 : (c.valor > 200_000_000 ? RED : AMBER) }}>{c.tipo_doc === 'NIT' ? 'NIT ' : (c.valor > 200_000_000 ? '⚠ persona natural (contrato alto) · ' : 'persona natural · ')}{c.nit_contratista}</div>}</td>
                    <td style={{ ...td, maxWidth: 260 }}>{c.objeto ?? '—'}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap', fontFamily: '"IBM Plex Mono", monospace', fontSize: 12 }}>{fmtCOP(c.valor)}</td>
                    <td style={{ ...td, fontSize: 12, fontFamily: '"IBM Plex Mono", monospace' }}>{fmtFecha(c.fecha_firma)}</td>
                    <td style={td}>{c.estado ?? '—'}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <Btn small onClick={() => auditar(c._auditar)} disabled={!!auditando}><Gavel size={12} /> Auditar</Btn>
                        {c._grafo && <Btn small tone="ghost" onClick={() => verContratista(c._grafo!)}><GitBranch size={12} /></Btn>}
                        {c.nit_contratista && c.tipo_doc === 'NIT' && (
                          <Btn small tone="ghost" onClick={() => lanzarRadarEntidad(c.nit_contratista!)} title="Lanzar radar sobre este contratista"><Radar size={12} /></Btn>
                        )}
                          </div>
                        </td>
                      </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  )
}

// ── Pantalla: Expedientes ────────────────────────────────────────────────────
function PantallaExpedientes({ expedientes, cargandoExp, cargarExpedientes, abrirExpediente }: {
  expedientes: api.ExpedienteResumen[]; cargandoExp: boolean; cargarExpedientes: () => void; abrirExpediente: (id: number) => void
}) {
  return (
    <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '10px 16px', borderBottom: `1px solid ${INK12}`, background: PAPEL2 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: INK55, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Expedientes auditados</span>
        <span style={{ marginLeft: 'auto' }}><Btn small tone="ghost" onClick={cargarExpedientes} disabled={cargandoExp}><RefreshCw size={11} className={cargandoExp ? 'spin' : ''} /> Refrescar</Btn></span>
      </div>
      {expedientes.length === 0
        ? <div style={{ padding: 24, textAlign: 'center', color: INK55, fontSize: 13 }}>{cargandoExp ? 'Cargando…' : 'Sin expedientes todavía. Audita un contrato desde “Buscar”.'}</div>
        : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
              <thead><tr>
                <th style={th}>Contrato</th><th style={th}>Entidad</th><th style={th}>Contratista</th>
                <th style={th}>Valor</th><th style={th}>Estado</th><th style={th}>Actualizado</th>
              </tr></thead>
              <tbody>
                {expedientes.map(e => (
                  <tr key={e.id} style={{ cursor: 'pointer' }} onClick={() => abrirExpediente(e.id)}>
                    <td style={td}>{e.referencia_contrato ?? e.id_contrato}<div style={{ fontSize: 11, color: INK55 }}>{e.id_contrato}</div></td>
                    <td style={td}>{e.entidad ?? '—'}</td>
                    <td style={td}>{e.contratista ?? '—'}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtCOP(e.valor_contrato)}</td>
                    <td style={td}><Badge estado={e.estado} /></td>
                    <td style={td}>{fmtFecha(e.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  )
}

// Veredicto determinista: lo que auditar SIEMPRE puede mostrar, haya informe o no.
// Score de metadatos + datos del proceso precontractual, con señales explicables.
function PanelAnalisis({ analisis }: { analisis?: api.AnalisisDeterminista | null }) {
  if (!analisis) return null
  const c = NIVEL_COLOR[analisis.nivel] ?? INK55
  const p = analisis.proceso
  const sub: CSSProperties = { fontSize: 11, fontWeight: 700, color: INK55, textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 6 }
  const senal = (t: string, i: number) => (
    <div key={i} style={{ display: 'flex', gap: 7, alignItems: 'flex-start', fontSize: 13, color: INK, marginBottom: 5 }}>
      <span style={{ color: c, fontWeight: 800, lineHeight: 1.3 }}>›</span><span>{t}</span>
    </div>
  )
  const dato = (k: string, v: string) => (
    <div><div style={{ fontSize: 10.5, color: INK55, textTransform: 'uppercase', letterSpacing: 0.3 }}>{k}</div><div style={{ fontSize: 13, fontWeight: 700, color: INK }}>{v}</div></div>
  )
  const senContrato = analisis.senales.filter(s => s.nivel === 'contrato')
  const senProceso = analisis.senales.filter(s => s.nivel === 'proceso')
  const valorContrato = Number((analisis.contrato as Record<string, unknown>).valor) || 0
  return (
    <div style={{ ...card, borderLeft: `4px solid ${c}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Radar size={16} color={c} />
        <div style={{ fontSize: 14, fontWeight: 800, color: INK }}>Veredicto determinista</div>
        <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 800, color: WHITE, background: c, padding: '3px 12px', borderRadius: 999 }}>
          {analisis.score} · {analisis.nivel.toUpperCase()}
        </span>
      </div>
      <div style={{ fontSize: 12, color: INK55, marginBottom: 12 }}>
        Lo que dicen los datos abiertos de este contrato y su proceso — sin gastar un token. Si hay informe de supervisión, se profundiza abajo.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 14 }}>
        <div>
          <div style={sub}>Del contrato</div>
          {senContrato.length ? senContrato.map((s, i) => senal(s.texto, i)) : <div style={{ fontSize: 12, color: INK55 }}>Sin señales de metadatos.</div>}
        </div>
        <div>
          <div style={sub}>Del proceso</div>
          {senProceso.length ? senProceso.map((s, i) => senal(s.texto, i)) : <div style={{ fontSize: 12, color: INK55 }}>{p ? 'Sin señales del proceso.' : 'Proceso no hallado en datos abiertos.'}</div>}
        </div>
      </div>
      {p && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${INK12}`, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 12, alignItems: 'end' }}>
          {dato('Modalidad', p.modalidad ?? '—')}
          {dato('Proponentes', p.ofertas != null ? String(p.ofertas) : (p.manifestaron != null ? String(p.manifestaron) : '—'))}
          {dato('Presupuesto', p.precio_base != null ? fmtCOP(p.precio_base) : '—')}
          {dato('Adjudicado', p.adjudicado ? fmtCOP(p.adjudicado) : fmtCOP(valorContrato))}
          {p.url && <a href={p.url} target="_blank" rel="noopener noreferrer" style={{ color: GREEN, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}><ExternalLink size={12} /> Ver en SECOP</a>}
        </div>
      )}
    </div>
  )
}

// ── Pantalla: Detalle del expediente ─────────────────────────────────────────
function PantallaDetalle({ detalle, cargando, generando, enviando, envioOk, orgId, onVolver, onGenerar, onRecargar, onVerContratista, onGuardarDenuncia, onEnviarDenuncia }: {
  detalle: api.ExpedienteDetalle | null; cargando: boolean; generando: boolean
  enviando: boolean; envioOk: api.EnvioResult | null; orgId: string
  onVolver: () => void; onGenerar: (id: number) => void; onRecargar: (id: number) => void
  onVerContratista: (nit: string) => void
  onGuardarDenuncia: (html: string) => Promise<void>
  onEnviarDenuncia: (opts: { destinatario_email: string; destinatario_nombre: string; contenido_html?: string }) => Promise<void>
}) {
  const [modalEnvio, setModalEnvio] = useState(false)
  const [destEmail, setDestEmail] = useState('')
  const [destNombre, setDestNombre] = useState('')
  const [canalEnvio, setCanalEnvio] = useState<'smtp' | 'resend'>('resend')

  // F4 — requerimientos (respuestas recibidas)
  const [reqs, setReqs] = useState<api.Requerimiento[]>([])
  const [respExpandida, setRespExpandida] = useState(false)

  // Notas del equipo
  const [notas, setNotas] = useState<api.Nota[]>([])
  const [notaTexto, setNotaTexto] = useState('')
  const [guardandoNota, setGuardandoNota] = useState(false)
  const [notasOpen, setNotasOpen] = useState(false)

  // Fallo — F7
  const [falloTexto, setFalloTexto] = useState('')
  const [analizandoRespuesta, setAnalizandoRespuesta] = useState(false)
  const [analizandoFallo, setAnalizandoFallo] = useState(false)
  const [falloSeccionAbierta, setFalloSeccionAbierta] = useState(false)
  const [impugnacionAbierta, setImpugnacionAbierta] = useState(false)
  const [cerrando, setCerrando] = useState(false)

  // Tutela — F5
  const [modalTutela, setModalTutela] = useState(false)
  const [generandoTutela, setGenerandoTutela] = useState(false)
  const [radicadoNum, setRadicadoNum] = useState('')
  const [radicadoJuzgado, setRadicadoJuzgado] = useState('')
  const [radicadoCiudad, setRadicadoCiudad] = useState('')
  const [guardandoRadicado, setGuardandoRadicado] = useState(false)

  useEffect(() => {
    if (!detalle) return
    const id = detalle.expediente.id
    api.obtenerRequerimientos(id).then(setReqs).catch(() => {})
    api.obtenerNotas(id).then(setNotas).catch(() => {})
  }, [detalle?.expediente?.id])

  if (cargando || !detalle) return <div style={{ ...card, textAlign: 'center', color: INK55 }}><Loader size={18} className="spin" /> Cargando expediente…</div>
  const exp = detalle.expediente as Record<string, unknown>
  const nit = exp.nit_contratista as string | undefined
  const denuncia = detalle.actuaciones?.find(a => a.tipo === 'denuncia')
  const citas = denuncia?.evaluacion?.citas

  // Badge de días hábiles restantes (F3)
  const fechaVencStr = envioOk?.fecha_vencimiento ?? (exp.fecha_vencimiento as string | undefined)
  let diasRestantesEl: ReactNode = null
  if (fechaVencStr) {
    const hoy = new Date(); hoy.setHours(0,0,0,0)
    const venc = new Date(fechaVencStr + 'T00:00:00')
    const diff = Math.round((venc.getTime() - hoy.getTime()) / 86_400_000)
    diasRestantesEl = diff >= 0
      ? <span style={{ display:'inline-flex', alignItems:'center', gap:5, padding:'4px 10px', background:'#ECFDF5', border:'1px solid #6EE7B7', borderRadius:999, fontSize:12, color:'#065F46', fontWeight:700 }}><Calendar size={12} /> {diff} día{diff!==1?'s':''} hábiles restantes</span>
      : <span style={{ display:'inline-flex', alignItems:'center', gap:5, padding:'4px 10px', background:'#FEF2F2', border:'1px solid #FCA5A5', borderRadius:999, fontSize:12, color:RED, fontWeight:700 }}><AlertTriangle size={12} /> Vencido hace {Math.abs(diff)} día{Math.abs(diff)!==1?'s':''} — sin respuesta</span>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Btn tone="ghost" small onClick={onVolver}><ChevronLeft size={13} /> Expedientes</Btn>
      </div>

      {/* Cabecera */}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ fontSize: 18, fontWeight: 800, color: INK }}>{String(exp.contratista ?? '—')}</div>
            <div style={{ fontSize: 13, color: INK55 }}>{String(exp.entidad ?? '—')}</div>
            <div style={{ fontSize: 12, color: INK55, marginTop: 4 }}>{String(exp.referencia_contrato ?? exp.id_contrato)} · {String(exp.id_contrato)}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <Badge estado={String(exp.estado)} />
            <div style={{ fontSize: 18, fontWeight: 800, color: INK, marginTop: 6 }}>{fmtCOP(exp.valor_contrato as number)}</div>
            {nit && <div style={{ marginTop: 6 }}><Btn small tone="ghost" onClick={() => onVerContratista(nit)}><GitBranch size={12} /> Ver contratista</Btn></div>}
          </div>
        </div>
      </div>

      {/* Veredicto determinista — siempre visible, haya informe o no */}
      <PanelAnalisis analisis={detalle.analisis} />

      {/* Documentos en custodia */}
      <Seccion titulo="Documentos en custodia" icono={<ShieldCheck size={15} />}>
        {detalle.documentos.length === 0 ? <Vacio texto="Sin documentos." /> : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Archivo</th><th style={th}>SHA-256</th><th style={th}>Captura</th><th style={th}></th></tr></thead>
            <tbody>
              {detalle.documentos.map(d => (
                <tr key={d.id}>
                  <td style={td}>{d.nombre_archivo ?? '—'}</td>
                  <td style={{ ...td, fontFamily: 'monospace', fontSize: 11 }}>{d.sha256?.slice(0, 16)}…</td>
                  <td style={td}>{fmtFecha(d.fecha_captura)}</td>
                  <td style={td}>{d.url_origen && <a href={d.url_origen} target="_blank" rel="noopener noreferrer" style={{ color: GREEN }}><ExternalLink size={13} /></a>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Seccion>

      {/* Hallazgos */}
      <Seccion titulo={`Hallazgos (${detalle.hallazgos.length})`} icono={<AlertTriangle size={15} />}>
        {detalle.hallazgos.length === 0 ? <Vacio texto="Sin hallazgos del informe de supervisión (este contrato no tiene informe publicado). El veredicto de arriba es lo que arrojan los datos abiertos." /> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
              <thead><tr>
                <th style={th}>Regla</th><th style={th}>Folio</th><th style={th}>Evidencia</th>
                <th style={th}>Afirmado</th><th style={th}>Calculado</th><th style={th}>Δ</th>
              </tr></thead>
              <tbody>
                {detalle.hallazgos.map(h => (
                  <tr key={h.id}>
                    <td style={{ ...td, whiteSpace: 'nowrap', fontWeight: 700 }}>{h.regla_id}</td>
                    <td style={td}>{h.folio ?? '—'}</td>
                    <td style={{ ...td, maxWidth: 340 }}>{h.evidencia_textual ?? '—'}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{h.cifra_afirmada == null ? '—' : fmtCOP(h.cifra_afirmada)}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{h.cifra_calculada == null ? '—' : fmtCOP(h.cifra_calculada)}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap', color: h.delta ? RED : INK55, fontWeight: 700 }}>{h.delta == null ? '—' : fmtCOP(h.delta)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Seccion>

      {/* Denuncia */}
      <Seccion titulo="Borrador de denuncia" icono={<Gavel size={15} />}>
        {generando ? (
          <div style={{ textAlign: 'center', padding: 20, color: INK55, fontSize: 13 }}>
            <Loader size={18} className="spin" /><div style={{ marginTop: 6 }}>Generando… fundamenta contra el corpus, redacta y valida cada cita. Puede tardar 2-4 min.</div>
          </div>
        ) : denuncia ? (
          <>
            {/* Chips de citas */}
            {citas && (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
                <Chip icono={<ShieldCheck size={13} />} tone={GREEN} n={citas.respaldadas?.length ?? 0} texto="respaldadas por corpus" />
                <Chip icono={<FileText size={13} />} tone={INK55} n={citas.del_hecho?.length ?? 0} texto="datos del hecho (motor)" />
                <Chip icono={<AlertTriangle size={13} />} tone={(citas.sinRespaldo?.length ?? 0) > 0 ? RED : INK12} n={citas.sinRespaldo?.length ?? 0} texto="sin respaldo" />
              </div>
            )}

            {/* Editor TipTap */}
            <EditorDenuncia
              htmlInicial={denuncia.contenido_html ?? ''}
              expedienteId={String(detalle.expediente.id)}
              onGuardar={onGuardarDenuncia}
            />

            {/* Área de envío (F2) */}
            <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              {envioOk ? (
                <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 14px', background:'#ECFDF5', border:'1px solid #6EE7B7', borderRadius:10, fontSize:13, color:'#065F46', fontWeight:700 }}>
                  <CheckCircle size={16} /> Enviado · {envioOk.consecutivo}
                  {diasRestantesEl && <span style={{ marginLeft: 8 }}>{diasRestantesEl}</span>}
                </div>
              ) : (
                <>
                  <Btn tone="ink" onClick={() => setModalEnvio(true)} disabled={enviando}>
                    {enviando ? <Loader size={14} className="spin" /> : <Send size={14} />}
                    {enviando ? 'Enviando…' : 'Enviar derecho de petición'}
                  </Btn>
                  {diasRestantesEl && diasRestantesEl}
                </>
              )}
            </div>

            {/* Modal de envío */}
            {modalEnvio && (
              <div style={{ position:'fixed', inset:0, background:'rgba(11,31,26,0.55)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:60 }}>
                <div style={{ ...card, maxWidth:440, width:'100%' }}>
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
                    <b style={{ fontSize:15, color:INK }}>Enviar derecho de petición</b>
                    <span style={{ cursor:'pointer', color:INK55 }} onClick={() => setModalEnvio(false)}><X size={16} /></span>
                  </div>
                  <p style={{ fontSize:13, color:INK55, marginBottom:14 }}>
                    Se enviará con consecutivo <b>VEE-{new Date().getFullYear()}-XXXXX</b>, Reply-To <code>veedor@numa.la</code> y plazo de 15 días hábiles.
                  </p>
                  <label style={{ display:'block', fontSize:13, fontWeight:600, color:INK, marginBottom:4 }}>Email del destinatario *</label>
                  <input
                    type="email" value={destEmail} onChange={e => setDestEmail(e.target.value)}
                    placeholder="supervisor@entidad.gov.co"
                    style={{ width:'100%', padding:'8px 12px', border:`1px solid ${INK12}`, borderRadius:8, fontSize:13, color:INK, background:WHITE, boxSizing:'border-box', marginBottom:10 }}
                  />
                  <label style={{ display:'block', fontSize:13, fontWeight:600, color:INK, marginBottom:4 }}>Nombre del destinatario</label>
                  <input
                    type="text" value={destNombre} onChange={e => setDestNombre(e.target.value)}
                    placeholder="Dr. Juan Pérez"
                    style={{ width:'100%', padding:'8px 12px', border:`1px solid ${INK12}`, borderRadius:8, fontSize:13, color:INK, background:WHITE, boxSizing:'border-box', marginBottom:14 }}
                  />
                  <label style={{ display:'block', fontSize:13, fontWeight:600, color:INK, marginBottom:6 }}>Canal de envío</label>
                  <div style={{ display:'flex', gap:8, marginBottom:18 }}>
                    {(['resend', 'smtp'] as const).map(c => (
                      <button key={c} onClick={() => setCanalEnvio(c)} style={{
                        flex:1, padding:'8px 0', borderRadius:8, fontSize:13, fontWeight:600, cursor:'pointer',
                        border: `2px solid ${canalEnvio === c ? INK : INK12}`,
                        background: canalEnvio === c ? 'rgba(10,46,34,0.06)' : WHITE,
                        color: canalEnvio === c ? INK : INK55,
                      }}>
                        {c === 'resend' ? '📧 Resend (resend.com)' : '🖧 SMTP propio'}
                      </button>
                    ))}
                  </div>
                  {canalEnvio === 'smtp' && (
                    <p style={{ fontSize:12, color:AMBER, marginBottom:12, padding:'8px 10px', background:`${AMBER}12`, borderRadius:8 }}>
                      Asegúrate de haber configurado el SMTP de tu organización en Configuración → Envío.
                    </p>
                  )}
                  <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
                    <Btn tone="ghost" onClick={() => setModalEnvio(false)}>Cancelar</Btn>
                    <Btn tone="ink" disabled={!destEmail || enviando} onClick={async () => {
                      setModalEnvio(false)
                      await onEnviarDenuncia({ destinatario_email: destEmail, destinatario_nombre: destNombre, canal: canalEnvio })
                    }}>
                      <Send size={13} /> Confirmar envío
                    </Btn>
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
          <div style={{ textAlign: 'center', padding: 16 }}>
            {(exp.estado as string) === 'denuncia_borrador' ? (
              // El backend ya generó la denuncia pero la UI no la tiene aún.
              // Ofrece recargar en lugar de volver a generar.
              <>
                <p style={{ fontSize: 13, color: AMBER, marginBottom: 12, fontWeight: 600 }}>
                  La denuncia fue generada. Recarga el expediente para verla.
                </p>
                <Btn tone="ink" onClick={() => onRecargar(detalle.expediente.id)}>
                  <RefreshCw size={14} /> Recargar expediente
                </Btn>
              </>
            ) : (
              <>
                <p style={{ fontSize: 13, color: INK55, marginBottom: 12 }}>Genera el borrador desde los hallazgos. La IA solo redacta; el fundamento sale del corpus, cada cita se valida.</p>
                <Btn tone="gold" onClick={() => onGenerar(detalle.expediente.id)}><Gavel size={14} /> Generar borrador de denuncia</Btn>
              </>
            )}
          </div>
        )}
      </Seccion>

      {/* F4 — Seguimiento del requerimiento */}
      {(reqs.length > 0 || envioOk) && (() => {
        const req = reqs[0]
        const analisis = req?.analisis_respuesta
        let analisisBadge: ReactNode = null
        if (analisis) {
          if (analisis.respondio_fondo) {
            analisisBadge = <span style={{ display:'inline-flex', alignItems:'center', gap:5, padding:'3px 9px', background:'#ECFDF5', border:'1px solid #6EE7B7', borderRadius:999, fontSize:12, color:'#065F46', fontWeight:700 }}><CheckCircle size={12} /> Respondió de fondo ✓</span>
          } else if (analisis.tipo_respuesta === 'evasiva' || analisis.tipo_respuesta === 'formal') {
            analisisBadge = <span style={{ display:'inline-flex', alignItems:'center', gap:5, padding:'3px 9px', background:'#FEF3C7', border:'1px solid #FCD34D', borderRadius:999, fontSize:12, color:'#92400E', fontWeight:700 }}><AlertTriangle size={12} /> Respuesta evasiva ⚠️</span>
          } else if (analisis.tipo_respuesta === 'silencio_admin') {
            analisisBadge = <span style={{ display:'inline-flex', alignItems:'center', gap:5, padding:'3px 9px', background:'#FEF2F2', border:'1px solid #FCA5A5', borderRadius:999, fontSize:12, color:RED, fontWeight:700 }}><AlertTriangle size={12} /> Silencio administrativo</span>
          }
        }
        return (
          <Seccion titulo="Seguimiento del requerimiento" icono={<Inbox size={15} />}>
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              {req?.consecutivo && (
                <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
                  <span style={{ fontFamily:'monospace', fontWeight:700, fontSize:13, color:DKGRN }}>{req.consecutivo}</span>
                  {req.estado && <Badge estado={req.estado} />}
                  {req.fecha_envio && <span style={{ fontSize:12, color:INK55 }}>Enviado {fmtFecha(req.fecha_envio)}</span>}
                  {analisisBadge}
                </div>
              )}

              {/* Respuesta recibida */}
              {req?.respuesta_html ? (
                <div style={{ border:`1px solid ${INK12}`, borderRadius:8, overflow:'hidden' }}>
                  <div
                    style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'8px 12px', background:INK06, cursor:'pointer' }}
                    onClick={() => setRespExpandida(v => !v)}
                  >
                    <span style={{ fontSize:13, fontWeight:600, color:INK }}>
                      <MessageSquare size={13} style={{ verticalAlign:'middle', marginRight:5 }} />
                      Respuesta de {req.respuesta_from ?? 'la entidad'}
                      {req.fecha_respuesta && <span style={{ fontWeight:400, color:INK55, marginLeft:8 }}>{fmtFecha(req.fecha_respuesta)}</span>}
                    </span>
                    {respExpandida ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </div>
                  {respExpandida && (
                    <iframe
                      srcDoc={req.respuesta_html}
                      style={{ width:'100%', height:320, border:'none', background:WHITE }}
                      sandbox="allow-same-origin"
                      title="Respuesta de la entidad"
                    />
                  )}
                </div>
              ) : (
                <div style={{ fontSize:13, color:INK55 }}>Sin respuesta recibida aún.</div>
              )}

              {/* Botón analizar respuesta — aparece cuando hay respuesta pero aún no se analizó */}
              {req?.respuesta_html && !analisis && (
                <Btn tone="ghost" small disabled={analizandoRespuesta} onClick={async () => {
                  if (!detalle || !req) return
                  setAnalizandoRespuesta(true)
                  try {
                    const resultado = await api.analizarRespuesta(detalle.expediente.id, req.id)
                    const updated = await api.obtenerRequerimientos(detalle.expediente.id)
                    setReqs(updated)
                    void resultado
                  } catch (e) { console.error(e) } finally { setAnalizandoRespuesta(false) }
                }}>
                  {analizandoRespuesta ? <Loader size={13} className="spin" /> : <MessageSquare size={13} />}
                  {analizandoRespuesta ? 'Analizando…' : 'Analizar respuesta con IA'}
                </Btn>
              )}

              {/* Análisis de fondo */}
              {analisis?.razon && (
                <div style={{ fontSize:13, color:INK, background:INK06, borderRadius:8, padding:'8px 12px' }}>
                  <b>Análisis:</b> {analisis.razon}
                </div>
              )}

              {/* Botón radicar tutela — aparece cuando vencido o respuesta no de fondo */}
              {((!req?.respuesta_html && envioOk) || (analisis && !analisis.respondio_fondo)) && (
                <div style={{ marginTop:4 }}>
                  {req?.numero_radicado ? (
                    <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 14px', background:'#F5F3FF', border:'1px solid #A78BFA', borderRadius:10, fontSize:13, color:'#5B21B6', fontWeight:700 }}>
                        <FileCheck size={15} /> Tutela radicada · {req.numero_radicado}
                        {req.juzgado && <span style={{ fontWeight:400, color:'#6D28D9' }}>· {req.juzgado}</span>}
                        {/* F6 — días sin fallo */}
                        {req.fecha_radicado && (() => {
                          const hoy = new Date(); hoy.setHours(0,0,0,0)
                          const rad = new Date(req.fecha_radicado)
                          const dias = Math.round((hoy.getTime() - rad.getTime()) / 86_400_000)
                          return dias >= 10
                            ? <span style={{ marginLeft:'auto', padding:'2px 8px', background:'#FEF2F2', border:'1px solid #FCA5A5', borderRadius:999, fontSize:11, color:RED, fontWeight:700 }}>⚠️ {dias} días sin fallo</span>
                            : <span style={{ marginLeft:'auto', padding:'2px 8px', background:'#F0FDF4', border:'1px solid #6EE7B7', borderRadius:999, fontSize:11, color:'#065F46', fontWeight:700 }}>{dias} día{dias!==1?'s':''} desde radicación</span>
                        })()}
                      </div>
                      {/* F6 — link Rama Judicial */}
                      <a
                        href={`https://consultaprocesos.ramajudicial.gov.co:448/MisConsultas/procesos/lista`}
                        target="_blank" rel="noopener noreferrer"
                        style={{ fontSize:12, color:GREEN, display:'inline-flex', alignItems:'center', gap:4 }}
                      >
                        <ExternalLink size={12} /> Consultar en Rama Judicial
                      </a>
                    </div>
                  ) : (
                    <Btn tone="gold" onClick={() => setModalTutela(true)}>
                      <Gavel size={14} /> Radicar tutela
                    </Btn>
                  )}
                </div>
              )}
            </div>
          </Seccion>
        )
      })()}

      {/* F7 — Fallo judicial */}
      {(() => {
        const req = reqs.find(r => r.tipo === 'tutela')
        if (!req?.numero_radicado) return null  // sin tutela radicada, no mostrar

        const fallo = req.analisis_fallo
        const esDesfavorable = fallo?.resultado === 'desfavorable' || fallo?.resultado === 'inhibitorio'
        const esParcial = fallo?.resultado === 'parcial'

        return (
          <Seccion titulo="Fallo judicial" icono={<FileCheck size={15} />}>
            {fallo ? (
              <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                {/* Resultado */}
                <div style={{
                  display:'flex', alignItems:'center', gap:10, padding:'12px 16px', borderRadius:10,
                  background: fallo.resultado === 'favorable' ? '#ECFDF5' : esDesfavorable ? '#FEF2F2' : '#FEF3C7',
                  border: `1px solid ${fallo.resultado === 'favorable' ? '#6EE7B7' : esDesfavorable ? '#FCA5A5' : '#FCD34D'}`,
                }}>
                  <span style={{ fontSize:22 }}>{fallo.resultado === 'favorable' ? '✅' : esDesfavorable ? '❌' : '⚠️'}</span>
                  <div>
                    <div style={{ fontWeight:800, fontSize:15, color:INK, textTransform:'capitalize' }}>
                      Fallo {fallo.resultado}
                    </div>
                    {fallo.razon && <div style={{ fontSize:13, color:INK55, marginTop:2 }}>{fallo.razon}</div>}
                  </div>
                </div>

                {/* Extracto */}
                {fallo.extracto && (
                  <blockquote style={{ margin:0, padding:'8px 14px', borderLeft:`3px solid ${INK12}`, color:INK55, fontSize:13, fontStyle:'italic' }}>
                    "{fallo.extracto}"
                  </blockquote>
                )}

                {/* Acción siguiente */}
                {fallo.accion_siguiente && (
                  <div style={{ fontSize:13, color:INK, background:INK06, borderRadius:8, padding:'8px 12px' }}>
                    <b>Próxima acción:</b> {fallo.accion_siguiente}
                  </div>
                )}

                {/* Argumentos de impugnación (si desfavorable/parcial) */}
                {(esDesfavorable || esParcial) && fallo.impugnacion_sugerida && (
                  <div style={{ border:`1px solid ${INK12}`, borderRadius:8, overflow:'hidden' }}>
                    <div
                      style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'8px 12px', background:INK06, cursor:'pointer' }}
                      onClick={() => setImpugnacionAbierta(v => !v)}
                    >
                      <span style={{ fontSize:13, fontWeight:700, color:INK }}>Argumentos para impugnar</span>
                      {impugnacionAbierta ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </div>
                    {impugnacionAbierta && (
                      <div style={{ padding:'12px 14px', fontSize:13, color:INK, whiteSpace:'pre-wrap', lineHeight:1.6 }}>
                        {fallo.impugnacion_sugerida}
                      </div>
                    )}
                  </div>
                )}

                {/* Acciones */}
                <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                  {fallo.resultado === 'favorable' && (
                    <Btn tone="ink" disabled={cerrando} onClick={async () => {
                      if (!detalle) return
                      setCerrando(true)
                      try {
                        await api.cerrarExpediente(detalle.expediente.id, 'cerrado_favorable', `Expediente cerrado con fallo favorable. ${fallo.razon ?? ''}`.trim())
                        onVolver()
                      } finally { setCerrando(false) }
                    }}>
                      {cerrando ? <Loader size={13} className="spin" /> : <CheckCircle size={13} />} Cerrar con victoria
                    </Btn>
                  )}
                  <Btn tone="ghost" small onClick={() => setFalloSeccionAbierta(v => !v)}>
                    <RefreshCw size={12} /> Re-analizar
                  </Btn>
                </div>

                {/* Re-analizar expandido */}
                {falloSeccionAbierta && (
                  <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                    <textarea
                      value={falloTexto} onChange={e => setFalloTexto(e.target.value)}
                      placeholder="Pega aquí el texto completo del fallo…"
                      rows={6}
                      style={{ width:'100%', padding:'8px 12px', border:`1px solid ${INK12}`, borderRadius:8, fontSize:13, color:INK, background:WHITE, resize:'vertical', boxSizing:'border-box', fontFamily:'inherit' }}
                    />
                    <div style={{ display:'flex', justifyContent:'flex-end' }}>
                      <Btn tone="gold" disabled={!falloTexto.trim() || analizandoFallo} onClick={async () => {
                        if (!detalle || !falloTexto.trim() || !req.id) return
                        setAnalizandoFallo(true)
                        try {
                          await api.analizarFallo(detalle.expediente.id, req.id, falloTexto.trim())
                          const updated = await api.obtenerRequerimientos(detalle.expediente.id)
                          setReqs(updated)
                          setFalloTexto('')
                          setFalloSeccionAbierta(false)
                        } finally { setAnalizandoFallo(false) }
                      }}>
                        {analizandoFallo ? <Loader size={13} className="spin" /> : <Gavel size={13} />}
                        {analizandoFallo ? 'Analizando…' : 'Analizar fallo'}
                      </Btn>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              /* Primera vez — pegar texto del fallo */
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                <p style={{ fontSize:13, color:INK55, margin:0 }}>
                  Cuando el juez emita el fallo, pega el texto aquí. Claude determinará si es favorable, parcial o desfavorable y sugerirá los argumentos de impugnación si aplica.
                </p>
                <textarea
                  value={falloTexto} onChange={e => setFalloTexto(e.target.value)}
                  placeholder="Pega aquí el texto completo del fallo del juez…"
                  rows={6}
                  style={{ width:'100%', padding:'8px 12px', border:`1px solid ${INK12}`, borderRadius:8, fontSize:13, color:INK, background:WHITE, resize:'vertical', boxSizing:'border-box', fontFamily:'inherit' }}
                />
                <div style={{ display:'flex', justifyContent:'flex-end' }}>
                  <Btn tone="gold" disabled={!falloTexto.trim() || analizandoFallo} onClick={async () => {
                    if (!detalle || !falloTexto.trim() || !req.id) return
                    setAnalizandoFallo(true)
                    try {
                      await api.analizarFallo(detalle.expediente.id, req.id, falloTexto.trim())
                      const updated = await api.obtenerRequerimientos(detalle.expediente.id)
                      setReqs(updated)
                      setFalloTexto('')
                    } finally { setAnalizandoFallo(false) }
                  }}>
                    {analizandoFallo ? <Loader size={13} className="spin" /> : <Gavel size={13} />}
                    {analizandoFallo ? 'Analizando con IA…' : 'Analizar fallo'}
                  </Btn>
                </div>
              </div>
            )}
          </Seccion>
        )
      })()}

      {/* Notas del equipo */}
      <div style={{ border:`1px solid ${INK12}`, borderRadius:12, background:WHITE }}>
        <div
          style={{ display:'flex', alignItems:'center', gap:8, padding:'12px 16px', cursor:'pointer', userSelect:'none' }}
          onClick={() => setNotasOpen(v => !v)}
        >
          <MessageSquare size={15} color={DKGRN} />
          <span style={{ fontSize:14, fontWeight:700, color:INK, flex:1 }}>Notas del equipo ({notas.length})</span>
          {notasOpen ? <ChevronDown size={14} color={INK55} /> : <ChevronRight size={14} color={INK55} />}
        </div>
        {notasOpen && (
          <div style={{ padding:'0 16px 16px', display:'flex', flexDirection:'column', gap:8 }}>
            {notas.length === 0 && <div style={{ fontSize:13, color:INK55 }}>Sin notas aún.</div>}
            {notas.map(n => (
              <div key={n.id} style={{ background:INK06, borderRadius:8, padding:'8px 12px', fontSize:13, color:INK }}>
                <div>{n.contenido}</div>
                <div style={{ fontSize:11, color:INK55, marginTop:3 }}>{fmtFecha(n.created_at)}</div>
              </div>
            ))}
            <textarea
              value={notaTexto}
              onChange={e => setNotaTexto(e.target.value)}
              placeholder="Agregar nota interna…"
              rows={3}
              style={{ width:'100%', padding:'8px 12px', border:`1px solid ${INK12}`, borderRadius:8, fontSize:13, color:INK, background:WHITE, resize:'vertical', boxSizing:'border-box', fontFamily:'inherit' }}
            />
            <div style={{ display:'flex', justifyContent:'flex-end' }}>
              <Btn
                tone="ink" small
                disabled={!notaTexto.trim() || guardandoNota}
                onClick={async () => {
                  if (!detalle || !notaTexto.trim()) return
                  setGuardandoNota(true)
                  try {
                    const nueva = await api.crearNota(detalle.expediente.id, { contenido: notaTexto.trim(), es_interna: true, org_id: orgId })
                    setNotas(prev => [...prev, nueva])
                    setNotaTexto('')
                  } finally { setGuardandoNota(false) }
                }}
              >
                {guardandoNota ? <Loader size={13} className="spin" /> : <Send size={13} />} Guardar nota
              </Btn>
            </div>
          </div>
        )}
      </div>

      {/* Modal tutela (F5) */}
      {modalTutela && (
        <div style={{ position:'fixed', inset:0, background:'rgba(11,31,26,0.55)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:60 }}>
          <div style={{ ...card, maxWidth:500, width:'100%' }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
              <b style={{ fontSize:15, color:INK }}>Registrar radicado de tutela</b>
              <span style={{ cursor:'pointer', color:INK55 }} onClick={() => setModalTutela(false)}><X size={16} /></span>
            </div>
            {generandoTutela ? (
              <div style={{ textAlign:'center', padding:24, color:INK55, fontSize:13 }}>
                <Loader size={18} className="spin" /><div style={{ marginTop:8 }}>Generando plantilla de tutela… puede tardar 1-2 min.</div>
              </div>
            ) : (
              <>
                <p style={{ fontSize:13, color:INK55, marginBottom:14 }}>
                  La tutela invoca el derecho fundamental de petición (Art. 23 CP) y acceso a información pública (Art. 74 CP + Ley 1712/2014). Registra el radicado una vez presentada ante el juzgado.
                </p>
                <label style={{ display:'block', fontSize:13, fontWeight:600, color:INK, marginBottom:4 }}>Número de radicado *</label>
                <input
                  type="text" value={radicadoNum} onChange={e => setRadicadoNum(e.target.value)}
                  placeholder="05001-33-03-001-2026-00123-00"
                  style={{ width:'100%', padding:'8px 12px', border:`1px solid ${INK12}`, borderRadius:8, fontSize:13, color:INK, background:WHITE, boxSizing:'border-box', marginBottom:10 }}
                />
                <label style={{ display:'block', fontSize:13, fontWeight:600, color:INK, marginBottom:4 }}>Juzgado *</label>
                <input
                  type="text" value={radicadoJuzgado} onChange={e => setRadicadoJuzgado(e.target.value)}
                  placeholder="Juzgado 1° Administrativo del Circuito de Medellín"
                  style={{ width:'100%', padding:'8px 12px', border:`1px solid ${INK12}`, borderRadius:8, fontSize:13, color:INK, background:WHITE, boxSizing:'border-box', marginBottom:10 }}
                />
                <label style={{ display:'block', fontSize:13, fontWeight:600, color:INK, marginBottom:4 }}>Ciudad</label>
                <input
                  type="text" value={radicadoCiudad} onChange={e => setRadicadoCiudad(e.target.value)}
                  placeholder="Medellín"
                  style={{ width:'100%', padding:'8px 12px', border:`1px solid ${INK12}`, borderRadius:8, fontSize:13, color:INK, background:WHITE, boxSizing:'border-box', marginBottom:16 }}
                />
                <div style={{ display:'flex', gap:8, justifyContent:'space-between', flexWrap:'wrap' }}>
                  <Btn tone="ghost" small onClick={async () => {
                    if (!detalle) return
                    setGenerandoTutela(true)
                    try {
                      const res = await api.generarTutela(detalle.expediente.id)
                      if (res.html) {
                        const a = document.createElement('a')
                        const blob = new Blob([res.html], { type: 'text/html' })
                        a.href = URL.createObjectURL(blob)
                        a.download = `tutela-${detalle.expediente.id}.html`
                        a.click()
                      }
                    } catch (e) { console.error(e) } finally { setGenerandoTutela(false) }
                  }}>
                    <FileText size={13} /> Generar plantilla
                  </Btn>
                  <div style={{ display:'flex', gap:8 }}>
                    <Btn tone="ghost" onClick={() => setModalTutela(false)}>Cancelar</Btn>
                    <Btn tone="ink" disabled={!radicadoNum.trim() || !radicadoJuzgado.trim() || guardandoRadicado} onClick={async () => {
                      if (!detalle) return
                      setGuardandoRadicado(true)
                      const exp = detalle.expediente as Record<string, unknown>
                      try {
                        await api.registrarRadicadoTutela(detalle.expediente.id, {
                          numero_radicado: radicadoNum.trim(),
                          juzgado: radicadoJuzgado.trim(),
                          ciudad_radicado: radicadoCiudad.trim() || undefined,
                          id_proceso: String(exp.id_contrato ?? detalle.expediente.id),
                        })
                        // reload reqs
                        const updated = await api.obtenerRequerimientos(detalle.expediente.id)
                        setReqs(updated)
                        setModalTutela(false)
                      } catch (e) { console.error(e) } finally { setGuardandoRadicado(false) }
                    }}>
                      {guardandoRadicado ? <Loader size={13} className="spin" /> : <FileCheck size={13} />} Registrar radicado
                    </Btn>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Auxiliares de presentación ───────────────────────────────────────────────
function Seccion({ titulo, icono, children }: { titulo: string; icono: ReactNode; children: ReactNode }) {
  return (
    <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: `1px solid ${INK12}`, color: DKGRN }}>
        {icono}<b style={{ fontSize: 14 }}>{titulo}</b>
      </div>
      <div style={{ padding: 16 }}>{children}</div>
    </div>
  )
}
const Vacio = ({ texto }: { texto: string }) => <div style={{ color: INK55, fontSize: 13, textAlign: 'center', padding: 8 }}>{texto}</div>

function Chip({ icono, tone, n, texto }: { icono: ReactNode; tone: string; n: number; texto: string }) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 999, border: `1px solid ${tone}`, color: tone === INK12 ? INK55 : tone, fontSize: 12, fontWeight: 600 }}>
      {icono}<b>{n}</b> {texto}
    </div>
  )
}

function Overlay({ texto, sub }: { texto: string; sub: string }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(11,31,26,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 }}>
      <div style={{ ...card, textAlign: 'center', maxWidth: 380 }}>
        <Loader size={26} className="spin" style={{ color: GREEN }} />
        <div style={{ fontSize: 15, fontWeight: 700, color: INK, marginTop: 10 }}>{texto}</div>
        <div style={{ fontSize: 12, color: INK55, marginTop: 6 }}>{sub}</div>
      </div>
    </div>
  )
}

function PanelContratista({ analisis, cargando, onClose, onBarrer }: {
  analisis: api.AnalisisCompleto | null; cargando: boolean
  onClose: () => void; onBarrer: (nit: string) => void
}) {
  const perfil   = analisis?.perfil   ?? null
  const red      = analisis?.red      ?? null
  const evolucion = analisis?.evolucion ?? null

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(11,31,26,0.45)', display: 'flex', justifyContent: 'flex-end', zIndex: 55 }} onClick={onClose}>
      <div style={{ width: 'min(540px, 94vw)', height: '100%', background: WHITE, padding: 20, overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
          <b style={{ fontSize: 15, color: INK, display: 'flex', alignItems: 'center', gap: 8 }}><GitBranch size={16} /> Perfil del contratista</b>
          <span style={{ marginLeft: 'auto', cursor: 'pointer', color: INK55 }} onClick={onClose}><X size={18} /></span>
        </div>

        {cargando || !analisis ? (
          <div style={{ color: INK55, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Loader size={16} className="spin" /> Analizando red… (~10–30s)
          </div>
        ) : (
          <>
            {/* Encabezado con métricas */}
            {perfil && (
              <>
                <div style={{ fontSize: 12, color: INK55, marginBottom: 4 }}>NIT {perfil.nit}</div>
                <div style={{ display: 'flex', gap: 20, marginBottom: 12 }}>
                  <div><div style={{ fontSize: 22, fontWeight: 800, color: INK }}>{perfil.total_contratos}</div><div style={{ fontSize: 11, color: INK55 }}>contratos (2 años)</div></div>
                  <div><div style={{ fontSize: 20, fontWeight: 800, color: INK }}>{fmtCOP(perfil.valor_total)}</div><div style={{ fontSize: 11, color: INK55 }}>valor total</div></div>
                </div>
              </>
            )}

            {/* Chips de red */}
            {red && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                <Chip icono={<GitBranch size={13} />} tone={DKGRN} n={red.resumen.contratistas} texto="empresas en la red" />
                <Chip icono={<GitBranch size={13} />} tone={GREEN} n={red.resumen.entidades_alcanzadas} texto="entidades" />
                {red.resumen.empresas_hermanas > 0 && (
                  <Chip icono={<AlertTriangle size={13} />} tone={AMBER} n={red.resumen.empresas_hermanas} texto="hermanas" />
                )}
              </div>
            )}

            {/* Señales de amaño detectadas */}
            {red && red.manos_comunes.length > 0 && (
              <div style={{ background: '#FEF9EC', border: `1px solid ${AMBER}`, borderRadius: 8, padding: 10, marginBottom: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: AMBER, marginBottom: 4 }}>Señales detectadas</div>
                {red.manos_comunes.map((m, i) => (
                  <div key={i} style={{ fontSize: 12, color: INK, padding: '2px 0' }}>• {m.nota}</div>
                ))}
              </div>
            )}

            {/* Mini grafo */}
            {red && (
              <div style={{ border: `1px solid ${INK12}`, borderRadius: 10, overflow: 'hidden', marginBottom: 12 }}>
                <div style={{ padding: '8px 12px', background: CREAM, fontSize: 11, fontWeight: 700, color: DKGRN, borderBottom: `1px solid ${INK12}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>Red de contratación</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <Btn small tone="ghost" onClick={() => descargarInformeRed(red, evolucion)}><FileText size={11} /> PDF</Btn>
                    {perfil && <Btn small onClick={() => onBarrer(perfil.nit)}><GitBranch size={11} /> Ver completa</Btn>}
                  </div>
                </div>
                <div style={{ height: 230 }}>
                  <GrafoRadial red={red} onExpandir={() => {}} />
                </div>
              </div>
            )}

            {/* Evolución */}
            {evolucion && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: DKGRN, marginBottom: 6 }}>Evolución en el tiempo</div>
                <div style={{ fontSize: 12, color: INK, marginBottom: 6 }}>
                  Nació en <b>{evolucion.hitos.inicio ?? '—'}</b> · pico en <b>{evolucion.hitos.pico ?? '—'}</b> · estado:{' '}
                  <b style={{ color: /declive|desinteg/.test(evolucion.hitos.estado ?? '') ? AMBER : DKGRN }}>{evolucion.hitos.estado}</b>
                </div>
                <GraficoEvolucion ev={evolucion} />
              </div>
            )}

            {/* Si la red no cargó, botón directo */}
            {!red && perfil && (
              <div style={{ marginBottom: 14 }}>
                <Btn small onClick={() => onBarrer(perfil.nit)}><GitBranch size={12} /> Barrer red de este contratista</Btn>
              </div>
            )}

            {/* Representantes */}
            {perfil && perfil.representantes.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={lbl}>Representantes legales</div>
                {perfil.representantes.map((r, i) => <div key={i} style={{ fontSize: 13, color: INK }}>• {r}</div>)}
              </div>
            )}

            {/* Entidades */}
            {perfil && perfil.por_entidad.length > 0 && (
              <>
                <div style={{ marginBottom: 6 }}><div style={lbl}>Entidades que lo contratan</div></div>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <tbody>
                    {perfil.por_entidad.slice(0, 12).map((e, i) => (
                      <tr key={i}>
                        <td style={{ ...td, fontSize: 12 }}>{e.nombre}<div style={{ fontSize: 10, color: INK55 }}>{e.n} contratos</div></td>
                        <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap', fontSize: 12 }}>{fmtCOP(e.valor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            {/* Errores parciales (info, no bloquea) */}
            {analisis.errores.length > 0 && (
              <div style={{ fontSize: 11, color: INK55, marginTop: 12 }}>
                Datos parciales — {analisis.errores.map(e => e.fuente).join(', ')} no respondieron.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ── Pantalla: Red / Sujetos vigilados ─────────────────────────────────────────
function PantallaRed({ red, barriendo, barrer, candidatos, cargandoCand, cargarCandidatos, ambito }: {
  red: api.RedBarrido | null; barriendo: boolean; barrer: (s: api.Semilla) => void
  candidatos: api.SenalRepMultiple[]; cargandoCand: boolean; cargarCandidatos: () => void
  ambito: api.Ambito | undefined
}) {
  const [tipo, setTipo] = useState<'rep' | 'nit'>('rep')
  const [val, setVal] = useState('')
  const [verCand, setVerCand] = useState(false)
  const lanzar = () => { const v = val.trim(); if (v) barrer(tipo === 'nit' ? { nit: v } : { repId: v }) }

  // Detección proactiva de carruseles (estado local — el sistema barre y rankea).
  const [carruseles, setCarruseles] = useState<api.Carrusel[]>([])
  const [detectando, setDetectando] = useState(false)
  const [errCarr, setErrCarr] = useState('')
  const [carrDesde, setCarrDesde] = useState('')
  const [carrHasta, setCarrHasta] = useState('')
  const [carrTipo, setCarrTipo] = useState('')
  const [carrEntidad, setCarrEntidad] = useState('')
  const [carrMinEmp, setCarrMinEmp] = useState(3)
  const [carrTopN, setCarrTopN] = useState(12)
  const detectar = async () => {
    setDetectando(true); setErrCarr('')
    try { setCarruseles(await api.detectarCarruseles({ topN: carrTopN, minEmpresas: carrMinEmp, ambito, desde: carrDesde || undefined, hasta: carrHasta || undefined, tipoContrato: carrTipo || undefined, entidad: carrEntidad || undefined })) }
    catch (e) { setErrCarr((e as Error).message) }
    finally { setDetectando(false) }
  }

  // Selección múltiple → cruces entre las redes elegidas.
  const [sel, setSel] = useState<Set<string>>(new Set())
  const toggleSel = (repId: string) => setSel(s => { const n = new Set(s); if (n.has(repId)) n.delete(repId); else n.add(repId); return n })
  const [cruces, setCruces] = useState<api.CrucesRed | null>(null)
  const [cruzando, setCruzando] = useState(false)
  const cruzar = async () => {
    if (sel.size < 2) return
    setCruzando(true); setErrCarr(''); setCruces(null)
    try { setCruces(await api.barridoRedMultiple([...sel].map(repId => ({ repId })), { ambito })) }
    catch (e) { setErrCarr((e as Error).message) }
    finally { setCruzando(false) }
  }

  // Evolución temporal de la red actual (la vida del carrusel).
  const [evolucion, setEvolucion] = useState<api.EvolucionRed | null>(null)
  const [cargandoEvol, setCargandoEvol] = useState(false)
  useEffect(() => { setEvolucion(null) }, [red])
  const verEvolucion = async () => {
    if (!red) return
    setCargandoEvol(true); setErrCarr('')
    try { setEvolucion(await api.evolucionRed(red.semilla, { dias: 2200, ambito })) }
    catch (e) { setErrCarr((e as Error).message) }
    finally { setCargandoEvol(false) }
  }

  return (
    <>
      <div style={card}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <label style={lbl}>Buscar por</label>
            <div style={{ display: 'flex', gap: 4 }}>
              <Btn small tone={tipo === 'rep' ? 'ink' : 'ghost'} onClick={() => setTipo('rep')}>Cédula rep.</Btn>
              <Btn small tone={tipo === 'nit' ? 'ink' : 'ghost'} onClick={() => setTipo('nit')}>NIT contratista</Btn>
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label style={lbl}>{tipo === 'rep' ? 'Cédula del representante legal' : 'NIT del contratista'}</label>
            <input style={inp} value={val} onChange={e => setVal(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') lanzar() }}
              placeholder={tipo === 'rep' ? 'p. ej. 1140823664' : 'p. ej. 901519494'} />
          </div>
          <Btn onClick={lanzar} disabled={barriendo || !val.trim()}>{barriendo ? <Loader size={14} className="spin" /> : <GitBranch size={14} />} Barrer red</Btn>
          <Btn tone="ghost" onClick={() => { setVerCand(v => !v); if (!candidatos.length) cargarCandidatos() }}><AlertTriangle size={14} /> Sospechosos</Btn>
          <Btn tone="gold" onClick={detectar} disabled={detectando}>{detectando ? <Loader size={14} className="spin" /> : <AlertTriangle size={14} />} Detectar carruseles</Btn>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 10, fontSize: 12, color: INK55 }}>
          <span>Carruseles — entidad/municipio:</span>
          <input style={{ ...inp, width: 150 }} placeholder="ej. Copacabana" value={carrEntidad} onChange={e => setCarrEntidad(e.target.value)} />
          <span>· período:</span>
          <input style={{ ...inp, width: 62 }} placeholder="desde" value={carrDesde} onChange={e => setCarrDesde(e.target.value)} />
          <input style={{ ...inp, width: 62 }} placeholder="hasta" value={carrHasta} onChange={e => setCarrHasta(e.target.value)} />
          <span>· tipo:</span>
          <input style={{ ...inp, width: 96 }} placeholder="Obra…" value={carrTipo} onChange={e => setCarrTipo(e.target.value)} />
          <span>· sensibilidad:</span>
          <select style={{ ...inp, width: 'auto', cursor: 'pointer' }} value={carrMinEmp} onChange={e => setCarrMinEmp(Number(e.target.value))}>
            <option value={2}>2 empresas (más casos)</option>
            <option value={3}>3 (flagrantes)</option>
          </select>
          <span>· revisar:</span>
          <select style={{ ...inp, width: 'auto', cursor: 'pointer' }} value={carrTopN} onChange={e => setCarrTopN(Number(e.target.value))}>
            <option value={12}>top 12</option>
            <option value={25}>top 25</option>
            <option value={40}>top 40</option>
          </select>
        </div>
        {verCand && (
          <div style={{ marginTop: 12, borderTop: `1px solid ${INK12}`, paddingTop: 12 }}>
            {cargandoCand ? <Vacio texto="Cargando candidatos…" /> : candidatos.length === 0 ? <Vacio texto="Sin candidatos." /> : (
              <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                {candidatos.slice(0, 40).map((c, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: `1px solid ${INK06}`, fontSize: 13 }}>
                    <span style={{ flex: 1 }}><b>{c.representante}</b> · {c.empresas_distintas} empresas · {c.entidad}</span>
                    <Btn small onClick={() => barrer({ repId: c.rep_id })}>Barrer</Btn>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {detectando && <div style={{ ...card, textAlign: 'center', color: INK55, fontSize: 13 }}><Loader size={18} className="spin" /> Recorriendo la contratación y puntuando redes… (~30-60s)</div>}
      {errCarr && <div style={{ ...card, borderColor: RED, background: '#FEF2F2', color: RED, fontSize: 13 }}>{errCarr}</div>}
      {carruseles.length > 0 && (
        <Seccion titulo={`Carruseles detectados (${carruseles.length})`} icono={<AlertTriangle size={15} />}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 12, color: INK55, flex: 1, minWidth: 220 }}>Ordenadas por sospecha (score = empresas de una mano + concentración en una entidad + monto + patrón de consorcios). Marcá dos o más y cruzá sus redes para ver dónde coinciden.</div>
            <Btn small onClick={cruzar} disabled={sel.size < 2 || cruzando}>{cruzando ? <Loader size={12} className="spin" /> : <GitBranch size={12} />} Ver cruces ({sel.size})</Btn>
          </div>
          {carruseles.map((c, i) => (
            <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '12px 0', borderBottom: `1px solid ${INK06}` }}>
              <input type="checkbox" checked={sel.has(c.rep_id)} onChange={() => toggleSel(c.rep_id)} style={{ marginTop: 6, accentColor: GREEN, width: 16, height: 16, cursor: 'pointer' }} />
              <div style={{ textAlign: 'center', minWidth: 54 }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: nivelColor(c.nivel) }}>{c.score}</div>
                <span style={{ fontSize: 10, fontWeight: 700, color: WHITE, background: nivelColor(c.nivel), padding: '1px 7px', borderRadius: 999, textTransform: 'uppercase' }}>{c.nivel}</span>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: INK }}>{c.representante}</div>
                <div style={{ fontSize: 12, color: INK55, marginBottom: 4 }}>{c.resumen.empresas} empresas · {c.resumen.entidades} entidades · {fmtCOP(c.resumen.valor_total)}</div>
                {c.senales.map((s, j) => <div key={j} style={{ fontSize: 12, color: INK }}>• {s}</div>)}
              </div>
              <Btn small onClick={() => barrer({ repId: c.rep_id })}><GitBranch size={12} /> Ver red</Btn>
            </div>
          ))}
        </Seccion>
      )}

      {cruzando && <div style={{ ...card, textAlign: 'center', color: INK55, fontSize: 13 }}><Loader size={18} className="spin" /> Cruzando las redes seleccionadas…</div>}
      {cruces && !cruzando && (
        <Seccion titulo="Cruces entre las redes seleccionadas" icono={<GitBranch size={15} />}>
          <div style={{ fontSize: 12, color: INK55, marginBottom: 10 }}>
            {cruces.redes.filter(r => r.red).length} redes cruzadas. Donde dos sujetos comparten una entidad o un representante hay un puente entre sus redes — la señal más fuerte de que operan juntos.
          </div>
          {cruces.cruces.entidades_compartidas.length === 0 && cruces.cruces.representantes_compartidos.length === 0 ? (
            <Vacio texto="Las redes seleccionadas no comparten entidades ni representantes." />
          ) : (
            <>
              {cruces.cruces.entidades_compartidas.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={lbl}>Entidades donde coinciden</div>
                  {cruces.cruces.entidades_compartidas.map((e, i) => (
                    <div key={i} style={{ fontSize: 13, color: INK, padding: '3px 0' }}>• <b>{e.nombre}</b> — en {e.en_redes} de las redes seleccionadas</div>
                  ))}
                </div>
              )}
              {cruces.cruces.representantes_compartidos.length > 0 && (
                <div>
                  <div style={lbl}>Representantes compartidos entre redes</div>
                  {cruces.cruces.representantes_compartidos.map((r, i) => (
                    <div key={i} style={{ fontSize: 13, color: INK, padding: '3px 0' }}>• <b>{r.nombre}</b> — en {r.en_redes} redes</div>
                  ))}
                </div>
              )}
            </>
          )}
        </Seccion>
      )}

      {barriendo && <div style={{ ...card, textAlign: 'center', color: INK55, fontSize: 13 }}><Loader size={18} className="spin" /> Tejiendo la red… (varias consultas a datos abiertos, ~10-30s)</div>}

      {red && !barriendo && (
        <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Chip icono={<GitBranch size={13} />} tone={DKGRN} n={red.resumen.contratistas} texto="empresas" />
            <Chip icono={<GitBranch size={13} />} tone={GREEN} n={red.resumen.entidades_alcanzadas} texto="entidades" />
            <Chip icono={<AlertTriangle size={13} />} tone={GOLD} n={red.resumen.empresas_hermanas} texto="empresas hermanas" />
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 999, border: `1px solid ${INK12}`, color: INK, fontSize: 12, fontWeight: 700 }}>
              {fmtCOP(red.resumen.valor_total)} movidos
            </div>
          </div>

          <Seccion titulo="Red de contratación" icono={<GitBranch size={15} />}>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
              <Btn small tone="ghost" onClick={() => descargarInformeRed(red, evolucion)}><FileText size={12} /> Descargar PDF</Btn>
            </div>
            <GrafoRadial red={red} onExpandir={(nit) => barrer({ nit })} />
            <div style={{ textAlign: 'center', fontSize: 11, color: INK55, marginTop: 4 }}>Tocá cualquier nodo para ver su detalle · en una empresa, botón para expandir la red.</div>
          </Seccion>

          <Seccion titulo="Evolución en el tiempo" icono={<Clock size={15} />}>
            {!evolucion ? (
              <div style={{ textAlign: 'center', padding: 8 }}>
                <p style={{ fontSize: 13, color: INK55, marginBottom: 12 }}>Cómo nació, se perpetuó o se desintegró esta red a lo largo de los años.</p>
                <Btn onClick={verEvolucion} disabled={cargandoEvol}>{cargandoEvol ? <Loader size={14} className="spin" /> : <Clock size={14} />} Ver evolución</Btn>
              </div>
            ) : (
              <>
                <div style={{ fontSize: 13, color: INK, marginBottom: 10 }}>
                  Nació en <b>{evolucion.hitos.inicio}</b> · pico en <b>{evolucion.hitos.pico}</b> · estado:{' '}
                  <b style={{ color: /declive|desinteg/.test(evolucion.hitos.estado) ? AMBER : DKGRN }}>{evolucion.hitos.estado}</b>
                </div>
                <GraficoEvolucion ev={evolucion} />
                <div style={{ textAlign: 'center', fontSize: 11, color: INK55, marginTop: 6 }}>Barra dorada = año pico. En rojo, los años en que la red concentró todo en una sola entidad.</div>
              </>
            )}
          </Seccion>

          {red.manos_comunes.length > 0 && (
            <Seccion titulo="Manos comunes" icono={<AlertTriangle size={15} />}>
              {red.manos_comunes.map((m, i) => <div key={i} style={{ fontSize: 13, color: INK, padding: '4px 0' }}>• {m.nota}</div>)}
            </Seccion>
          )}

          <Seccion titulo="Dónde se derrama la red" icono={<GitBranch size={15} />}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>Entidad</th><th style={th}>Contratos</th><th style={th}>Valor</th></tr></thead>
              <tbody>
                {red.nodos.entidades.map(e => (
                  <tr key={e.nit_entidad}>
                    <td style={td}>{e.nombre}</td>
                    <td style={td}>{e.contratos}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtCOP(e.valor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Seccion>
        </>
      )}

      {!red && !barriendo && (
        <div style={{ ...card, textAlign: 'center', color: INK55, fontSize: 13 }}>
          Ingresá una cédula de representante o un NIT de contratista y barré su red — o mirá los “Sospechosos” que el grafo ya detecta.
        </div>
      )}
    </>
  )
}

// ── Pantalla: Radar ────────────────────────────────────────────────────────────
// Detecta automáticamente los 7 patrones de corrupción inspirados en el caso
// Fondo Mixto Sierra Nevada: concentración de supervisores, cruzamientos mutuos,
// objetos clonados, actas antes de registro presupuestal, carruseles de empresas,
// rep legal en múltiples empresas y fraccionamiento.

function SeveridadBadge({ s }: { s: 'alto' | 'medio' | 'bajo' }) {
  const bg = s === 'alto' ? RED : s === 'medio' ? AMBER : INK55
  return <span style={{ fontSize: 11, fontWeight: 800, color: WHITE, background: bg, padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap' }}>{s.toUpperCase()}</span>
}

function HallazgoCard({ h, onAuditar, onVerContratista, onLanzarRadar }: {
  h: api.RadarHallazgo
  onAuditar: (id: string) => void
  onVerContratista: (nit: string) => void
  onLanzarRadar: (nit: string) => void
}) {
  const [abierto, setAbierto] = useState(false)
  const borde = h.severidad === 'alto' ? RED : h.severidad === 'medio' ? AMBER : INK12
  const ev = h.evidencia ?? {}
  const nit = String(ev.nit ?? ev.nit_a ?? ev.nit_contratista ?? '')
  const idContrato = String(ev.id_contrato ?? '')

  // ── Renderer especializado según señal ─────────────────────────────────────
  const renderEvidencia = () => {
    // CARRUSEL_CONCENTRACION — tabla de proveedores con % y botones
    if (h.senal === 'CARRUSEL_CONCENTRACION') {
      type Prov = { nit?: string; nombre?: string; contratos?: number; valor?: number; pct?: number }
      const provs = (ev.top_proveedores as Prov[] | undefined) ?? []
      const hhi = typeof ev.hhi === 'number' ? Math.round((ev.hhi as number) * 100) : '—'
      return (
        <div style={{ padding: '8px 14px 12px', background: WHITE, borderTop: `1px solid ${INK06}` }}>
          <div style={{ fontSize: 11, color: INK55, marginBottom: 8 }}>
            HHI {hhi}% · {String(ev.n_proveedores ?? '?')} proveedores · {String(ev.total_contratos ?? '?')} contratos
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${INK12}` }}>
                {['Proveedor', 'NIT', '%', 'Valor', ''].map(c => (
                  <th key={c} style={{ textAlign: 'left', padding: '3px 6px', fontWeight: 700, color: INK55, fontSize: 11 }}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {provs.map((p, i) => (
                <tr key={i} style={{ borderBottom: `1px solid ${INK06}`, background: (p.pct ?? 0) >= 50 ? '#FEF2F2' : WHITE }}>
                  <td style={{ padding: '4px 6px', fontWeight: (p.pct ?? 0) >= 50 ? 700 : 400 }}>{p.nombre ?? '—'}</td>
                  <td style={{ padding: '4px 6px', color: INK55, fontFamily: 'monospace' }}>{p.nit ?? '—'}</td>
                  <td style={{ padding: '4px 6px', fontWeight: 700, color: (p.pct ?? 0) >= 70 ? RED : INK }}>{p.pct ?? '?'}%</td>
                  <td style={{ padding: '4px 6px', color: INK55 }}>{fmtCOP(p.valor)}</td>
                  <td style={{ padding: '4px 6px' }}>
                    {p.nit && (
                      <div style={{ display: 'flex', gap: 4 }}>
                        <Btn small tone='ghost' onClick={() => onLanzarRadar(p.nit!)}>
                          <Radar size={10} /> Radar
                        </Btn>
                        <Btn small tone='ghost' onClick={() => onVerContratista(p.nit!)}>Red</Btn>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }

    // REP_LEGAL_MULTIPLE — tarjeta limpia sin JSON
    if (h.senal === 'REP_LEGAL_MULTIPLE') {
      const repNit = String(ev.nit_entidad ?? '')
      return (
        <div style={{ padding: '8px 14px 12px', background: WHITE, borderTop: `1px solid ${INK06}` }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontSize: 12, marginBottom: 10 }}>
            <div><span style={{ color: INK55 }}>Representante: </span><b>{String(ev.rep_nombre ?? '—')}</b></div>
            <div><span style={{ color: INK55 }}>ID: </span>{String(ev.rep_id ?? '—')}</div>
            <div><span style={{ color: INK55 }}>Entidad: </span><b>{String(ev.nombre_entidad ?? '—')}</b></div>
            <div><span style={{ color: INK55 }}>Empresas distintas: </span><b style={{ color: RED }}>{String(ev.empresas_distintas ?? '—')}</b></div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {repNit && <Btn small tone='ghost' onClick={() => onLanzarRadar(repNit)}>
              <Radar size={10} /> Radar entidad
            </Btn>}
          </div>
        </div>
      )
    }

    // FRACCIONAMIENTO_POSIBLE — nota + stats legibles
    if (h.senal === 'FRACCIONAMIENTO_POSIBLE') {
      return (
        <div style={{ padding: '8px 14px 12px', background: WHITE, borderTop: `1px solid ${INK06}` }}>
          <div style={{ fontSize: 12, color: INK, marginBottom: 8, padding: '6px 10px', background: '#FFFBEB', borderRadius: 6, borderLeft: `3px solid ${AMBER}` }}>
            {String(ev.nota ?? '')}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, fontSize: 11, color: INK55 }}>
            <div><span>Contratos: </span><b>{String(ev.contratos ?? '—')}</b></div>
            <div><span>Promedio: </span><b>{fmtCOP(ev.promedio as number)}</b></div>
            <div><span>Máximo: </span><b>{fmtCOP(ev.maximo as number)}</b></div>
            <div><span>Tipo: </span><b>{String(ev.tipo_contrato ?? '—')}</b></div>
            <div><span>Total: </span><b>{fmtCOP(ev.valor_agregado as number)}</b></div>
            <div><span>Umbral: </span><b>{fmtCOP(ev.umbral as number)}</b></div>
          </div>
        </div>
      )
    }

    // Fallback — JSON crudo para señales no mapeadas
    return (
      <div style={{ padding: '8px 14px 12px', background: WHITE, borderTop: `1px solid ${INK06}` }}>
        <pre style={{ fontSize: 11, color: INK55, whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: '0 0 10px', background: INK06, borderRadius: 6, padding: 8 }}>
          {JSON.stringify(ev, null, 2)}
        </pre>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {nit && nit !== 'undefined' && <Btn small tone='ghost' onClick={() => onVerContratista(nit)}>Ver contratista {nit}</Btn>}
          {idContrato && idContrato !== 'undefined' && <Btn small tone='green' onClick={() => onAuditar(idContrato)}>Auditar contrato</Btn>}
        </div>
      </div>
    )
  }

  return (
    <div style={{ border: `1.5px solid ${borde}`, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px', cursor: 'pointer', background: h.severidad === 'alto' ? '#FEF2F2' : h.severidad === 'medio' ? '#FFFBEB' : WHITE }}
        onClick={() => setAbierto(a => !a)}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 3 }}>
            <SeveridadBadge s={h.severidad} />
            <span style={{ fontSize: 12, fontWeight: 700, color: INK55, background: INK06, padding: '2px 7px', borderRadius: 6 }}>{h.fuente}</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: INK }}>{h.titulo}</span>
          </div>
          <div style={{ fontSize: 12, color: INK55, lineHeight: 1.45 }}>{h.descripcion}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: INK }}>{fmtCOP(h.valor ?? h.valor_total as number)}</span>
          <span style={{ fontSize: 11, color: GOLD }}>{abierto ? '▲ cerrar' : '▼ ver detalle'}</span>
        </div>
      </div>
      {abierto && renderEvidencia()}
    </div>
  )
}

function PantallaRadar({ resultado, cargando, filtros, setFiltros, onActivar, onAuditar, onVerContratista }: {
  resultado: api.RadarResultado | null
  cargando: boolean
  filtros: api.RadarOpts
  setFiltros: (f: api.RadarOpts) => void
  onActivar: (opts: api.RadarOpts) => void
  onAuditar: (id: string) => void
  onVerContratista: (nit: string) => void
}) {
  const altos  = resultado?.hallazgos.filter(h => h.severidad === 'alto')  ?? []
  const medios = resultado?.hallazgos.filter(h => h.severidad === 'medio') ?? []
  const bajos  = resultado?.hallazgos.filter(h => h.severidad === 'bajo')  ?? []

  // Lanzar radar sobre un NIT específico desde dentro de un hallazgo
  const lanzarRadarDesdeHallazgo = (nit: string) => {
    const opts: api.RadarOpts = { nitEntidad: nit }
    setFiltros(opts)
    onActivar(opts)
  }

  return (
    <>
      {/* Formulario de parámetros */}
      <div style={{ ...card }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: INK, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Radar size={16} style={{ color: RED }} /> Radar de patrones de corrupción
        </div>
        <div style={{ fontSize: 12, color: INK55, marginBottom: 12, lineHeight: 1.55 }}>
          <b style={{ color: INK }}>Con entidad:</b> 8 motores (concentración HHI, supervisores, cruzamientos, objetos clonados, actas, carruseles de cáscaras, rep. múltiple, fraccionamiento).
          {' '}<b style={{ color: INK }}>Radar global:</b> barre todo SECOP con 3 motores — carrusel por concentración (HHI), carruseles de cáscaras y rep. legal múltiple. Detecta entidades que rotan contratos entre favoritos sin que se vea desde una sola entidad.
          {' '}Sin PDFs, sin IA — solo datos abiertos.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10, marginBottom: 12 }}>
          <div>
            <label style={lbl}>NIT de entidad (opcional)</label>
            <input style={inp} value={filtros.nitEntidad ?? ''} onChange={e => setFiltros({ ...filtros, nitEntidad: e.target.value || undefined })} placeholder="Ej: 800125697" />
          </div>
          <div>
            <label style={lbl}>Nombre entidad (opcional)</label>
            <input style={inp} value={filtros.entidad ?? ''} onChange={e => setFiltros({ ...filtros, entidad: e.target.value || undefined })} placeholder="Ej: Fondo Mixto..." />
          </div>
          <div>
            <label style={lbl}>Desde</label>
            <input style={inp} type="date" value={filtros.desde ?? ''} onChange={e => setFiltros({ ...filtros, desde: e.target.value || undefined })} />
          </div>
          <div>
            <label style={lbl}>Hasta</label>
            <input style={inp} type="date" value={filtros.hasta ?? ''} onChange={e => setFiltros({ ...filtros, hasta: e.target.value || undefined })} />
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Btn tone='green' onClick={() => onActivar(filtros)} disabled={cargando}>
            {cargando ? <><Loader size={14} className="spin" /> Analizando…</> : <><Radar size={14} /> Activar radar{(filtros.nitEntidad || filtros.entidad) ? ' (entidad)' : ''}</>}
          </Btn>
          <Btn tone='ghost' onClick={() => { setFiltros({}); onActivar({}) }} disabled={cargando} title="Barre todo SECOP buscando carruseles y rep. legal múltiple (sin filtro de entidad)">
            <Radar size={14} /> Radar global SECOP
          </Btn>
        </div>
        {cargando && <span style={{ fontSize: 12, color: INK55, marginTop: 6, display: 'block' }}>Puede tardar hasta 3 min (descarga ~2.000 contratos de SECOP)</span>}
      </div>

      {/* Resultados */}
      {resultado && (
        <>
          {/* Resumen de conteo */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {[
              { label: 'Total hallazgos', val: resultado.n_hallazgos, color: INK },
              { label: 'Alto', val: resultado.alto, color: RED },
              { label: 'Medio', val: resultado.medio, color: AMBER },
              { label: 'Bajo', val: bajos.length, color: INK55 },
            ].map(({ label, val, color }) => (
              <div key={label} style={{ ...card, flex: 1, minWidth: 100, textAlign: 'center' }}>
                <div style={{ fontSize: 26, fontWeight: 900, color }}>{val}</div>
                <div style={{ fontSize: 11, color: INK55, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
              </div>
            ))}
          </div>

          {/* Errores de motores (si los hay) */}
          {resultado.errores.length > 0 && (
            <div style={{ ...card, borderColor: AMBER, background: '#FFFBEB' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: AMBER, marginBottom: 6 }}>Motores con errores ({resultado.errores.length})</div>
              {resultado.errores.map((e, i) => (
                <div key={i} style={{ fontSize: 12, color: INK55 }}>· <b>{e.fuente}:</b> {e.error}</div>
              ))}
            </div>
          )}

          {/* Hallazgos por severidad */}
          {[
            { list: altos,  label: `Riesgo ALTO — ${altos.length} hallazgo${altos.length > 1 ? 's' : ''}`,  color: RED },
            { list: medios, label: `Riesgo MEDIO — ${medios.length} hallazgo${medios.length > 1 ? 's' : ''}`, color: AMBER },
            { list: bajos,  label: `Bajo — ${bajos.length} hallazgo${bajos.length > 1 ? 's' : ''}`,           color: INK55 },
          ].filter(g => g.list.length > 0).map(({ list, label, color }) => (
            <div key={label} style={{ ...card, padding: 0, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: `1px solid ${INK12}`, background: INK06 }}>
                <b style={{ fontSize: 13, color }}>{label}</b>
              </div>
              <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {list.map((h, i) => <HallazgoCard key={i} h={h} onAuditar={onAuditar} onVerContratista={onVerContratista} onLanzarRadar={lanzarRadarDesdeHallazgo} />)}
              </div>
            </div>
          ))}
          {resultado.n_hallazgos === 0 && (
            <div style={{ ...card, textAlign: 'center', color: INK55, fontSize: 13 }}>
              El radar no encontró patrones sospechosos con los filtros actuales.
            </div>
          )}
        </>
      )}

      {!resultado && !cargando && (
        <div style={{ ...card, textAlign: 'center', color: INK55, fontSize: 13 }}>
          <div style={{ marginBottom: 8, fontSize: 22 }}>📡</div>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>El radar detecta 7 patrones automáticamente</div>
          <div style={{ fontSize: 12, lineHeight: 1.6 }}>
            Concentración de supervisores · Cruzamiento de pagos · Objetos clonados ·
            Actas antes de registro · Carruseles · Rep. legal múltiple · Fraccionamiento
          </div>
        </div>
      )}
    </>
  )
}
