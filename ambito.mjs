/**
 * ÁMBITO DE COMPETENCIA — quién puede ver qué.
 *
 * Cada cliente (contraloría/veeduría) tiene un ámbito con dos ejes + una lista:
 *   · territorial — nivel + departamentos + municipios + orden (nacional/territorial)
 *   · temático    — sectores (Transporte, Salud, Educación…)
 *   · sujetos de control — NITs explícitos (los "502 de Antioquia"); si está, MANDA.
 *
 * Determinista sobre los campos reales de SECOP: departamento, ciudad, orden,
 * sector, nit_entidad. Dos formas de aplicarlo:
 *   · clausulasSoQL(ambito)      → recorta la query a Socrata (búsqueda/grafo) — barato
 *   · dentroDelAmbito(fila, amb) → predicado post-hoc (para lo ya traído)
 *
 * Ejemplos (del brief):
 *   Contraloría de Antioquia → { nivel:'departamental', orden:'territorial', departamentos:['Antioquia'] }
 *                              o { sujetos_control:[...502 NITs] }
 *   Contraloría Nacional     → AMBITO_NACIONAL (ve todo)
 *   Contraloría Mpal Medellín→ { nivel:'municipal', departamentos:['Antioquia'], municipios:['Medellín'] }
 *   Veeduría alimentación    → { sectores:['Educación','Inclusión Social y Reconciliación'] }
 *   Veeduría de Córdoba      → { orden:'territorial', departamentos:['Córdoba'] }
 */

export const AMBITO_NACIONAL = Object.freeze({
  nivel: 'nacional', orden: 'ambos', departamentos: [], municipios: [], sectores: null, sujetos_control: [],
});

const up  = (s) => (s ?? '').toString().toUpperCase().trim();
const esc = (s) => String(s).replace(/'/g, "''");

// ¿El ámbito es "abierto" (ve todo)? nacional, ambos órdenes, sin filtros ni whitelist.
export function esNacionalPleno(a) {
  return !a || (a.orden === 'ambos' && !a.departamentos?.length && !a.municipios?.length
    && !a.sectores?.length && !a.sujetos_control?.length && !a.objeto);
}

// Predicado: ¿la fila (un contrato de SECOP) cae dentro del ámbito?
export function dentroDelAmbito(fila, ambito) {
  if (esNacionalPleno(ambito)) return true;
  // 1) La whitelist de sujetos de control manda sobre todo.
  if (ambito.sujetos_control?.length) return ambito.sujetos_control.includes(fila.nit_entidad);
  // 2) Orden nacional / territorial.
  if (ambito.orden && ambito.orden !== 'ambos') {
    const esNacional = up(fila.orden) === 'NACIONAL';
    if (ambito.orden === 'nacional'   && !esNacional) return false;
    if (ambito.orden === 'territorial' && esNacional) return false;
  }
  // 3) Territorial.
  if (ambito.departamentos?.length && !ambito.departamentos.map(up).includes(up(fila.departamento))) return false;
  if (ambito.municipios?.length    && !ambito.municipios.map(up).includes(up(fila.ciudad)))         return false;
  // 4) Temático (por sector y/o por objeto del contrato).
  if (ambito.sectores?.length && !ambito.sectores.map(up).includes(up(fila.sector))) return false;
  if (ambito.objeto && !up(fila.objeto ?? fila.objeto_del_contrato).includes(up(ambito.objeto))) return false;
  return true;
}

export function filtrarPorAmbito(filas, ambito) {
  return esNacionalPleno(ambito) ? filas : filas.filter(f => dentroDelAmbito(f, ambito));
}

// Traduce el ámbito a condiciones SoQL (para el $where de Socrata). Une con AND.
export function clausulasSoQL(ambito) {
  if (esNacionalPleno(ambito)) return [];
  if (ambito.sujetos_control?.length) {
    // La whitelist manda: nada más hace falta.
    return [`nit_entidad IN (${ambito.sujetos_control.map(n => `'${esc(n)}'`).join(',')})`];
  }
  const w = [];
  if (ambito.orden === 'nacional')    w.push(`upper(orden) = 'NACIONAL'`);
  if (ambito.orden === 'territorial') w.push(`upper(orden) != 'NACIONAL'`);
  if (ambito.departamentos?.length)   w.push(`upper(departamento) IN (${ambito.departamentos.map(d => `'${esc(up(d))}'`).join(',')})`);
  if (ambito.municipios?.length)      w.push(`upper(ciudad) IN (${ambito.municipios.map(m => `'${esc(up(m))}'`).join(',')})`);
  if (ambito.sectores?.length)        w.push(`upper(sector) IN (${ambito.sectores.map(s => `'${esc(up(s))}'`).join(',')})`);
  // Temático por objeto del contrato — más confiable que el sector de SECOP
  // (el PAE, p.ej., está disperso en 8 sectores; el objeto sí lo agrupa).
  if (ambito.objeto)                  w.push(`upper(objeto_del_contrato) like '%${esc(up(ambito.objeto))}%'`);
  return w;
}

// Descripción legible del ámbito (para la UI y para explicar recortes).
export function describirAmbito(ambito) {
  if (esNacionalPleno(ambito)) return 'Nacional — sin restricción';
  if (ambito.sujetos_control?.length) return `${ambito.sujetos_control.length} sujetos de control`;
  const p = [];
  if (ambito.orden && ambito.orden !== 'ambos') p.push(ambito.orden);
  if (ambito.departamentos?.length) p.push(ambito.departamentos.join(', '));
  if (ambito.municipios?.length)    p.push(ambito.municipios.join(', '));
  if (ambito.sectores?.length)      p.push(`sectores: ${ambito.sectores.join(', ')}`);
  if (ambito.objeto)                p.push(`objeto: "${ambito.objeto}"`);
  return p.join(' · ') || 'Nacional';
}
