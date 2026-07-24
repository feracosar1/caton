-- ── API Keys externas para Veedor API ────────────────────────────────────────
-- Permite a entidades externas consumir https://veedor-api.numa.la
-- con una key propia sin necesitar una cuenta en Catón.
--
-- Formato del key:  sk_veedor_{32 chars base64url}
-- En tránsito:      Authorization: Bearer sk_veedor_XXXX...
-- En DB:            solo el SHA-256 del key (nunca el key en claro)

CREATE TABLE IF NOT EXISTS veedor_api_keys (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  key_hash        text        UNIQUE NOT NULL,   -- SHA-256 hex del key completo
  key_prefix      text        NOT NULL,          -- primeros 20 chars (para mostrar en UI)
  nombre          text        NOT NULL,          -- "Contraloría Cundinamarca"
  email           text,                          -- contacto
  plan            text        NOT NULL DEFAULT 'basico'
                              CHECK (plan IN ('basico', 'profesional', 'enterprise')),
  activo          boolean     NOT NULL DEFAULT true,
  limite_mes      int,                           -- NULL = ilimitado
  peticiones_mes  int         NOT NULL DEFAULT 0,
  peticiones_total bigint     NOT NULL DEFAULT 0,
  periodo_reset   date        NOT NULL DEFAULT date_trunc('month', now())::date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz
);

-- Índice de lookup (hot path — se consulta en cada request autenticado con API key)
CREATE INDEX IF NOT EXISTS idx_api_keys_hash   ON veedor_api_keys (key_hash) WHERE activo = true;
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON veedor_api_keys (key_prefix);

-- RLS: solo el dueño o super admin ve sus propias keys
ALTER TABLE veedor_api_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY "dueño ve su key"   ON veedor_api_keys FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "admin ve todo"     ON veedor_api_keys FOR ALL   USING (is_caton_admin());
CREATE POLICY "service role todo" ON veedor_api_keys FOR ALL   USING (auth.role() = 'service_role');

-- ── RPC verificar_api_key ────────────────────────────────────────────────────
-- Recibe el SHA-256 del key, retorna true si está activo y dentro del límite.
-- También registra el uso (last_used_at + peticiones).
-- SECURITY DEFINER: el server llama con anon key, esta fn puede escribir.

CREATE OR REPLACE FUNCTION verificar_api_key(p_key_hash text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row veedor_api_keys;
BEGIN
  SELECT * INTO v_row
  FROM veedor_api_keys
  WHERE key_hash = p_key_hash AND activo = true;

  IF NOT FOUND THEN RETURN false; END IF;

  -- Reset mensual automático
  IF v_row.periodo_reset < date_trunc('month', now())::date THEN
    UPDATE veedor_api_keys
    SET peticiones_mes = 0,
        periodo_reset  = date_trunc('month', now())::date
    WHERE key_hash = p_key_hash;
    v_row.peticiones_mes := 0;
  END IF;

  -- Verificar límite mensual
  IF v_row.limite_mes IS NOT NULL AND v_row.peticiones_mes >= v_row.limite_mes THEN
    RETURN false;  -- 429 en el middleware
  END IF;

  -- Registrar uso
  UPDATE veedor_api_keys
  SET last_used_at    = now(),
      peticiones_mes  = peticiones_mes + 1,
      peticiones_total = peticiones_total + 1
  WHERE key_hash = p_key_hash;

  RETURN true;
END;
$$;

-- ── Función auxiliar is_caton_admin (si no existe ya) ────────────────────────
CREATE OR REPLACE FUNCTION is_caton_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM caton_admins WHERE user_id = auth.uid()
  );
$$;
