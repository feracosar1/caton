/**
 * Cliente del veedor-server para el flujo de VEEDURÍA (expedientes).
 *
 * El veedor-server es un Express aparte (VM Azure, auth por VEEDOR_SECRET). El
 * secreto va en el bundle a propósito: el veedor es una herramienta interna de
 * admin, no una superficie pública. Mismo patrón que el resto de VeedorPage.
 *
 * Aquí viven solo las llamadas a /veeduria/* — el flujo nuevo: buscar contratos,
 * tirar del grafo del contratista, auditar (motor), leer el expediente y sus
 * hallazgos, y generar el borrador de denuncia. El humano decide en cada paso;
 * nada se envía solo.
 */

export const VEEDOR_URL = import.meta.env.VITE_VEEDOR_URL ?? '/api/veedor'

// JWT de sesión de NUMA. El componente lo inyecta con setAuthToken(session.accessToken).
// En dev local cae al VITE_VEEDOR_SECRET si no hay sesión (el server lo acepta por túnel);
// en prod ese secret NO existe en el bundle, así que solo vale el JWT del super admin.
let authToken = (import.meta.env.VITE_VEEDOR_SECRET as string | undefined) ?? ''
export const setAuthToken = (t: string) => { authToken = t || ((import.meta.env.VITE_VEEDOR_SECRET as string | undefined) ?? '') }

export async function veedorFetch<T = unknown>(path: string, method = 'GET', body?: object, timeoutMs = 15_000): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new DOMException(`Timeout (${Math.round(timeoutMs / 1000)}s)`, 'AbortError')), timeoutMs)
  try {
    const res = await fetch(`${VEEDOR_URL}${path}`, {
      method,
      headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    })
    const data = await res.json()
    if (!res.ok || data?.ok === false) throw new Error(data?.error ?? `HTTP ${res.status}`)
    return data as T
  } finally {
    clearTimeout(timer)
  }
}

// ── Tipos (espejo de busqueda.mjs / grafo-contratistas.mjs / repo-veeduria.mjs) ──

export interface ContratoBusqueda {
  id_contrato:        string
  referencia:         string | null
  proceso:            string | null
  entidad:            string | null
  nit_entidad:        string | null
  contratista:        string | null
  nit_contratista:    string | null
  representante_legal:string | null
  valor:              number
  fecha_firma:        string | null
  estado:             string | null
  tipo:               string | null
  modalidad:          string | null
  objeto:             string | null
  tipo_doc:           string | null   // 'NIT' (empresa) | 'Cédula de Ciudadanía' (persona natural)
  score:              number          // 0-100, sospecha determinista (score-contrato.mjs)
  nivel:              'alto' | 'medio' | 'bajo'
  razones:            string[]        // qué señales dispararon el score
  _auditar:           string
  _grafo:             string | null
}

export interface Ambito {
  nivel?:           'nacional' | 'departamental' | 'municipal'
  orden?:           'nacional' | 'territorial' | 'ambos'
  departamentos?:   string[]
  municipios?:      string[]
  sectores?:        string[] | null
  objeto?:          string        // filtro temático por objeto del contrato (más confiable que el sector)
  sujetos_control?: string[]
}

export interface FiltrosBusqueda {
  entidad?:        string
  nitEntidad?:     string
  contratista?:    string
  nitContratista?: string
  objeto?:         string
  valorMin?:       number
  valorMax?:       number
  desde?:          string
  hasta?:          string
  estado?:         string
  tipo?:           string
  modalidad?:      string
  limite?:         number
  ambito?:         Ambito
  sinRuido?:       boolean       // oculta cancelados y contratos en $0
  soloEmpresas?:   boolean       // excluye TODAS las personas naturales (agresivo)
  sinServiciosPersonales?: boolean  // excluye SOLO prestación de servicios de persona natural (el ruido real)
}

export interface Hallazgo {
  id:                number
  expediente_id:     number
  regla_id:          string
  doc_id:            number | null
  folio:             string | null
  cifra_afirmada:    number | null
  cifra_calculada:   number | null
  delta:             number | null
  evidencia_textual: string | null
  detalle:           Record<string, unknown> | null
  norma_ref:         string | null
  norma_verificada:  boolean
}

export interface ExpedienteResumen {
  id:                  number
  id_contrato:         string
  referencia_contrato: string | null
  entidad:             string | null
  contratista:         string | null
  valor_contrato:      number | null
  estado:              string
  score_triaje:        number | null
  updated_at:          string
}

export interface DocumentoCustodia {
  id:             number
  nombre_archivo: string | null
  url_origen:     string | null
  sha256:         string | null
  fecha_captura:  string | null
  tamano_bytes:   number | null
}

export interface CitasEval {
  respaldadas?:  string[]
  del_hecho?:    string[]
  sinRespaldo?:  string[]
  total?:        number
}

export interface Actuacion {
  id:             number
  tipo:           string
  direccion:      string | null
  estado:         string | null
  contenido_html: string | null
  evaluacion:     { citas?: CitasEval; sinCorpus?: boolean; revisionHumana?: unknown } | null
  created_at:     string
}

// Veredicto determinista (analisis-determinista.mjs): lo que auditar SIEMPRE puede
// dar, haya informe o no — score de metadatos (Nivel 0) + datos del proceso (Nivel 1).
export interface AnalisisProceso {
  id_proceso:    string | null
  modalidad:     string | null
  justificacion: string | null
  invitados:     number | null
  manifestaron:  number | null
  ofertas:       number | null
  precio_base:   number | null
  adjudicado:    number | null
  duracion:      string | null
  estado:        string | null
  url:           string | null
}
export interface AnalisisSenal { nivel: 'contrato' | 'proceso'; texto: string }
export interface AnalisisDeterminista {
  score:    number
  nivel:    'alto' | 'medio' | 'bajo'
  razones:  string[]
  senales:  AnalisisSenal[]
  contrato: Record<string, unknown>
  proceso:  AnalisisProceso | null
}

export interface ExpedienteDetalle {
  expediente:  Record<string, unknown> & { id: number; estado: string; id_contrato: string }
  documentos:  DocumentoCustodia[]
  hallazgos:   Hallazgo[]
  actuaciones: Actuacion[]
  analisis?:   AnalisisDeterminista | null
}

export interface PerfilContratista {
  nit:             string
  total_contratos: number
  valor_total:     number
  representantes:  string[]
  por_entidad:     Array<{ nit_entidad: string; nombre: string; n: number; valor: number }>
  contratos_recientes: Array<Record<string, unknown>>
}

// ── Llamadas del flujo ───────────────────────────────────────────────────────

function qs(filtros: FiltrosBusqueda): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(filtros)) {
    if (v === undefined || v === null || v === '') continue
    p.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
  }
  return p.toString()
}

export const buscarContratos = (f: FiltrosBusqueda) =>
  veedorFetch<{ contratos: ContratoBusqueda[] }>(`/veeduria/buscar?${qs(f)}`, 'GET', undefined, 45_000).then(r => r.contratos)

export const resumenBusqueda = (f: FiltrosBusqueda) =>
  veedorFetch<{ contratos: number; valor_total: number }>(`/veeduria/resumen?${qs(f)}`, 'GET', undefined, 45_000)

// Auditar corre el pipeline completo (descarga + extracción LLM + motor) de forma
// síncrona → puede tardar (5-8 min en contratos con muchos PDFs). Timeout amplio.
export const auditarContrato = (idContrato: string) =>
  veedorFetch<{ expedienteId: number; estado: string; hallazgos: number; analisis: AnalisisDeterminista | null }>(
    `/veeduria/auditar/${encodeURIComponent(idContrato)}`, 'POST', undefined, 480_000)

export const listarExpedientes = (estado?: string) =>
  veedorFetch<{ expedientes: ExpedienteResumen[] }>(
    `/veeduria/expedientes${estado ? `?estado=${encodeURIComponent(estado)}` : ''}`).then(r => r.expedientes)

export const obtenerExpediente = (id: number) =>
  veedorFetch<ExpedienteDetalle>(`/veeduria/expediente/${id}`)

// La denuncia es asíncrona: responde al toque, genera en background. La UI hace
// polling a obtenerExpediente hasta que aparezca la actuación 'denuncia'.
export const generarDenuncia = (id: number) =>
  veedorFetch<{ procesando: boolean; mensaje: string }>(`/veeduria/expediente/${id}/denuncia`, 'POST')

// Guardar ediciones manuales del editor TipTap.
export const guardarDenuncia = (id: number, contenido_html: string) =>
  veedorFetch<{ ok: boolean }>(`/veeduria/expediente/${id}/denuncia`, 'PATCH', { contenido_html })

// Enviar denuncia vía Resend con tracking (consecutivo + threading + 15 días hábiles).
export interface EnvioResult {
  ok: boolean
  consecutivo: string
  message_id: string
  fecha_vencimiento: string   // ISO date — 15 días hábiles desde el envío
}
export const enviarDenuncia = (id: number, opts: {
  destinatario_email: string
  destinatario_nombre: string
  org_id: string            // org de NUMA del usuario autenticado (para RPCs de consecutivo)
  contenido_html?: string   // usa el guardado si se omite
}) =>
  veedorFetch<EnvioResult>(`/veeduria/expediente/${id}/enviar`, 'POST', opts, 30_000)

// ── Requerimientos (veedor_requerimientos) ──────────────────────────────────
export interface Requerimiento {
  id: number
  id_proceso: string
  consecutivo: string | null
  tipo: string
  estado: string
  fecha_envio: string | null
  fecha_vencimiento: string | null
  respuesta_html: string | null
  respuesta_from: string | null
  fecha_respuesta: string | null
  analisis_respuesta: { respondio_fondo?: boolean; tipo_respuesta?: string; razon?: string } | null
  numero_radicado: string | null
  juzgado: string | null
  ciudad_radicado: string | null
  fecha_radicado: string | null
  analisis_fallo: { resultado?: string; razon?: string; extracto?: string; impugnacion_sugerida?: string | null; accion_siguiente?: string } | null
}

export const obtenerRequerimientos = (id: number) =>
  veedorFetch<{ requerimientos: Requerimiento[] }>(`/veeduria/expediente/${id}/requerimientos`).then(r => r.requerimientos)

// ── Notas internas (veedor_notas) ───────────────────────────────────────────
export interface Nota {
  id: number
  contenido: string
  es_interna: boolean
  created_at: string
}

export const obtenerNotas = (id: number) =>
  veedorFetch<{ notas: Nota[] }>(`/veeduria/expediente/${id}/notas`).then(r => r.notas)

export const crearNota = (id: number, opts: { contenido: string; es_interna?: boolean; org_id: string }) =>
  veedorFetch<{ nota: Nota }>(`/veeduria/expediente/${id}/nota`, 'POST', opts).then(r => r.nota)

// ── Análisis de respuesta (F4) ──────────────────────────────────────────────
export const analizarRespuesta = (id: number, requerimiento_id: number) =>
  veedorFetch<{ respondio_fondo?: boolean; tipo_respuesta?: string; razon?: string; solicita_documentos_adicionales?: boolean; menciona_terminos_adicionales?: boolean }>(
    `/veeduria/expediente/${id}/analizar-respuesta`, 'POST', { requerimiento_id }, 60_000
  )

// ── Tutela (F5) ─────────────────────────────────────────────────────────────
export const generarTutela = (id: number) =>
  veedorFetch<{ procesando: boolean; html?: string }>(`/veeduria/expediente/${id}/tutela`, 'POST', {}, 90_000)

export const registrarRadicadoTutela = (id: number, opts: {
  numero_radicado: string; juzgado: string; ciudad_radicado?: string; id_proceso: string
}) =>
  veedorFetch<{ ok: boolean }>(`/veeduria/expediente/${id}/radicado-tutela`, 'POST', opts)

export const analizarFallo = (id: number, requerimiento_id: number, fallo_texto: string) =>
  veedorFetch<{ ok: boolean; resultado?: string; razon?: string; extracto?: string; impugnacion_sugerida?: string | null; accion_siguiente?: string }>(
    `/veeduria/expediente/${id}/fallo`, 'POST', { requerimiento_id, fallo_texto }, 60_000
  )

export const cerrarExpediente = (id: number, estado: 'cerrado_favorable' | 'cerrado', notas?: string) =>
  veedorFetch<{ ok: boolean }>(`/veeduria/expediente/${id}/cerrar`, 'POST', { estado, notas })

export const perfilContratista = (nit: string) =>
  veedorFetch<{ perfil: PerfilContratista }>(`/veeduria/grafo/perfil/${encodeURIComponent(nit)}`).then(r => r.perfil)

// Análisis completo: perfil + red + evolución en una sola llamada paralela.
export interface AnalisisCompleto {
  perfil:    PerfilContratista | null
  red:       RedBarrido | null
  evolucion: EvolucionRed | null
  errores:   Array<{ fuente: string; error: string }>
}

export const analisisCompleto = (nit: string, opts?: { ambito?: Ambito }) => {
  const p = new URLSearchParams({ nit })
  if (opts?.ambito) p.set('ambito', JSON.stringify(opts.ambito))
  return veedorFetch<AnalisisCompleto>(`/veeduria/grafo/analisis-completo?${p}`, 'GET', undefined, 120_000)
}

// ── Barrido de red (grafo-contratistas.mjs) ──────────────────────────────────

export interface NodoContratista { nit: string; nombre: string; contratos: number; valor: number; salto: number }
export interface NodoRep { rep_id: string; nombre: string; salto: number; empresas: string[]; num_empresas: number; num_entidades: number }
export interface NodoEntidad { nit_entidad: string; nombre: string; contratos: number; valor: number }
export interface Arista { from: string; to: string; tipo: 'adjudica' | 'representa'; valor?: number }
export interface ManoComun extends NodoRep { nota: string }

export interface RedBarrido {
  semilla:  { nit?: string; repId?: string }
  saltos:   number
  nodos:    { contratistas: NodoContratista[]; representantes: NodoRep[]; entidades: NodoEntidad[] }
  aristas:  Arista[]
  manos_comunes: ManoComun[]
  resumen:  { contratistas: number; representantes: number; entidades: number; valor_total: number; empresas_hermanas: number; entidades_alcanzadas: number }
}

export interface SenalRepMultiple {
  senal: string; representante: string; rep_id: string; entidad: string; nit_entidad: string
  empresas_distintas: number; contratos: number; valor_total: number
}

export interface CrucesRed {
  redes: Array<{ semilla: { nit?: string; repId?: string }; red?: RedBarrido; error?: string }>
  cruces: {
    entidades_compartidas: Array<{ nit_entidad: string; nombre: string; en_redes: number }>
    representantes_compartidos: Array<{ rep_id: string; nombre: string; en_redes: number }>
  }
}

export type Semilla = { nit?: string; repId?: string }

// El barrido corre varias queries a Socrata → timeout generoso.
export const barridoRed = (semilla: Semilla, opts?: { saltos?: number; dias?: number; ambito?: Ambito }) => {
  const p = new URLSearchParams()
  if (semilla.nit)   p.set('nit', semilla.nit)
  if (semilla.repId) p.set('repId', semilla.repId)
  if (opts?.saltos)  p.set('saltos', String(opts.saltos))
  if (opts?.dias)    p.set('dias', String(opts.dias))
  if (opts?.ambito)  p.set('ambito', JSON.stringify(opts.ambito))
  return veedorFetch<{ red: RedBarrido }>(`/veeduria/grafo/barrido?${p}`, 'GET', undefined, 90_000).then(r => r.red)
}

export const barridoRedMultiple = (semillas: Semilla[], opts?: { saltos?: number; dias?: number; ambito?: Ambito }) =>
  veedorFetch<CrucesRed>(`/veeduria/grafo/barrido-multiple`, 'POST', { semillas, ...opts }, 120_000)

export const repLegalCandidatos = () =>
  veedorFetch<{ senales: SenalRepMultiple[] }>(`/veeduria/grafo/rep-multiple`).then(r => r.senales)

export interface Carrusel {
  rep_id: string; representante: string
  score: number; nivel: 'alto' | 'medio' | 'bajo'; senales: string[]
  entidad_principal: string | null
  resumen: { empresas: number; entidades: number; valor_total: number; concentracion: number }
}

// Barre varios sospechosos y los rankea → puede tardar. Timeout amplio.
export const detectarCarruseles = (opts?: { topN?: number; dias?: number; minEmpresas?: number; ambito?: Ambito; desde?: string; hasta?: string; nitEntidad?: string; tipoContrato?: string; entidad?: string }) => {
  const p = new URLSearchParams()
  if (opts?.topN)         p.set('topN', String(opts.topN))
  if (opts?.dias)         p.set('dias', String(opts.dias))
  if (opts?.minEmpresas)  p.set('minEmpresas', String(opts.minEmpresas))
  if (opts?.ambito)       p.set('ambito', JSON.stringify(opts.ambito))
  if (opts?.desde)        p.set('desde', opts.desde)
  if (opts?.hasta)        p.set('hasta', opts.hasta)
  if (opts?.nitEntidad)   p.set('nitEntidad', opts.nitEntidad)
  if (opts?.tipoContrato) p.set('tipo', opts.tipoContrato)
  if (opts?.entidad)      p.set('entidad', opts.entidad)
  return veedorFetch<{ carruseles: Carrusel[] }>(`/veeduria/grafo/carruseles?${p}`, 'GET', undefined, 180_000).then(r => r.carruseles)
}

export interface PuntoEvolucion { periodo: string; empresas: number; empresas_nuevas: number; entidades: number; contratos: number; valor: number }
export interface EvolucionRed {
  semilla: Semilla
  serie:   PuntoEvolucion[]
  hitos:   { inicio: string | null; ultimo: string | null; pico: string | null; estado: string }
  total_contratos: number
}

export const evolucionRed = (semilla: Semilla, opts?: { dias?: number; ambito?: Ambito }) => {
  const p = new URLSearchParams()
  if (semilla.nit)   p.set('nit', semilla.nit)
  if (semilla.repId) p.set('repId', semilla.repId)
  if (opts?.dias)    p.set('dias', String(opts.dias))
  if (opts?.ambito)  p.set('ambito', JSON.stringify(opts.ambito))
  return veedorFetch<{ evolucion: EvolucionRed }>(`/veeduria/grafo/evolucion?${p}`, 'GET', undefined, 60_000).then(r => r.evolucion)
}

// Presets de ámbito para el selector demo ("ver como…"). En producción el
// ámbito lo fija el cliente autenticado, no un dropdown.
export const AMBITOS_DEMO: Array<{ label: string; ambito?: Ambito }> = [
  { label: 'Nacional — sin restricción', ambito: undefined },
  { label: 'Contraloría de Antioquia', ambito: { orden: 'territorial', departamentos: ['Antioquia'] } },
  { label: 'Contraloría Municipal de Medellín', ambito: { departamentos: ['Antioquia'], municipios: ['Medellín'] } },
  { label: 'Veeduría de alimentación escolar (PAE)', ambito: { objeto: 'alimentacion escolar' } },
  { label: 'Veeduría de obras — Córdoba', ambito: { orden: 'territorial', departamentos: ['Córdoba'], objeto: 'obra' } },
]

// Vocabulario controlado de SECOP para los dropdowns de búsqueda (valores exactos,
// ordenados por frecuencia). El estado 'terminado' va en minúscula porque así lo
// guarda SECOP y el filtro compara exacto.
export const TIPOS_CONTRATO = [
  'Prestación de servicios', 'Obra', 'Suministros', 'Compraventa', 'Consultoría',
  'Interventoría', 'Arrendamiento de inmuebles', 'Comodato', 'Seguros', 'Concesión',
  'Acuerdo Marco de Precios', 'Servicios financieros', 'Asociación Público Privada',
  'Negocio fiduciario', 'Decreto 092 de 2017', 'Otro',
]
export const ESTADOS_CONTRATO = [
  'En ejecución', 'Cerrado', 'Modificado', 'terminado', 'Borrador',
  'Aprobado', 'Cancelado', 'Suspendido', 'Prorrogado',
]

// ── RADAR — tipos de los nuevos motores ─────────────────────────────────────

// Hallazgo unificado que devuelve /veeduria/radar.
// Cada motor lo normaliza a este formato antes de ordenar por severidad.
export interface RadarHallazgo {
  fuente:    string              // 'concentracion' | 'cruzamiento' | 'clones' | 'actas' | 'carrusel' | 'rep_multiple' | 'fraccionamiento'
  senal:     string              // código de señal: 'CONCENTRACION_SUPERVISORES', 'CRUZAMIENTO_SUPERVISORES', etc.
  severidad: 'alto' | 'medio' | 'bajo'
  valor:     number              // valor monetario involucrado (para ordenar)
  titulo:    string              // texto corto (2-4 palabras)
  descripcion: string            // frase que explica el hallazgo para un humano
  evidencia: Record<string, unknown>  // datos crudos del motor (mostrar en detalle)
}

export interface RadarResultado {
  n_hallazgos: number
  alto:        number
  medio:       number
  hallazgos:   RadarHallazgo[]
  errores:     Array<{ fuente: string; error: string }>
}

// Motor supervisores — concentracion
export interface SupervisorConcentrado {
  nit:           string
  nombre:        string
  total:         number   // total de contratos de supervisión
  simultaneos:   number   // pico de contratos simultáneos estimado
  valor_total:   number
  contratos:     Array<{ id_contrato: string; entidad: string; objeto: string; valor: number; fecha_firma: string }>
}

export interface ConcentracionResult {
  supervisores: SupervisorConcentrado[]
  periodo:      { desde: string; hasta: string }
}

// Motor supervisores — cruzamiento
export interface CruzamientoResult {
  hallazgos: Array<{
    senal:       'CRUZAMIENTO_SUPERVISORES' | 'PERFIL_CRUZADO'
    nit_a:       string
    nombre_a:    string
    nit_b:       string | null
    nombre_b:    string | null
    descripcion: string
    valor:       number
    evidencia:   Record<string, unknown>
  }>
}

// Motor similitud — objetos duplicados
export interface GrupoClones {
  senal:       string
  similitud:   number
  miembros:    Array<{ nit: string; nombre: string; id_contrato: string; objeto: string; valor: number }>
  valor_total: number
}

// Motor similitud — actas antes de registro
export interface ActaIrregular {
  senal:        'PROCESO_POSTERIOR_A_CONTRATO' | 'SIN_PROCESO_PRECONTRACTUAL'
  id_contrato:  string
  contratista:  string
  valor:        number
  fecha_firma:  string
  fecha_proceso:string | null
  diferencia_dias: number | null
}

// ── Llamadas a los nuevos endpoints ─────────────────────────────────────────

export type RadarOpts = {
  nitEntidad?:  string
  entidad?:     string
  desde?:       string
  hasta?:       string
  ambito?:      Ambito
}

function radarQs(opts?: RadarOpts): string {
  const p = new URLSearchParams()
  if (opts?.nitEntidad) p.set('nitEntidad', opts.nitEntidad)
  if (opts?.entidad)    p.set('entidad', opts.entidad)
  if (opts?.desde)      p.set('desde', opts.desde)
  if (opts?.hasta)      p.set('hasta', opts.hasta)
  if (opts?.ambito)     p.set('ambito', JSON.stringify(opts.ambito))
  return p.toString()
}

// Radar completo: corre los 7 motores en paralelo y unifica resultados.
// Timeout amplio porque algunos motores descargan 2000 contratos.
export const radar = (opts?: RadarOpts) =>
  veedorFetch<RadarResultado>(`/veeduria/radar?${radarQs(opts)}`, 'GET', undefined, 180_000)

export const concentracionSupervisoresApi = (opts?: RadarOpts) =>
  veedorFetch<ConcentracionResult>(`/veeduria/supervisores/concentracion?${radarQs(opts)}`, 'GET', undefined, 90_000)

export const cruzamientoSupervisoresApi = (opts?: RadarOpts) =>
  veedorFetch<CruzamientoResult>(`/veeduria/supervisores/cruzamiento?${radarQs(opts)}`, 'GET', undefined, 90_000)

export const objetosDuplicadosApi = (opts?: RadarOpts) =>
  veedorFetch<{ grupos: GrupoClones[] }>(`/veeduria/contratos/clones?${radarQs(opts)}`, 'GET', undefined, 120_000)

export const actasIrregularesApi = (opts?: RadarOpts) =>
  veedorFetch<{ irregulares: ActaIrregular[] }>(`/veeduria/contratos/actas-irregulares?${radarQs(opts)}`, 'GET', undefined, 90_000)

// ── Cronograma (veedor_cronograma) ───────────────────────────────────────────

export type TipoHito =
  | 'entrega_oferta'
  | 'audiencia_aclaracion'
  | 'visita_tecnica'
  | 'subsanacion'
  | 'evaluacion_publicacion'
  | 'traslado_informe'
  | 'adjudicacion'
  | 'firma_contrato'
  | 'inicio_ejecucion'
  | 'entrega_producto'
  | 'liquidacion'
  | 'audiencia_apertura'
  | 'otro'

export type EstadoHito = 'pendiente' | 'cumplido' | 'vencido' | 'pospuesto'

export interface CronogramaHito {
  id:                   string
  id_proceso:           string
  tipo_hito:            TipoHito
  descripcion:          string
  fecha_limite:         string   // ISO 8601
  documento_requerido:  string | null
  notas_adicionales:    string | null
  estado:               EstadoHito
  fuente_extraccion:    string
  alerta_7d_enviada:    boolean
  alerta_3d_enviada:    boolean
  alerta_1d_enviada:    boolean
  alerta_hoy_enviada:   boolean
  email_alerta:         string | null
  created_at:           string
}

export const HITO_LABELS: Record<TipoHito, string> = {
  entrega_oferta:        'Entrega de oferta',
  audiencia_aclaracion:  'Audiencia de aclaración',
  visita_tecnica:        'Visita técnica',
  subsanacion:           'Subsanación de documentos',
  evaluacion_publicacion:'Publicación de evaluación',
  traslado_informe:      'Traslado del informe',
  adjudicacion:          'Adjudicación',
  firma_contrato:        'Firma del contrato',
  inicio_ejecucion:      'Inicio de ejecución',
  entrega_producto:      'Entrega de producto/informe',
  liquidacion:           'Liquidación',
  audiencia_apertura:    'Audiencia de apertura',
  otro:                  'Hito del proceso',
}

// Extrae el cronograma de un proceso SECOP (llama a la edge function)
export const extraerCronograma = (idProceso: string, opts?: {
  proceso_data?:    Record<string, unknown>
  documentos_texto?: string
  org_id?:          string
  email_alerta?:    string
}) =>
  veedorFetch<{ ok: boolean; hitos: CronogramaHito[]; total: number }>(
    `/veeduria/expediente/cronograma/extraer`,
    'POST',
    { id_proceso: idProceso, ...opts },
    120_000
  )

// Obtiene el cronograma guardado de un proceso
export const obtenerCronograma = (idProceso: string) =>
  veedorFetch<{ hitos: CronogramaHito[] }>(
    `/veeduria/expediente/cronograma/${encodeURIComponent(idProceso)}`
  ).then(r => r.hitos)

// Marcar hito como cumplido / pospuesto manualmente
export const actualizarHito = (hitoId: string, estado: EstadoHito) =>
  veedorFetch<{ ok: boolean }>(
    `/veeduria/expediente/cronograma/hito/${hitoId}`,
    'PATCH',
    { estado }
  )

// ── Configuración SMTP por org ──────────────────────────────────────────────

export interface SmtpConfig {
  org_id:         string
  smtp_host:      string
  smtp_port:      number
  smtp_user:      string
  smtp_secure:    boolean
  imap_host:      string | null
  imap_port:      number
  imap_secure:    boolean
  from_name:      string | null
  from_email:     string | null
  activo:         boolean
  last_imap_poll: string | null
}

export const obtenerSmtpConfig = (org_id: string) =>
  veedorFetch<{ config: SmtpConfig | null }>(`/veeduria/config/smtp?org_id=${encodeURIComponent(org_id)}`)
    .then(r => r.config)

export const guardarSmtpConfig = (opts: {
  org_id:      string
  smtp_host:   string
  smtp_port:   number
  smtp_user:   string
  smtp_pass:   string   // texto plano — el servidor cifra antes de guardar
  smtp_secure?: boolean
  imap_host?:  string
  imap_port?:  number
  imap_secure?: boolean
  from_name?:  string
  from_email?: string
}) =>
  veedorFetch<{ config: SmtpConfig }>('/veeduria/config/smtp', 'POST', opts)
    .then(r => r.config)

export const eliminarSmtpConfig = (org_id: string) =>
  veedorFetch<{ desactivado: boolean }>(`/veeduria/config/smtp?org_id=${encodeURIComponent(org_id)}`, 'DELETE' as 'POST')
