/**
 * MOTOR DE REGLAS — VEEDURÍA
 *
 * Principio rector: la IA extrae, el motor decide.
 *
 * NIVEL 1 (este archivo, parte 1) — reglas DOCUMENTALES sobre texto plano.
 *   Cero LLM, cero OCR. Cuestan ~$0 y son SEGURAS, porque son binarias: el
 *   patrón está o no está. Si el regex falla, produce un falso NEGATIVO (no lo
 *   ve), nunca un número equivocado.
 *
 * NIVEL 2 (parte 2) — reglas ARITMÉTICAS sobre campos ya extraídos.
 *   Requieren extracción estructurada (LLM con structured output). NUNCA regex:
 *   probamos sacar la forma de pago con regex sobre texto plano y dio
 *   $149.021.979 cuando la cifra real es $221.914.018 — pdftotext desarma la
 *   tabla y se come una cuota. Un hallazgo aritmético equivocado tumba la
 *   denuncia entera.
 *
 * Todo hallazgo sale con: regla_id, doc_id, folio y evidencia_textual.
 */

// ── Utilidades ────────────────────────────────────────────────────────────────
const norm = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

function contexto(txt, idx, antes = 90, despues = 150) {
  return norm(txt.slice(Math.max(0, idx - antes), idx + despues));
}

const H = (regla_id, doc, folio, evidencia_textual, detalle = {}) =>
  ({ regla_id, doc_id: doc.id, doc_nombre: doc.nombre, folio, evidencia_textual, detalle });

// Fechas dd/mm/aaaa → ISO. Descarta años imposibles (los radicados parecen fechas).
function fechasISO(txt) {
  const out = [];
  for (const m of txt.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) {
    const [, d, mo, y] = m;
    const yy = +y;
    if (yy < 1990 || yy > 2099) continue;
    if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) continue;
    out.push({ iso: `${y}-${String(+mo).padStart(2, '0')}-${String(+d).padStart(2, '0')}`, raw: m[0], idx: m.index });
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════════
// NIVEL 1 — reglas por documento
// ══════════════════════════════════════════════════════════════════════════════
export function reglasDocumento(doc, contrato) {
  const txt = doc.texto;
  const hallazgos = [];

  // ── DOC-04 · residuos de fórmula de hoja de cálculo en documento suscrito ──
  const formulas = [...txt.matchAll(/\+?[A-Z]{1,2}\d{1,4}:[A-Z]{1,2}\d{1,4}/g)];
  if (formulas.length) {
    hallazgos.push(H('DOC-04', doc, 'num. 6',
      contexto(txt, formulas[0].index, 120, 200),
      { referencias: formulas.length, ejemplos: formulas.slice(0, 5).map(m => m[0]) }));
  }

  // ── DOC-03 · el formato se firmó sin depurar el texto instructivo ──────────
  const placeholders = [...txt.matchAll(/\b[Xx]{4,}\b/g)];
  if (placeholders.length) {
    hallazgos.push(H('DOC-03', doc, 'varios',
      contexto(txt, placeholders[0].index),
      { campos: placeholders.length, marcadores: [...new Set(placeholders.map(m => m[0]))].slice(0, 6) }));
  }

  // ── DOC-02 · el expediente vive fuera de SECOP (Ley 1712/2014) ─────────────
  const repos = [...txt.matchAll(/(onedrive|sharepoint|my\.sharepoint)/gi)];
  if (repos.length) {
    const personal = /personal\/([a-z_]+)/i.exec(txt);
    hallazgos.push(H('DOC-02', doc, 'num. 14',
      contexto(txt, repos[0].index, 60, 220),
      { referencias: repos.length, cuenta_personal: personal?.[1] ?? null }));
  }

  // ── DOC-01 · el soporte remite al expediente de OTRO contrato ──────────────
  // El más grave: acredita que el informe se copió del de otro contratista.
  // OJO: los números viven dentro de URLs percent-encoded (…%2F76015292025%5F…),
  // así que \b NO sirve — la 'F' de '%2F' pega contra el primer dígito y anula
  // el word boundary. Se usa lookaround por dígito, no por carácter de palabra.
  const propio = contrato.referencia;                       // ej. 76014602025
  const ajenos = new Set();
  for (const m of txt.matchAll(/(?<!\d)(\d{11})(?!\d)/g)) {
    const n = m[1];
    if (n === propio) continue;
    if (n.slice(0, 4) !== propio.slice(0, 4)) continue;     // misma regional y serie
    ajenos.add(n);
  }
  if (ajenos.size) {
    const primero = [...ajenos][0];
    const idx = txt.indexOf(primero);
    const veces = (txt.match(new RegExp(primero, 'g')) ?? []).length;
    hallazgos.push(H('DOC-01', doc, 'num. 14',
      decodeURIComponent(contexto(txt, idx, 120, 160).replace(/%(?![0-9A-F]{2})/gi, '%25')),
      { contrato_auditado: propio, contratos_ajenos: [...ajenos], ocurrencias: veces }));
  }

  // ── CRON-02 · la supervisión se fechó antes de que el contrato existiera ───
  // Anclado al DATO, no a cualquier fecha del papel: el encabezado del formato
  // imprime su fecha de versión (12/08/2025 en el F1.P18.ABS v5) en TODAS las
  // páginas, y eso es anterior a muchos contratos sin que signifique nada. Una
  // fecha que se repite una vez por página es del membrete, no del contenido.
  const firma = contrato.fecha_firma;                       // ISO
  const todas = fechasISO(txt);
  const frecuencia = {};
  for (const f of todas) frecuencia[f.raw] = (frecuencia[f.raw] ?? 0) + 1;
  const UMBRAL_MEMBRETE = 5;                                // ~1 por página
  const previas = todas.filter(f => f.iso < firma && frecuencia[f.raw] < UMBRAL_MEMBRETE);

  if (previas.length) {
    const unicas = [...new Set(previas.map(f => f.raw))];
    const descartadas = [...new Set(todas.filter(f => f.iso < firma && frecuencia[f.raw] >= UMBRAL_MEMBRETE).map(f => f.raw))];
    hallazgos.push(H('CRON-02', doc, 'num. 2',
      contexto(txt, previas[0].idx),
      { fecha_firma_contrato: firma, fechas_anteriores: unicas.slice(0, 8),
        descartadas_por_membrete: descartadas }));
  }

  // ── COHER-03 · obligaciones calificadas masivamente N/A ────────────────────
  // Ojo: la nota (iv) del F1.P18.ABS dice que "Observaciones" NO es obligatorio.
  // El cargo NO es no haber observado: es que si NO hubo prestación del servicio,
  // la obligación se INCUMPLIÓ (va "NO", nota ii) y no "no aplica".
  const na = (txt.match(/\bN\/A\b/g) ?? []).length;
  const noAplica = (txt.match(/No\s+Aplica/gi) ?? []).length;
  const sinAtencion = /no\s+se\s+present[oó]\s+atenci[oó]n/i.test(txt);
  if (na >= 10 && sinAtencion) {
    const m = /no\s+se\s+present[oó]\s+atenci[oó]n[^.]{0,120}/i.exec(txt);
    hallazgos.push(H('COHER-03', doc, 'num. 14', norm(m?.[0] ?? ''),
      { celdas_na: na, soportes_no_aplica: noAplica,
        razon: 'La propia supervisión declara que no hubo prestación del servicio: eso es incumplimiento (nota ii), no inaplicabilidad.' }));
  }

  return hallazgos;
}

// ══════════════════════════════════════════════════════════════════════════════
// NIVEL 1 — reglas TRANSVERSALES (necesitan ver todos los informes juntos)
// ══════════════════════════════════════════════════════════════════════════════
export function reglasTransversales(docs, contrato) {
  const hallazgos = [];

  // ── CLON-02 · la misma fecha de supervisión arrastrada entre informes ──────
  const fechasSup = docs.map(d => {
    const m = /Fecha\s+en\s+la\s+que\s+realiza?\s+la\s+supervisi[oó]n[^\d]{0,120}(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(d.texto)
           ?? /supervisi[oó]n\s*\(desde\s+y\s+hasta\s+cuando\)[^\d]{0,120}(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(d.texto);
    return { doc: d, fecha: m?.[1] ?? null };
  }).filter(x => x.fecha);

  const distintas = new Set(fechasSup.map(x => x.fecha));
  if (fechasSup.length >= 2 && distintas.size === 1) {
    hallazgos.push(H('CLON-02', fechasSup[0].doc, 'num. 2',
      `Los ${fechasSup.length} informes consignan la misma fecha de supervisión: ${fechasSup[0].fecha}`,
      { fecha_unica: fechasSup[0].fecha, informes: fechasSup.length,
        periodos_distintos: docs.map(d => d.nombre) }));
  }

  // ── CLON-03 · matrices de obligaciones de resoluciones distintas ───────────
  // Un informe cita VARIAS resoluciones dentro del clausulado (1400/2020 de
  // cuenta maestra, 312/2019, etc.) — listarlas todas sería ruido. Lo que
  // importa es UNA: la resolución que adopta la MINUTA del contrato, que es la
  // primera del documento. Si difiere entre informes del mismo contrato, se
  // aplicaron dos matrices de obligaciones distintas sin otrosí que lo explique.
  const minuta = docs.map(d => {
    const m = /Resoluci[oó]n\s+(?:No\.?\s*)?(\d{3,4})\s+de\s+(\d{4})/i.exec(d.texto);
    return { doc: d, res: m ? `${m[1]}/${m[2]}` : null };
  }).filter(x => x.res);

  const distintasMinutas = [...new Set(minuta.map(x => x.res))];
  if (minuta.length >= 2 && distintasMinutas.length >= 2) {
    hallazgos.push(H('CLON-03', minuta[0].doc, 'num. 14',
      `Los informes del mismo contrato invocan matrices de obligaciones de resoluciones distintas: ${
        minuta.map(x => `${x.doc.nombre} → Resolución ${x.res}`).join('; ')}`,
      { resoluciones: distintasMinutas,
        por_informe: minuta.map(x => ({ informe: x.doc.nombre, resolucion: x.res })) }));
  }

  // ── CLON-01 · informe clonado (mismo cuerpo narrativo entre períodos) ──────
  // Se compara solo la matriz de obligaciones (num. 14), que es donde se copia.
  const cuerpo = (t) => {
    const i = t.search(/14\.\s*Cumplimiento\s+de\s+Obligaciones/i);
    return i < 0 ? '' : norm(t.slice(i)).toLowerCase().replace(/\d/g, '');
  };
  for (let i = 0; i + 1 < docs.length; i++) {
    const a = cuerpo(docs[i].texto), b = cuerpo(docs[i + 1].texto);
    if (!a || !b) continue;
    const min = Math.min(a.length, b.length);
    let iguales = 0;
    for (let k = 0; k < min; k++) if (a[k] === b[k]) iguales++;
    const similitud = min ? iguales / min : 0;
    if (similitud > 0.92) {
      hallazgos.push(H('CLON-01', docs[i + 1], 'num. 14',
        `La matriz de obligaciones es ${(similitud * 100).toFixed(0)}% idéntica a la del informe anterior, pese a certificar un período distinto.`,
        { similitud: +(similitud * 100).toFixed(1), contra: docs[i].nombre }));
    }
  }

  return hallazgos;
}

export function motorNivel1(docs, contrato) {
  const hallazgos = [];
  for (const d of docs) hallazgos.push(...reglasDocumento(d, contrato));
  hallazgos.push(...reglasTransversales(docs, contrato));
  return hallazgos;
}

// ══════════════════════════════════════════════════════════════════════════════
// NIVEL 2 — reglas ARITMÉTICAS
//
// Operan SOLO sobre campos ya transcritos por el extractor. Jamás sobre texto.
// Cada hallazgo lleva cifra_afirmada, cifra_calculada y delta: cualquiera puede
// rehacer la cuenta y llegar al mismo número. Eso es lo que la sostiene ante un
// ente de control.
// ══════════════════════════════════════════════════════════════════════════════
const TOLERANCIA = 1;                      // pesos — redondeos, no hallazgos
const suma = (arr, campo = 'valor') => (arr ?? []).reduce((s, x) => s + (Number(x?.[campo]) || 0), 0);

// ── Obligaciones incumplidas: las cuenta el TEXTO, no el modelo ───────────────
// La matriz del numeral 14 ocupa una decena de páginas. Mandársela al LLM
// multiplica el costo por cinco y él la cuenta peor: contar celdas es
// determinista. Se cuenta sobre el texto completo (pdftotext, gratis).
//
// TRAMPA, y no es menor: hay que contar lo DILIGENCIADO, no lo IMPRESO. El
// numeral 13 del formulario trae impresa la lista de sanciones posibles —
// "Declaratoria de Total incumplimiento con cobro de perjuicios (art. 17 Ley
// 1150 de 2007)"— aparezca o no una sanción. Un regex que buscara "incumplimiento"
// la contaba como incumplimiento reconocido y producía un FALSO POSITIVO en un
// informe donde el supervisor no reconoció ninguno. Denunciar eso —"reconoció el
// incumplimiento y no sancionó"— contra alguien que no reconoció nada es
// exactamente lo que un abogado defensor usa para tumbar la denuncia entera.
//
// Solo cuenta la afirmación que ESCRIBIÓ el supervisor: "no cumplió".
// Medido contra los 3 informes reales: 0, 2 y 2 — idéntico al modelo leyendo el
// PDF completo.
const RE_INCUMPLIMIENTO = /\bno\s+cumpli[oó]\b/gi;

// ¿Hay al menos UNA obligación incumplida reconocida por el supervisor?
//
// Devuelve booleano, no número — a propósito. El CONTEO de obligaciones es
// inestable por dos frentes y ninguno tiene arreglo determinista:
//   · el LLM cuenta distinto en cada corrida del MISMO PDF (120 vs 27 obligaciones
//     cumplidas entre dos pasadas; 2 vs 0 incumplidas) — contar filas de una tabla
//     de 13 páginas es justo lo que un modelo hace mal y sin reproducibilidad;
//   · el regex sobre texto plano tampoco: pdftotext destruye las filas, dos
//     incumplimientos con la misma observación colapsan a uno, y el texto impreso
//     del numeral 13 mete falsos positivos.
//
// Pero COHER-01 no necesita el número: necesita saber si el supervisor reconoció
// algún incumplimiento y aun así no sancionó. Eso es un SÍ/NO, y el regex lo
// acierta — busca solo la afirmación que ESCRIBIÓ el supervisor ("no cumplió"),
// no el catálogo de sanciones impreso en la plantilla.
export function reconoceIncumplimiento(textoCompleto) {
  return /\bno\s+cumpli[oó]\b/i.test(textoCompleto ?? '');
}

export function reglasAritmeticas(doc, c, contrato) {
  const hallazgos = [];
  const A = (regla, folio, afirmada, calculada, texto, detalle = {}) => {
    const delta = (calculada ?? 0) - (afirmada ?? 0);
    hallazgos.push({
      regla_id: regla, doc_id: doc.id, doc_nombre: doc.nombre, folio,
      cifra_afirmada: afirmada, cifra_calculada: calculada, delta,
      evidencia_textual: texto, detalle,
    });
  };

  // ── ARIT-01 · la forma de pago no cubre el valor del contrato ──────────────
  const sumaCuotas = suma(c.forma_pago);
  const total = c.valor_total ?? contrato.valor;
  if (c.forma_pago?.length && total && Math.abs(sumaCuotas - total) > TOLERANCIA) {
    A('ARIT-01', 'num. 5',
      sumaCuotas, total,
      `La forma de pago desagrega ${c.forma_pago.length} desembolsos que suman $${sumaCuotas.toLocaleString('es-CO')}, frente a un valor total del contrato de $${total.toLocaleString('es-CO')}.`,
      { cuotas: c.forma_pago, suma_cuotas: sumaCuotas, valor_total: total,
        sin_cronograma: total - sumaCuotas });
  }

  // ── ARIT-02 · pagó con ejecución certificada en cero ───────────────────────
  if ((c.pagos_al_contratista ?? 0) > 0 && (c.valor_ejecutado ?? 0) === 0) {
    A('ARIT-02', 'num. 11',
      0, c.pagos_al_contratista,
      `El numeral 11 certifica VALOR TOTAL EJECUTADO $0,00 y, en el mismo cuadro, PAGOS EFECTUADOS AL CONTRATISTA $${(c.pagos_al_contratista).toLocaleString('es-CO')}.`,
      { valor_ejecutado: c.valor_ejecutado, pagos: c.pagos_al_contratista });
  }

  // ── ARIT-03 · lo certificado no concilia con lo pagado ─────────────────────
  const cert = suma(c.certificaciones_pago);
  const pag  = suma(c.pagos_efectuados);
  if (cert > 0 && Math.abs(cert - pag) > TOLERANCIA) {
    A('ARIT-03', 'num. 7 y 8',
      pag, cert,
      `El numeral 7 certifica pagos por $${cert.toLocaleString('es-CO')} y el numeral 8 reporta pagos efectuados por $${pag.toLocaleString('es-CO')}.`,
      { certificado: cert, pagado: pag, sin_conciliar: cert - pag });
  }

  // ── ARIT-04 · valor absurdo frente al contrato ─────────────────────────────
  if (c.valor_vf && total && c.valor_vf > 50 * total) {
    A('ARIT-04', 'num. 5',
      total, c.valor_vf,
      `Se consigna un Valor de VF de $${c.valor_vf.toLocaleString('es-CO')} en un contrato cuyo valor total es $${total.toLocaleString('es-CO')}.`,
      { veces_el_contrato: Math.round(c.valor_vf / total) });
  }

  // ── CRON-01 · certificación de pago anticipada ─────────────────────────────
  for (const cp of (c.certificaciones_pago ?? [])) {
    if (!cp.fecha_certificacion || !c.periodo_hasta) continue;
    if (cp.fecha_certificacion < c.periodo_hasta) {
      const dias = Math.round((new Date(c.periodo_hasta) - new Date(cp.fecha_certificacion)) / 864e5);
      hallazgos.push({
        regla_id: 'CRON-01', doc_id: doc.id, doc_nombre: doc.nombre, folio: 'num. 7',
        cifra_afirmada: null, cifra_calculada: dias, delta: dias,
        evidencia_textual: `La certificación de pago del período "${cp.periodo_certificado ?? '—'}" por $${(cp.valor ?? 0).toLocaleString('es-CO')} se expidió el ${cp.fecha_certificacion}, cuando aún faltaban ${dias} días para que terminara el período certificado (${c.periodo_hasta}).`,
        detalle: { certificacion: cp, periodo_hasta: c.periodo_hasta, dias_antes: dias },
      });
    }
  }

  // ── CRON-04 · respaldo presupuestal retroactivo ────────────────────────────
  if (c.adicion_cdp_fecha && c.fecha_documento_adicion &&
      c.adicion_cdp_fecha < c.fecha_documento_adicion) {
    const dias = Math.round((new Date(c.fecha_documento_adicion) - new Date(c.adicion_cdp_fecha)) / 864e5);
    hallazgos.push({
      regla_id: 'CRON-04', doc_id: doc.id, doc_nombre: doc.nombre, folio: 'num. 5',
      cifra_afirmada: null, cifra_calculada: dias, delta: dias,
      evidencia_textual: `El CDP de la adición opera desde el ${c.adicion_cdp_fecha}, ${dias} días ANTES del documento de adición que lo origina (${c.fecha_documento_adicion}).`,
      detalle: { cdp_adicion: c.adicion_cdp_fecha, documento_adicion: c.fecha_documento_adicion },
    });
  }

  // ── DUP-01 · el CDP/RP de la adición duplica el del contrato principal ─────
  const cdpDup = c.adicion_cdp_numero &&
    [c.cdp_numero, c.cdp2_numero].filter(Boolean).includes(c.adicion_cdp_numero);
  const rpDup = c.adicion_rp_numero &&
    [c.rp_numero, c.rp2_numero].filter(Boolean).includes(c.adicion_rp_numero);
  if (cdpDup || rpDup) {
    hallazgos.push({
      regla_id: 'DUP-01', doc_id: doc.id, doc_nombre: doc.nombre, folio: 'num. 5',
      cifra_afirmada: null, cifra_calculada: null, delta: null,
      evidencia_textual: `El mismo consecutivo presupuestal ampara el valor inicial del contrato y su adición: CDP ${c.adicion_cdp_numero}, RP ${c.adicion_rp_numero}. Un mismo CDP y un mismo RP no pueden respaldar simultáneamente dos compromisos distintos.`,
      detalle: { cdp_principal: c.cdp_numero, cdp2: c.cdp2_numero, cdp_adicion: c.adicion_cdp_numero,
                 rp_principal: c.rp_numero, rp2: c.rp2_numero, rp_adicion: c.adicion_rp_numero },
    });
  }

  // ── COHER-01 · reconoce incumplimiento y no ejerce ninguna acción ──────────
  // Fundamento directo: nota (ii) del F1.P18.ABS — si marca "no" cumplida, debe
  // indicar las razones Y QUÉ ACCIONES SE HAN TOMADO sobre dicho incumplimiento.
  //
  // La condición es un SÍ/NO (¿reconoció algún incumplimiento?), no un conteo.
  // c.reconoce_incumplimiento lo pone el TEXTO PLANO (regex sobre "no cumplió"),
  // no el LLM: es la señal reproducible. Sin fallback al conteo del LLM — ese
  // número no es estable y no debe decidir un hallazgo.
  const hayIncumplimiento = c.reconoce_incumplimiento === true;
  if (hayIncumplimiento && !c.tiene_sanciones && !c.tiene_descuentos) {
    hallazgos.push({
      regla_id: 'COHER-01', doc_id: doc.id, doc_nombre: doc.nombre, folio: 'num. 13 y 14',
      cifra_afirmada: null, cifra_calculada: null, delta: null,
      evidencia_textual: `El numeral 14 reconoce el incumplimiento de al menos una obligación contractual, y los numerales 9 y 13 —descuentos y sanciones— quedan íntegramente en blanco: no se registra requerimiento, sanción ni descuento.`,
      detalle: { incumplidas: c.obligaciones_incumplidas ?? [],
                 sanciones: c.tiene_sanciones, descuentos: c.tiene_descuentos },
    });
  }

  // ── COHER-02 · certifica cumplimiento con ejecución en cero ────────────────
  // Condición sobre el BOOLEANO (¿declaró alguna cumplida?), no el conteo. Y la
  // evidencia NO cita cuántas: ese número no es reproducible entre corridas, así
  // que ponerlo en la denuncia es munición para el defensor. El hecho sólido es
  // cualitativo — certifica cumplimiento y a la vez reporta ejecución de $0.
  if (c.declara_alguna_cumplida === true && (c.valor_ejecutado ?? 0) === 0 && (c.pagos_al_contratista ?? 0) > 0) {
    hallazgos.push({
      regla_id: 'COHER-02', doc_id: doc.id, doc_nombre: doc.nombre, folio: 'num. 11 y 14',
      cifra_afirmada: null, cifra_calculada: null, delta: null,
      evidencia_textual: `El numeral 14 certifica el cumplimiento de obligaciones contractuales, mientras el numeral 11 reporta un valor total ejecutado de $0,00 y pagos al contratista por $${(c.pagos_al_contratista).toLocaleString('es-CO')}.`,
      detalle: { valor_ejecutado: c.valor_ejecutado, pagos_al_contratista: c.pagos_al_contratista },
    });
  }

  return hallazgos;
}
