/**
 * PERSISTENCIA del expediente de veeduría.
 *
 * Capa delgada sobre las tablas veeduria_* del schema-veeduria.sql. El
 * orquestador (pipeline.mjs) la recibe como `repo`; sin ella corre en memoria.
 *
 * Recibe un cliente de Supabase ya construido (el mismo `supabase` del
 * veedor-server, con service_role_key). No lee secretos por su cuenta.
 */

export function crearRepo(supabase) {
  return {
    // ── Expediente ──
    async crearExpediente(contrato) {
      const { data, error } = await supabase.from('veeduria_expedientes')
        .upsert({
          id_contrato:         contrato.id_contrato,
          id_portafolio:       contrato.id_portafolio,
          referencia_contrato: contrato.referencia_contrato,
          entidad:             contrato.entidad,
          nit_entidad:         contrato.nit_entidad,
          contratista:         contrato.contratista,
          nit_contratista:     contrato.nit_contratista,
          supervisor:          contrato.supervisor,
          valor_contrato:      contrato.valor_contrato,
          estado:              'seleccionado',
          updated_at:          new Date().toISOString(),
        }, { onConflict: 'id_contrato' })
        .select('id').single();
      if (error) throw new Error(`crearExpediente: ${error.message}`);
      return data.id;
    },

    async actualizarEstado(expedienteId, estado, extra = {}) {
      const { error } = await supabase.from('veeduria_expedientes')
        .update({ estado, updated_at: new Date().toISOString(), ...extra })
        .eq('id', expedienteId);
      if (error) throw new Error(`actualizarEstado: ${error.message}`);
    },

    // ── Documentos (custodia) ──
    async guardarDocumento(expedienteId, doc) {
      const { data, error } = await supabase.from('veeduria_documentos')
        .upsert({
          expediente_id:      expedienteId,
          origen:             doc.origen,
          tipo:               'informe_supervision',
          nombre_archivo:     doc.nombre,
          id_documento_secop: doc.id_documento_secop,
          url_origen:         doc.url_origen,
          sha256:             doc.sha256,
          fecha_captura:      doc.fecha_captura,
          tamano_bytes:       doc.tamano_bytes,
          texto_extraido:     doc._texto ?? null,
        }, { onConflict: 'sha256' })
        .select('id').single();
      if (error) throw new Error(`guardarDocumento: ${error.message}`);
      return data.id;
    },

    // ── Hallazgos (SOLO el motor escribe acá) ──
    async guardarHallazgo(expedienteId, h) {
      const { error } = await supabase.from('veeduria_hallazgos').insert({
        expediente_id:     expedienteId,
        regla_id:          h.regla_id,
        doc_id:            h.doc_id_db ?? null,     // FK real; puede requerir mapeo doc.id→doc_id_db
        folio:             h.folio,
        cifra_afirmada:    h.cifra_afirmada,
        cifra_calculada:   h.cifra_calculada,
        delta:             h.delta,
        evidencia_textual: h.evidencia_textual,
        detalle:           h.detalle ?? null,
        norma_ref:         h.norma_ref ?? null,
        norma_verificada:  false,
      });
      if (error) throw new Error(`guardarHallazgo: ${error.message}`);
    },

    // ── Lectura para la UI ──
    async listarExpedientes({ estado, limite = 50 } = {}) {
      let q = supabase.from('veeduria_expedientes')
        .select('id,id_contrato,referencia_contrato,entidad,contratista,valor_contrato,estado,score_triaje,updated_at')
        .order('updated_at', { ascending: false }).limit(limite);
      if (estado) q = q.eq('estado', estado);
      const { data, error } = await q;
      if (error) throw new Error(`listarExpedientes: ${error.message}`);
      return data;
    },

    async obtenerExpediente(expedienteId) {
      const { data: exp, error: e1 } = await supabase.from('veeduria_expedientes')
        .select('*').eq('id', expedienteId).single();
      if (e1) throw new Error(`obtenerExpediente: ${e1.message}`);

      const { data: docs } = await supabase.from('veeduria_documentos')
        .select('id,nombre_archivo,url_origen,sha256,fecha_captura,tamano_bytes')
        .eq('expediente_id', expedienteId);

      const { data: hallazgos } = await supabase.from('veeduria_hallazgos')
        .select('*').eq('expediente_id', expedienteId).order('id');

      // Actuaciones (denuncia, respuesta, tutela…) — para que la UI muestre el
      // borrador y su desglose de citas. Incluye el HTML: son pocas por expediente.
      const { data: actuaciones } = await supabase.from('veeduria_actuaciones')
        .select('id,tipo,direccion,estado,contenido_html,evaluacion,created_at')
        .eq('expediente_id', expedienteId).order('created_at');

      return { expediente: exp, documentos: docs ?? [], hallazgos: hallazgos ?? [], actuaciones: actuaciones ?? [] };
    },

    // ── Actuaciones (denuncia, respuesta, tutela…) ──
    async guardarActuacion(expedienteId, { tipo, contenidoHtml, estado = 'borrador', evaluacion = null }) {
      const { data, error } = await supabase.from('veeduria_actuaciones')
        .insert({ expediente_id: expedienteId, tipo, direccion: 'enviada', estado,
                  contenido_html: contenidoHtml, evaluacion })
        .select('id').single();
      if (error) throw new Error(`guardarActuacion: ${error.message}`);
      return data.id;
    },

    async actualizarActuacion(expedienteId, tipo, { contenidoHtml }) {
      const { error } = await supabase.from('veeduria_actuaciones')
        .update({ contenido_html: contenidoHtml })
        .eq('expediente_id', expedienteId)
        .eq('tipo', tipo);
      if (error) throw new Error(`actualizarActuacion: ${error.message}`);
    },
  };
}
