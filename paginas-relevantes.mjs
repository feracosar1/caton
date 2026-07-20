/**
 * SELECCIÓN DE PÁGINAS POR CONTENIDO — no por número.
 *
 * Mandarle a Claude el PDF entero cuesta 7× más de lo necesario: en un informe
 * de 17 páginas, los numerales con las cifras (1–13) ocupan las primeras y el
 * resto es la matriz de obligaciones, que ya contamos gratis con regex.
 *
 * PERO recortar a "las primeras 4 páginas" es una trampa: funciona para ESTE
 * formato y ESTE contrato. Un informe con más partes, un contrato de obra, o una
 * versión nueva del formato corren las tablas a otras páginas — y el recorte
 * cortaría justo donde están los datos, sin dar error. El motor no encontraría
 * la forma de pago, no habría hallazgo, y nadie se enteraría.
 *
 * Acá se buscan los numerales por su TEXTO, página por página (pdftotext, gratis),
 * y se manda solo el rango donde efectivamente están.
 *
 * Si no se reconoce la estructura → se manda el PDF COMPLETO. Un documento raro
 * cuesta $1 en vez de $0.20; un hallazgo perdido cuesta la denuncia.
 */

import { execSync } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs';

// Los numerales cuyo contenido alimenta las reglas aritméticas del motor.
// Cada uno con las variantes que aparecen en la práctica (el formato se
// diligencia a mano y el OCR/extracción no siempre respeta mayúsculas ni tildes).
const NUMERALES_CLAVE = [
  // El numeral 1 trae el PERÍODO del informe. Sin él, la regla CRON-01
  // (certificación de pago expedida antes de que terminara el período) no tiene
  // contra qué comparar y deja de dispararse — en silencio.
  { n: 1,  re: /1\.?\s*datos\s+generales/i,                    titulo: 'Datos generales (período)' },
  { n: 2,  re: /2\.?\s*datos\s+(del\s+)?supervisor/i,          titulo: 'Datos del supervisor' },
  { n: 5,  re: /5\.?\s*informaci[oó]n\s+presupuestal/i,        titulo: 'Información presupuestal' },
  { n: 7,  re: /7\.?\s*certificaciones?\s+para\s+pagos?/i,     titulo: 'Certificaciones de pago' },
  { n: 8,  re: /8\.?\s*pagos?\s+efectuados?/i,                 titulo: 'Pagos efectuados' },
  { n: 9,  re: /9\.?\s*descuentos?/i,                          titulo: 'Descuentos' },
  { n: 11, re: /11\.?\s*resumen\s+ejecuci[oó]n/i,              titulo: 'Resumen de ejecución' },
  { n: 12, re: /12\.?\s*garant[ií]as/i,                        titulo: 'Garantías' },
  { n: 13, re: /13\.?\s*sanciones/i,                           titulo: 'Sanciones' },
];

// Texto de UNA página, sin cargar el PDF entero en memoria.
function textoDePagina(rutaPdf, pagina) {
  try {
    return execSync(`pdftotext -layout -enc UTF-8 -f ${pagina} -l ${pagina} "${rutaPdf}" - 2>/dev/null`,
      { maxBuffer: 8 * 1024 * 1024 }).toString();
  } catch { return ''; }
}

function numeroDePaginas(rutaPdf) {
  try {
    const info = execSync(`pdfinfo "${rutaPdf}" 2>/dev/null`, { maxBuffer: 1024 * 64 }).toString();
    return Number(/Pages:\s+(\d+)/.exec(info)?.[1]) || 0;
  } catch { return 0; }
}

/**
 * Devuelve { pdf, paginas, detectados, motivo }.
 * Si no se reconocen los numerales, devuelve el PDF completo con motivo explícito.
 */
export function recortarAloRelevante(pdfBuffer, { maxPaginasBusqueda = 12 } = {}) {
  const base = `/tmp/vd_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const src  = `${base}.pdf`;
  const tmp  = [];

  try {
    writeFileSync(src, pdfBuffer);
    const total = numeroDePaginas(src);
    if (!total) return { pdf: pdfBuffer, paginas: null, detectados: [], motivo: 'no se pudo leer el PDF' };

    // 1. ¿En qué página aparece cada numeral clave?
    const encontrados = new Map();
    const hasta = Math.min(total, maxPaginasBusqueda);
    for (let p = 1; p <= hasta; p++) {
      const txt = textoDePagina(src, p);
      if (!txt) continue;
      for (const num of NUMERALES_CLAVE) {
        if (!encontrados.has(num.n) && num.re.test(txt)) encontrados.set(num.n, p);
      }
    }

    // 2. Si no reconocemos la estructura, NO adivinamos: va el PDF completo.
    //    Falta el 5 (presupuesto) o el 11 (ejecución) = no es un F1.P18.ABS
    //    reconocible, o el formato cambió. Mejor pagar de más que perder el caso.
    const criticos = [5, 11];
    const faltan = criticos.filter(n => !encontrados.has(n));
    if (faltan.length) {
      return {
        pdf: pdfBuffer, paginas: null,
        detectados: [...encontrados.entries()].map(([n, p]) => ({ numeral: n, pagina: p })),
        motivo: `no se ubicaron los numerales ${faltan.join(' y ')} — se envía el documento completo (${total} pp)`,
      };
    }

    // 3. Rango que cubre TODOS los numerales hallados, + 1 de colchón:
    //    una tabla puede desbordarse a la página siguiente.
    const paginas = [...encontrados.values()];
    const desde = Math.max(1, Math.min(...paginas));
    const hastaPag = Math.min(total, Math.max(...paginas) + 1);

    if (hastaPag - desde + 1 >= total) {
      return { pdf: pdfBuffer, paginas: null,
               detectados: [...encontrados.entries()].map(([n, p]) => ({ numeral: n, pagina: p })),
               motivo: 'los numerales cubren todo el documento' };
    }

    // 4. Recortar con poppler
    execSync(`pdfseparate -f ${desde} -l ${hastaPag} "${src}" "${base}-%d.pdf" 2>/dev/null`);
    const partes = [];
    for (let p = desde; p <= hastaPag; p++) {
      const f = `${base}-${p}.pdf`;
      if (existsSync(f)) { partes.push(f); tmp.push(f); }
    }
    if (!partes.length) throw new Error('pdfseparate no produjo páginas');

    const out = `${base}-out.pdf`; tmp.push(out);
    execSync(`pdfunite ${partes.map(f => `"${f}"`).join(' ')} "${out}" 2>/dev/null`);

    return {
      pdf: readFileSync(out),
      paginas: { desde, hasta: hastaPag, de: total },
      detectados: [...encontrados.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([n, p]) => ({ numeral: n, pagina: p, titulo: NUMERALES_CLAVE.find(x => x.n === n).titulo })),
      motivo: null,
    };
  } catch (e) {
    // Ante cualquier problema: el documento completo. Nunca recortar a ciegas.
    return { pdf: pdfBuffer, paginas: null, detectados: [], motivo: `fallo al recortar (${e.message}) — se envía completo` };
  } finally {
    for (const f of [src, ...tmp]) { try { unlinkSync(f); } catch { /* */ } }
  }
}
