/**
 * GRAFO RADIAL de una red de contratación (barrido por sujeto vigilado).
 *
 * SVG puro, sin librerías. Layout de tres anillos:
 *   centro  → representante(s) legal(es)  (la mano)
 *   anillo1 → empresas (contratistas)     (los NITs que esa mano mueve)
 *   anillo2 → entidades                   (dónde se derrama la red)
 *
 * Aristas: representa (rep→empresa, tenue) · adjudica (empresa→entidad, grosor
 * por monto). Click en una empresa la vuelve la nueva semilla (expandir).
 */
import { useState } from 'react'
import type { RedBarrido, EvolucionRed, VerificacionRepLegal } from './veedorApi.js'
import * as api from './veedorApi.js'

const INK = '#0B1F1A', INK55 = 'rgba(11,31,26,0.55)', INK12 = 'rgba(11,31,26,0.12)'
const REP = '#DC2626', EMP = '#2563EB', ENT = '#1D9E75', LINE = 'rgba(11,31,26,0.14)', GOLD = '#C6A15B'

const corto = (s: string, n = 18) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const fmtCOP = (n: number) => new Intl.NumberFormat('es-CO', { notation: 'compact', style: 'currency', currency: 'COP', maximumFractionDigits: 1 }).format(n)
const fmtCOPfull = (n: number) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n)

type SelNode = { tipo: string; color: string; nombre: string; idLabel: string; id: string; valor?: number; detalle: string; expandNit?: string }

export function GrafoRadial({ red, onExpandir }: { red: RedBarrido; onExpandir?: (nit: string) => void }) {
  const [sel, setSel] = useState<SelNode | null>(null)
  const [verif, setVerif] = useState<{ loading: boolean; result: VerificacionRepLegal | null; error: string | null }>({ loading: false, result: null, error: null })

  function seleccionar(nodo: SelNode) {
    setSel(nodo)
    setVerif({ loading: false, result: null, error: null })
  }

  async function verificarEnSecop(cedula: string) {
    setVerif({ loading: true, result: null, error: null })
    try {
      const r = await api.verificarRepLegal(cedula)
      setVerif({ loading: false, result: r, error: null })
    } catch (e) {
      setVerif({ loading: false, result: null, error: (e as Error).message ?? 'Error al consultar SECOP' })
    }
  }
  const W = 760, H = 600, cx = W / 2, cy = H / 2, R1 = 158, R2 = 252
  const empresas = red.nodos.contratistas
  const entidades = red.nodos.entidades
  const reps = red.nodos.representantes

  if (!empresas.length && !reps.length) {
    return <div style={{ textAlign: 'center', color: INK55, fontSize: 13, padding: 24 }}>La red no arrojó nodos.</div>
  }

  // Posiciones.
  const posRep = new Map<string, { x: number; y: number }>()
  const posEmp = new Map<string, { x: number; y: number }>()
  const posEnt = new Map<string, { x: number; y: number }>()

  reps.forEach((r, i) => {
    if (reps.length === 1) posRep.set(r.rep_id, { x: cx, y: cy })
    else { const a = (i / reps.length) * 2 * Math.PI - Math.PI / 2; posRep.set(r.rep_id, { x: cx + 46 * Math.cos(a), y: cy + 46 * Math.sin(a) }) }
  })
  empresas.forEach((c, i) => {
    const a = (i / Math.max(1, empresas.length)) * 2 * Math.PI - Math.PI / 2
    posEmp.set(c.nit, { x: cx + R1 * Math.cos(a), y: cy + R1 * Math.sin(a) })
  })
  entidades.forEach((e, i) => {
    const a = (i / Math.max(1, entidades.length)) * 2 * Math.PI - Math.PI / 2
    posEnt.set(e.nit_entidad, { x: cx + R2 * Math.cos(a), y: cy + R2 * Math.sin(a) })
  })

  // Escalas por monto.
  const maxEmp = Math.max(1, ...empresas.map(e => e.valor))
  const maxEnt = Math.max(1, ...entidades.map(e => e.valor))
  const maxAdj = Math.max(1, ...red.aristas.filter(a => a.tipo === 'adjudica').map(a => a.valor ?? 0))
  const rEmp = (v: number) => 7 + 13 * Math.sqrt(v / maxEmp)
  const rEnt = (v: number) => 15 + 19 * Math.sqrt(v / maxEnt)
  const wAdj = (v: number) => 0.8 + 5 * Math.sqrt(v / maxAdj)
  const selId = sel?.id

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', minWidth: 520, maxWidth: W, display: 'block', margin: '0 auto' }}>
        {/* Aristas primero (debajo de los nodos) */}
        {red.aristas.map((a, i) => {
          if (a.tipo === 'representa') {
            const p = posRep.get(a.from), q = posEmp.get(a.to)
            if (!p || !q) return null
            return <line key={`r${i}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke={LINE} strokeWidth={1} />
          }
          const p = posEmp.get(a.from), q = posEnt.get(a.to)
          if (!p || !q) return null
          return <line key={`a${i}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke={ENT} strokeOpacity={0.35} strokeWidth={wAdj(a.valor ?? 0)} />
        })}

        {/* Entidades (anillo exterior) — clic = detalle */}
        {entidades.map(e => {
          const p = posEnt.get(e.nit_entidad)!; const r = rEnt(e.valor); const on = selId === e.nit_entidad
          return (
            <g key={e.nit_entidad} style={{ cursor: 'pointer' }} onClick={() => seleccionar({ tipo: 'Entidad contratante', color: ENT, nombre: e.nombre, idLabel: 'NIT', id: e.nit_entidad, valor: e.valor, detalle: `${e.contratos} contratos recibidos de esta red` })}>
              <circle cx={p.x} cy={p.y} r={r} fill={ENT} fillOpacity={0.9} stroke={on ? GOLD : '#fff'} strokeWidth={on ? 4 : 2}>
                <title>{e.nombre} — {e.contratos} contratos · {fmtCOP(e.valor)}</title>
              </circle>
              <text x={p.x} y={p.y - r - 4} textAnchor="middle" fontSize={10} fontWeight={700} fill={INK}>{corto(e.nombre, 22)}</text>
            </g>
          )
        })}

        {/* Empresas (anillo intermedio) — clic = detalle (con botón expandir) */}
        {empresas.map(c => {
          const p = posEmp.get(c.nit)!; const r = rEmp(c.valor); const on = selId === c.nit
          return (
            <g key={c.nit} style={{ cursor: 'pointer' }} onClick={() => seleccionar({ tipo: 'Empresa', color: EMP, nombre: c.nombre, idLabel: 'NIT', id: c.nit, valor: c.valor, detalle: `${c.contratos} contrato(s) en esta red`, expandNit: c.nit })}>
              <circle cx={p.x} cy={p.y} r={r} fill={EMP} fillOpacity={0.85} stroke={on ? GOLD : '#fff'} strokeWidth={on ? 4 : 1.5}>
                <title>{c.nombre} (NIT {c.nit}) · {fmtCOP(c.valor)}</title>
              </circle>
              <text x={p.x} y={p.y + r + 11} textAnchor="middle" fontSize={9} fill={INK55}>{corto(c.nombre, 16)}</text>
            </g>
          )
        })}

        {/* Representantes (centro) — clic = detalle */}
        {reps.map(r => {
          const p = posRep.get(r.rep_id)!; const on = selId === r.rep_id
          return (
            <g key={r.rep_id} style={{ cursor: 'pointer' }} onClick={() => seleccionar({ tipo: 'Representante legal (la mano)', color: REP, nombre: r.nombre, idLabel: 'Cédula', id: r.rep_id, detalle: `${r.num_empresas} empresas repartidas en ${r.num_entidades} entidad(es)` })}>
              <circle cx={p.x} cy={p.y} r={26} fill={REP} stroke={on ? GOLD : '#fff'} strokeWidth={on ? 5 : 3}>
                <title>{r.nombre} — {r.num_empresas} empresas en {r.num_entidades} entidades</title>
              </circle>
              <text x={p.x} y={p.y + 42} textAnchor="middle" fontSize={11} fontWeight={800} fill={INK}>{corto(r.nombre, 22)}</text>
            </g>
          )
        })}
      </svg>

      {/* Panel de detalle del nodo tocado */}
      {sel ? (
        <div style={{ border: `1px solid ${INK12}`, borderLeft: `4px solid ${sel.color}`, borderRadius: 10, padding: '12px 14px', margin: '8px auto 0', maxWidth: 560, background: '#fff' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: sel.color, textTransform: 'uppercase' }}>{sel.tipo}</span>
            <span style={{ marginLeft: 'auto', fontSize: 11, color: INK55, cursor: 'pointer' }} onClick={() => { setSel(null); setVerif({ loading: false, result: null, error: null }) }}>✕</span>
          </div>
          <div style={{ fontSize: 15, fontWeight: 800, color: INK, margin: '2px 0' }}>{sel.nombre}</div>
          <div style={{ fontSize: 12, color: INK55 }}>{sel.idLabel}: {sel.id}{sel.valor != null ? ` · ${fmtCOPfull(sel.valor)}` : ''}</div>
          <div style={{ fontSize: 13, color: INK, marginTop: 4 }}>{sel.detalle}</div>
          {sel.expandNit && onExpandir && (
            <button onClick={() => onExpandir(sel.expandNit!)} style={{ marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', fontSize: 12, fontWeight: 600, color: '#fff', background: ENT, border: 'none', borderRadius: 8, cursor: 'pointer' }}>Expandir la red desde esta empresa</button>
          )}
          {/* Verificación SECOP — solo para representantes legales */}
          {sel.tipo.startsWith('Representante') && (
            <div style={{ marginTop: 10 }}>
              {!verif.result && !verif.loading && !verif.error && (
                <button
                  onClick={() => verificarEnSecop(sel.id)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', fontSize: 12, fontWeight: 600, color: '#fff', background: REP, border: 'none', borderRadius: 8, cursor: 'pointer' }}
                >
                  Verificar en SECOP
                </button>
              )}
              {verif.loading && (
                <div style={{ fontSize: 12, color: INK55, fontStyle: 'italic' }}>Consultando SECOP II…</div>
              )}
              {verif.error && (
                <div style={{ fontSize: 12, color: REP }}>Error: {verif.error}</div>
              )}
              {verif.result && (() => {
                const v = verif.result
                const badgeColor = v.veredicto === 'confirmado' ? '#16a34a' : v.veredicto === 'posible_error_datos' ? '#d97706' : INK55
                const badgeLabel = v.veredicto === 'confirmado' ? `✓ Confirmado — ${v.empresas.length} empresas en SECOP` : v.veredicto === 'posible_error_datos' ? '⚠ Solo 1 empresa registrada — posible error de datos' : 'Sin datos en SECOP'
                return (
                  <div style={{ background: '#f8fafc', border: `1px solid ${INK12}`, borderRadius: 8, padding: '10px 12px' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: badgeColor, marginBottom: 4 }}>{badgeLabel}</div>
                    <div style={{ fontSize: 11, color: INK55, marginBottom: v.empresas.length ? 6 : 0 }}>{v.nota}</div>
                    {v.empresas.length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                        {v.empresas.slice(0, 8).map(e => (
                          <div key={e.nit} style={{ fontSize: 11, color: INK, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                            <span style={{ fontWeight: 600 }}>{e.nombre}</span>
                            <span style={{ color: INK55, whiteSpace: 'nowrap' }}>{e.num_contratos} contratos · {fmtCOP(e.valor_total)}</span>
                          </div>
                        ))}
                        {v.empresas.length > 8 && <div style={{ fontSize: 11, color: INK55 }}>…y {v.empresas.length - 8} más</div>}
                      </div>
                    )}
                    <div style={{ fontSize: 10, color: INK55, marginTop: 6 }}>Fuente: {v.fuente ?? 'SECOP II datos.gov.co'}</div>
                  </div>
                )
              })()}
            </div>
          )}
        </div>
      ) : (
        <div style={{ textAlign: 'center', fontSize: 12, color: INK55, marginTop: 6 }}>Tocá cualquier nodo para ver su detalle completo.</div>
      )}

      {/* Leyenda */}
      <div style={{ display: 'flex', gap: 16, justifyContent: 'center', fontSize: 11, color: INK55, marginTop: 8 }}>
        <span><span style={{ color: REP }}>●</span> representante</span>
        <span><span style={{ color: EMP }}>●</span> empresa</span>
        <span><span style={{ color: ENT }}>●</span> entidad</span>
        <span>tamaño y grosor = monto</span>
      </div>
    </div>
  )
}

// ── GRÁFICO DE EVOLUCIÓN TEMPORAL — la vida del carrusel por año ───────────────
// Barras de valor por año (el pico en dorado). Bajo cada barra, empresas y
// entidades: cuando las entidades bajan a 1, la red capturó a un solo cliente.
export function GraficoEvolucion({ ev }: { ev: EvolucionRed }) {
  const serie = ev.serie
  if (!serie.length) return <div style={{ textAlign: 'center', color: INK55, fontSize: 13, padding: 16 }}>Sin historial de contratos en el período.</div>
  const W = 720, H = 260, padX = 16, padTop = 26, padBot = 46
  const maxV = Math.max(...serie.map(s => s.valor), 1)
  const bw = (W - padX * 2) / serie.length
  const chartH = H - padTop - padBot
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', minWidth: 460, maxWidth: W, display: 'block' }}>
        {serie.map((s, i) => {
          const h = (s.valor / maxV) * chartH
          const x = padX + i * bw
          const y = padTop + chartH - h
          const esPico = s.periodo === ev.hitos.pico
          return (
            <g key={s.periodo}>
              <rect x={x + 8} y={y} width={bw - 16} height={Math.max(1, h)} fill={esPico ? GOLD : ENT} fillOpacity={0.9} rx={3}>
                <title>{s.periodo}: {s.empresas} empresas ({s.empresas_nuevas} nuevas) · {s.entidades} entidades · {s.contratos} contratos · {fmtCOP(s.valor)}</title>
              </rect>
              <text x={x + bw / 2} y={y - 5} textAnchor="middle" fontSize={10} fontWeight={700} fill={INK}>{fmtCOP(s.valor)}</text>
              <text x={x + bw / 2} y={H - padBot + 17} textAnchor="middle" fontSize={12} fontWeight={800} fill={INK}>{s.periodo}</text>
              <text x={x + bw / 2} y={H - padBot + 31} textAnchor="middle" fontSize={9} fill={s.entidades === 1 ? REP : INK55} fontWeight={s.entidades === 1 ? 700 : 400}>{s.empresas} emp · {s.entidades} ent</text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
