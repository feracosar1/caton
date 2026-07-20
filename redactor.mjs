/**
 * REDACTOR — fase 4. La prosa nace de la TABLA, nunca del documento.
 *
 * Principio rector, heredado del motor: la IA no decide nada. Acá recibe una
 * lista de hallazgos ya calculados —cada uno con su cifra afirmada, su cifra
 * calculada, su delta, su documento y su folio— y los convierte en prosa. No
 * recalcula, no reinterpreta, no agrega hechos.
 *
 * Y una regla que es la que hace que la denuncia se sostenga:
 *
 *   EL REDACTOR NO PUEDE CITAR UNA NORMA QUE NO ESTÉ VERIFICADA EN EL CORPUS.
 *
 * No basta con pedírselo en el prompt: se valida la salida. Cada norma citada se
 * confronta contra los fragmentos que efectivamente se recuperaron del corpus.
 * Si cita una que no está, se rehace. Si insiste, se marca para revisión humana.
 * Una cita inventada —un artículo que no dice lo que decimos que dice— es lo que
 * un abogado defensor necesita para tumbar la denuncia entera, con los 27
 * hallazgos adentro.
 *
 * Variables de entorno (además de ANTHROPIC_API_KEY y VOYAGE_API_KEY):
 *   NUMA_CORPUS_ENDPOINT   https://numa-corpus.search.windows.net
 *   NUMA_CORPUS_KEY        (query key del servicio de Azure AI Search de NUMA)
 *   NUMA_CORPUS_INDEX      corpus
 *
 * Sin esas tres, el redactor funciona igual pero NO cita normas: los hallazgos
 * salen con los hechos y las cifras, y la fundamentación queda marcada como
 * pendiente. Es la degradación correcta — mejor una denuncia sin normas que una
 * con normas falsas.
 */

const MODEL = 'claude-sonnet-4-6';

// ── Qué buscar en el corpus para fundamentar cada familia de reglas ───────────
// Una query por regla, no una genérica: la de "pago sin ejecución" no debe
// traer los mismos fragmentos que la de "expediente fuera de SECOP".
const CONSULTA_POR_REGLA = {
  'ARIT-01': 'forma de pago cronograma desembolsos valor del contrato adición recursos comprometidos sin respaldo',
  'ARIT-02': 'pago de lo no debido ejecución no acreditada detrimento patrimonial responsabilidad fiscal ley 610 de 2000',
  'ARIT-03': 'conciliación entre lo certificado y lo pagado estado de cuenta supervisor deber de verificación financiera',
  'ARIT-04': 'vigencia futura valor del compromiso presupuestal legalidad del gasto estatuto orgánico del presupuesto',
  'CRON-01': 'certificación de cumplimiento expedida antes de la ejecución veracidad supervisor ley 1474 de 2011 artículo 84',
  'CRON-02': 'certificación de hechos contrarios a la realidad deber funcional supervisor código general disciplinario',
  'CRON-03': 'período del informe de supervisión vigencia anterior a la suscripción del contrato',
  'CRON-04': 'certificado de disponibilidad presupuestal y registro presupuestal previos al compromiso decreto 111 de 1996',
  'DUP-01' : 'un mismo certificado de disponibilidad presupuestal no puede amparar dos compromisos distintos',
  'DUP-02' : 'factura duplicada doble pago peculado por apropiación código penal',
  'DOC-01' : 'supervisor deber de verificar los soportes documentales del expediente contractual guía de supervisión ICBF',
  'DOC-02' : 'publicidad del expediente contractual SECOP II ley 1712 de 2014 acceso a la información pública',
  'DOC-03' : 'diligenciamiento íntegro del formato de informe de supervisión deber de veracidad del documento suscrito',
  'DOC-04' : 'documento público suscrito sin depurar deber de veracidad e integridad del supervisor',
  'DOC-05' : 'campos obligatorios del formato de informe de supervisión deber de diligenciamiento',
  'COHER-01': 'supervisor debe exigir el cumplimiento del contrato imponer multas procedimiento sancionatorio ley 1474 de 2011 artículos 84 y 86',
  'COHER-02': 'certificación de cumplimiento sin ejecución acreditada veracidad de la certificación del supervisor',
  'COHER-03': 'calificación de obligaciones no aplica justificación formato informe de supervisión ICBF',
  'CLON-01': 'falsedad ideológica en documento público certificación contraria a la realidad código penal artículo 286',
  'CLON-02': 'fecha de la actividad de supervisión veracidad del informe periódico',
  'CLON-03': 'matriz de obligaciones del contrato clausulado suscrito otrosí modificatorio',
};

// Fundamento común a toda denuncia de veeduría: siempre se busca.
const CONSULTA_BASE = 'veeduría ciudadana control social ley 850 de 2003 deberes del supervisor ley 1474 de 2011 artículo 84 responsabilidad fiscal disciplinaria y penal';

// ── Corpus: embedding (Voyage) + búsqueda vectorial (Azure AI Search) ─────────
async function embeber(texto, voyageKey) {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${voyageKey}` },
    body: JSON.stringify({ model: 'voyage-law-2', input: [texto], input_type: 'query' }),
  });
  if (!res.ok) throw new Error(`Voyage ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return (await res.json()).data[0].embedding;
}

async function buscarCorpus(consulta, cfg, { k = 6, umbral = 0.35 } = {}) {
  const vector = await embeber(consulta, cfg.voyageKey);
  const res = await fetch(
    `${cfg.endpoint}/indexes/${cfg.index}/docs/search?api-version=2024-07-01`,
    {
      method: 'POST',
      headers: { 'api-key': cfg.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vectorQueries: [{ kind: 'vector', vector, fields: 'embedding', k }],
        select: 'id,content,title,doc_type,source',
      }),
    });
  if (!res.ok) throw new Error(`Azure Search ${res.status}: ${(await res.text()).slice(0, 160)}`);

  const data = await res.json();
  return (data.value ?? [])
    .filter(m => (m['@search.score'] ?? 0) >= umbral && m.content)
    .map(m => ({ titulo: m.title, tipo: m.doc_type, texto: m.content, score: m['@search.score'] }));
}

/**
 * Recupera el fundamento normativo de cada regla disparada.
 * Devuelve solo lo que EXISTE en el corpus. Lo que no aparece, no se cita.
 */
export async function fundamentar(hallazgos, {
  endpoint = process.env.NUMA_CORPUS_ENDPOINT,
  key      = process.env.NUMA_CORPUS_KEY,
  index    = process.env.NUMA_CORPUS_INDEX ?? 'corpus',
  voyageKey = process.env.VOYAGE_API_KEY,
} = {}) {
  if (!endpoint || !key || !voyageKey) {
    return {
      normas: [],
      sinCorpus: true,
      aviso: 'Sin acceso al corpus jurídico (faltan NUMA_CORPUS_ENDPOINT / NUMA_CORPUS_KEY / VOYAGE_API_KEY). La denuncia se redacta con los hechos y las cifras, SIN citar normas.',
    };
  }

  const cfg = { endpoint: endpoint.replace(/\/$/, ''), key, index, voyageKey };
  const reglas = [...new Set(hallazgos.map(h => h.regla_id))];
  const normas = [];
  const vistos = new Set();

  for (const consulta of [CONSULTA_BASE, ...reglas.map(r => CONSULTA_POR_REGLA[r]).filter(Boolean)]) {
    let frags = [];
    try { frags = await buscarCorpus(consulta, cfg); }
    catch (e) { console.warn(`[redactor] corpus: ${e.message}`); continue; }

    for (const f of frags) {
      const clave = (f.titulo ?? '') + '|' + f.texto.slice(0, 80);
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      normas.push(f);
    }
  }

  // Tope: el corpus puede devolver decenas de fragmentos casi iguales (la misma
  // ley troceada). Se ordena por relevancia y se conserva un fragmento por norma,
  // hasta 18 — suficiente para citar sin inflar el prompt del redactor.
  const porNorma = new Map();
  for (const n of normas.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))) {
    const norma = (n.titulo ?? '').split('—')[0].split('|')[0].trim().toLowerCase();
    if (!porNorma.has(norma)) porNorma.set(norma, n);
  }
  const top = [...porNorma.values()].slice(0, 18);

  return { normas: top, sinCorpus: false, aviso: top.length ? null : 'El corpus no devolvió fundamento para ninguna regla.' };
}

// ── Validación anti-alucinación ──────────────────────────────────────────────
// Extrae las normas citadas en el texto y confronta cada una contra el corpus
// recuperado. Lo que no esté respaldado, se reporta.
const RE_CITAS = /\b(?:Ley|Decreto|Resoluci[oó]n|Acuerdo)\s+(?:No\.?\s*)?(\d{1,5})\s+de\s+(\d{4})\b/gi;

// Valida las normas citadas en tres categorías:
//   · respaldadas  — el corpus tiene la norma → fundamento verificado, OK
//   · del_hecho    — la norma aparece en los HALLAZGOS (el motor la extrajo del
//                    documento real: "el informe aplica la Resolución 1264",
//                    "la obligación exige la Ley 2046"). Es EVIDENCIA, no
//                    fundamento inventado. El motor ya la verificó → OK.
//   · sin_respaldo — no está ni en el corpus ni en los hechos → posible
//                    alucinación → se rechaza.
//
// La distinción es la clave: solo el fundamento que AGREGA el redactor necesita
// corpus. Los datos que el motor probó pueden citarse sin más. Confundirlos —
// como hacía la versión anterior — obliga al redactor a borrar evidencia real.
export function validarCitas(texto, normas, hallazgos = []) {
  const corpus = normas.map(n => `${n.titulo ?? ''} ${n.texto}`).join(' \n ').toLowerCase();
  const hechos = hallazgos
    .map(h => `${h.evidencia_textual ?? ''} ${JSON.stringify(h.detalle ?? {})}`)
    .join(' ').toLowerCase();

  const citadas = new Map();
  for (const m of texto.matchAll(RE_CITAS)) {
    const clave = `${m[1]}/${m[2]}`;
    if (!citadas.has(clave)) citadas.set(clave, m[0].trim());
  }

  const respaldadas = [], del_hecho = [], sin_respaldo = [];
  for (const [clave, cita] of citadas) {
    const [num, anio] = clave.split('/');
    const re = new RegExp(`\\b${num}\\b[^.\\n]{0,40}\\b${anio}\\b`, 'i');
    if (re.test(corpus))      respaldadas.push(cita);
    else if (re.test(hechos)) del_hecho.push(cita);
    else                      sin_respaldo.push(cita);
  }
  // sinRespaldo se mantiene como alias para compatibilidad con el llamador.
  return { respaldadas, del_hecho, sinRespaldo: sin_respaldo, total: citadas.size };
}

// ── Redacción ────────────────────────────────────────────────────────────────
const SYSTEM = `Eres el redactor de una queja-denuncia formal de veeduría ciudadana en Colombia. Recibes HALLAZGOS YA CALCULADOS por un motor determinístico y los conviertes en prosa jurídica.

REGLAS ABSOLUTAS:

1. NO CALCULES NI RECALCULES. Cada hallazgo trae su cifra afirmada, su cifra calculada y su delta. Úsalas TAL CUAL. Si sumas, restas o "corriges" un número, inutilizas la denuncia.

2. NO AGREGUES HECHOS. Solo puedes afirmar lo que está en los hallazgos. Nada de contexto inventado, nada de inferencias sobre intenciones, nada de hechos "probables".

3. FUNDAMENTO vs EVIDENCIA — la regla más importante sobre normas:
   · Como FUNDAMENTO (para afirmar que un hecho viola el derecho — "esto vulnera la Ley X", "se subsume en el artículo Y"), SOLO podés invocar normas de la LISTA DE NORMAS VERIFICADAS. Si un hecho te parece que viola una norma que no está en la lista, describí el hecho y omití el fundamento normativo. Un fundamento inventado destruye la denuncia.
   · Como EVIDENCIA (parte del hecho que el motor ya probó — "el informe aplica la Resolución 1264 de 2017", "la obligación exige cumplir la Ley 2046 de 2020"), SÍ transcribí la norma tal como aparece en el hallazgo, aunque no esté en la lista verificada. Eso no es fundamento tuyo: es un dato que el motor extrajo del documento. Omitirlo mutila la evidencia.

4. EL HECHO SE AFIRMA; EL DELITO SE SUBSUME. Los hallazgos son aritméticos y documentales: afírmalos en indicativo, sin "presuntamente" ni "supuestamente" ("la suma de los desembolsos asciende a X", no "presuntamente ascendería"). Pero la calificación penal se redacta SIEMPRE como subsunción — "los hechos descritos se subsumen en el tipo penal del artículo X" — nunca como veredicto de culpabilidad, y solo si el artículo está en las normas verificadas.

5. NUMERACIÓN: las secciones van en números romanos (I, II, III...). Los hallazgos van en enteros consecutivos (1, 2, 3...), sin decimales ni subniveles.

6. Cada hallazgo debe indicar el DOCUMENTO y el FOLIO de donde sale, y transcribir su evidencia textual cuando la tenga.

7. En "documentos auditados" haz constar que fueron obtenidos del Sistema Electrónico de Contratación Pública SECOP II, con su fecha de captura y su hash SHA-256.

8. Separa las cuatro vías en secciones distintas: FISCAL, DISCIPLINARIA, PENAL y CONTRACTUAL. No las fundas en un genérico "acciones legales".

Lenguaje claro, directo y firme. Sin adjetivos de indignación: los números hablan solos.

Devuelve HTML limpio (h2, h3, p, ul, li, strong, table). Sin estilos en línea, sin colores. Negrilla solo en los hallazgos críticos.`;

export async function redactarDenuncia({ expediente, hallazgos, documentos, normas, sinCorpus }, {
  apiKey = process.env.ANTHROPIC_API_KEY, model = MODEL, intentos = 2,
} = {}) {
  if (!apiKey) throw new Error('Falta ANTHROPIC_API_KEY');
  if (!hallazgos?.length) throw new Error('Sin hallazgos: no hay denuncia que redactar');

  const listaNormas = sinCorpus || !normas?.length
    ? '(NINGUNA NORMA VERIFICADA — está PROHIBIDO citar normas. Redacta los hechos y las cifras, y en la sección de fundamento escribe: "Pendiente de fundamentación normativa.")'
    : normas.map((n, i) =>
        `[${i + 1}] ${n.titulo ?? 'sin título'}\n${n.texto.slice(0, 1400)}`).join('\n\n---\n\n');

  const contexto = {
    contrato: expediente,
    documentos_auditados: documentos,
    hallazgos: hallazgos.map((h, i) => ({
      numero: i + 1,
      regla: h.regla_id,
      documento: h.doc_nombre,
      folio: h.folio,
      cifra_afirmada: h.cifra_afirmada,
      cifra_calculada: h.cifra_calculada,
      delta: h.delta,
      hecho: h.evidencia_textual,
      detalle: h.detalle,
    })),
  };

  let ultimoAviso = '';
  for (let intento = 1; intento <= intentos; intento++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model, max_tokens: 16000, system: SYSTEM,
        messages: [{
          role: 'user',
          content: `NORMAS VERIFICADAS EN EL CORPUS (las únicas que puedes citar):\n\n${listaNormas}\n\n${'═'.repeat(60)}\n\nHALLAZGOS DEL MOTOR (ya calculados — no los recalcules):\n\n${JSON.stringify(contexto, null, 2)}\n\n${ultimoAviso}Redacta la queja-denuncia formal.`,
        }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);

    const data = await res.json();
    const html = data.content?.find(c => c.type === 'text')?.text ?? '';
    const citas = validarCitas(html, normas ?? [], hallazgos);

    // Solo rechazan las citas SIN respaldo (ni corpus ni hecho). Las del_hecho
    // son evidencia legítima del motor y NO cuentan como alucinación.
    if (!citas.sinRespaldo.length) {
      return { html, citas, tokens: data.usage, intentos: intento };
    }

    // Invocó como fundamento una norma que no está en el corpus ni en los hechos.
    ultimoAviso = `⚠ EL INTENTO ANTERIOR FUE RECHAZADO. Invocaste como fundamento normas que no están en la lista verificada NI aparecen en los hechos del motor: ${citas.sinRespaldo.join(', ')}. Quitá esas normas del FUNDAMENTO (describí el hecho sin ellas). Podés seguir mencionando normas que sí aparecen en los hallazgos como parte del hecho.\n\n`;
    console.warn(`[redactor] intento ${intento}: citas sin respaldo → ${citas.sinRespaldo.join(', ')}`);

    if (intento === intentos) {
      return {
        html, citas, tokens: data.usage, intentos: intento,
        revisionHumana: `El redactor insistió en citar normas que no están en el corpus: ${citas.sinRespaldo.join(', ')}. NO ENVIAR sin verificarlas a mano.`,
      };
    }
  }
}
