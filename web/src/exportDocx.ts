// @ts-nocheck
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  ShadingType,
  LeaderType,
  Table,
  TableCell,
  TableOfContents,
  TableRow,
  TabStopType,
  TextRun,
  ThematicBreak,
  VerticalAlign,
  WidthType,
  convertInchesToTwip,
} from 'docx';

// Rayado notarial (guardas): tab derecho al borde del contenido (letter 8.5in − 2×1.18in
// margen ≈ 6.14in) con relleno de guiones, para llenar el espacio sobrante al final de cada
// párrafo e impedir que se inserte texto. Solo aplica a escrituras (rayado=true).
const RAYADO_TAB_POS = convertInchesToTwip(6.14);
const rayadoTabStop = { type: TabStopType.RIGHT, position: RAYADO_TAB_POS, leader: LeaderType.HYPHEN };

// ─── public profile shape ─────────────────────────────────────────────────────

export type ProfileData = {
  logo_url?: string;
  contact_phone?: string;
  contact_email?: string;
  contact_website?: string;
  contact_address?: string;
  lawyer_name?: string;
  bar_license?: string;
} | null;

// ─── intermediate representation ─────────────────────────────────────────────

export type DocRun = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
};

export type DocBlockAlign = 'justify' | 'center' | 'right' | 'left';

export type DocBlock =
  | { type: 'paragraph'; runs: DocRun[]; align?: DocBlockAlign }
  | { type: 'heading'; level: 1 | 2 | 3 | 4; text: string }
  | { type: 'list'; ordered: boolean; items: DocRun[][] }
  | { type: 'table'; rows: DocRun[][][] }
  | { type: 'page_break' }
  | { type: 'hr' }
  | { type: 'signature_block'; lines: string[] };

// ─── numbering reference IDs ──────────────────────────────────────────────────

const DECIMAL_REF = 'numa-decimal';
const BULLET_REF = 'numa-bullet';
const HEADING_NUM_REF = 'numa-heading-num';

// ─── helpers: extract runs from a DOM element ─────────────────────────────────

function nodeToRuns(node: Node): DocRun[] {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? '';
    if (!text) return [];
    return [{ text }];
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return [];

  const el = node as Element;
  const tag = el.tagName.toLowerCase();

  if (tag === 'br') return [{ text: '\n' }];

  const childRuns: DocRun[] = Array.from(el.childNodes).flatMap(nodeToRuns);

  const isBold = ['strong', 'b'].includes(tag);
  const isItalic = ['em', 'i'].includes(tag);
  const isUnderline = tag === 'u';
  const isStrike = ['s', 'del', 'strike'].includes(tag);

  if (!isBold && !isItalic && !isUnderline && !isStrike) return childRuns;

  return childRuns.map((r) => ({
    ...r,
    bold: r.bold || isBold,
    italic: r.italic || isItalic,
    underline: r.underline || isUnderline,
    strike: r.strike || isStrike,
  }));
}

function elToRuns(el: Element): DocRun[] {
  return Array.from(el.childNodes).flatMap(nodeToRuns);
}

function elToPlainText(el: Element): string {
  return el.textContent?.trim() ?? '';
}

function detectAlign(el: Element): DocBlockAlign {
  const style = (el as HTMLElement).style?.textAlign ?? '';
  const align = el.getAttribute('align') ?? style;
  if (align === 'center') return 'center';
  if (align === 'right') return 'right';
  if (align === 'left') return 'left';
  return 'justify';
}

// ─── HTML → DocBlock[] ────────────────────────────────────────────────────────

export function parseHtmlToDocxBlocks(html: string): DocBlock[] {
  const container = document.createElement('div');
  container.innerHTML = html;

  const blocks: DocBlock[] = [];

  function walkElement(el: Element): void {
    const tag = el.tagName.toLowerCase();

    if (tag === 'script' || tag === 'style') return;

    if (['h1', 'h2', 'h3', 'h4'].includes(tag)) {
      const level = parseInt(tag[1], 10) as 1 | 2 | 3 | 4;
      blocks.push({ type: 'heading', level, text: elToPlainText(el) });
      return;
    }

    if (tag === 'hr') {
      blocks.push({ type: 'hr' });
      return;
    }

    if (tag === 'br') return;

    if (tag === 'ol' || tag === 'ul') {
      const items = Array.from(el.querySelectorAll(':scope > li')).map((li) =>
        elToRuns(li as Element)
      );
      if (items.length > 0) {
        blocks.push({ type: 'list', ordered: tag === 'ol', items });
      }
      return;
    }

    if (tag === 'table') {
      const rows: DocRun[][][] = [];
      el.querySelectorAll('tr').forEach((tr) => {
        const cells: DocRun[][] = [];
        tr.querySelectorAll('td, th').forEach((cell) => {
          cells.push(elToRuns(cell as Element));
        });
        if (cells.length > 0) rows.push(cells);
      });
      if (rows.length > 0) {
        blocks.push({ type: 'table', rows });
      }
      return;
    }

    if (
      el.classList.contains('signature-block') ||
      el.getAttribute('data-type') === 'signature'
    ) {
      const lines = Array.from(el.children)
        .map((c) => c.textContent?.trim() ?? '')
        .filter(Boolean);
      blocks.push({ type: 'signature_block', lines });
      return;
    }

    if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article') {
      const style = (el as HTMLElement).style?.pageBreakBefore ?? '';
      if (style === 'always') blocks.push({ type: 'page_break' });

      const runs = elToRuns(el);
      const text = (el.textContent ?? '').trim();

      if (!text && runs.length === 0) {
        blocks.push({ type: 'paragraph', runs: [{ text: '' }] });
        return;
      }

      if (tag === 'div' || tag === 'section' || tag === 'article') {
        const hasBlockChildren = Array.from(el.children).some((c) => {
          const ct = c.tagName.toLowerCase();
          return ['p', 'div', 'h1', 'h2', 'h3', 'h4', 'ol', 'ul', 'table', 'hr', 'section'].includes(ct);
        });
        if (hasBlockChildren) {
          Array.from(el.childNodes).forEach((child) => {
            if (child.nodeType === Node.ELEMENT_NODE) {
              walkElement(child as Element);
            } else if (child.nodeType === Node.TEXT_NODE) {
              const t = (child.textContent ?? '').trim();
              if (t) blocks.push({ type: 'paragraph', runs: [{ text: t }], align: 'justify' });
            }
          });
          return;
        }
      }

      blocks.push({ type: 'paragraph', runs, align: detectAlign(el) });
      return;
    }

    Array.from(el.childNodes).forEach((child) => {
      if (child.nodeType === Node.ELEMENT_NODE) {
        walkElement(child as Element);
      } else if (child.nodeType === Node.TEXT_NODE) {
        const t = (child.textContent ?? '').trim();
        if (t) blocks.push({ type: 'paragraph', runs: [{ text: t }], align: 'justify' });
      }
    });
  }

  Array.from(container.childNodes).forEach((node) => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      walkElement(node as Element);
    } else if (node.nodeType === Node.TEXT_NODE) {
      const t = (node.textContent ?? '').trim();
      if (t) blocks.push({ type: 'paragraph', runs: [{ text: t }], align: 'justify' });
    }
  });

  return blocks;
}

// ─── DocRun[] → TextRun[] ─────────────────────────────────────────────────────

function runsToTextRuns(runs: DocRun[]): TextRun[] {
  if (runs.length === 0) return [new TextRun('')];
  return runs.map(
    (r) =>
      new TextRun({
        text: r.text,
        bold: r.bold,
        italics: r.italic,
        underline: r.underline ? {} : undefined,
        strike: r.strike,
        font: 'Times New Roman',
        size: 24,
      })
  );
}

// ─── align helper ─────────────────────────────────────────────────────────────

function toDocxAlign(
  align?: DocBlockAlign
): (typeof AlignmentType)[keyof typeof AlignmentType] {
  switch (align) {
    case 'center': return AlignmentType.CENTER;
    case 'right': return AlignmentType.RIGHT;
    case 'left': return AlignmentType.LEFT;
    default: return AlignmentType.JUSTIFIED;
  }
}

// ─── DocBlock → docx element ──────────────────────────────────────────────────

export function blockToParagraph(block: DocBlock, rayado = false): Paragraph | Table | null {
  switch (block.type) {
    case 'heading': {
      const levelMap: Record<1 | 2 | 3 | 4, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
        1: HeadingLevel.HEADING_1,
        2: HeadingLevel.HEADING_2,
        3: HeadingLevel.HEADING_3,
        4: HeadingLevel.HEADING_4,
      };
      const isMainHeading = block.level === 1;
      const isSubHeading = block.level === 2;
      return new Paragraph({
        text: block.text,
        heading: levelMap[block.level],
        spacing: { before: block.level <= 2 ? 280 : 200, after: 120 },
        numbering: isMainHeading
          ? { reference: HEADING_NUM_REF, level: 0 }
          : isSubHeading
            ? { reference: HEADING_NUM_REF, level: 1 }
            : undefined,
      });
    }

    case 'paragraph': {
      const runs = runsToTextRuns(block.runs);
      // Rayado notarial: solo en párrafos CON contenido (no vacíos), y no en párrafos ya
      // centrados/derecha (firmas, encabezados). Se agrega un tab final que el tab-stop derecho
      // con leader de guiones rellena hasta el margen.
      const tieneTexto = block.runs.some(r => (r.text ?? '').trim().length > 0);
      const aplicaRayado = rayado && tieneTexto && (block.align ?? 'left') === 'left';
      if (aplicaRayado) runs.push(new TextRun({ text: '\t' }));
      return new Paragraph({
        children: runs,
        alignment: toDocxAlign(block.align),
        spacing: { after: 120, line: 360, lineRule: 'auto' },
        ...(aplicaRayado ? { tabStops: [rayadoTabStop] } : {}),
      });
    }

    case 'hr': {
      return new Paragraph({
        children: [new ThematicBreak()],
        spacing: { before: 120, after: 120 },
      });
    }

    case 'page_break': {
      return new Paragraph({
        children: [new PageBreak()],
      });
    }

    case 'signature_block': {
      const children: TextRun[] = [];
      block.lines.forEach((line, idx) => {
        if (idx > 0) children.push(new TextRun({ break: 1 }));
        children.push(new TextRun({ text: line, font: 'Times New Roman', size: 24 }));
      });
      return new Paragraph({
        children,
        spacing: { before: 480, after: 120, line: 360, lineRule: 'auto' },
        alignment: AlignmentType.CENTER,
      });
    }

    case 'list':
      return null;

    case 'table': {
      const tableRows = block.rows.map((rowCells) =>
        new TableRow({
          children: rowCells.map((cellRuns) =>
            new TableCell({
              children: [
                new Paragraph({
                  children: runsToTextRuns(cellRuns),
                  spacing: { after: 60 },
                }),
              ],
              width: { size: Math.floor(9360 / rowCells.length), type: WidthType.DXA },
            })
          ),
        })
      );
      return new Table({
        rows: tableRows,
        width: { size: 100, type: WidthType.PERCENTAGE },
      });
    }

    default:
      return null;
  }
}

// ─── list blocks → Paragraph[] ───────────────────────────────────────────────

function listBlockToParagraphs(block: DocBlock & { type: 'list' }): Paragraph[] {
  return block.items.map(
    (itemRuns) =>
      new Paragraph({
        children: runsToTextRuns(itemRuns),
        numbering: { reference: block.ordered ? DECIMAL_REF : BULLET_REF, level: 0 },
        spacing: { after: 80, line: 360, lineRule: 'auto' },
      })
  );
}

// ─── header builder ───────────────────────────────────────────────────────────

async function fetchLogoBuffer(url: string): Promise<ArrayBuffer | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return await resp.arrayBuffer();
  } catch {
    return null;
  }
}

const NONE_BORDER = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' } as const;

export async function buildHeader(profile: ProfileData): Promise<Header> {
  if (!profile || (!profile.logo_url && !profile.lawyer_name)) {
    return new Header({ children: [] });
  }

  const logoBuffer = profile.logo_url ? await fetchLogoBuffer(profile.logo_url) : null;

  const noBorders = {
    top: NONE_BORDER,
    bottom: NONE_BORDER,
    left: NONE_BORDER,
    right: NONE_BORDER,
    insideH: NONE_BORDER,
    insideV: NONE_BORDER,
  };

  const leftCell = new TableCell({
    width: { size: 25, type: WidthType.PERCENTAGE },
    verticalAlign: VerticalAlign.CENTER,
    borders: noBorders,
    children: [
      new Paragraph({
        children: logoBuffer
          ? [new ImageRun({ data: logoBuffer, transformation: { width: 90, height: 36 }, type: 'png' })]
          : [],
        spacing: { before: 0, after: 0 },
      }),
    ],
  });

  const nameRuns: TextRun[] = profile.lawyer_name
    ? [
        new TextRun({
          text: profile.lawyer_name,
          font: 'Times New Roman',
          size: 22,
          bold: true,
          color: '111827',
        }),
      ]
    : [new TextRun('')];

  const rightCell = new TableCell({
    width: { size: 75, type: WidthType.PERCENTAGE },
    verticalAlign: VerticalAlign.CENTER,
    borders: noBorders,
    children: [
      new Paragraph({
        children: nameRuns,
        alignment: AlignmentType.RIGHT,
        spacing: { before: 0, after: 0 },
      }),
    ],
  });

  const headerTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: noBorders,
    rows: [
      new TableRow({
        children: [leftCell, rightCell],
      }),
    ],
  });

  const dividerLine = new Paragraph({
    children: [],
    spacing: { before: 60, after: 0 },
    border: {
      bottom: { style: 'single', size: 4, color: 'E5E7EB', space: 4 },
    },
  });

  return new Header({ children: [headerTable, dividerLine] });
}



// ─── footer builder ───────────────────────────────────────────────────────────

function buildDocxFooter(profile: ProfileData, showBranding: boolean): Footer {
  const contactParts: string[] = [];
  if (profile?.lawyer_name) contactParts.push(profile.lawyer_name);
  if (profile?.bar_license) contactParts.push(`T.P. ${profile.bar_license}`);
  if (profile?.contact_phone) contactParts.push(profile.contact_phone);
  if (profile?.contact_email) contactParts.push(profile.contact_email);
  if (profile?.contact_website) contactParts.push(profile.contact_website);
  if (profile?.contact_address) contactParts.push(profile.contact_address);

  const leftText =
    contactParts.length > 0
      ? contactParts.join('  |  ')
      : showBranding
        ? 'numa.la'
        : '';

  return new Footer({
    children: [
      new Paragraph({
        children: [
          ...(leftText
            ? [
                new TextRun({ text: leftText, font: 'Times New Roman', size: 16, color: '6B7280' }),
                new TextRun({ text: '     ', font: 'Times New Roman', size: 16 }),
              ]
            : []),
          new TextRun({ text: 'Pág. ', font: 'Times New Roman', size: 16, color: '374151' }),
          new TextRun({
            children: [PageNumber.CURRENT],
            font: 'Times New Roman',
            size: 16,
            color: '374151',
          }),
          new TextRun({ text: ' de ', font: 'Times New Roman', size: 16, color: '374151' }),
          new TextRun({
            children: [PageNumber.TOTAL_PAGES],
            font: 'Times New Roman',
            size: 16,
            color: '374151',
          }),
        ],
        alignment: leftText ? AlignmentType.JUSTIFIED : AlignmentType.RIGHT,
        border: {
          top: { style: 'single', size: 6, color: 'E5E7EB', space: 4 },
        },
        spacing: { before: 80 },
      }),
    ],
  });
}


// ─── blocks → docx children ───────────────────────────────────────────────────

function blocksToDocxChildren(blocks: DocBlock[], rayado = false): (Paragraph | Table | TableOfContents)[] {
  const children: (Paragraph | Table | TableOfContents)[] = [];

  for (const block of blocks) {
    if (block.type === 'list') {
      children.push(...listBlockToParagraphs(block));
    } else {
      const el = blockToParagraph(block, rayado);
      if (el) children.push(el);
    }
  }

  if (children.length === 0) {
    children.push(new Paragraph({ children: [new TextRun('')] }));
  }

  return children;
}

// ─── numbering configuration ──────────────────────────────────────────────────

const numberingConfig = {
  config: [
    {
      reference: DECIMAL_REF,
      levels: [
        {
          level: 0,
          format: LevelFormat.DECIMAL,
          text: '%1.',
          alignment: AlignmentType.LEFT,
          style: {
            paragraph: {
              indent: { left: 720, hanging: 360 },
              spacing: { after: 80, line: 360, lineRule: 'auto' as const },
            },
            run: { font: 'Times New Roman', size: 24 },
          },
        },
      ],
    },
    {
      reference: BULLET_REF,
      levels: [
        {
          level: 0,
          format: LevelFormat.BULLET,
          text: '\u2022',
          alignment: AlignmentType.LEFT,
          style: {
            paragraph: {
              indent: { left: 720, hanging: 360 },
              spacing: { after: 80, line: 360, lineRule: 'auto' as const },
            },
            run: { font: 'Times New Roman', size: 24 },
          },
        },
      ],
    },
    {
      reference: HEADING_NUM_REF,
      levels: [
        {
          level: 0,
          format: LevelFormat.UPPER_ROMAN,
          text: '%1.',
          alignment: AlignmentType.LEFT,
          style: {
            paragraph: {
              spacing: { before: 280, after: 120 },
              alignment: AlignmentType.CENTER,
            },
            run: { bold: true, font: 'Times New Roman', size: 28, color: '111827' },
          },
        },
        {
          level: 1,
          format: LevelFormat.DECIMAL,
          text: '%2.',
          alignment: AlignmentType.LEFT,
          style: {
            paragraph: {
              spacing: { before: 200, after: 100 },
            },
            run: { bold: true, font: 'Times New Roman', size: 26, color: '111827' },
          },
        },
      ],
    },
  ],
};

// ─── style definitions ────────────────────────────────────────────────────────

const stylesConfig = {
  default: {
    document: {
      run: { font: 'Times New Roman', size: 24 },
      paragraph: { spacing: { after: 120, line: 360, lineRule: 'auto' as const } },
    },
  },
  paragraphStyles: [
    {
      id: 'Heading1',
      name: 'Heading 1',
      basedOn: 'Normal',
      next: 'Normal',
      quickFormat: true,
      run: { bold: true, size: 28, font: 'Times New Roman', color: '111827' },
      paragraph: { spacing: { before: 280, after: 120 }, alignment: AlignmentType.CENTER },
    },
    {
      id: 'Heading2',
      name: 'Heading 2',
      basedOn: 'Normal',
      next: 'Normal',
      quickFormat: true,
      run: { bold: true, size: 26, font: 'Times New Roman', color: '111827' },
      paragraph: { spacing: { before: 200, after: 100 } },
    },
    {
      id: 'Heading3',
      name: 'Heading 3',
      basedOn: 'Normal',
      next: 'Normal',
      quickFormat: true,
      run: { bold: true, size: 24, font: 'Times New Roman', color: '374151' },
      paragraph: { spacing: { before: 160, after: 80 } },
    },
    {
      id: 'Heading4',
      name: 'Heading 4',
      basedOn: 'Normal',
      next: 'Normal',
      quickFormat: true,
      run: { bold: true, italics: true, size: 24, font: 'Times New Roman', color: '374151' },
      paragraph: { spacing: { before: 120, after: 60 } },
    },
  ],
};

// ─── plain text → DocBlock[] ──────────────────────────────────────────────────

const ROMAN_SECTION_RE = /^[IVXLCDM]+\.\s+\S/i;

function plainTextToDocxBlocks(text: string): DocBlock[] {
  const blocks: DocBlock[] = [];
  const paragraphs = text.split(/\n\n+/);

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) {
      blocks.push({ type: 'paragraph', runs: [{ text: '' }] });
      continue;
    }

    // Roman numeral section heading: "I. LAS PARTES", "II. TÍTULO EJECUTIVO"
    if (ROMAN_SECTION_RE.test(trimmed) && !trimmed.includes('\n') && trimmed.length < 80) {
      blocks.push({ type: 'heading', level: 2, text: trimmed });
      continue;
    }

    // Multi-line block: each line becomes a run with a line break between them
    const lines = trimmed.split('\n');
    const runs: DocRun[] = [];
    lines.forEach((line, idx) => {
      if (idx > 0) runs.push({ text: '\n' });
      runs.push({ text: line });
    });
    blocks.push({ type: 'paragraph', runs, align: 'justify' });
  }

  return blocks;
}

function isHtmlContent(content: string): boolean {
  return /<[a-z][\s\S]*>/i.test(content);
}

function isModoNumaHtml(html: string): boolean {
  return html.includes('0F3D2E');
}

// ─── Modo Numa HTML → styled docx children ───────────────────────────────────

const NM_GREEN = '0F3D2E';
const NM_GOLD  = 'C6A15B';
const NM_GRAY  = '5A6472';

function nmAttr(el: Element): string { return el.getAttribute('style') || ''; }
function nmHas(el: Element, re: RegExp): boolean { return re.test(nmAttr(el)); }
function nmIsGreenBg(el: Element): boolean { return nmHas(el, /0F3D2E/i); }
function nmIsSmallCaps(el: Element): boolean { return nmHas(el, /font-variant\s*:\s*small-caps/i); }
function nmIsCenter(el: Element): boolean { return nmHas(el, /text-align\s*:\s*center/i); }
function nmIsRight(el: Element): boolean { return nmHas(el, /text-align\s*:\s*right/i); }
function nmIsSep(el: Element): boolean { return nmHas(el, /height\s*:\s*2px/i); }

function nmExtractRuns(el: Element, size: number, color?: string, bold?: boolean, italic?: boolean): TextRun[] {
  const temp = document.createElement('div');
  temp.innerHTML = el.innerHTML.replace(/<br\s*\/?>/gi, '\n');
  const lines = (temp.textContent || '').split('\n');
  const runs: TextRun[] = [];
  lines.forEach((line, i) => {
    if (i > 0) runs.push(new TextRun({ break: 1 }));
    if (line.trim()) runs.push(new TextRun({ text: line, font: 'Times New Roman', size, color, bold, italics: italic }));
  });
  return runs.length ? runs : [new TextRun({ text: '' })];
}

const NM_NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' } as const;

function nmSectionHeading(text: string): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({ text: '\u25A0  ' + text.toUpperCase(), font: 'Times New Roman', size: 26, bold: true, color: NM_GREEN }),
    ],
    alignment: AlignmentType.CENTER,
    spacing: { before: 480, after: 80 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: NM_GREEN, space: 6 } },
  });
}

function nmSubheading(text: string): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text: text.toUpperCase(), font: 'Times New Roman', size: 20, bold: true, color: NM_GRAY })],
    spacing: { before: 200, after: 80 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: NM_GOLD, space: 4 } },
  });
}

function nmRefBlock(el: Element): Table {
  const text = (el.textContent || '').trim();
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: NM_NO_BORDER, bottom: NM_NO_BORDER, left: NM_NO_BORDER, right: NM_NO_BORDER, insideHorizontal: NM_NO_BORDER, insideVertical: NM_NO_BORDER },
    rows: [new TableRow({
      children: [new TableCell({
        shading: { fill: NM_GREEN, type: ShadingType.CLEAR, color: 'auto' },
        borders: { top: NM_NO_BORDER, bottom: NM_NO_BORDER, left: NM_NO_BORDER, right: NM_NO_BORDER },
        children: [new Paragraph({
          children: [new TextRun({ text, font: 'Times New Roman', size: 20, bold: true, color: NM_GOLD })],
          spacing: { before: 100, after: 100 },
        })],
      })],
    })],
  });
}

function nmStyledTable(tableEl: Element): Table {
  const rows: TableRow[] = [];
  tableEl.querySelectorAll('tr').forEach((tr) => {
    const tdList = Array.from((tr as Element).querySelectorAll('td, th'));
    if (!tdList.length) return;
    const cells = tdList.map((td, colIdx) => {
      const isGreen = nmIsGreenBg(td);
      const isFirst = colIdx === 0;
      const w = tdList.length === 2 ? (isFirst && isGreen ? 22 : 78) : Math.floor(100 / tdList.length);
      const text = (td.textContent || '').trim();
      return new TableCell({
        width: { size: w, type: WidthType.PERCENTAGE },
        shading: isGreen
          ? { fill: NM_GREEN, type: ShadingType.CLEAR, color: 'auto' }
          : { fill: 'FFFFFF', type: ShadingType.CLEAR, color: 'auto' },
        borders: {
          top:    { style: BorderStyle.SINGLE, size: 2, color: 'E0DBD0' },
          bottom: { style: BorderStyle.SINGLE, size: 2, color: 'E0DBD0' },
          left:   NM_NO_BORDER,
          right:  NM_NO_BORDER,
        },
        children: [new Paragraph({
          children: [new TextRun({ text, font: 'Times New Roman', size: isGreen ? 18 : 22, bold: isGreen, color: isGreen ? NM_GOLD : '1A1A1A' })],
          alignment: isGreen ? AlignmentType.CENTER : AlignmentType.JUSTIFIED,
          spacing: { before: 80, after: 80 },
        })],
      });
    });
    rows.push(new TableRow({ children: cells }));
  });
  if (!rows.length) rows.push(new TableRow({ children: [new TableCell({ children: [new Paragraph({ children: [new TextRun('')] })] })] }));
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows,
    borders: { top: NM_NO_BORDER, bottom: NM_NO_BORDER, left: NM_NO_BORDER, right: NM_NO_BORDER, insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: 'E0DBD0', space: 0 }, insideVertical: NM_NO_BORDER },
  });
}

function parseModoNumaHtmlToDocxChildren(html: string): (Paragraph | Table)[] {
  const container = document.createElement('div');
  container.innerHTML = html;
  const root = (container.firstElementChild as HTMLElement) || container;
  const out: (Paragraph | Table)[] = [];
  let pendingHeading: string | null = null;

  for (const child of Array.from(root.children)) {
    const el = child as HTMLElement;
    const tag = el.tagName.toLowerCase();
    const text = (el.textContent || '').trim();

    // Skip icon divs (■ only)
    if (text.replace(/\s/g, '') === '■') continue;

    // Separator → emit buffered heading
    if (nmIsSep(el)) {
      if (pendingHeading !== null) { out.push(nmSectionHeading(pendingHeading)); pendingHeading = null; }
      continue;
    }

    // Section title (small-caps + centered) → buffer
    if (nmIsSmallCaps(el) && nmIsCenter(el)) { pendingHeading = text; continue; }

    // Sub-heading (small-caps, not centered)
    if (nmIsSmallCaps(el)) { if (text) out.push(nmSubheading(text)); continue; }

    // REF block (green bg, not a table)
    if (nmIsGreenBg(el) && tag !== 'table') {
      if (text) { out.push(nmRefBlock(el)); out.push(new Paragraph({ children: [new TextRun('')], spacing: { after: 160 } })); }
      continue;
    }

    // Table
    if (tag === 'table') {
      out.push(nmStyledTable(el));
      out.push(new Paragraph({ children: [new TextRun('')], spacing: { after: 120 } }));
      continue;
    }

    // Right-aligned (date)
    if (nmIsRight(el)) {
      out.push(new Paragraph({ children: nmExtractRuns(el, 20, NM_GRAY, false, true), alignment: AlignmentType.RIGHT, spacing: { after: 200 } }));
      continue;
    }

    // Normal paragraph
    if (text) {
      out.push(new Paragraph({ children: nmExtractRuns(el, 22), alignment: AlignmentType.JUSTIFIED, spacing: { after: 120, line: 360, lineRule: 'auto' } }));
    } else {
      out.push(new Paragraph({ children: [new TextRun('')], spacing: { after: 80 } }));
    }
  }

  return out;
}

// ─── main export ──────────────────────────────────────────────────────────────

export async function exportDocx(
  htmlContent: string,
  title: string,
  profile?: ProfileData,
  showBranding = false,
  rayado = false,
): Promise<void> {
  let bodyChildren: (Paragraph | Table | TableOfContents)[];
  if (!isHtmlContent(htmlContent)) {
    bodyChildren = blocksToDocxChildren(plainTextToDocxBlocks(htmlContent), rayado);
  } else if (isModoNumaHtml(htmlContent)) {
    bodyChildren = parseModoNumaHtmlToDocxChildren(htmlContent);
  } else {
    bodyChildren = blocksToDocxChildren(parseHtmlToDocxBlocks(htmlContent), rayado);
  }

  const hasProfile = !!profile && !!(profile.logo_url || profile.lawyer_name);
  const header = hasProfile ? await buildHeader(profile) : null;

  const allChildren = [...bodyChildren];

  const sectionMarginTop = hasProfile
    ? convertInchesToTwip(1.4)
    : convertInchesToTwip(0.98);

  const doc = new Document({
    title,
    numbering: numberingConfig,
    styles: stylesConfig,
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: sectionMarginTop,
              bottom: convertInchesToTwip(0.98),
              left: convertInchesToTwip(1.18),
              right: convertInchesToTwip(1.18),
              header: convertInchesToTwip(0.35),
              footer: convertInchesToTwip(0.35),
            },
          },
        },
        ...(header
          ? {
              headers: {
                default: header,
              },
            }
          : {}),
        footers: {
          default: buildDocxFooter(profile ?? null, showBranding),
        },
        children: allChildren,
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title.replace(/[^\p{L}\p{N}\-_. ]/gu, '_')}.docx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
