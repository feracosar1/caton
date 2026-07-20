-- ============================================================================
-- CORPUS DE VEEDURÍA — inventario + siembra
-- Correr en: SQL Editor del Supabase de NUMA (vrrejwnhceipqnriwuac)
--
-- CÓMO FUNCIONA (verificado en el código, no asumido):
--   jurisprudencia_scrape_queue  →  blast (EC2 3.132.186.111)
--                                →  descarga + pdftotext/OCR + chunk + Voyage
--                                →  Azure AI Search, índice 'corpus'
--                                →  que es de donde Luma lee el corpus GLOBAL.
--
--   Ojo: el código y CLAUDE.md dicen "Pinecone". Es FALSO — es Azure AI Search
--   (numa-corpus.search.windows.net, índice 'corpus'). Ver blast-server.mjs:51
--   y legal-assistant/index.ts:13.
--
--   Por eso NO hace falta subir nada a pgvector ni tocar el filtro
--   `if (c.scope === "org")` de legal-assistant/luma-autoflow: lo que entra por
--   esta cola queda global y Luma lo encuentra.
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- PASO 1 — INVENTARIO: ¿qué hay ya indexado? (el "grupo A")
-- ─────────────────────────────────────────────────────────────────────────────

-- 1a. Estado global de la cola del blast, por fuente
SELECT source,
       count(*)                                    AS total,
       count(*) FILTER (WHERE status = 'done')     AS indexados,
       count(*) FILTER (WHERE status = 'error')    AS con_error,
       count(*) FILTER (WHERE status = 'pending')  AS pendientes,
       max(processed_at)                           AS ultimo_procesado
FROM jurisprudencia_scrape_queue
GROUP BY source
ORDER BY total DESC;

-- 1b. ¿Están las normas concretas que el motor va a citar?
--     Si una fila sale con indexados = 0, esa norma NO está y hay que sembrarla.
WITH normas(etiqueta, patron) AS (VALUES
  ('Ley 80 de 1993 (contratación estatal)',        '%ley%80%1993%'),
  ('Ley 1150 de 2007',                             '%ley%1150%2007%'),
  ('Ley 1474 de 2011 (supervisor, arts. 83-84)',   '%ley%1474%2011%'),
  ('Ley 610 de 2000 (responsabilidad fiscal)',     '%ley%610%2000%'),
  ('Ley 1952 de 2019 (disciplinario)',             '%ley%1952%2019%'),
  ('Ley 599 de 2000 (código penal)',               '%ley%599%2000%'),
  ('Ley 1712 de 2014 (transparencia)',             '%ley%1712%2014%'),
  ('Ley 1755 de 2015 (derecho de petición)',       '%ley%1755%2015%'),
  ('Ley 850 de 2003 (veedurías)',                  '%ley%850%2003%'),
  ('Ley 2046 de 2020 (compras locales)',           '%ley%2046%2020%'),
  ('Decreto 1082 de 2015',                         '%decreto%1082%2015%'),
  ('Decreto 111 de 1996 (presupuesto)',            '%decreto%111%1996%'),
  ('Decreto 2591 de 1991 (tutela/desacato)',       '%2591%1991%'),
  ('Ley 270 de 1996 (admin. de justicia)',         '%ley%270%1996%')
)
SELECT n.etiqueta,
       count(q.id) FILTER (WHERE q.status = 'done') AS indexados,
       count(q.id)                                  AS en_cola
FROM normas n
LEFT JOIN jurisprudencia_scrape_queue q
       ON lower(coalesce(q.title, '') || ' ' || q.identifier || ' ' || q.url) LIKE n.patron
GROUP BY n.etiqueta
ORDER BY indexados ASC, n.etiqueta;

-- 1c. Corpus en pgvector (docs subidos a mano por org/admin — distinto del global)
SELECT source_type, scope, status, count(*) AS docs, sum(chunks_count) AS chunks
FROM legal_corpus_documents
GROUP BY source_type, scope, status
ORDER BY docs DESC;


-- ─────────────────────────────────────────────────────────────────────────────
-- PASO 2 — SIEMBRA: grupo B (ruta judicial) + grupo C (normativa ICBF)
--
-- Todas las URLs de abajo fueron verificadas descargándolas (HTTP 200, PDF real).
-- El blast las procesa con pdftotext; si alguna viniera escaneada, cae a OCR.
-- Idempotente: UNIQUE(source, identifier) + ON CONFLICT DO NOTHING.
-- ─────────────────────────────────────────────────────────────────────────────

-- Las 7 URLs de abajo fueron verificadas UNA POR UNA descargándolas desde la VM
-- Azure (HTTP 200 + PDF/HTML real). Ojo: varias URLs que devuelve Google están
-- desactualizadas y el ICBF responde 403 con una página HTML de error (no 404),
-- así que un "parece que existe" no vale: hay que bajarla.
INSERT INTO jurisprudencia_scrape_queue (source, identifier, url, title, area_derecho, priority)
VALUES
  -- ── GRUPO C · Normativa ICBF ────────────────────────────────────────────────
  -- No está en SUIN (son documentos internos del ICBF). Es la que más cita la
  -- denuncia: sin esto, norma_ref sale NULL en casi todos los hallazgos.

  -- ✔ 818 KB · define los deberes del supervisor que la denuncia dice violados
  ('icbf', 'G6.ABS-v4',
   'https://www.icbf.gov.co/system/files/g6.abs_guia_ejercicio_supervision_interventoria_contratos_convenios_suscritos_por_el_icbf_v4.pdf',
   'ICBF G6.ABS — Guía general para el ejercicio de supervisión e interventoría de contratos y convenios suscritos por el ICBF (v4, 18/12/2024)',
   'contratacion_estatal', 1),

  -- ✔ 340 KB · el procedimiento del que cuelga el formato F1.P18.ABS
  ('icbf', 'P18.ABS-v2',
   'https://www.icbf.gov.co/system/files/procesos/p18.abs_procedimiento_supervision_contratos_convenios_suscritos_por_el_icbf_v2.pdf',
   'ICBF P18.ABS — Procedimiento para adelantar la supervisión de contratos y convenios suscritos por el ICBF (v2)',
   'contratacion_estatal', 1),

  -- ✔ 1.27 MB · V7 (¡no v6!). Res. 7700/2023, mod. por 3397/2024 y 7740/2025
  ('icbf', 'MO1.ABS-v7',
   'https://www.icbf.gov.co/system/files/MO1.ABS_Manual_de_Contrataci%C3%B3n_V7_0.pdf',
   'ICBF MO1.ABS — Manual de Contratación (V7, adoptado por Resolución 7700 de 2023)',
   'contratacion_estatal', 1),

  -- ✔ 435 KB · legalización de cuentas en contratos de aporte de primera infancia
  ('icbf', 'A8.MO12.PP-v1',
   'https://www.icbf.gov.co/sites/default/files/procesos/a8.mo12.pp_anexo_para_la_revision_y_legalizacion_de_cuentas_en_los_contratos_de_aporte_direccion_de_primera_infancia_v1.pdf',
   'ICBF A8.MO12.PP — Anexo para la revisión y legalización de cuentas en los contratos de aporte, Dirección de Primera Infancia (v1)',
   'contratacion_estatal', 1),

  -- ✔ 763 KB
  ('icbf', 'G19.PP-v1',
   'https://www.icbf.gov.co/sites/default/files/procesos/g19.pp_guia_orientadora_para_la_supervision_modalidades_familias_y_comunidades_v1.pdf',
   'ICBF G19.PP — Guía orientadora para la supervisión de las modalidades familias y comunidades (v1)',
   'contratacion_estatal', 3),

  -- ✔ 78 KB HTML · cuenta maestra (el informe la exige y la supervisora no la verificó)
  ('icbf', 'RES-1400-2020',
   'https://www.icbf.gov.co/cargues/avance/compilacion/docs/resolucion_icbf_1400_2020.htm',
   'ICBF Resolución 1400 de 2020 — Cuenta maestra para la ejecución de recursos de contratos de aporte',
   'contratacion_estatal', 2),

  -- ── GRUPO B · Ruta judicial ─────────────────────────────────────────────────
  -- ✔ 129 KB HTML · NO está en SUIN (es del Consejo Superior de la Judicatura).
  -- Es la herramienta que hace mover al juez (Ley 270/1996 art. 101 num. 6) —
  -- la que los veedores no usan porque no son abogados.
  ('csj_acuerdo', 'PSAA11-8716',
   'https://www.ramajudicial.gov.co/web/consejo-superior-de-la-judicatura/portal/corporacion/normatividad/-/asset_publisher/P5M0rVxrpi0U/content/id/149620216',
   'Acuerdo PSAA11-8716 de 2011 — Por el cual se reglamenta el ejercicio de la Vigilancia Judicial Administrativa (CSJ)',
   'constitucional', 1)

ON CONFLICT (source, identifier) DO NOTHING;


-- ─────────────────────────────────────────────────────────────────────────────
-- PASO 3 — Verificar la siembra y disparar el blast
-- ─────────────────────────────────────────────────────────────────────────────
SELECT source, identifier, status, title
FROM jurisprudencia_scrape_queue
WHERE source IN ('icbf', 'csj_acuerdo')
ORDER BY source, priority;

-- Luego, en el EC2 (o desde /admin → Jurisprudencia, botón "1 batch"):
--   curl -X POST http://localhost:3000/blast -H "Authorization: Bearer $BLAST_SECRET"
--
-- Y para comprobar que Luma ya los ve, preguntarle algo que SOLO esté en el G6.ABS,
-- p.ej.: "¿qué debe hacer un supervisor del ICBF cuando marca una obligación N/A?"


-- ─────────────────────────────────────────────────────────────────────────────
-- PENDIENTE — buscados pero SIN URL oficial verificada. NO sembrar a ciegas:
-- el ICBF responde 403 con página HTML de error, así que una URL rota no da 404,
-- da "documento" — y terminaría indexando basura como si fuera la norma.
--   · Guía G5.ABS — compras locales (30% a pequeños productores, Ley 2046/2020)
--   · Resoluciones 8300/2021 y 3944/2022 (modifican la 1400 de cuenta maestra)
--   · Resoluciones 1264/2017 y 7998/2023 (las dos minutas del hallazgo 44)
--   · G19.P — Guía operativa de contratos de aporte (la URL que circula da 403)
--   · Manuales técnicos y guías operativas de Primera Infancia
--
-- APARTE (no va por esta cola):
--   · F1.P18.ABS v5 — es un .xlsx, no un PDF:
--     https://www.icbf.gov.co/system/files/procesos/f1.p18.abs_formato_informe_supervision_contrato_o_convenio_v5_0.xlsx
--     El blast no procesa Excel. Y conviene tratarlo distinto: esa plantilla en
--     blanco define el ESQUEMA EXACTO de los campos del informe (numerales 1-16)
--     y sus notas instructivas. De ahí sale el extractor, y de sus notas salen
--     tres reglas del motor (campos obligatorios en blanco, texto instructivo sin
--     depurar tipo "xxxxx", y la nota (ii) que obliga a justificar cada N/A).
-- ─────────────────────────────────────────────────────────────────────────────
