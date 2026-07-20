/**
 * Test E2E standalone de secop-docs.mjs — no necesita base de datos.
 *
 * Simula el flujo real del pipeline:
 *   1. Toma procesos recientes de p6dx-8zbt (como fase 1)
 *   2. descubrirDocumentos(id_del_portafolio)   (como fase 3)
 *   3. elegirPliego + descargarDocumento
 *   4. Valida magic bytes %PDF y tamaño vs el declarado en el dataset
 *
 * Uso:  node test-secop-docs.mjs [n_procesos]
 */

import https from 'https';
import { descubrirDocumentos, elegirPliego, descargarDocumento } from './secop-docs.mjs';

const N = Number(process.argv[2] || 6);

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Accept: 'application/json', 'User-Agent': 'veedor-test' } }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

const hace = (dias) => new Date(Date.now() - dias * 86_400_000).toISOString().slice(0, 10);

async function main() {
  console.log(`── 1. Fase 1 simulada: procesos de los últimos 30 días (>$100M) ──`);
  const q = new URLSearchParams({
    $select: 'id_del_portafolio,id_del_proceso,entidad,modalidad_de_contratacion,precio_base,fecha_de_publicacion_del',
    $where: `fecha_de_publicacion_del > '${hace(30)}T00:00:00.000' AND fecha_de_publicacion_del < '${hace(3)}T00:00:00.000' AND precio_base > 100000000`,
    $order: 'fecha_de_publicacion_del DESC',
    $limit: String(N * 3),
  });
  const rows = await getJson(`https://www.datos.gov.co/resource/p6dx-8zbt.json?${q}`);

  // El dataset trae varias filas por portafolio (lotes) — deduplicar
  const vistos = new Set();
  const procesos = [];
  for (const r of rows) {
    if (!r.id_del_portafolio || vistos.has(r.id_del_portafolio)) continue;
    vistos.add(r.id_del_portafolio);
    procesos.push(r);
    if (procesos.length >= N) break;
  }
  console.log(`   ${procesos.length} procesos únicos\n`);

  let ok = 0, sinDocs = 0, fail = 0;
  for (const p of procesos) {
    const tag = `${p.id_del_portafolio} · ${p.entidad?.slice(0, 38)}`;
    try {
      const docs = await descubrirDocumentos(p.id_del_portafolio, {
        anioHint: new Date(p.fecha_de_publicacion_del).getFullYear(),
      });
      if (docs.length === 0) {
        sinDocs++;
        console.log(`   ⏳ SIN DOCS AÚN  ${tag} (publicado ${p.fecha_de_publicacion_del?.slice(0, 10)})`);
        continue;
      }
      const pliego = elegirPliego(docs);
      if (!pliego) {
        sinDocs++;
        console.log(`   ⏳ ${docs.length} docs pero ningún PDF elegible  ${tag}`);
        continue;
      }
      const buf = await descargarDocumento(pliego);
      const esPdf = buf.slice(0, 4).toString() === '%PDF';
      const tamOk = !pliego.bytes || Math.abs(buf.length - pliego.bytes) <= 1024;
      if (esPdf && tamOk) {
        ok++;
        console.log(`   ✓ ${tag}`);
        console.log(`     "${pliego.nombre.slice(0, 60)}" — ${Math.round(buf.length / 1024)}KB (${pliego.tipo}, ${docs.length} docs en el proceso)`);
      } else {
        fail++;
        console.log(`   ✗ ${tag} — pdf=${esPdf} tamOk=${tamOk} (${buf.length}b vs ${pliego.bytes}b)`);
      }
    } catch (err) {
      fail++;
      console.log(`   ✗ ${tag} — ${err.message}`);
    }
  }

  console.log(`\n── RESULTADO: ${ok} descargados+validados · ${sinDocs} sin docs aún (rezago normal) · ${fail} fallos ──`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
