-- Migración: tabla para búsquedas asíncronas de SECOP
-- Aplicar en el Supabase de CATÓN (sedldbxesnsyohkidrtm.supabase.co)
-- SQL Editor → Run

CREATE TABLE IF NOT EXISTS veedor_busquedas_async (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filtros          jsonb NOT NULL DEFAULT '{}',
  email_destino    text NOT NULL,
  estado           text NOT NULL DEFAULT 'corriendo'
                     CHECK (estado IN ('corriendo', 'completada', 'error')),
  total_contratos  int,
  top_score        int,
  error_msg        text,
  created_at       timestamptz DEFAULT now(),
  completado_at    timestamptz
);

-- Índice para listar los jobs recientes
CREATE INDEX IF NOT EXISTS idx_veedor_busquedas_async_created
  ON veedor_busquedas_async (created_at DESC);
