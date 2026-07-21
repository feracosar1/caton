// @ts-nocheck
/**
 * VeedorCronograma — panel de cronograma de un proceso SECOP.
 *
 * Muestra los hitos del cronograma con indicadores de urgencia y
 * permite extraerlo del texto de los pliegos.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  Calendar, Clock, CheckCircle2, XCircle, AlertTriangle,
  RefreshCw, FileText, ChevronDown, ChevronRight, Loader2,
} from 'lucide-react'
import {
  type CronogramaHito, type EstadoHito, type TipoHito, HITO_LABELS,
  extraerCronograma, obtenerCronograma, actualizarHito,
} from './veedorApi'

interface Props {
  idProceso:    string
  procesoDatos?: Record<string, unknown>
  orgId?:        string
  emailAlerta?:  string
  /** Texto ya extraído de los pliegos (si disponible desde el expediente) */
  textoPliegos?: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function diasHasta(fechaIso: string): number {
  const diff = new Date(fechaIso).getTime() - Date.now()
  return Math.ceil(diff / (1000 * 60 * 60 * 24))
}

function urgenciaBadge(hito: CronogramaHito): { color: string; texto: string } | null {
  if (hito.estado !== 'pendiente') return null
  const dias = diasHasta(hito.fecha_limite)
  if (dias < 0)  return { color: 'bg-red-100 text-red-700 border-red-200',    texto: 'Vencido' }
  if (dias === 0) return { color: 'bg-red-100 text-red-700 border-red-200',   texto: '¡Hoy!' }
  if (dias === 1) return { color: 'bg-orange-100 text-orange-700 border-orange-200', texto: 'Mañana' }
  if (dias <= 3)  return { color: 'bg-amber-100 text-amber-700 border-amber-200',    texto: `${dias} días` }
  if (dias <= 7)  return { color: 'bg-yellow-100 text-yellow-700 border-yellow-200', texto: `${dias} días` }
  return null
}

function estadoIcon(estado: EstadoHito) {
  if (estado === 'cumplido')   return <CheckCircle2 className="w-5 h-5 text-green-500" />
  if (estado === 'vencido')    return <XCircle      className="w-5 h-5 text-red-500" />
  if (estado === 'pospuesto')  return <AlertTriangle className="w-5 h-5 text-amber-500" />
  return <Clock className="w-5 h-5 text-[#0F3D2E]" />
}

function formatFecha(iso: string): string {
  return new Date(iso).toLocaleString('es-CO', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota',
  })
}

const TIPO_ORDER: TipoHito[] = [
  'audiencia_aclaracion', 'visita_tecnica', 'subsanacion', 'entrega_oferta',
  'audiencia_apertura', 'evaluacion_publicacion', 'traslado_informe',
  'adjudicacion', 'firma_contrato', 'inicio_ejecucion',
  'entrega_producto', 'liquidacion', 'otro',
]

// ── Componente de hito individual ─────────────────────────────────────────────

function HitoRow({
  hito,
  onCumplido,
}: {
  hito:       CronogramaHito
  onCumplido: (id: string, estado: EstadoHito) => void
}) {
  const [expanded,  setExpanded]  = useState(false)
  const [guardando, setGuardando] = useState(false)

  const badge    = urgenciaBadge(hito)
  const diasFalt = diasHasta(hito.fecha_limite)
  const tieneDetalle = !!(hito.documento_requerido || hito.notas_adicionales)

  async function toggleEstado() {
    const nuevoEstado: EstadoHito = hito.estado === 'cumplido' ? 'pendiente' : 'cumplido'
    setGuardando(true)
    try {
      await actualizarHito(hito.id, nuevoEstado)
      onCumplido(hito.id, nuevoEstado)
    } catch { /* silencioso */ } finally {
      setGuardando(false)
    }
  }

  return (
    <div className={`border rounded-lg overflow-hidden transition-all ${
      hito.estado === 'cumplido' ? 'opacity-60 border-gray-200' :
      hito.estado === 'vencido'  ? 'border-red-200 bg-red-50/30' :
      diasFalt <= 1              ? 'border-red-300 bg-red-50/50' :
      diasFalt <= 3              ? 'border-amber-200 bg-amber-50/30' :
      'border-gray-200'
    }`}>
      {/* Fila principal */}
      <div className="flex items-start gap-3 p-3">
        {/* Icono de estado */}
        <div className="mt-0.5 flex-shrink-0">
          {estadoIcon(hito.estado)}
        </div>

        {/* Contenido */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div>
              <span className="text-xs font-semibold text-[#5A6472] uppercase tracking-wide">
                {HITO_LABELS[hito.tipo_hito] ?? hito.tipo_hito}
              </span>
              <p className={`text-sm font-medium mt-0.5 ${hito.estado === 'cumplido' ? 'line-through text-gray-400' : 'text-[#0B0B0B]'}`}>
                {hito.descripcion}
              </p>
            </div>
            {badge && (
              <span className={`text-xs font-bold px-2 py-0.5 rounded border flex-shrink-0 ${badge.color}`}>
                {badge.texto}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 mt-1.5">
            <Calendar className="w-3.5 h-3.5 text-[#5A6472]" />
            <span className="text-xs text-[#5A6472]">{formatFecha(hito.fecha_limite)}</span>
          </div>
        </div>

        {/* Acciones */}
        <div className="flex items-center gap-1 flex-shrink-0">
          {tieneDetalle && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="p-1 text-gray-400 hover:text-gray-600 rounded"
            >
              {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </button>
          )}
          <button
            onClick={toggleEstado}
            disabled={guardando}
            title={hito.estado === 'cumplido' ? 'Marcar pendiente' : 'Marcar cumplido'}
            className={`p-1 rounded transition-colors ${
              hito.estado === 'cumplido'
                ? 'text-green-500 hover:text-gray-400'
                : 'text-gray-300 hover:text-green-500'
            }`}
          >
            {guardando ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Detalle expandible */}
      {expanded && tieneDetalle && (
        <div className="border-t border-gray-100 px-4 py-3 bg-gray-50/50 space-y-2">
          {hito.documento_requerido && (
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <FileText className="w-3.5 h-3.5 text-amber-600" />
                <span className="text-xs font-semibold text-amber-700 uppercase tracking-wide">Documento a presentar</span>
              </div>
              <p className="text-sm text-gray-700">{hito.documento_requerido}</p>
            </div>
          )}
          {hito.notas_adicionales && (
            <p className="text-xs text-gray-500 italic">{hito.notas_adicionales}</p>
          )}
        </div>
      )}
    </div>
  )
}

// ── Componente principal ──────────────────────────────────────────────────────

export function VeedorCronograma({ idProceso, procesoDatos, orgId, emailAlerta, textoPliegos }: Props) {
  const [hitos,      setHitos]      = useState<CronogramaHito[]>([])
  const [cargando,   setCargando]   = useState(false)
  const [extrayendo, setExtrayendo] = useState(false)
  const [error,      setError]      = useState<string | null>(null)

  // Cargar cronograma guardado
  const cargar = useCallback(async () => {
    setCargando(true)
    setError(null)
    try {
      const data = await obtenerCronograma(idProceso)
      setHitos(data)
    } catch {
      // Sin cronograma aún — OK, mostrar CTA de extracción
      setHitos([])
    } finally {
      setCargando(false)
    }
  }, [idProceso])

  useEffect(() => { cargar() }, [cargar])

  // Extraer cronograma con LLM
  async function handleExtraer() {
    setExtrayendo(true)
    setError(null)
    try {
      const res = await extraerCronograma(idProceso, {
        proceso_data:    procesoDatos,
        documentos_texto: textoPliegos,
        org_id:           orgId,
        email_alerta:     emailAlerta,
      })
      setHitos(res.hitos ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al extraer el cronograma')
    } finally {
      setExtrayendo(false)
    }
  }

  function onHitoActualizado(id: string, estado: EstadoHito) {
    setHitos(prev => prev.map(h => h.id === id ? { ...h, estado } : h))
  }

  // Agrupar por estado para mostrar pendientes primero
  const pendientes = hitos.filter(h => h.estado === 'pendiente')
    .sort((a, b) => new Date(a.fecha_limite).getTime() - new Date(b.fecha_limite).getTime())
  const completados = hitos.filter(h => h.estado !== 'pendiente')
    .sort((a, b) => new Date(a.fecha_limite).getTime() - new Date(b.fecha_limite).getTime())

  // Próximo hito urgente
  const proximo = pendientes[0]
  const proximoDias = proximo ? diasHasta(proximo.fecha_limite) : null

  if (cargando) {
    return (
      <div className="flex items-center gap-2 py-8 justify-center text-[#5A6472]">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span className="text-sm">Cargando cronograma…</span>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Calendar className="w-5 h-5 text-[#0F3D2E]" />
          <h3 className="text-sm font-bold text-[#0B0B0B] uppercase tracking-wide">Cronograma del proceso</h3>
          {hitos.length > 0 && (
            <span className="text-xs bg-[#E4EDE9] text-[#0F3D2E] px-2 py-0.5 rounded font-medium">
              {pendientes.length} pendientes
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {hitos.length > 0 && (
            <button
              onClick={cargar}
              className="p-1.5 text-gray-400 hover:text-gray-600 rounded"
              title="Actualizar"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={handleExtraer}
            disabled={extrayendo}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-[#0F3D2E] text-white rounded hover:bg-[#123F35] disabled:opacity-60 transition-colors"
          >
            {extrayendo ? (
              <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Extrayendo…</>
            ) : (
              <><RefreshCw className="w-3.5 h-3.5" /> {hitos.length > 0 ? 'Re-extraer' : 'Extraer cronograma'}</>
            )}
          </button>
        </div>
      </div>

      {/* Alerta próximo hito urgente */}
      {proximo && proximoDias !== null && proximoDias <= 3 && (
        <div className={`rounded-lg p-3 border flex items-start gap-3 ${
          proximoDias <= 0 ? 'bg-red-50 border-red-200' :
          proximoDias <= 1 ? 'bg-orange-50 border-orange-200' :
          'bg-amber-50 border-amber-200'
        }`}>
          <AlertTriangle className={`w-4 h-4 flex-shrink-0 mt-0.5 ${
            proximoDias <= 1 ? 'text-red-600' : 'text-amber-600'
          }`} />
          <div>
            <p className="text-sm font-semibold text-gray-900">
              {proximoDias <= 0 ? '¡Hito vencido hoy!' :
               proximoDias === 1 ? '¡Hito mañana!' :
               `Hito en ${proximoDias} días`}
            </p>
            <p className="text-xs text-gray-600 mt-0.5">
              {HITO_LABELS[proximo.tipo_hito]}: {proximo.descripcion}
              {' · '}{formatFecha(proximo.fecha_limite)}
            </p>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Sin cronograma */}
      {hitos.length === 0 && !extrayendo && (
        <div className="text-center py-10 border-2 border-dashed border-gray-200 rounded-lg">
          <Calendar className="w-8 h-8 text-gray-300 mx-auto mb-2" />
          <p className="text-sm text-gray-500">Sin cronograma extraído</p>
          <p className="text-xs text-gray-400 mt-1">
            Extrae el cronograma automáticamente desde los documentos del proceso
          </p>
          <button
            onClick={handleExtraer}
            disabled={extrayendo}
            className="mt-3 px-4 py-2 text-sm font-semibold bg-[#0F3D2E] text-white rounded hover:bg-[#123F35] transition-colors"
          >
            Extraer cronograma
          </button>
        </div>
      )}

      {/* Lista de hitos pendientes */}
      {pendientes.length > 0 && (
        <div className="space-y-2">
          {pendientes.map(h => (
            <HitoRow key={h.id} hito={h} onCumplido={onHitoActualizado} />
          ))}
        </div>
      )}

      {/* Hitos completados/vencidos (colapsados) */}
      {completados.length > 0 && (
        <details className="group">
          <summary className="text-xs text-gray-400 cursor-pointer hover:text-gray-600 flex items-center gap-1 list-none select-none">
            <ChevronRight className="w-3.5 h-3.5 group-open:rotate-90 transition-transform" />
            {completados.length} hito{completados.length > 1 ? 's' : ''} completado{completados.length > 1 ? 's' : ''}/vencido{completados.length > 1 ? 's' : ''}
          </summary>
          <div className="space-y-2 mt-2">
            {completados.map(h => (
              <HitoRow key={h.id} hito={h} onCumplido={onHitoActualizado} />
            ))}
          </div>
        </details>
      )}

      {/* Info de alertas */}
      {hitos.length > 0 && (
        <p className="text-xs text-gray-400 text-center pt-1">
          Alertas automáticas por email: 7 días · 3 días · 1 día · el día del hito
        </p>
      )}
    </div>
  )
}
