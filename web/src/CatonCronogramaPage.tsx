/**
 * CatonCronogramaPage.tsx
 *
 * Vista de cronograma del proceso precontractual SECOP.
 * Muestra la línea de tiempo oficial de cada expediente (publicación → observaciones
 * → cierre → adjudicación → firma → ejecución) con las actuaciones del veedor
 * (derechos de petición, tutelas) superpuestas.
 *
 * Flujo:
 *  1. Carga expedientes + hitos de la org (cronograma-org)
 *  2. Por expediente: muestra la línea de tiempo horizontal con las fases SECOP
 *  3. Botón "Importar fechas SECOP" en cada expediente sin cronograma
 *  4. Actuaciones del veedor se muestran como badges sobre la línea de tiempo
 */
import { useState, useEffect, useCallback } from 'react'
import {
  Calendar, Clock, AlertTriangle, CheckCircle2, RefreshCw,
  Loader2, FileText, ChevronDown, ChevronRight, Zap,
} from 'lucide-react'
import type { CatonUser } from './useCatonAuth.js'
import { veedorFetch } from './veedorApi.js'

// ── Paleta ────────────────────────────────────────────────────────────────────
const DKGRN  = '#0F3D2E'
const CREAM  = '#F5F3EF'
const GOLD   = '#C6A15B'
const WHITE  = '#FFFFFF'
const INK06  = 'rgba(10,46,34,0.06)'
const INK12  = 'rgba(10,46,34,0.12)'
const INK35  = 'rgba(10,46,34,0.35)'
const INK55  = 'rgba(10,46,34,0.55)'
const TINTA  = '#0A2E22'
const ROJO   = '#B0392C'
const AMBER  = '#C07000'
const VERDE  = '#1E7F4E'
const AZUL   = '#1D4ED8'

// ── Tipos ─────────────────────────────────────────────────────────────────────

interface Hito {
  id: string
  id_proceso: string
  tipo: string
  nombre: string
  fecha_inicio: string | null
  fecha_fin: string | null
  estado: 'pendiente' | 'en_curso' | 'completado' | 'vencido'
  verificado: boolean
  alerta_activa: boolean
  notas: string | null
}

interface Requerimiento {
  id: string
  expediente_id: string
  tipo: string
  estado: string
  fecha_envio: string | null
  fecha_vencimiento: string | null
  fecha_respuesta: string | null
  dias_restantes: number
  vencido: boolean
}

interface Expediente {
  id: string
  id_contrato: string | null
  id_proceso: string | null
  entidad: string
  estado: string
  created_at: string
  updated_at: string
}

interface CronogramaData {
  expedientes: Expediente[]
  requerimientos: Requerimiento[]
  por_estado: {
    vencidos: number
    proximos_7d: number
    proximos_30d: number
  }
}

interface Props { user: CatonUser }

// ── Orden canónico de fases SECOP ─────────────────────────────────────────────
const FASES_ORDEN = [
  'publicacion_pliego',
  'observaciones_inicio',
  'observaciones_fin',
  'adendas',
  'audiencia',
  'cierre_recepcion_ofertas',
  'evaluacion_inicio',
  'evaluacion_fin',
  'adjudicacion',
  'firma_contrato',
  'inicio_ejecucion',
  'fin_ejecucion',
]

const FASE_LABEL: Record<string, string> = {
  publicacion_pliego:       'Publicación',
  observaciones_inicio:     'Obs. inicio',
  observaciones_fin:        'Obs. fin',
  adendas:                  'Adenda',
  audiencia:                'Audiencia',
  cierre_recepcion_ofertas: 'Cierre ofertas',
  evaluacion_inicio:        'Eval. inicio',
  evaluacion_fin:           'Eval. fin',
  adjudicacion:             'Adjudicación',
  firma_contrato:           'Firma',
  inicio_ejecucion:         'Inicio ejec.',
  fin_ejecucion:            'Fin ejec.',
}

const TIPO_REQ_LABEL: Record<string, string> = {
  derecho_peticion: 'D.P.',
  tutela:           'Tutela',
  recurso:          'Recurso',
  memorial:         'Memorial',
}

const ESTADO_EXP_COLOR: Record<string, string> = {
  seleccionado:        '#6366F1',
  auditado:            GOLD,
  denuncia_borrador:   '#0EA5E9',
  enviada:             VERDE,
  esperando_respuesta: '#F59E0B',
  respuesta_recibida:  '#8B5CF6',
  cerrado:             INK35,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtFecha(iso: string | null) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: '2-digit' })
}

function esPasado(iso: string | null) {
  if (!iso) return false
  return new Date(iso) < new Date()
}

function esFuturoInmediato(iso: string | null, dias = 7) {
  if (!iso) return false
  const d = new Date(iso)
  const ahora = new Date()
  const diff = (d.getTime() - ahora.getTime()) / (1000 * 60 * 60 * 24)
  return diff >= 0 && diff <= dias
}

function hitosOrdenados(hitos: Hito[]): Hito[] {
  return [...hitos].sort((a, b) => {
    const ia = FASES_ORDEN.indexOf(a.tipo)
    const ib = FASES_ORDEN.indexOf(b.tipo)
    if (ia !== -1 && ib !== -1) return ia - ib
    if (ia !== -1) return -1
    if (ib !== -1) return 1
    return (a.fecha_inicio ?? '').localeCompare(b.fecha_inicio ?? '')
  })
}

// ── Componente principal ──────────────────────────────────────────────────────

export function CatonCronogramaPage({ user }: Props) {
  const [data, setData]     = useState<CronogramaData | null>(null)
  const [hitos, setHitos]   = useState<Record<string, Hito[]>>({})  // keyed by id_proceso
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState('')
  const [importando, setImportando] = useState<Record<string, boolean>>({})
  const [expandido, setExpandido]   = useState<Record<string, boolean>>({})

  const load = useCallback(async () => {
    if (!user.orgId) { setLoading(false); return }
    setLoading(true); setError('')
    try {
      const res = await veedorFetch<CronogramaData>(`/veeduria/admin/cronograma-org?org_id=${user.orgId}`)
      setData(res)

      // Cargar hitos para todos los expedientes que tengan id_proceso
      const expConProceso = (res.expedientes ?? []).filter(e => e.id_proceso || e.id_contrato)
      const hitosMap: Record<string, Hito[]> = {}

      await Promise.allSettled(
        expConProceso.map(async (exp) => {
          const idProceso = exp.id_proceso || exp.id_contrato
          if (!idProceso) return
          try {
            const r = await veedorFetch<{ hitos: Hito[] }>(`/veeduria/expediente/cronograma/${encodeURIComponent(idProceso)}`)
            if (r.hitos && r.hitos.length > 0) {
              hitosMap[idProceso] = r.hitos
            }
          } catch { /* no tiene hitos */ }
        })
      )
      setHitos(hitosMap)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error cargando cronograma')
    } finally { setLoading(false) }
  }, [user.orgId])

  useEffect(() => { void load() }, [load])

  const importarSecop = async (exp: Expediente) => {
    const idProceso = exp.id_proceso || exp.id_contrato
    if (!idProceso) return
    setImportando(p => ({ ...p, [exp.id]: true }))
    try {
      const res = await veedorFetch<{ ok: boolean; hitos: Hito[]; mensaje?: string }>(
        `/veeduria/expediente/${exp.id}/importar-secop`,
        'POST',
        { org_id: user.orgId },
      )

      if (res.hitos && res.hitos.length > 0) {
        setHitos(prev => ({ ...prev, [idProceso]: res.hitos }))
        setExpandido(prev => ({ ...prev, [exp.id]: true }))
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Error importando fechas SECOP')
    } finally {
      setImportando(p => ({ ...p, [exp.id]: false }))
    }
  }

  if (loading) {
    return (
      <div style={{ padding: '48px 40px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
        <Loader2 size={24} color={DKGRN} className="animate-spin" />
        <span style={{ fontSize: 13, color: INK55 }}>Cargando cronograma…</span>
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ padding: '32px 40px' }}>
        <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: '14px 18px' }}>
          <p style={{ color: ROJO, fontSize: 13, margin: '0 0 10px' }}>{error}</p>
          <button onClick={load} style={btnStyle}><RefreshCw size={14} /> Reintentar</button>
        </div>
      </div>
    )
  }

  const expedientes = data?.expedientes ?? []
  const requerimientos = data?.requerimientos ?? []

  // Agrupar requerimientos por expediente_id
  const reqPorExp: Record<string, Requerimiento[]> = {}
  for (const r of requerimientos) {
    if (!reqPorExp[r.expediente_id]) reqPorExp[r.expediente_id] = []
    reqPorExp[r.expediente_id].push(r)
  }

  const vencidos = requerimientos.filter(r => r.vencido).length
  const proximos7 = requerimientos.filter(r => !r.vencido && r.dias_restantes <= 7).length

  return (
    <div style={{ padding: '32px 40px', maxWidth: 1100, margin: '0 auto' }}>

      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <Calendar size={18} color={GOLD} />
          <h1 style={{ fontSize: 22, fontWeight: 800, color: TINTA, margin: 0 }}>
            Cronograma de Procesos
          </h1>
          <button onClick={load} style={{ marginLeft: 'auto', ...btnStyle }}>
            <RefreshCw size={14} /> Actualizar
          </button>
        </div>
        <p style={{ fontSize: 13, color: INK55, margin: 0 }}>
          Línea de tiempo oficial SECOP por expediente — publicación, observaciones, audiencia, cierre, adjudicación, firma y ejecución.
        </p>
      </div>

      {/* KPI Strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 28 }}>
        <KpiCard label="Expedientes" value={expedientes.length} icon={<FileText size={16} color={DKGRN} />} color={DKGRN} />
        <KpiCard
          label="Con cronograma SECOP"
          value={expedientes.filter(e => hitos[(e.id_proceso || e.id_contrato) ?? '']?.length > 0).length}
          icon={<Calendar size={16} color={AZUL} />}
          color={AZUL}
        />
        <KpiCard
          label="DPs vencidos"
          value={vencidos}
          icon={<AlertTriangle size={16} color={ROJO} />}
          color={ROJO}
          highlight={vencidos > 0}
        />
        <KpiCard
          label="Plazos próximos 7d"
          value={proximos7}
          icon={<Clock size={16} color={AMBER} />}
          color={AMBER}
          highlight={proximos7 > 0}
        />
      </div>

      {/* Lista de expedientes */}
      {expedientes.length === 0 ? (
        <EmptyState />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {expedientes.map(exp => {
            const idProceso = exp.id_proceso || exp.id_contrato
            const hitosExp = idProceso ? (hitos[idProceso] ?? []) : []
            const reqs = reqPorExp[exp.id] ?? []
            const abierto = expandido[exp.id] ?? hitosExp.length > 0
            const cargandoImport = importando[exp.id]

            return (
              <ExpedienteCard
                key={exp.id}
                exp={exp}
                hitos={hitosExp}
                reqs={reqs}
                abierto={abierto}
                cargandoImport={cargandoImport}
                onToggle={() => setExpandido(p => ({ ...p, [exp.id]: !abierto }))}
                onImportar={() => importarSecop(exp)}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Tarjeta de expediente ─────────────────────────────────────────────────────

interface ExpedienteCardProps {
  exp: Expediente
  hitos: Hito[]
  reqs: Requerimiento[]
  abierto: boolean
  cargandoImport?: boolean
  onToggle: () => void
  onImportar: () => void
}

function ExpedienteCard({ exp, hitos, reqs, abierto, cargandoImport, onToggle, onImportar }: ExpedienteCardProps) {
  const idProceso = exp.id_proceso || exp.id_contrato
  const tieneHitos = hitos.length > 0
  const hitosOrd = hitosOrdenados(hitos)

  // Semáforo de urgencia de DPs
  const reqVencidos = reqs.filter(r => r.vencido)
  const reqUrgentes = reqs.filter(r => !r.vencido && r.dias_restantes <= 7)

  let estadoColor = ESTADO_EXP_COLOR[exp.estado] ?? INK35
  const borderLeft = reqVencidos.length > 0 ? ROJO : reqUrgentes.length > 0 ? AMBER : INK12

  return (
    <div style={{
      background: WHITE,
      border: `1.5px solid ${borderLeft}`,
      borderRadius: 14,
      overflow: 'hidden',
      boxShadow: reqVencidos.length > 0 ? `0 0 0 1px ${ROJO}20` : 'none',
    }}>
      {/* Header del expediente */}
      <div
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '14px 18px',
          cursor: 'pointer',
          borderBottom: abierto ? `1px solid ${INK12}` : 'none',
          background: abierto ? INK06 : WHITE,
        }}
      >
        {abierto ? <ChevronDown size={16} color={INK55} /> : <ChevronRight size={16} color={INK55} />}

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, fontWeight: 800, color: TINTA, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 380 }}>
              {exp.entidad}
            </span>
            <span style={{
              fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 99,
              background: estadoColor + '18', color: estadoColor,
              border: `1px solid ${estadoColor}30`,
            }}>
              {exp.estado.replace(/_/g, ' ')}
            </span>
            {reqVencidos.length > 0 && (
              <span style={{
                fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 99,
                background: '#FEF2F2', color: ROJO, border: `1px solid #FECACA`,
              }}>
                ⚠ {reqVencidos.length} DP vencido{reqVencidos.length > 1 ? 's' : ''}
              </span>
            )}
            {reqUrgentes.length > 0 && reqVencidos.length === 0 && (
              <span style={{
                fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 99,
                background: '#FFF7ED', color: AMBER, border: `1px solid #FED7AA`,
              }}>
                ⏰ {reqUrgentes.length} próximo{reqUrgentes.length > 1 ? 's' : ''}
              </span>
            )}
          </div>
          {idProceso && (
            <span style={{ fontSize: 11, color: INK35, fontFamily: 'monospace' }}>
              {idProceso}
            </span>
          )}
        </div>

        {/* Botón importar SECOP */}
        {!tieneHitos && idProceso && (
          <button
            onClick={e => { e.stopPropagation(); onImportar() }}
            disabled={cargandoImport}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '6px 12px', fontSize: 12, fontWeight: 700,
              borderRadius: 8, border: `1.5px solid ${DKGRN}`,
              background: DKGRN, color: WHITE, cursor: cargandoImport ? 'wait' : 'pointer',
              opacity: cargandoImport ? 0.7 : 1, flexShrink: 0,
            }}
          >
            {cargandoImport
              ? <><Loader2 size={12} className="animate-spin" /> Importando…</>
              : <><Zap size={12} /> Importar SECOP</>
            }
          </button>
        )}

        {tieneHitos && (
          <span style={{ fontSize: 11, color: INK55, flexShrink: 0 }}>
            {hitosOrd.length} fase{hitosOrd.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Contenido expandido */}
      {abierto && (
        <div style={{ padding: '16px 18px' }}>
          {tieneHitos ? (
            <>
              {/* Línea de tiempo SECOP */}
              <TimelineSecop hitos={hitosOrd} />

              {/* Actuaciones del veedor */}
              {reqs.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: INK35, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
                    Actuaciones del Veedor
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {reqs.map(r => <RequerimientoRow key={r.id} req={r} />)}
                  </div>
                </div>
              )}

              {/* Botón re-importar */}
              <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  onClick={onImportar}
                  style={{ ...btnStyle, fontSize: 11, padding: '5px 10px', color: INK35 }}
                >
                  <RefreshCw size={11} /> Reimportar fechas SECOP
                </button>
              </div>
            </>
          ) : (
            <div style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              padding: '24px 16px', textAlign: 'center', gap: 10,
            }}>
              {idProceso ? (
                <>
                  <Calendar size={28} color={DKGRN} style={{ opacity: 0.35 }} />
                  <p style={{ fontSize: 13, color: INK55, margin: 0, maxWidth: 340 }}>
                    Este expediente no tiene un cronograma SECOP importado aún.
                    Haz clic en <strong>Importar SECOP</strong> para traer las fechas oficiales del proceso precontractual.
                  </p>
                  {reqs.length > 0 && (
                    <div style={{ width: '100%', maxWidth: 480, marginTop: 4 }}>
                      <div style={{ fontSize: 11, fontWeight: 800, color: INK35, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6, textAlign: 'left' }}>
                        Actuaciones del Veedor
                      </div>
                      {reqs.map(r => <RequerimientoRow key={r.id} req={r} />)}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <FileText size={28} color={INK35} style={{ opacity: 0.35 }} />
                  <p style={{ fontSize: 13, color: INK55, margin: 0, maxWidth: 340 }}>
                    Este expediente no tiene un ID de proceso SECOP vinculado. Verifica la referencia del contrato para poder importar el cronograma oficial.
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Línea de tiempo SECOP ─────────────────────────────────────────────────────

function TimelineSecop({ hitos }: { hitos: Hito[] }) {
  const ahora = new Date()

  // Encontrar la fase activa (la más reciente que ya pasó, o la próxima)
  const pasados = hitos.filter(h => h.fecha_inicio && new Date(h.fecha_inicio) <= ahora)
  const futuros = hitos.filter(h => h.fecha_inicio && new Date(h.fecha_inicio) > ahora)
  const faseActual = futuros[0] || pasados[pasados.length - 1] || null

  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 800, color: INK35, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
        Cronograma Oficial SECOP
      </div>

      {/* Vista horizontal scrollable */}
      <div style={{ overflowX: 'auto', paddingBottom: 8 }}>
        <div style={{ display: 'flex', gap: 0, minWidth: 'max-content', position: 'relative' }}>
          {/* Línea de fondo */}
          <div style={{
            position: 'absolute',
            top: 20, left: 16,
            right: 16, height: 2,
            background: INK12,
            zIndex: 0,
          }} />

          {hitos.map((hito, idx) => {
            const pasado = esPasado(hito.fecha_inicio)
            const esActual = faseActual?.id === hito.id
            const urgente = esFuturoInmediato(hito.fecha_inicio, 7)

            let dotColor = INK12
            let dotBorder = INK35
            if (pasado) { dotColor = VERDE; dotBorder = VERDE }
            if (urgente) { dotColor = AMBER; dotBorder = AMBER }
            if (esActual) { dotColor = DKGRN; dotBorder = DKGRN }
            if (hito.alerta_activa) { dotColor = ROJO; dotBorder = ROJO }

            return (
              <div key={hito.id} style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                gap: 6, width: 92, position: 'relative', zIndex: 1,
              }}>
                {/* Dot */}
                <div style={{
                  width: 14, height: 14, borderRadius: '50%',
                  background: dotColor,
                  border: `2.5px solid ${dotBorder}`,
                  boxShadow: esActual ? `0 0 0 3px ${DKGRN}25` : 'none',
                  flexShrink: 0,
                }} />

                {/* Label + fecha */}
                <div style={{ textAlign: 'center' }}>
                  <div style={{
                    fontSize: 10, fontWeight: esActual ? 800 : 600,
                    color: esActual ? DKGRN : pasado ? VERDE : INK55,
                    lineHeight: 1.3,
                  }}>
                    {FASE_LABEL[hito.tipo] ?? hito.nombre}
                  </div>
                  <div style={{
                    fontSize: 10, color: hito.alerta_activa ? ROJO : urgente ? AMBER : INK35,
                    fontWeight: (urgente || hito.alerta_activa) ? 700 : 400,
                    marginTop: 2,
                  }}>
                    {fmtFecha(hito.fecha_inicio)}
                  </div>
                  {esActual && (
                    <div style={{
                      fontSize: 9, fontWeight: 800, color: DKGRN,
                      background: DKGRN + '14', borderRadius: 4,
                      padding: '1px 5px', marginTop: 3, display: 'inline-block',
                    }}>
                      ← actual
                    </div>
                  )}
                  {pasado && !esActual && (
                    <div style={{
                      fontSize: 9, color: VERDE, marginTop: 2,
                    }}>
                      ✓
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Fila de requerimiento del veedor ─────────────────────────────────────────

function RequerimientoRow({ req }: { req: Requerimiento }) {
  const urgente = req.vencido
  const proximo = !req.vencido && req.dias_restantes <= 7

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '8px 12px', borderRadius: 8,
      background: urgente ? '#FEF2F2' : proximo ? '#FFF7ED' : INK06,
      border: `1px solid ${urgente ? '#FECACA' : proximo ? '#FED7AA' : INK12}`,
    }}>
      <div style={{
        width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
        background: urgente ? ROJO : proximo ? AMBER : VERDE,
      }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: TINTA }}>
          {TIPO_REQ_LABEL[req.tipo] ?? req.tipo}
        </span>
        {req.fecha_envio && (
          <span style={{ fontSize: 11, color: INK55, marginLeft: 8 }}>
            enviado {fmtFecha(req.fecha_envio)}
          </span>
        )}
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        {req.vencido ? (
          <span style={{ fontSize: 11, fontWeight: 800, color: ROJO }}>
            Vencido hace {Math.abs(req.dias_restantes)}d
          </span>
        ) : req.fecha_vencimiento ? (
          <span style={{ fontSize: 11, fontWeight: 600, color: proximo ? AMBER : INK55 }}>
            Vence {fmtFecha(req.fecha_vencimiento)}
          </span>
        ) : (
          <span style={{ fontSize: 11, color: INK35 }}>
            {req.estado.replace(/_/g, ' ')}
          </span>
        )}
      </div>
    </div>
  )
}

// ── Estado vacío ──────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', padding: '60px 32px', textAlign: 'center',
      background: WHITE, borderRadius: 14, border: `1px solid ${INK12}`,
    }}>
      <div style={{
        width: 64, height: 64, borderRadius: 16,
        background: INK06, display: 'flex', alignItems: 'center', justifyContent: 'center',
        marginBottom: 16,
      }}>
        <Calendar size={28} color={DKGRN} style={{ opacity: 0.5 }} />
      </div>
      <h3 style={{ fontSize: 16, fontWeight: 800, color: TINTA, margin: '0 0 8px' }}>
        Sin expedientes activos
      </h3>
      <p style={{ fontSize: 13, color: INK55, margin: 0, maxWidth: 340, lineHeight: 1.6 }}>
        Cuando tengas expedientes en seguimiento, sus cronogramas oficiales SECOP aparecerán aquí con la línea de tiempo del proceso precontractual.
      </p>
    </div>
  )
}

// ── KPI Card ──────────────────────────────────────────────────────────────────

function KpiCard({ label, value, icon, color, highlight }: {
  label: string; value: number; icon: React.ReactNode; color: string; highlight?: boolean
}) {
  return (
    <div style={{
      background: highlight ? `${color}08` : WHITE,
      border: `1.5px solid ${highlight ? color + '40' : INK12}`,
      borderRadius: 12, padding: '16px 18px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        {icon}
        <span style={{ fontSize: 11, fontWeight: 700, color: INK55, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {label}
        </span>
      </div>
      <div style={{ fontSize: 28, fontWeight: 900, color: highlight ? color : TINTA, lineHeight: 1 }}>
        {value}
      </div>
    </div>
  )
}

// ── Estilos compartidos ───────────────────────────────────────────────────────

const btnStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '7px 14px', fontSize: 13, fontWeight: 600,
  borderRadius: 8, border: `1px solid ${INK12}`,
  background: WHITE, color: TINTA, cursor: 'pointer',
}
