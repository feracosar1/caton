// @ts-nocheck
/**
 * exportDenuncia — genera Word (.docx) del borrador de denuncia.
 *
 * Usa la misma infraestructura que MinutaGenerator: parseHtmlToDocxBlocks
 * convierte el HTML de TipTap a bloques intermedios, blockToParagraph los
 * renderiza como párrafos Word. El membrete va en el header; el pie de
 * página y firmante van al final.
 */
import {
  AlignmentType,
  Document,
  Footer,
  Header,
  Packer,
  Paragraph,
  TextRun,
  convertInchesToTwip,
  PageNumber,
  HeadingLevel,
} from 'docx'
import { parseHtmlToDocxBlocks, blockToParagraph, numberingConfig } from './exportDocx.js'

export interface ExportDenunciaOpts {
  html: string
  consecutivo: string
  piePagina?: string
  firmante?: string
  cargoFirmante?: string
  /** URL pública de la imagen del membrete (JPG/PNG, max ~250x80 px) */
  membreteUrl?: string
}

const VERDE  = '0F3D2E'
const NEGRO  = '0B1F1A'
const GRIS   = '5A6472'
const DORADO = 'C6A15B'

function parrafo(texto: string, opts?: {
  bold?: boolean; size?: number; color?: string; align?: 'center' | 'right' | 'left'
  heading?: typeof HeadingLevel[keyof typeof HeadingLevel]; spacing?: number
}): Paragraph {
  return new Paragraph({
    heading: opts?.heading,
    alignment: opts?.align === 'center'
      ? AlignmentType.CENTER
      : opts?.align === 'right'
      ? AlignmentType.RIGHT
      : AlignmentType.LEFT,
    spacing: { after: opts?.spacing ?? 120 },
    children: [
      new TextRun({
        text: texto,
        bold: opts?.bold,
        size: (opts?.size ?? 11) * 2,  // half-points
        color: opts?.color ?? NEGRO,
        font: 'Times New Roman',
      }),
    ],
  })
}

export async function exportarDenunciaDocx(opts: ExportDenunciaOpts): Promise<Blob> {
  const { html, consecutivo, piePagina, firmante, cargoFirmante } = opts

  // Parsear HTML del editor a bloques intermedios
  const bloques = parseHtmlToDocxBlocks(html)

  // Convertir bloques a párrafos Word (filtrar nulls)
  const cuerpo = bloques
    .map(b => blockToParagraph(b, false))
    .filter((p): p is Paragraph | Table => p !== null)

  // Header: consecutivo + título
  const header = new Header({
    children: [
      parrafo(consecutivo || 'DENUNCIA FORMAL ANTE ÓRGANO DE CONTROL', {
        bold: true, size: 10, color: VERDE, align: 'right',
      }),
      new Paragraph({
        border: { bottom: { style: 'single' as const, size: 6, color: VERDE, space: 4 } },
        spacing: { after: 240 },
        children: [],
      }),
    ],
  })

  // Footer: pie de página + número de página
  const pieParagraphs: Paragraph[] = []
  if (piePagina) {
    pieParagraphs.push(parrafo(piePagina, { size: 9, color: GRIS }))
  }
  if (firmante) {
    pieParagraphs.push(parrafo(
      `${firmante}${cargoFirmante ? ` · ${cargoFirmante}` : ''}`,
      { size: 9, color: NEGRO, bold: true }
    ))
  }
  pieParagraphs.push(
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      children: [
        new TextRun({ text: 'Página ', size: 18, color: GRIS }),
        new TextRun({ children: [PageNumber.CURRENT], size: 18, color: GRIS }),
        new TextRun({ text: ' de ', size: 18, color: GRIS }),
        new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18, color: GRIS }),
      ],
    })
  )

  const footer = new Footer({ children: pieParagraphs })

  // Bloque de firma al final del documento
  const bloquesFirma: Paragraph[] = []
  if (firmante) {
    bloquesFirma.push(
      parrafo('', { spacing: 480 }),  // espacio antes de firma
      parrafo('_'.repeat(40), { color: GRIS }),
      parrafo(firmante, { bold: true, size: 11 }),
    )
    if (cargoFirmante) {
      bloquesFirma.push(parrafo(cargoFirmante, { size: 10, color: GRIS }))
    }
  }

  const doc = new Document({
    numbering: numberingConfig,
    sections: [
      {
        properties: {
          page: {
            margin: {
              top:    convertInchesToTwip(1.1),
              bottom: convertInchesToTwip(1.1),
              left:   convertInchesToTwip(1.25),
              right:  convertInchesToTwip(1.25),
            },
          },
        },
        headers: { default: header },
        footers: { default: footer },
        children: [
          // Título principal del documento
          parrafo('DENUNCIA FORMAL ANTE ÓRGANO DE CONTROL COMPETENTE', {
            bold: true, size: 14, color: VERDE, align: 'center', spacing: 240,
          }),
          parrafo(`Ref.: ${consecutivo || 'Expediente de veeduría'}`, {
            size: 11, color: GRIS, align: 'center', spacing: 480,
          }),
          // Cuerpo
          ...cuerpo,
          // Firma
          ...bloquesFirma,
        ],
      },
    ],
  })

  const buffer = await Packer.toBuffer(doc)
  return new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
}
