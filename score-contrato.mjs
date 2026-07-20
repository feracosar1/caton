/**
 * SCORE DE SOSPECHA de un contrato — la única fuente de verdad del riesgo.
 *
 * Determinista sobre metadatos (sin necesidad del informe de supervisión): cada
 * señal suma, el resultado es 0-100 con las razones explícitas. NO acusa —
 * ORDENA: convierte la lista plana de búsqueda en un radar. Reemplaza el scoring
 * por IA del veedor viejo (la IA no debe decidir el score, solo extraer).
 *
 * Señales de metadatos (las que se leen de la fila del contrato, sin más queries):
 *   · sin competencia (contratación directa / régimen especial)
 *   · persona natural con contrato alto (posible testaferro)
 *   · magnitud del dinero
 *   · objeto genérico / sin describir (opacidad)
 *
 * Pendiente v2 (requieren agregación, no la fila): contratista recurrente en la
 * entidad, parte de una red/carrusel, fraccionamiento.
 */
const PLACEHOLDERS = new Set([
  'sin descripcion', 'no definido', 'no aplica', 'sin informacion',
  'n/a', 'na', 'ninguno', 'ninguna', '0', 'no registra', 'no registrado',
]);

/**
 * Limpia strings de SECOP: null/undefined/vacío → '', placeholders → ''.
 * Úsala al normalizar campos antes de scorear o mostrar.
 */
export function limpiar(v) {
  if (v == null) return '';
  const s = String(v).trim();
  return PLACEHOLDERS.has(s.toLowerCase()) ? '' : s;
}

export function scorearContrato(c) {
  let s = 0;
  const razones = [];
  const val = Number(c.valor) || 0;
  const modalidad = (c.modalidad || '').toLowerCase();
  const objeto = (c.objeto || '').trim();
  const esPersonaNatural = c.tipo_doc && c.tipo_doc !== 'NIT';

  // Sin competencia real
  if (modalidad.includes('directa')) { s += 25; razones.push('Contratación directa (sin licitar)'); }
  else if (modalidad.includes('gimen especial')) { s += 12; razones.push('Régimen especial (menos control)'); }
  else if (modalidad.includes('nima cuant')) { s += 6; razones.push('Mínima cuantía'); }

  // Persona natural con contrato alto (¿por qué un individuo tanto?)
  if (esPersonaNatural && val > 200_000_000) { s += 30; razones.push('Persona natural con contrato alto'); }

  // Magnitud del dinero
  if (val > 5_000_000_000)      { s += 20; razones.push('Contrato de más de $5.000M'); }
  else if (val > 1_000_000_000) { s += 12; razones.push('Contrato de más de $1.000M'); }
  else if (val > 500_000_000)   { s += 6; }

  // Objeto opaco o no declarado
  if (objeto.length === 0) { s += 15; razones.push('Objeto del contrato no declarado'); }
  else if (objeto.length < 40) { s += 10; razones.push('Objeto genérico o sin describir'); }

  // Sin representante legal identificado — señal de empresa fantasma o titular oculto
  const repLegal = (c.representante_legal ?? '').trim();
  if (!repLegal && val > 100_000_000) { s += 8; razones.push('Sin representante legal identificado'); }

  const score = Math.min(100, s);
  const nivel = score >= 55 ? 'alto' : score >= 30 ? 'medio' : 'bajo';
  return { score, nivel, razones };
}
