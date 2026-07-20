-- ============================================================================
-- VEEDURÍA — Expediente end-to-end
-- Correr en: Supabase DEDICADO del veedor (después de schema.sql)
--
-- PRINCIPIO RECTOR (no negociable):
--   La IA CLASIFICA Y EXTRAE. El MOTOR DETERMINÍSTICO DECIDE.
--
-- Garantías estructurales de ese principio, cableadas en el esquema:
--   · veeduria_hallazgos.regla_id  NOT NULL FK  → ningún hallazgo existe sin una
--     regla registrada. Un LLM no puede inventar un hallazgo: no tiene regla.
--   · veeduria_hallazgos.doc_id    NOT NULL FK  → sin documento soporte, no hay
--     hallazgo. Y todo documento trae sha256 + url_origen + fecha_captura.
--   · cifra_afirmada / cifra_calculada / delta  → cualquiera reproduce el número.
--   · norma_ref sólo se llena si la norma está en el corpus (ver §corpus).
--
-- El TRIAJE (indicios de metadata) vive en tabla aparte y NUNCA produce hallazgos.
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. DÍAS HÁBILES (Colombia) — la base de todos los relojes
--    Ley Emiliani (51 de 1983): varios festivos se trasladan al lunes siguiente.
--    No se calcula: se carga. Cargar cada año.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS festivos_co (
  fecha   date PRIMARY KEY,
  nombre  text NOT NULL
);

-- Festivos 2026 (18, como manda la ley). Los marcados (L) son los que la Ley
-- Emiliani corre al lunes siguiente. Los tres móviles cuelgan de la Pascua, que
-- en 2026 cae el domingo 5 de abril: Ascensión +43d, Corpus +64d, S. Corazón +71d.
INSERT INTO festivos_co (fecha, nombre) VALUES
  ('2026-01-01','Año Nuevo'),
  ('2026-01-12','Reyes Magos (L)'),
  ('2026-03-23','San José (L)'),
  ('2026-04-02','Jueves Santo'),
  ('2026-04-03','Viernes Santo'),
  ('2026-05-01','Día del Trabajo'),
  ('2026-05-18','Ascensión del Señor (L)'),
  ('2026-06-08','Corpus Christi (L)'),
  ('2026-06-15','Sagrado Corazón (L)'),
  ('2026-06-29','San Pedro y San Pablo (L)'),
  ('2026-07-20','Día de la Independencia'),
  ('2026-08-07','Batalla de Boyacá'),
  ('2026-08-17','Asunción de la Virgen (L)'),
  ('2026-10-12','Día de la Raza (L)'),
  ('2026-11-02','Todos los Santos (L)'),
  ('2026-11-16','Independencia de Cartagena (L)'),
  ('2026-12-08','Inmaculada Concepción'),
  ('2026-12-25','Navidad')
ON CONFLICT (fecha) DO NOTHING;

-- ⚠ CARGAR 2027 ANTES DE QUE TERMINE 2026. Un expediente en desacato puede
--   cruzar el año (el caso real de INTERVEEN lleva 143 días), y si faltan los
--   festivos del año siguiente los vencimientos se calculan mal — en contra
--   nuestra, porque contaríamos como hábiles días que no lo son.

-- Suma N días hábiles a una fecha (excluye sábados, domingos y festivos).
-- STABLE, no IMMUTABLE: lee festivos_co. Marcarla IMMUTABLE le mentiría al
-- planner (que podría cachear vencimientos calculados antes de cargar 2027).
CREATE OR REPLACE FUNCTION sumar_dias_habiles(p_desde date, p_dias int)
RETURNS date LANGUAGE plpgsql STABLE AS $$
DECLARE d date := p_desde; restantes int := p_dias;
BEGIN
  WHILE restantes > 0 LOOP
    d := d + 1;
    IF extract(isodow FROM d) < 6
       AND NOT EXISTS (SELECT 1 FROM festivos_co f WHERE f.fecha = d) THEN
      restantes := restantes - 1;
    END IF;
  END LOOP;
  RETURN d;
END $$;

-- Días hábiles transcurridos entre dos fechas (para "han pasado N días").
-- Se itera con enteros (date - date = int; date + int = date) en vez de
-- generate_series(date, date, interval), que Postgres no resuelve por sí solo.
CREATE OR REPLACE FUNCTION dias_habiles_entre(p_desde date, p_hasta date)
RETURNS int LANGUAGE sql STABLE AS $$
  SELECT count(*)::int
  FROM generate_series(1, (p_hasta - p_desde)) AS i
  WHERE extract(isodow FROM p_desde + i) < 6
    AND NOT EXISTS (SELECT 1 FROM festivos_co f WHERE f.fecha = p_desde + i)
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. EXPEDIENTE — la máquina de estados
--    El humano decide cada transición marcada con ⚑. El sistema nunca avanza solo.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS veeduria_expedientes (
  id                  bigserial PRIMARY KEY,
  -- Objeto auditado
  id_contrato         text NOT NULL,          -- CO1.PCCNTR.*  (llave de los docs de EJECUCIÓN)
  id_portafolio       text,                   -- CO1.BDOS.*    (llave de los docs precontractuales)
  referencia_contrato text,                   -- el nº que usa la entidad (ej. 76014602025)
  entidad             text,
  nit_entidad         text,
  contratista         text,
  nit_contratista     text,
  supervisor          text,                   -- a quien se denuncia
  valor_contrato      numeric,

  estado text NOT NULL DEFAULT 'seleccionado' CHECK (estado IN (
    'seleccionado',        -- ⚑ el humano lo escogió del triaje
    'ingestando',          --   descargando documentos (con custodia)
    'extrayendo',          --   LLM llenando tablas de datos
    'auditado',            --   motor SQL corrió → hay (o no hay) hallazgos
    'sin_hallazgos',       --   RESULTADO VÁLIDO: se auditó y no había nada. No es fracaso.
    'denuncia_borrador',   -- ⚑ humano revisa
    'denuncia_enviada',    --   ⏱ corre reloj de 15 días hábiles (Ley 1755/2015)
    'respuesta_recibida',  --   llegó a veeduria@numa.la → LLM la evalúa
    'respuesta_vencida',   --   silencio: habilita tutela
    'tutela_borrador',     -- ⚑
    'tutela_presentada',   --   esperando radicado
    'tutela_radicada',     --   ← se engancha al monitoreo judicial de NUMA
    'contestacion_recibida', -- la accionada contestó → cruce de contradicciones
    'alcance_borrador',    -- ⚑ escrito de alcance antes del fallo
    'fallo_recibido',      --   LLM evalúa el fallo
    'impugnacion_borrador',-- ⚑ fallo desfavorable
    'desacato_borrador',   -- ⚑ ganamos pero incumplen (⏱ 48h del fallo)
    'vja_borrador',        -- ⚑ el juez no se mueve → Vigilancia Judicial Administrativa
    'cerrado'
  )),

  -- Enlace con el monitoreo judicial de NUMA (Base 2 ↔ NUMA)
  radicado            text,                   -- 23 dígitos
  judicial_case_id    uuid,                   -- FK lógica a judicial_cases en NUMA

  score_triaje        int,                    -- por qué lo alertamos (0-100)
  creado_por          uuid,
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now(),
  UNIQUE (id_contrato)
);

CREATE INDEX IF NOT EXISTS idx_exp_estado   ON veeduria_expedientes (estado);
CREATE INDEX IF NOT EXISTS idx_exp_radicado ON veeduria_expedientes (radicado);


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. TRIAJE — indicios de metadata. NO son hallazgos. Nunca se denuncian.
--    Sale de los 81 campos de datos abiertos, sin bajar un solo PDF.
--    Esto es lo que el humano ve en la lista para decidir qué auditar.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS veeduria_triaje (
  id            bigserial PRIMARY KEY,
  id_contrato   text NOT NULL,
  senal         text NOT NULL,     -- ADICION_ALTA | SIN_INFORMES_PUBLICADOS | CONTRATISTA_RECURRENTE | ...
  descripcion   text NOT NULL,     -- el "por qué te lo alertamos", en español llano
  peso          int  NOT NULL,     -- suma al score_triaje
  evidencia     jsonb,             -- los campos de datos abiertos que lo sustentan
  created_at    timestamptz DEFAULT now(),
  UNIQUE (id_contrato, senal)
);


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. DOCUMENTOS — cadena de custodia. Sin esto, la prueba no se sostiene.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS veeduria_documentos (
  id             bigserial PRIMARY KEY,
  expediente_id  bigint NOT NULL REFERENCES veeduria_expedientes(id) ON DELETE CASCADE,
  origen         text NOT NULL CHECK (origen IN (
                   'secop',              -- bajado de datos abiertos (automático)
                   'entidad',            -- respuesta de la entidad (llegó por correo)
                   'rama_judicial',      -- lo subió el humano tras la alerta de movimiento
                   'propio')),           -- lo que nosotros radicamos
  tipo           text NOT NULL,          -- informe_supervision | contrato | acta | respuesta | contestacion | fallo | ...
  nombre_archivo text,
  id_documento_secop text,               -- id_documento de dmgg-8hin (inmutable)
  url_origen     text NOT NULL,          -- de dónde salió, verificable por cualquiera
  sha256         text NOT NULL,          -- custodia
  fecha_captura  timestamptz NOT NULL DEFAULT now(),
  fecha_documento date,                  -- fecha del documento en sí
  tamano_bytes   bigint,
  r2_key         text,                   -- copia inmutable en R2
  texto_extraido text,
  UNIQUE (sha256)                        -- mismo archivo = un solo registro
);

CREATE INDEX IF NOT EXISTS idx_doc_exp ON veeduria_documentos (expediente_id);


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. EXTRACCIÓN — el LLM llena esto. NO decide nada. Solo transcribe el formato.
--    Campos = numerales del F1.P18.ABS (el formato estándar del ICBF).
--    El esquema sale de la plantilla oficial en blanco, no de adivinar.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS veeduria_informe_supervision (
  id                   bigserial PRIMARY KEY,
  expediente_id        bigint NOT NULL REFERENCES veeduria_expedientes(id) ON DELETE CASCADE,
  doc_id               bigint NOT NULL REFERENCES veeduria_documentos(id),
  numero_informe       int,
  periodo_desde        date,
  periodo_hasta        date,
  fecha_emision        date,
  fecha_supervision    date,              -- num. 2 — "fecha en que realizó la supervisión"

  -- num. 5 · Información presupuestal
  valor_inicial        numeric,
  cdp_numero           text,  cdp_fecha  date,  cdp_valor  numeric,
  rp_numero            text,  rp_fecha   date,  rp_valor   numeric,
  adicion_cdp_numero   text,  adicion_cdp_fecha date, adicion_valor numeric,
  adicion_rp_numero    text,  adicion_rp_fecha  date,
  fecha_documento_adicion date,
  valor_vf             numeric,           -- "Valor de VF" (vigencia futura)
  forma_pago           jsonb,             -- [{cuota:1, tipo:'mensual', valor:4928}, ...]
  valor_total          numeric,

  -- num. 7 · Certificaciones de pago suscritas por el supervisor
  certificaciones_pago jsonb,             -- [{periodo, fecha_certificacion, valor, ubicacion_soporte}]
  -- num. 8 · Pagos efectuados según estado de cuenta
  pagos_efectuados     jsonb,             -- [{fecha, valor, orden_pago, ubicacion_soporte}]

  -- num. 11 · Resumen ejecución presupuestal acumulado
  valor_ejecutado      numeric,
  valor_ejecutado_icbf numeric,
  pagos_al_contratista numeric,
  valor_a_liberar      numeric,
  saldo_por_pagar      numeric,

  -- num. 12/13 · Garantías y sanciones
  garantias            jsonb,             -- [{amparo, poliza, aseguradora, desde, hasta}]
  sanciones            jsonb,             -- vacío = no impuso ninguna
  descuentos           jsonb,

  -- num. 14 · Cumplimiento de obligaciones (la matriz)
  obligaciones         jsonb,             -- [{n, texto, cumple:'SI'|'NO'|'N/A', soporte, ubicacion, observacion}]
  matriz_resolucion    text,              -- "1264 de 2017" | "7998 de 2023" — dos minutas distintas = hallazgo

  -- num. 6 · Contratación derivada
  contratacion_derivada_texto text,       -- si trae residuos de fórmula Excel → hallazgo

  -- num. 15 · Matriz de riesgos
  riesgos_detectados   boolean,

  texto_completo       text,              -- para las reglas de regex/clonado
  hash_narrativo       text,              -- sha256 de las secciones narrativas → detecta informe clonado
  extraido_at          timestamptz DEFAULT now(),
  UNIQUE (doc_id)
);


-- ─────────────────────────────────────────────────────────────────────────────
-- 6. CATÁLOGO DE REGLAS — cada hallazgo debe nacer de una de estas.
--    Derivadas de los 44 hallazgos reales de la denuncia INTERVEEN.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS veeduria_reglas (
  id           text PRIMARY KEY,
  familia      text NOT NULL CHECK (familia IN ('aritmetica','cronologia','duplicidad','documental','coherencia','clonado')),
  titulo       text NOT NULL,
  descripcion  text NOT NULL,          -- qué detecta, en español
  via          text NOT NULL CHECK (via IN ('fiscal','disciplinaria','penal','contractual')),
  severidad    text NOT NULL CHECK (severidad IN ('alta','media','baja')),
  norma_ref    text,                   -- SOLO si está en el corpus. Si no: NULL.
  activa       boolean NOT NULL DEFAULT true
);

INSERT INTO veeduria_reglas (id, familia, titulo, descripcion, via, severidad) VALUES
  ('ARIT-01','aritmetica','Forma de pago no cuadra con el valor total',
   'La suma de las cuotas de la forma de pago difiere del valor total del contrato después de modificaciones.','fiscal','alta'),
  ('ARIT-02','aritmetica','Pagos certificados con ejecución en cero',
   'Se certifican pagos al contratista y simultáneamente ejecución de $0. Pago sin ejecución acreditada.','fiscal','alta'),
  ('ARIT-03','aritmetica','Diferencia no conciliada entre certificado y pagado',
   'La suma de las certificaciones de pago difiere de la suma de los pagos efectivamente reportados.','fiscal','alta'),
  ('ARIT-04','aritmetica','Valor absurdo frente al contrato',
   'Un campo consigna un valor desproporcionado (>50x) frente al valor total del contrato.','fiscal','alta'),
  ('CRON-01','cronologia','Certificación de pago anticipada',
   'La certificación de pago se expidió antes de que terminara el período que pretende certificar.','disciplinaria','alta'),
  ('CRON-02','cronologia','Supervisión fechada antes del contrato',
   'La fecha en que se realizó la supervisión es anterior a la suscripción del contrato.','disciplinaria','alta'),
  ('CRON-03','cronologia','Período del informe inicia antes del contrato',
   'El período que certifica el informe comienza en una vigencia anterior a la suscripción.','disciplinaria','media'),
  ('CRON-04','cronologia','Respaldo presupuestal retroactivo',
   'El CDP/RP de la adición tiene fecha de operación anterior al documento de adición que lo origina.','fiscal','alta'),
  ('DUP-01','duplicidad','CDP/RP de la adición duplican los del contrato principal',
   'El mismo consecutivo presupuestal ampara el valor inicial y la adición.','fiscal','alta'),
  ('DUP-02','duplicidad','Factura duplicada',
   'La misma (NIT proveedor, número de factura) aparece en más de un informe o contrato.','penal','alta'),
  ('DOC-01','documental','Soporte remite al expediente de otro contrato',
   'La ruta del documento soporte apunta a un número de contrato distinto del auditado.','disciplinaria','alta'),
  ('DOC-02','documental','Expediente fuera del control público',
   'El soporte reposa en OneDrive/SharePoint personal y no en SECOP II (Ley 1712/2014).','disciplinaria','media'),
  ('DOC-03','documental','Formato firmado sin diligenciar',
   'Campos conservan el texto instructivo de la plantilla (xxxxx, XXXXX) en un documento suscrito.','disciplinaria','media'),
  ('DOC-04','documental','Residuos de fórmula de hoja de cálculo',
   'El documento suscrito contiene cadenas de referencias de Excel (+A97:W112...).','disciplinaria','media'),
  ('DOC-05','documental','Campos obligatorios en blanco',
   'Numerales que el propio formato exige diligenciar quedaron vacíos.','disciplinaria','media'),
  ('COHER-01','coherencia','Incumplimiento reconocido sin sanción ni descuento',
   'El supervisor califica una obligación como NO cumplida y no registra requerimiento, sanción ni descuento.','disciplinaria','alta'),
  ('COHER-02','coherencia','Certifica cumplimiento con ejecución en cero',
   'Declara cumplidas las obligaciones mientras el resumen presupuestal reporta ejecución de $0.','disciplinaria','alta'),
  ('COHER-03','coherencia','Obligaciones calificadas masivamente como N/A sin justificar',
   'La totalidad de obligaciones marcadas N/A sin la justificación individual que exige el formato.','disciplinaria','media'),
  ('CLON-01','clonado','Informe clonado entre períodos',
   'Las secciones narrativas de dos informes consecutivos tienen el mismo hash.','disciplinaria','alta'),
  ('CLON-02','clonado','Fecha de supervisión arrastrada',
   'Todos los informes consignan la misma fecha de supervisión, en períodos distintos.','disciplinaria','alta'),
  ('CLON-03','clonado','Matrices de obligaciones de resoluciones distintas',
   'Informes del mismo contrato aplican matrices de obligaciones de resoluciones diferentes, sin otrosí.','disciplinaria','alta')
ON CONFLICT (id) DO NOTHING;


-- ─────────────────────────────────────────────────────────────────────────────
-- 7. HALLAZGOS — SOLO los escribe el motor. Estructura que lo garantiza.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS veeduria_hallazgos (
  id               bigserial PRIMARY KEY,
  expediente_id    bigint NOT NULL REFERENCES veeduria_expedientes(id) ON DELETE CASCADE,
  regla_id         text   NOT NULL REFERENCES veeduria_reglas(id),      -- sin regla no hay hallazgo
  doc_id           bigint NOT NULL REFERENCES veeduria_documentos(id),  -- sin soporte no hay hallazgo
  folio            text,                    -- numeral / página donde consta
  numero           int,                     -- 1,2,3… consecutivo en la denuncia (enteros, sin decimales)

  -- Reproducibilidad: cualquiera puede rehacer la cuenta
  cifra_afirmada   numeric,
  cifra_calculada  numeric,
  delta            numeric,
  evidencia_textual text,                   -- fragmento literal del documento
  detalle          jsonb,                   -- inputs de la regla, para auditar el cálculo

  norma_ref        text,                    -- NULL si la norma no está en el corpus
  norma_verificada boolean NOT NULL DEFAULT false,
  created_at       timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hall_exp   ON veeduria_hallazgos (expediente_id);
CREATE INDEX IF NOT EXISTS idx_hall_regla ON veeduria_hallazgos (regla_id);


-- ─────────────────────────────────────────────────────────────────────────────
-- 8. CONTRADICCIONES — lo que la entidad AFIRMA vs. lo que la evidencia PRUEBA.
--    El LLM extrae las afirmaciones. El motor las confronta. Alimenta el ALCANCE.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS veeduria_contradicciones (
  id                 bigserial PRIMARY KEY,
  expediente_id      bigint NOT NULL REFERENCES veeduria_expedientes(id) ON DELETE CASCADE,
  afirmacion         text NOT NULL,                       -- lo que dijo la entidad
  doc_afirmacion_id  bigint NOT NULL REFERENCES veeduria_documentos(id),  -- dónde lo dijo
  evidencia          text NOT NULL,                       -- lo que dice el documento
  doc_evidencia_id   bigint NOT NULL REFERENCES veeduria_documentos(id),  -- con qué se refuta
  folio_evidencia    text,
  hallazgo_id        bigint REFERENCES veeduria_hallazgos(id),  -- si refuta un hallazgo concreto
  created_at         timestamptz DEFAULT now()
);


-- ─────────────────────────────────────────────────────────────────────────────
-- 9. ACTUACIONES — el hilo procesal. Cada pieza que entra o sale del expediente.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS veeduria_actuaciones (
  id             bigserial PRIMARY KEY,
  expediente_id  bigint NOT NULL REFERENCES veeduria_expedientes(id) ON DELETE CASCADE,
  tipo           text NOT NULL CHECK (tipo IN (
                   'denuncia','respuesta_entidad','tutela','contestacion_accionada',
                   'alcance','fallo','impugnacion','desacato','memorial','vja','otro')),
  direccion      text NOT NULL CHECK (direccion IN ('enviada','recibida')),
  estado         text NOT NULL DEFAULT 'borrador'
                 CHECK (estado IN ('borrador','aprobada','enviada','recibida')),
  contenido_html text,
  doc_id         bigint REFERENCES veeduria_documentos(id),
  destinatarios  jsonb,                    -- [{nombre, entidad, email}]
  enviada_at     timestamptz,
  recibida_at    timestamptz,
  -- Evaluación por LLM de lo recibido (respuesta / contestación / fallo)
  evaluacion     jsonb,                    -- {de_fondo:bool, evasiva:bool, resumen, recomendacion}
  aprobada_por   uuid,                     -- ⚑ el humano. NULL = nadie la aprobó todavía.
  aprobada_at    timestamptz,
  created_at     timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_act_exp ON veeduria_actuaciones (expediente_id, created_at);


-- ─────────────────────────────────────────────────────────────────────────────
-- 10. TÉRMINOS — los relojes. Lo que convierte al veedor en máquina.
--     Un humano pierde el hilo a los 143 días. Esto no.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS veeduria_terminos (
  id             bigserial PRIMARY KEY,
  expediente_id  bigint NOT NULL REFERENCES veeduria_expedientes(id) ON DELETE CASCADE,
  actuacion_id   bigint REFERENCES veeduria_actuaciones(id),
  tipo           text NOT NULL CHECK (tipo IN (
                   'respuesta_peticion',   -- 15 días hábiles · Ley 1755/2015
                   'cumplimiento_fallo',   -- 48 horas · el propio fallo
                   'notificacion_fallo',   -- día siguiente · Dec. 2591/91 art. 30
                   'tramite_desacato',     -- breve · Dec. 2591/91 art. 52
                   'impugnacion')),        -- 3 días · Dec. 2591/91 art. 31
  norma          text NOT NULL,
  inicia         date NOT NULL,
  vence          date NOT NULL,            -- calculado con sumar_dias_habiles()
  cumplido       boolean NOT NULL DEFAULT false,
  cumplido_at    date,
  -- Qué se habilita cuando vence sin cumplirse:
  habilita       text CHECK (habilita IN ('tutela','desacato','memorial','vja','impugnacion')),
  created_at     timestamptz DEFAULT now()
);

-- Vista: qué está vencido HOY y qué acción habilita. Esto es lo que ve el humano.
CREATE OR REPLACE VIEW veeduria_vencidos AS
SELECT t.id, t.expediente_id, e.entidad, e.referencia_contrato,
       t.tipo, t.norma, t.vence, t.habilita,
       (CURRENT_DATE - t.vence) AS dias_vencido
FROM veeduria_terminos t
JOIN veeduria_expedientes e ON e.id = t.expediente_id
WHERE NOT t.cumplido AND t.vence < CURRENT_DATE
ORDER BY t.vence;


-- ─────────────────────────────────────────────────────────────────────────────
-- 11. RLS — nadie entra por anon/authenticated. Solo el servidor (service_role).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE veeduria_expedientes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE veeduria_triaje             ENABLE ROW LEVEL SECURITY;
ALTER TABLE veeduria_documentos         ENABLE ROW LEVEL SECURITY;
ALTER TABLE veeduria_informe_supervision ENABLE ROW LEVEL SECURITY;
ALTER TABLE veeduria_reglas             ENABLE ROW LEVEL SECURITY;
ALTER TABLE veeduria_hallazgos          ENABLE ROW LEVEL SECURITY;
ALTER TABLE veeduria_contradicciones    ENABLE ROW LEVEL SECURITY;
ALTER TABLE veeduria_actuaciones        ENABLE ROW LEVEL SECURITY;
ALTER TABLE veeduria_terminos           ENABLE ROW LEVEL SECURITY;
ALTER TABLE festivos_co                 ENABLE ROW LEVEL SECURITY;
-- Sin políticas = solo service_role (que bypasea RLS). Igual que schema.sql.
