-- RLS policies para veedor_config_smtp
-- Aplicar en Supabase de CATÓN (sedldbxesnsyohkidrtm)

-- Tabla ya existe (schema-envio.sql). Solo agregamos políticas.

CREATE POLICY "miembros pueden leer config smtp"
  ON veedor_config_smtp FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM veedor_memberships
      WHERE veedor_memberships.org_id = veedor_config_smtp.org_id
        AND veedor_memberships.user_id = auth.uid()
        AND veedor_memberships.activo = true
    )
  );

CREATE POLICY "directores pueden escribir config smtp"
  ON veedor_config_smtp FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM veedor_memberships
      WHERE veedor_memberships.org_id = veedor_config_smtp.org_id
        AND veedor_memberships.user_id = auth.uid()
        AND veedor_memberships.activo = true
        AND veedor_memberships.rol IN ('director', 'coordinador')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM veedor_memberships
      WHERE veedor_memberships.org_id = veedor_config_smtp.org_id
        AND veedor_memberships.user_id = auth.uid()
        AND veedor_memberships.activo = true
        AND veedor_memberships.rol IN ('director', 'coordinador')
    )
  );
