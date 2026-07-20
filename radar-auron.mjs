/**
 * RADAR AURON — caza de procesos públicos de software/web al alcance de Auron.
 *
 * Mismo motor de datos abiertos que el veedor (sin login, sin captcha), pero
 * apuntado a la ofensiva: encontrar procesos donde Auron PUEDE ofertar y ganar.
 *
 * Filtro de alcance: en mínima cuantía la experiencia se acredita con UN (1)
 * contrato (estatal o privado) terminado y liquidado, de valor >= al presupuesto
 * oficial. Con el mejor contrato de Auron ($120M) el techo es ese; algunos
 * pliegos permiten sumar varios contratos (ahí el techo sube a $170M).
 *
 * Uso:
 *   node radar-auron.mjs            # solo lo ABIERTO hoy
 *   node radar-auron.mjs --dias 90  # además, histórico para calibrar
 */

const SOCRATA = 'https://www.datos.gov.co/resource';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── Perfil de Auron ───────────────────────────────────────────────────────────
const CONTRATOS_AURON = [50_000_000, 120_000_000];   // ambos con entidades privadas
const TECHO_1 = Math.max(...CONTRATOS_AURON);                       // pliego pide 1 contrato
const TECHO_N = CONTRATOS_AURON.reduce((a, b) => a + b, 0);         // pliego deja sumar

// Vocabulario de caza. Frases, no palabras sueltas: "digital" o "sistema" solos
// traen material pedagógico, sistemas de riego y sillas ergonómicas.
const KW = [
  // desarrollo puro
  'DESARROLLO DE SOFTWARE', 'DESARROLLO DEL SOFTWARE', 'DESARROLLO DE UN SOFTWARE',
  'SOFTWARE A LA MEDIDA', 'FABRICA DE SOFTWARE', 'SOFTWARE COMO SERVICIO', 'SAAS',
  'DESARROLLO WEB', 'DESARROLLO E IMPLEMENTACION', 'DESARROLLO E IMPLEMENTACIÓN',
  // sistemas de información
  'SISTEMA DE INFORMACION', 'SISTEMA DE INFORMACIÓN', 'SISTEMAS DE INFORMACION',
  'SISTEMAS DE INFORMACIÓN',
  // web
  'SITIO WEB', 'PAGINA WEB', 'PÁGINA WEB', 'PORTAL WEB', 'APLICATIVO WEB',
  'APLICACION WEB', 'APLICACIÓN WEB', 'GEOPORTAL', 'INTRANET',
  // apps y plataformas
  'APLICATIVO MOVIL', 'APLICACION MOVIL', 'APLICACIÓN MÓVIL', 'APLICATIVO',
  'PLATAFORMA WEB', 'PLATAFORMA TECNOLOGICA', 'PLATAFORMA TECNOLÓGICA',
  'PLATAFORMA DIGITAL',
  // gobierno digital / trámites (terreno GovRegistro)
  'GOBIERNO DIGITAL', 'TRAMITES EN LINEA', 'TRÁMITES EN LÍNEA', 'VENTANILLA UNICA',
  'VENTANILLA ÚNICA', 'GESTION DOCUMENTAL', 'GESTIÓN DOCUMENTAL',
  // integración
  'INTEROPERABILIDAD', 'SERVICIOS WEB', 'API REST',
];

// Ruido: si aparece alguno, se descarta aunque matchee arriba. Cada uno salió de
// un falso positivo real (tiquetes, mobiliario de archivo, tóner, pentesting…).
const EX = [
  'LICENCIA', 'RENOVACION', 'RENOVACIÓN', 'SUSCRIPCION', 'SUSCRIPCIÓN', 'MICROSOFT',
  'ANTIVIRUS', 'OFFICE 365', 'IMPRESORA', 'IMPRESION', 'IMPRESIÓN', 'FOTOCOPIA',
  'TONER', 'TÓNER', 'PAPELERIA', 'PAPELERÍA', 'TIQUETE', 'PASAJE', 'TRANSPORTE',
  'VEHICULO', 'VEHÍCULO', 'MOBILIARIO', 'HOSTING', 'DOMINIO', 'MATERIAL PEDAGOGICO',
  'MATERIAL PEDAGÓGICO', 'CERTIFICADO DIGITAL', 'FIRMA DIGITAL', 'TOKEN',
  'APOYO LOGISTICO', 'APOYO LOGÍSTICO', 'OPERADOR LOGISTICO', 'CONSERVACION',
  'CONSERVACIÓN', 'PENTESTING', 'VULNERABILIDAD', 'CABLEADO', 'STREAMING',
  'MATERIALES DE FORMACION', 'MATERIALES DE FORMACIÓN', 'ALIMENTACION', 'ALIMENTACIÓN',
];

// Modalidades donde una empresa puede ofertar (la directa es dedocracia: no aplica)
const MODALIDADES = [
  'Mínima cuantía',
  'Selección abreviada subasta inversa',
  'Selección Abreviada de Menor Cuantía',
  'Concurso de méritos abierto',
  'Licitación pública',
];

const TXT = "coalesce(descripci_n_del_procedimiento,'') || ' ' || coalesce(nombre_del_procedimiento,'')";
const fmt = (n) => '$' + Math.round(n).toLocaleString('es-CO');

async function socrata(dataset, params) {
  const q = new URLSearchParams(params);
  const headers = { Accept: 'application/json', 'User-Agent': UA };
  if (process.env.SOCRATA_APP_TOKEN) headers['X-App-Token'] = process.env.SOCRATA_APP_TOKEN;
  const res = await fetch(`${SOCRATA}/${dataset}.json?${q}`, { headers });
  if (!res.ok) throw new Error(`Socrata HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`Socrata: ${data?.message ?? 'respuesta inesperada'}`);
  return data;
}

function whereClause(desdeISO) {
  const like = KW.map(k => `upper(${TXT}) like '%${k}%'`).join(' OR ');
  const excl = EX.map(k => `upper(${TXT}) not like '%${k}%'`).join(' AND ');
  const mods = MODALIDADES.map(m => `'${m}'`).join(',');
  return `fecha_de_publicacion_del > '${desdeISO}T00:00:00.000' `
       + `AND modalidad_de_contratacion in (${mods}) `
       + `AND estado_del_procedimiento not in ('Cancelado','Adjudicado','Terminado') `
       + `AND precio_base > 3000000 AND (${like}) AND ${excl}`;
}

// El dataset trae una fila por lote → deduplicar por portafolio
function dedup(rows) {
  const vistos = new Set(), out = [];
  for (const r of rows) {
    const p = r.id_del_portafolio;
    if (!p || vistos.has(p)) continue;
    vistos.add(p);
    out.push(r);
  }
  return out;
}

const alcance = (precio) =>
  precio <= TECHO_1 ? '✅ AL ALCANCE'
  : precio <= TECHO_N ? '🟡 SI SUMAN CONTRATOS'
  : '❌ FUERA';

async function documentosDe(portafolio) {
  try {
    const docs = await socrata('dmgg-8hin', {
      proceso: portafolio, $select: 'nombre_archivo,id_documento', $limit: '40',
    });
    return docs.filter(d => /INVITAC|PLIEGO|ESTUDIO PREVIO/i.test(d.nombre_archivo));
  } catch { return []; }
}

async function main() {
  const dias = Number(process.argv.includes('--dias')
    ? process.argv[process.argv.indexOf('--dias') + 1] : 45);
  const hoy = new Date();
  const desde = new Date(hoy - dias * 864e5).toISOString().slice(0, 10);

  const rows = await socrata('p6dx-8zbt', {
    $select: 'id_del_portafolio,id_del_proceso,entidad,departamento_entidad,ciudad_entidad,'
           + 'precio_base,fecha_de_publicacion_del,fecha_de_recepcion_de,'
           + 'estado_del_procedimiento,fase,modalidad_de_contratacion,'
           + 'descripci_n_del_procedimiento,urlproceso',
    $where: whereClause(desde),
    $order: 'fecha_de_recepcion_de DESC',
    $limit: '300',
  });

  const procs = dedup(rows);
  const abiertos = procs.filter(r => r.fecha_de_recepcion_de && new Date(r.fecha_de_recepcion_de) >= hoy);

  console.log(`RADAR AURON · ${hoy.toISOString().slice(0, 16).replace('T', ' ')} · últimos ${dias} días`);
  console.log(`Techo de experiencia: ${fmt(TECHO_1)} (1 contrato) · ${fmt(TECHO_N)} (sumando los dos)\n`);

  console.log(`═══ VENTANA ABIERTA — se puede ofertar YA (${abiertos.length}) ═══\n`);
  if (abiertos.length === 0) console.log('  (nada abierto ahora mismo en el perfil)\n');

  for (const r of abiertos.sort((a, b) => new Date(a.fecha_de_recepcion_de) - new Date(b.fecha_de_recepcion_de))) {
    const precio = Number(r.precio_base || 0);
    const cierra = new Date(r.fecha_de_recepcion_de);
    const dLeft = Math.ceil((cierra - hoy) / 864e5);
    console.log(`■ ${alcance(precio)} · ${fmt(precio)} · cierra ${cierra.toISOString().slice(0, 10)} (${dLeft}d)`);
    console.log(`  ${r.entidad?.slice(0, 62)} · ${r.modalidad_de_contratacion}`);
    console.log(`  ${(r.descripci_n_del_procedimiento || '').slice(0, 118)}`);
    const docs = await documentosDe(r.id_del_portafolio);
    if (docs.length) console.log(`  docs: ${docs.slice(0, 3).map(d => d.nombre_archivo.slice(0, 42)).join(' · ')}`);
    if (r.urlproceso?.url) console.log(`  ${r.urlproceso.url}`);
    console.log();
  }

  // Calibración: qué tan seguido aparece algo al alcance
  const alAlcance = procs.filter(r => Number(r.precio_base || 0) <= TECHO_1);
  const semanas = dias / 7;
  console.log(`═══ CALIBRACIÓN (${dias} días) ═══`);
  console.log(`  ${procs.length} procesos en el perfil · ${alAlcance.length} al alcance (${fmt(TECHO_1)})`);
  console.log(`  ritmo: ${(alAlcance.length / semanas).toFixed(1)} al alcance por semana\n`);

  console.log(`  Los del período, al alcance (para ver el tipo de presa):`);
  for (const r of alAlcance.sort((a, b) => Number(b.precio_base) - Number(a.precio_base)).slice(0, 12)) {
    console.log(`    ${fmt(Number(r.precio_base)).padStart(14)} | ${(r.modalidad_de_contratacion || '').slice(0, 26).padEnd(26)} | ${(r.entidad || '').slice(0, 32)}`);
    console.log(`                   ${(r.descripci_n_del_procedimiento || '').slice(0, 90)}`);
  }
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
