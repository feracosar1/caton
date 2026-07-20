-- ============================================================
-- VEEDOR SECOP — Schema para Supabase dedicado
-- Ejecutar en: SQL Editor del proyecto Supabase Veedor
-- Acceso: solo via service_role_key desde veedor-server
-- ============================================================

-- Procesos de contratación
CREATE TABLE IF NOT EXISTS secop_procesos (
  id                    text PRIMARY KEY,
  -- CO1.BDOS.* — join con datasets "SECOP II Archivos Descarga" (documentos)
  id_portafolio         text,
  entidad               text,
  nit_entidad           text,
  departamento          text,
  ciudad                text,
  modalidad             text,
  estado                text,
  fase                  text,
  descripcion           text,
  valor_proceso         numeric,
  codigo_unspsc         text,
  fecha_publicacion     timestamptz,
  fecha_limite          timestamptz,
  fecha_adjudicacion    timestamptz,
  url_proceso           text,
  raw                   jsonb,
  score_riesgo          int DEFAULT 0,
  alertas_count         int DEFAULT 0,
  procesado_at          timestamptz,
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now()
);

-- Contratos adjudicados
CREATE TABLE IF NOT EXISTS secop_contratos (
  id                    text PRIMARY KEY,
  id_proceso            text,
  entidad               text,
  nit_entidad           text,
  contratista           text,
  nit_contratista       text,
  valor_contrato        numeric,
  fecha_firma           timestamptz,
  objeto                text,
  raw                   jsonb,
  created_at            timestamptz DEFAULT now()
);

-- Cola de descarga de documentos
CREATE TABLE IF NOT EXISTS secop_cola_descarga (
  id                    bigserial PRIMARY KEY,
  id_proceso            text,
  url                   text,
  tipo_doc              text,
  estado                text DEFAULT 'pending',
  intentos              int DEFAULT 0,
  error_msg             text,
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now(),
  UNIQUE (id_proceso, tipo_doc)
);

-- Documentos descargados
CREATE TABLE IF NOT EXISTS secop_documentos (
  id                    bigserial PRIMARY KEY,
  id_proceso            text,
  tipo_doc              text,
  nombre_archivo        text,
  blob_key              text,
  tamanio_bytes         bigint,
  tipo_contenido        text,  -- texto, escaneado, plano
  texto_extraido        text,
  indexado              boolean DEFAULT false,
  created_at            timestamptz DEFAULT now()
);

-- Contratistas
CREATE TABLE IF NOT EXISTS secop_contratistas (
  nit                   text PRIMARY KEY,
  razon_social          text,
  rep_legal_nombre      text,
  rep_legal_cedula      text,
  direccion             text,
  telefono              text,
  municipio             text,
  total_contratos       int DEFAULT 0,
  valor_total_contratos numeric DEFAULT 0,
  updated_at            timestamptz DEFAULT now(),
  created_at            timestamptz DEFAULT now()
);

-- Personas naturales
CREATE TABLE IF NOT EXISTS secop_personas (
  cedula                text PRIMARY KEY,
  nombre                text,
  tipo                  text,
  entidad_vinculo       text,
  cargo                 text,
  fecha_desde           date,
  fecha_hasta           date,
  created_at            timestamptz DEFAULT now()
);

-- Grafo de relaciones
CREATE TABLE IF NOT EXISTS secop_relaciones (
  id                    bigserial PRIMARY KEY,
  tipo                  text NOT NULL,
  nodo_origen_tipo      text NOT NULL,
  nodo_origen_id        text NOT NULL,
  nodo_destino_tipo     text NOT NULL,
  nodo_destino_id       text NOT NULL,
  peso                  numeric DEFAULT 1,
  metadata              jsonb,
  created_at            timestamptz DEFAULT now(),
  UNIQUE (tipo, nodo_origen_tipo, nodo_origen_id, nodo_destino_tipo, nodo_destino_id)
);

-- Alertas detectadas
CREATE TABLE IF NOT EXISTS secop_alertas (
  id                    bigserial PRIMARY KEY,
  id_proceso            text,
  tipo_alerta           text NOT NULL,
  severidad             text,
  descripcion           text,
  evidencia             jsonb,
  score_contribucion    int DEFAULT 0,
  created_at            timestamptz DEFAULT now(),
  UNIQUE (id_proceso, tipo_alerta)
);

-- Observaciones y ciclo de escalación
CREATE TABLE IF NOT EXISTS secop_observaciones (
  id                    bigserial PRIMARY KEY,
  id_proceso            text,
  texto                 text,
  estado                text DEFAULT 'draft',
  respuesta_entidad     text,
  fecha_radicacion      timestamptz,
  fecha_respuesta       timestamptz,
  siguiente_accion      text,
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now()
);

-- ── Índices ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_proc_entidad   ON secop_procesos (nit_entidad);
CREATE INDEX IF NOT EXISTS idx_proc_fase      ON secop_procesos (fase);
CREATE INDEX IF NOT EXISTS idx_proc_score     ON secop_procesos (score_riesgo DESC);
CREATE INDEX IF NOT EXISTS idx_proc_fecha     ON secop_procesos (fecha_publicacion DESC);

-- Si la base ya existía antes de agregar id_portafolio (debe ir antes del índice):
ALTER TABLE secop_procesos ADD COLUMN IF NOT EXISTS id_portafolio text;
CREATE INDEX IF NOT EXISTS idx_proc_portaf    ON secop_procesos (id_portafolio);
CREATE INDEX IF NOT EXISTS idx_cont_nit       ON secop_contratos (nit_contratista);
CREATE INDEX IF NOT EXISTS idx_cont_entidad   ON secop_contratos (nit_entidad);
CREATE INDEX IF NOT EXISTS idx_rel_origen     ON secop_relaciones (nodo_origen_tipo, nodo_origen_id);
CREATE INDEX IF NOT EXISTS idx_rel_destino    ON secop_relaciones (nodo_destino_tipo, nodo_destino_id);
CREATE INDEX IF NOT EXISTS idx_alertas_proc   ON secop_alertas (id_proceso);
CREATE INDEX IF NOT EXISTS idx_cola_estado    ON secop_cola_descarga (estado);

-- ── RLS — bloquear acceso directo, solo service_role ─────────────────────────
ALTER TABLE secop_procesos       ENABLE ROW LEVEL SECURITY;
ALTER TABLE secop_contratos      ENABLE ROW LEVEL SECURITY;
ALTER TABLE secop_cola_descarga  ENABLE ROW LEVEL SECURITY;
ALTER TABLE secop_documentos     ENABLE ROW LEVEL SECURITY;
ALTER TABLE secop_contratistas   ENABLE ROW LEVEL SECURITY;
ALTER TABLE secop_personas       ENABLE ROW LEVEL SECURITY;
ALTER TABLE secop_relaciones     ENABLE ROW LEVEL SECURITY;
ALTER TABLE secop_alertas        ENABLE ROW LEVEL SECURITY;
ALTER TABLE secop_observaciones  ENABLE ROW LEVEL SECURITY;

-- Sin políticas = nadie entra por anon/authenticated
-- El servidor usa service_role_key que bypasea RLS

-- ── Stats function ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION veedor_stats()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT jsonb_build_object(
    'total_procesos',     (SELECT count(*) FROM secop_procesos),
    'procesos_activos',   (SELECT count(*) FROM secop_procesos WHERE fase IN ('Convocado','Publicado','Selección')),
    'total_alertas',      (SELECT count(*) FROM secop_alertas),
    'alta_severidad',     (SELECT count(*) FROM secop_alertas WHERE severidad = 'alta'),
    'total_contratos',    (SELECT count(*) FROM secop_contratos),
    'total_contratistas', (SELECT count(*) FROM secop_contratistas),
    'nodos_grafo',        (SELECT count(*) FROM secop_relaciones),
    'en_cola',            (SELECT count(*) FROM secop_cola_descarga WHERE estado = 'pending'),
    'alto_riesgo',        (SELECT count(*) FROM secop_procesos WHERE score_riesgo >= 40)
  )
$$;
