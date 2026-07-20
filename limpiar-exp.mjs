/**
 * Mantenimiento puntual: deja el expediente del gold-set listo para re-generar
 * la denuncia desde cero. Borra actuaciones 'denuncia' previas y devuelve el
 * estado a 'auditado'. Usa PostgREST directo (fetch) para evitar el realtime
 * de supabase-js. Se corre con --env-file en la VM.
 */
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const ID_CONTRATO = 'CO1.PCCNTR.8743473';

const rExp = await fetch(`${URL}/rest/v1/veeduria_expedientes?id_contrato=eq.${ID_CONTRATO}&select=id,estado,contratista`, { headers: H });
const [exp] = await rExp.json();
if (!exp) { console.error('no se encontró el expediente'); process.exit(1); }

const rDel = await fetch(`${URL}/rest/v1/veeduria_actuaciones?expediente_id=eq.${exp.id}&tipo=eq.denuncia`,
  { method: 'DELETE', headers: { ...H, Prefer: 'return=representation' } });
const borradas = await rDel.json();

await fetch(`${URL}/rest/v1/veeduria_expedientes?id=eq.${exp.id}`,
  { method: 'PATCH', headers: H, body: JSON.stringify({ estado: 'auditado' }) });

console.log(`✓ expediente ${exp.id} (${exp.contratista}) listo`);
console.log(`  actuaciones denuncia borradas: ${Array.isArray(borradas) ? borradas.length : 0}`);
console.log(`  estado: ${exp.estado} → auditado`);
