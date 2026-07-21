/**
 * EditorDenuncia — editor TipTap para el borrador de denuncia del Veedor.
 *
 * Carga el HTML generado por el backend, permite editarlo y:
 *  - Guardar borrador (PATCH al veedor-server)
 *  - Descargar Word (.docx) con membrete y pie de página
 *  - Copiar al portapapeles
 */
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Table } from '@tiptap/extension-table'
import { TableRow } from '@tiptap/extension-table-row'
import { TableCell } from '@tiptap/extension-table-cell'
import { TableHeader } from '@tiptap/extension-table-header'
import { useState, useCallback } from 'react'
import {
  Bold, Italic, Heading1, Heading2, Heading3,
  List, Table as TableIcon, Save, Download, Loader, Check, Copy,
} from 'lucide-react'

// Paleta (espejo de VeeduriaExpedientes)
const DKGRN = '#0F3D2E'
const GREEN = '#1D9E75'
const INK   = '#0B1F1A'
const INK12 = 'rgba(11,31,26,0.12)'
const INK55 = 'rgba(11,31,26,0.55)'
const CREAM = '#F5F3EF'
const GOLD  = '#C6A15B'
const WHITE = '#FFFFFF'

interface EditorDenunciaProps {
  htmlInicial: string
  consecutivo?: string
  expedienteId: string
  /** Callback para persistir el HTML editado en el veedor-server */
  onGuardar: (html: string) => Promise<void>
  /** Configuración de membrete (fetched desde supabase veedor_config) */
  config?: {
    pie_pagina_text?: string
    firmante_nombre?: string
    firmante_cargo?: string
  }
}

const BTN: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5,
  padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600,
  cursor: 'pointer', border: `1px solid ${INK12}`, background: WHITE, color: INK,
  transition: 'all 0.15s',
}
const BTN_ACTIVE: React.CSSProperties = { ...BTN, background: DKGRN, color: WHITE, border: `1px solid ${DKGRN}` }
const DIVIDER: React.CSSProperties = { width: 1, height: 20, background: INK12, margin: '0 4px' }

export function EditorDenuncia({ htmlInicial, consecutivo, expedienteId, onGuardar, config }: EditorDenunciaProps) {
  const [guardando, setGuardando] = useState(false)
  const [guardado, setGuardado]   = useState(false)
  const [exportando, setExportando] = useState(false)
  const [copiado, setCopiado]     = useState(false)

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        bulletList:  { keepMarks: true },
        orderedList: { keepMarks: true },
      }),
      Table.configure({ resizable: false }),
      TableRow,
      TableCell,
      TableHeader,
    ],
    content: htmlInicial || '<p></p>',
    editorProps: {
      attributes: {
        class: 'veedor-editor-content',
        style: 'outline:none; min-height:400px; padding:20px; font-family:Georgia,serif; font-size:14px; line-height:1.7; color:#0B1F1A',
      },
    },
  })

  const guardar = useCallback(async () => {
    if (!editor) return
    setGuardando(true)
    try {
      await onGuardar(editor.getHTML())
      setGuardado(true)
      setTimeout(() => setGuardado(false), 2500)
    } finally {
      setGuardando(false)
    }
  }, [editor, onGuardar])

  const copiar = useCallback(() => {
    if (!editor) return
    const text = editor.getText()
    navigator.clipboard.writeText(text).then(() => {
      setCopiado(true)
      setTimeout(() => setCopiado(false), 2000)
    })
  }, [editor])

  const exportarWord = useCallback(async () => {
    if (!editor) return
    setExportando(true)
    try {
      const { exportarDenunciaDocx } = await import('./exportDenuncia.js')
      const blob = await exportarDenunciaDocx({
        html: editor.getHTML(),
        consecutivo: consecutivo ?? '',
        piePagina: config?.pie_pagina_text,
        firmante: config?.firmante_nombre,
        cargoFirmante: config?.firmante_cargo,
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `Denuncia-${consecutivo ?? expedienteId}.docx`
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      setExportando(false)
    }
  }, [editor, consecutivo, expedienteId, config])

  if (!editor) return null

  const isActive = (type: string, attrs?: Record<string, unknown>) =>
    attrs ? editor.isActive(type, attrs) : editor.isActive(type)

  return (
    <div style={{ border: `1px solid ${INK12}`, borderRadius: 10, overflow: 'hidden', background: WHITE }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 3, padding: '8px 12px',
        borderBottom: `1px solid ${INK12}`, background: CREAM, flexWrap: 'wrap',
      }}>
        {/* Formato de texto */}
        <button style={isActive('bold') ? BTN_ACTIVE : BTN}
          onClick={() => editor.chain().focus().toggleBold().run()} title="Negrita (Ctrl+B)">
          <Bold size={13} />
        </button>
        <button style={isActive('italic') ? BTN_ACTIVE : BTN}
          onClick={() => editor.chain().focus().toggleItalic().run()} title="Cursiva (Ctrl+I)">
          <Italic size={13} />
        </button>

        <span style={DIVIDER} />

        {/* Encabezados */}
        <button style={isActive('heading', { level: 1 }) ? BTN_ACTIVE : BTN}
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} title="Título 1">
          <Heading1 size={13} />
        </button>
        <button style={isActive('heading', { level: 2 }) ? BTN_ACTIVE : BTN}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} title="Título 2">
          <Heading2 size={13} />
        </button>
        <button style={isActive('heading', { level: 3 }) ? BTN_ACTIVE : BTN}
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} title="Título 3">
          <Heading3 size={13} />
        </button>

        <span style={DIVIDER} />

        {/* Lista */}
        <button style={isActive('bulletList') ? BTN_ACTIVE : BTN}
          onClick={() => editor.chain().focus().toggleBulletList().run()} title="Lista con viñetas">
          <List size={13} />
        </button>

        {/* Tabla */}
        <button style={BTN}
          onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} title="Insertar tabla">
          <TableIcon size={13} />
        </button>

        <span style={DIVIDER} />

        {/* Acciones */}
        <button style={{ ...BTN, marginLeft: 'auto' }} onClick={copiar} title="Copiar texto">
          {copiado ? <Check size={13} color={GREEN} /> : <Copy size={13} />}
        </button>

        <button
          style={{ ...BTN, background: exportando ? CREAM : WHITE }}
          onClick={exportarWord} disabled={exportando} title="Descargar Word (.docx)">
          {exportando ? <Loader size={13} className="spin" /> : <Download size={13} />}
          <span style={{ fontSize: 11 }}>Word</span>
        </button>

        <button
          style={{ ...BTN, background: guardado ? GREEN : GOLD, color: WHITE, border: 'none' }}
          onClick={guardar} disabled={guardando || guardado} title="Guardar borrador">
          {guardando ? <Loader size={13} className="spin" /> : guardado ? <Check size={13} /> : <Save size={13} />}
          <span style={{ fontSize: 11 }}>{guardado ? 'Guardado' : 'Guardar'}</span>
        </button>
      </div>

      {/* Encabezado consecutivo */}
      {consecutivo && (
        <div style={{ padding: '8px 20px', background: '#E4EDE9', borderBottom: `1px solid ${INK12}`, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: DKGRN, fontFamily: 'monospace' }}>{consecutivo}</span>
          <span style={{ fontSize: 11, color: INK55 }}>— Expediente de denuncia</span>
        </div>
      )}

      {/* Editor */}
      <div style={{ minHeight: 400, overflowY: 'auto', maxHeight: 680 }}>
        <EditorContent editor={editor} />
      </div>

      {/* Estilos para el contenido del editor */}
      <style>{`
        .veedor-editor-content h1 { font-size: 20px; font-weight: 800; color: #0F3D2E; margin: 16px 0 8px; }
        .veedor-editor-content h2 { font-size: 17px; font-weight: 700; color: #0F3D2E; margin: 14px 0 6px; }
        .veedor-editor-content h3 { font-size: 15px; font-weight: 700; color: #0B1F1A; margin: 12px 0 4px; }
        .veedor-editor-content p  { margin: 0 0 10px; }
        .veedor-editor-content ul { list-style: disc; padding-left: 22px; margin: 0 0 10px; }
        .veedor-editor-content ol { list-style: decimal; padding-left: 22px; margin: 0 0 10px; }
        .veedor-editor-content li { margin-bottom: 4px; }
        .veedor-editor-content strong { font-weight: 700; }
        .veedor-editor-content em { font-style: italic; }
        .veedor-editor-content table { border-collapse: collapse; width: 100%; margin: 12px 0; }
        .veedor-editor-content th, .veedor-editor-content td { border: 1px solid rgba(11,31,26,0.2); padding: 6px 10px; font-size: 13px; }
        .veedor-editor-content th { background: #E4EDE9; font-weight: 700; color: #0F3D2E; }
        .veedor-editor-content .is-editor-empty::before { content: attr(data-placeholder); float: left; color: rgba(11,31,26,0.4); pointer-events: none; height: 0; }
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  )
}
