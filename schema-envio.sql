-- ============================================================================
-- VEEDOR — Envío de requerimientos (consecutivos + email log + tracking)
-- Correr en Supabase de CATÓN después de schema-veeduria.sql
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Consecutivos por org/año  (VEE-YYYY-NNNNN)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS veedor_consecutivos (
  id       bigserial PRIMARY KEY,
  org_id   uuid      NOT NULL,
  year     int       NOT NULL,
  seq      int       NOT NULL DEFAULT 0,
  UNIQUE (org_id, year)
);

ALTER TABLE veedor_consecutivos ENABLE ROW LEVEL SECURITY;

-- Genera el siguiente consecutivo de forma atómica (upsert + increment).
CREATE OR REPLACE FUNCTION next_veedor_consecutivo(p_org_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_year int := date_part('year', now())::int;
  v_seq  int;
BEGIN
  INSERT INTO veedor_consecutivos (org_id, year, seq)
  VALUES (p_org_id, v_year, 1)
  ON CONFLICT (org_id, year)
  DO UPDATE SET seq = veedor_consecutivos.seq + 1
  RETURNING seq INTO v_seq;

  RETURN 'VEE-' || v_year || '-' || lpad(v_seq::text, 5, '0');
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Log de emails enviados (pixel de apertura + threading)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS veedor_email_log (
  id                  bigserial PRIMARY KEY,
  org_id              uuid      NOT NULL,
  expediente_id       text      NOT NULL,
  consecutivo         text      NOT NULL,
  message_id          text      NOT NULL,
  tipo                text      NOT NULL DEFAULT 'derecho_peticion',
  canal               text,                         -- 'smtp' | 'resend'
  destinatario_email  text      NOT NULL,
  destinatario_nombre text,
  pixel_id            uuid      NOT NULL DEFAULT gen_random_uuid(),
  open_count          int       NOT NULL DEFAULT 0,
  first_opened_at     timestamptz,
  fecha_envio         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pixel_id)
);

ALTER TABLE veedor_email_log ENABLE ROW LEVEL SECURITY;

-- Edge function de pixel llamará al backend que usará service_role.
-- No se necesita política de usuario autenticado para INSERT/UPDATE.

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Requerimientos (derecho de petición + tutela)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS veedor_requerimientos (
  id                  bigserial PRIMARY KEY,
  id_proceso          text      NOT NULL,          -- id_contrato del expediente
  org_id              uuid      NOT NULL,
  consecutivo         text,
  tipo                text      NOT NULL DEFAULT 'derecho_peticion'
                      CHECK (tipo IN ('derecho_peticion', 'tutela')),
  estado              text      NOT NULL DEFAULT 'enviado'
                      CHECK (estado IN (
                        'enviado', 'vencido_sin_respuesta',
                        'respondido', 'tutela_radicada'
                      )),

  -- Threading
  message_id_enviado  text,
  fecha_envio         timestamptz,
  fecha_vencimiento   date,        -- 15 días hábiles desde fecha_envio

  -- Respuesta
  respuesta_html      text,
  respuesta_from      text,
  respuesta_message_id text,
  fecha_respuesta     timestamptz,

  -- Análisis de fondo
  analisis_respuesta  jsonb,       -- { respondio_fondo, tipo_respuesta, razon, ... }

  -- Destinatario
  destinatario_email  text,
  destinatario_nombre text,

  -- Tutela
  numero_radicado     text,
  juzgado             text,
  ciudad_radicado     text,
  fecha_radicado      date,

  -- Análisis del fallo
  analisis_fallo      jsonb,

  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now(),

  UNIQUE (id_proceso)
);

ALTER TABLE veedor_requerimientos ENABLE ROW LEVEL SECURITY;

-- Trigger updated_at
CREATE OR REPLACE FUNCTION trg_set_updated_at_reqs()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS set_updated_at_reqs ON veedor_requerimientos;
CREATE TRIGGER set_updated_at_reqs
  BEFORE UPDATE ON veedor_requerimientos
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at_reqs();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Configuración de envío por org (SMTP / Resend)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS veedor_config_smtp (
  id          bigserial PRIMARY KEY,
  org_id      uuid NOT NULL UNIQUE,
  smtp_host   text,
  smtp_port   int  DEFAULT 587,
  smtp_user   text,
  smtp_pass   text,  -- cifrado en aplicación si se desea
  from_email  text,
  from_nombre text,
  imap_host   text,
  imap_port   int  DEFAULT 993,
  resend_api_key    text,
  resend_from_email text,
  activo      boolean DEFAULT true,
  last_imap_poll    timestamptz,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

ALTER TABLE veedor_config_smtp ENABLE ROW LEVEL SECURITY;
