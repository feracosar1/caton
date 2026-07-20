/**
 * EXTRACTOR F1.P18.ABS — el ÚNICO lugar donde interviene la IA.
 *
 * Su trabajo es TRANSCRIBIR el formato de informe de supervisión del ICBF a
 * campos estructurados. No decide, no calcula, no interpreta. Después el motor
 * determinístico hace la aritmética sobre estos campos y produce los hallazgos.
 *
 * Por qué el PDF va directo a Claude y no pasa por pdftotext:
 *   pdftotext desarma las tablas. Extrayendo la forma de pago con regex sobre su
 *   salida obtuvimos $149.021.979 cuando la cifra real es $221.914.018 — se comió
 *   una cuota. El PDF nativo conserva el layout y las celdas quedan asociadas a
 *   su fila. Para la aritmética eso no es un lujo: es la diferencia entre una
 *   denuncia que se sostiene y una que tumban.
 *
 * El esquema sale de la plantilla oficial en blanco (F1.P18.ABS v5, .xlsx),
 * no de adivinar los campos.
 */

import { recortarAloRelevante } from './paginas-relevantes.mjs';

// Sonnet 4.6, medido: 16/16 campos críticos. NO bajar a Haiku 4.5 — dio 8/16, y
// falla en la peor dirección posible: donde el informe dice VALOR EJECUTADO $0
// con pagos hechos (que es el hallazgo), Haiku "corrige" el absurdo y transcribe
// el valor pagado. El hallazgo desaparece y el supervisor queda exonerado.
// Sonnet 5 dio 15/16 (perdió un pago). El ahorro no está en el modelo: está en
// no mandarle páginas que no hacen falta (ver paginas-relevantes.mjs).
const MODEL_DEFAULT = 'claude-sonnet-4-6';

const num  = { type: ['number', 'null'] };
const str  = { type: ['string', 'null'] };
const date = { type: ['string', 'null'], description: 'AAAA-MM-DD, o null si está en blanco' };

const SCHEMA = {
  type: 'object',
  properties: {
    // 1. Datos generales
    numero_informe:  { type: ['integer', 'null'] },
    periodo_desde:   date,
    periodo_hasta:   date,
    fecha_emision:   date,
    valor_inicial:   num,

    // 2. Datos supervisor
    fecha_supervision: { ...date, description: 'Num. 2 — "fecha en la que realiza la supervisión". Transcribir tal cual, aunque parezca imposible.' },
    supervisor:        str,

    // 5. Información presupuestal
    cdp_numero: str, cdp_fecha: date, cdp_valor: num,
    rp_numero:  str, rp_fecha:  date, rp_valor:  num,
    cdp2_numero: { ...str, description: 'Segundo CDP si el numeral 5 registra dos' },
    cdp2_fecha: date, cdp2_valor: num,
    rp2_numero: str, rp2_fecha: date, rp2_valor: num,

    adicion_cdp_numero: str,
    adicion_cdp_fecha:  { ...date, description: 'Fecha inicial y/o de operación del CDP de la adición' },
    adicion_rp_numero:  str,
    adicion_rp_fecha:   date,
    adicion_valor:      num,
    fecha_documento_adicion: date,
    valor_vf: { ...num, description: 'Campo "Valor de VF" (vigencia futura), si aparece' },

    forma_pago: {
      type: 'array',
      description: 'Cada desembolso del cuadro "Forma de Pago". TRANSCRIBIR TODOS — no omitir ninguno.',
      items: {
        type: 'object',
        properties: {
          orden: { type: ['integer', 'null'] },
          tipo:  str,
          valor: num,
        },
      },
    },
    valor_total: { ...num, description: '(=) VALOR TOTAL después de modificaciones' },

    // 7. Certificaciones de pago suscritas por el supervisor
    certificaciones_pago: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          periodo_certificado: str,
          fecha_certificacion: date,
          valor: num,
          ubicacion_soporte: str,
        },
      },
    },

    // 8. Pagos efectuados según estado de cuenta
    pagos_efectuados: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          fecha: date,
          valor: num,
          orden_pago: str,
        },
      },
    },

    // 11. Resumen ejecución presupuestal acumulado
    valor_ejecutado:      num,
    valor_ejecutado_icbf: num,
    pagos_al_contratista: num,
    valor_a_liberar:      num,
    saldo_por_pagar:      num,

    // 13. Sanciones · 9. Descuentos — vacío significa que NO impuso ninguna
    tiene_sanciones:  { type: 'boolean' },
    tiene_descuentos: { type: 'boolean' },

    // 14. Cumplimiento de obligaciones
    // NO se piden CONTEOS. El número que el LLM saca de una matriz de 13 páginas
    // no es reproducible: dio 27 en una corrida y 120 en otra, del mismo PDF.
    // Solo booleanos estructurales, que sí son estables entre corridas. Contar
    // celdas de una tabla no es tarea de IA.
    declara_alguna_cumplida: { type: 'boolean',
      description: '¿El numeral 14 califica AL MENOS UNA obligación como cumplida (SI)? true o false — NO un conteo.' },
    obligaciones_incumplidas: {
      type: 'array',
      description: 'Las obligaciones marcadas NO cumplidas, con su texto y su observación LITERAL. Transcribir cada una, no contarlas.',
      items: {
        type: 'object',
        properties: { texto: str, observacion: str },
      },
    },

    // 15. Riesgos — TRANSCRIBE la casilla del numeral 15, no infieras si el
    // contrato es riesgoso. Si la casilla no está marcada, null.
    riesgo_alta_probabilidad: { type: ['boolean', 'null'],
      description: 'Casilla del numeral 15 "¿riesgo con alta probabilidad de ocurrencia?". Transcribir lo marcado; null si no está.' },
  },
  required: ['numero_informe', 'forma_pago', 'certificaciones_pago', 'pagos_efectuados',
             'tiene_sanciones', 'tiene_descuentos', 'declara_alguna_cumplida'],
};

const SYSTEM = `Eres un transcriptor de formularios. Tu ÚNICA función es copiar a campos estructurados lo que dice un Informe de Supervisión del ICBF (formato F1.P18.ABS).

REGLAS ABSOLUTAS:
1. NO calcules. NO sumes. NO restes. NO promedies. Si el documento dice tres cifras, devuelve las tres — nunca su suma.
2. NO interpretes ni corrijas. Si una fecha es imposible (anterior al contrato), transcríbela igual. Si un valor parece absurdo, transcríbelo igual. Detectar eso es trabajo de otro.
3. NO infieras lo que "debería" decir. Campo en blanco → null. Tabla vacía → [].
4. Los valores en pesos van como número, sin puntos ni símbolos: $72.892.039 → 72892039.
5. Las fechas van AAAA-MM-DD. Si el documento dice 16/06/2025 → "2025-06-16".
6. En "forma_pago" transcribe TODOS los desembolsos del cuadro. Omitir uno falsea la aritmética que hará el motor.

Cualquier cálculo, comparación o juicio lo hace un motor determinístico después. Tú solo transcribes.`;

// Cuerpo de la petición. Se comparte entre la vía en vivo y la del Batch API,
// para que las dos manden exactamente lo mismo y una tanda nocturna no pueda
// diferir de una prueba interactiva.
// RECORTE APAGADO POR DEFECTO. Medido, no supuesto:
//
//   PDF completo ....... US$1.02 · 13/13 hallazgos · 20/20 campos
//   recorte (pp. 1–5) .. US$0.27 · 12/13 hallazgos · 20/20 campos
//
// El hallazgo que se pierde es COHER-01 — "reconoce el incumplimiento y no
// sanciona" — porque contar las obligaciones marcadas NO exige ver la matriz
// entera (numeral 14, una decena de páginas). Se intentó contarlas por regex
// sobre el texto plano y no se puede: las dos obligaciones incumplidas comparten
// la misma observación literal, en filas distintas. Sin dedup el regex cuenta de
// más (y el texto IMPRESO del numeral 13 —"Declaratoria de Total incumplimiento
// con cobro de perjuicios"— produce un falso positivo donde el supervisor no
// reconoció nada); con dedup cuenta de menos. pdftotext destruyó las filas y no
// hay regex que las devuelva.
//
// La diferencia de costo son 37 centavos por contrato — auditando 50 al mes,
// US$18. No vale ni perder un cargo grave ni arriesgar un falso positivo en una
// denuncia contra una funcionaria con nombre propio.
//
// El ahorro real y sin riesgo es el Batch API: mismos tokens, misma precisión,
// mitad de precio (ver extractor-batch.mjs).
const RECORTAR_POR_DEFECTO = false;

export function construirPeticion(pdfBuffer, { model = MODEL_DEFAULT, recortar = RECORTAR_POR_DEFECTO } = {}) {
  const recorte = recortar
    ? recortarAloRelevante(pdfBuffer)
    : { pdf: pdfBuffer, paginas: null, detectados: [], motivo: 'recorte desactivado — pierde COHER-01' };
  return {
    recorte,
    body: {
      model,
      max_tokens: 8000,
      system: SYSTEM,
      tools: [{
        name: 'transcribir_informe',
        description: 'Transcribe los campos del informe de supervisión. Solo transcripción literal.',
        input_schema: SCHEMA,
      }],
      tool_choice: { type: 'tool', name: 'transcribir_informe' },
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: recorte.pdf.toString('base64') },
          },
          {
            type: 'text',
            text: 'Transcribe este Informe de Supervisión a los campos del esquema. Copia literalmente, sin calcular ni interpretar nada.',
          },
        ],
      }],
    },
  };
}

export function leerTranscripcion(data) {
  const use = data.content?.find(c => c.type === 'tool_use');
  if (!use) throw new Error('El modelo no devolvió la transcripción estructurada');
  return use.input;
}

export async function extraerInforme(pdfBuffer, { apiKey = process.env.ANTHROPIC_API_KEY, model = MODEL_DEFAULT } = {}) {
  if (!apiKey) throw new Error('Falta ANTHROPIC_API_KEY');

  const { body, recorte } = construirPeticion(pdfBuffer, { model });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const data = await res.json();
  return { campos: leerTranscripcion(data), tokens: data.usage, recorte };
}
