/**
 * MOTOR PRECONTRACTUAL — panel en el detalle del expediente.
 *
 * Lee los hallazgos del análisis precontractual determinista:
 * - Datos del proceso SECOP (p6dx-8zbt): proponente único, adjudicado == base,
 *   plazo corto, directa alto valor, adendas excesivas, etc.
 * - Alertas del pliego PDF (secop_alertas), si ya fue analizado.
 *
 * Costo: $0 en tokens (todo determinista). El humano decide qué hacer con los hallazgos.
 */

import { useEffect, useState } from 'react'
import { AlertTriangle, Info, ChevronDown, ChevronRight, FileSearch, Loader2 } from 'lucide-react'
import { obtenerPrecontractual, type HallazgoPrecontractual, type ResultadoPrecontractual } from './veedorApi.js'

interface Props {
  idProceso: string
  valorContrato?: number
}

const SEV_CONFIG = {
  alta:  { color: '#dc2626', bg: '#fef2f2', border: '#fecaca', icon: <AlertTriangle size={14} /> },
  media: { color: '#d97706', bg: '#fffbeb', border: '#fed7aa', icon: <AlertTriangle size={14} /> },
  baja:  { color: '#2563eb', bg: '#eff6ff', border: '#bfdbfe', icon: <Info size={14} /> },
}

const FUENTE_LABELS: Record<string, string> = {
  datos_proceso: 'Datos del proceso SECOP',
  pliego_pdf:    'Análisis del pliego PDF',
}

function HallazgoCard({ h, open, onToggle }: {
  h: HallazgoPrecontractual
  open: boolean
  onToggle: () => void
}) {
  const cfg = SEV_CONFIG[h.severidad] ?? SEV_CONFIG.baja

  return (
    <div style={{
      border: `1px solid ${cfg.border}`,
      borderRadius: 8,
      background: cfg.bg,
      marginBottom: 8,
      overflow: 'hidden',
    }}>
      <button
        onClick={onToggle}
        style={{
          width: '100%',
          textAlign: 'left',
          padding: '10px 12px',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span style={{ color: cfg.color, flexShrink: 0 }}>{cfg.icon}</span>
        <span style={{
          flex: 1,
          fontSize: 13,
          fontWeight: 600,
          color: '#0B0B0B',
          lineHeight: 1.3,
        }}>
          {h.titulo}
        </span>
        <span style={{
          fontSize: 10,
          fontWeight: 600,
          color: cfg.color,
          background: 'white',
          border: `1px solid ${cfg.border}`,
          borderRadius: 4,
          padding: '2px 6px',
          flexShrink: 0,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}>
          {h.severidad}
        </span>
        <span style={{ color: '#9CA3AF', flexShrink: 0 }}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>

      {open && (
        <div style={{ padding: '0 12px 12px' }}>
          <p style={{ margin: '0 0 10px', fontSize: 13, color: '#374151', lineHeight: 1.6 }}>
            {h.descripcion}
          </p>

          {/* Evidencia numérica */}
          {h.cifras.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
              {h.cifras.map((c, i) => (
                <div key={i} style={{
                  background: 'white',
                  border: `1px solid ${cfg.border}`,
                  borderRadius: 6,
                  padding: '4px 10px',
                  fontSize: 12,
                }}>
                  <span style={{ color: '#6B7280' }}>{c.label}: </span>
                  <span style={{ fontWeight: 700, color: cfg.color }}>{c.valor}</span>
                </div>
              ))}
            </div>
          )}

          {/* Evidencia textual */}
          {h.evidencia && (
            <div style={{
              background: 'white',
              border: `1px solid ${cfg.border}`,
              borderRadius: 6,
              padding: '8px 10px',
              fontSize: 12,
              color: '#4B5563',
              lineHeight: 1.5,
              fontStyle: 'italic',
            }}>
              "{h.evidencia}"
            </div>
          )}

          {/* Fuente */}
          <div style={{ marginTop: 8, fontSize: 11, color: '#9CA3AF' }}>
            Fuente: {FUENTE_LABELS[h.fuente] ?? h.fuente} · Regla: {h.regla_id}
          </div>
        </div>
      )}
    </div>
  )
}

export function MotorPrecontractual({ idProceso, valorContrato }: Props) {
  const [estado, setEstado] = useState<'idle' | 'cargando' | 'ok' | 'error'>('idle')
  const [resultado, setResultado] = useState<ResultadoPrecontractual | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [abiertos, setAbiertos] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!idProceso) return
    setEstado('cargando')
    obtenerPrecontractual(idProceso, valorContrato)
      .then(r => { setResultado(r); setEstado('ok') })
      .catch(e => { setErrorMsg(e.message ?? String(e)); setEstado('error') })
  }, [idProceso, valorContrato])

  const toggle = (id: string) =>
    setAbiertos(prev => {
      const s = new Set(prev)
      s.has(id) ? s.delete(id) : s.add(id)
      return s
    })

  if (estado === 'idle' || estado === 'cargando') {
    return (
      <div style={{ padding: '20px 0', display: 'flex', alignItems: 'center', gap: 8, color: '#9CA3AF', fontSize: 13 }}>
        <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} />
        Analizando fase precontractual…
      </div>
    )
  }

  if (estado === 'error') {
    return (
      <div style={{
        padding: '12px 14px',
        background: '#fef2f2',
        border: '1px solid #fecaca',
        borderRadius: 8,
        fontSize: 13,
        color: '#dc2626',
      }}>
        No se pudo cargar el análisis precontractual: {errorMsg}
      </div>
    )
  }

  if (!resultado) return null

  const { hallazgos, por_severidad, sin_datos, proceso, fuentes } = resultado

  if (sin_datos) {
    return (
      <div style={{
        padding: '14px 16px',
        background: '#F5F3EF',
        border: '1px solid #E4EDE9',
        borderRadius: 8,
        fontSize: 13,
        color: '#5A6472',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        <FileSearch size={15} />
        No se encontró proceso precontractual en SECOP para este contrato.
        Puede ser una contratación directa o un proceso no registrado en el sistema de datos abiertos.
      </div>
    )
  }

  if (hallazgos.length === 0) {
    return (
      <div style={{
        padding: '14px 16px',
        background: '#f0fdf4',
        border: '1px solid #bbf7d0',
        borderRadius: 8,
        fontSize: 13,
        color: '#15803d',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        <FileSearch size={15} />
        Sin hallazgos precontractuales detectados. La fase precontractual no presenta señales de alerta.
      </div>
    )
  }

  const altas  = hallazgos.filter(h => h.severidad === 'alta')
  const medias = hallazgos.filter(h => h.severidad === 'media')
  const bajas  = hallazgos.filter(h => h.severidad === 'baja')

  return (
    <div style={{ fontSize: 13 }}>
      {/* Cabecera con resumen */}
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        marginBottom: 12,
        alignItems: 'center',
      }}>
        {proceso && (
          <span style={{
            fontSize: 11,
            color: '#6B7280',
            background: '#F3F4F6',
            borderRadius: 4,
            padding: '3px 8px',
            fontFamily: 'monospace',
          }}>
            {idProceso}
          </span>
        )}
        {por_severidad.alta > 0 && (
          <span style={{
            fontSize: 11, fontWeight: 700, color: '#dc2626',
            background: '#fef2f2', border: '1px solid #fecaca',
            borderRadius: 4, padding: '3px 8px',
          }}>
            {por_severidad.alta} alta{por_severidad.alta > 1 ? 's' : ''}
          </span>
        )}
        {por_severidad.media > 0 && (
          <span style={{
            fontSize: 11, fontWeight: 700, color: '#d97706',
            background: '#fffbeb', border: '1px solid #fed7aa',
            borderRadius: 4, padding: '3px 8px',
          }}>
            {por_severidad.media} media{por_severidad.media > 1 ? 's' : ''}
          </span>
        )}
        {por_severidad.baja > 0 && (
          <span style={{
            fontSize: 11, fontWeight: 700, color: '#2563eb',
            background: '#eff6ff', border: '1px solid #bfdbfe',
            borderRadius: 4, padding: '3px 8px',
          }}>
            {por_severidad.baja} baja{por_severidad.baja > 1 ? 's' : ''}
          </span>
        )}
        <span style={{ fontSize: 11, color: '#9CA3AF', marginLeft: 'auto' }}>
          {fuentes.map(f => FUENTE_LABELS[f] ?? f).join(' · ')}
        </span>
      </div>

      {/* Hallazgos alta severidad */}
      {altas.length > 0 && (
        <div style={{ marginBottom: 4 }}>
          {altas.map((h, i) => (
            <HallazgoCard
              key={`${h.regla_id}-${i}`}
              h={h}
              open={abiertos.has(`${h.regla_id}-${i}`)}
              onToggle={() => toggle(`${h.regla_id}-${i}`)}
            />
          ))}
        </div>
      )}

      {/* Hallazgos severidad media */}
      {medias.length > 0 && (
        <div style={{ marginBottom: 4 }}>
          {medias.map((h, i) => (
            <HallazgoCard
              key={`${h.regla_id}-${i}`}
              h={h}
              open={abiertos.has(`${h.regla_id}-${i}`)}
              onToggle={() => toggle(`${h.regla_id}-${i}`)}
            />
          ))}
        </div>
      )}

      {/* Hallazgos baja severidad */}
      {bajas.length > 0 && (
        <div>
          {bajas.map((h, i) => (
            <HallazgoCard
              key={`${h.regla_id}-${i}`}
              h={h}
              open={abiertos.has(`${h.regla_id}-${i}`)}
              onToggle={() => toggle(`${h.regla_id}-${i}`)}
            />
          ))}
        </div>
      )}

      {/* Info proceso si está disponible */}
      {proceso && (
        <details style={{ marginTop: 12 }}>
          <summary style={{
            cursor: 'pointer',
            fontSize: 11,
            color: '#9CA3AF',
            userSelect: 'none',
            listStyle: 'none',
          }}>
            Ver datos del proceso SECOP
          </summary>
          <div style={{
            marginTop: 6,
            background: '#F5F3EF',
            borderRadius: 6,
            padding: '8px 10px',
            fontSize: 11,
            color: '#5A6472',
          }}>
            {Object.entries(proceso)
              .filter(([, v]) => v !== null && v !== undefined && v !== '')
              .slice(0, 16)
              .map(([k, v]) => (
                <div key={k} style={{ display: 'flex', gap: 6, marginBottom: 3 }}>
                  <span style={{ fontWeight: 600, minWidth: 160, flexShrink: 0 }}>{k}:</span>
                  <span style={{ wordBreak: 'break-all' }}>{String(v).slice(0, 120)}</span>
                </div>
              ))}
          </div>
        </details>
      )}
    </div>
  )
}
