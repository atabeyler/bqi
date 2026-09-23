import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, BorderStyle, WidthType, PageBreak,
  Header, Footer, PageNumber, ShadingType
} from 'docx';

const COLORS = {
  gold: 'D4AF37',
  black: '000000',
  red: 'C8102E',
  darkBlue: '1A2244',
  gray: '666666'
};

const FONT = 'Times New Roman';

function styledRun(text, opts = {}) {
  return new TextRun({
    text,
    font: FONT,
    size: opts.size || 22, // 11pt = 22 half-points
    bold: opts.bold || false,
    color: opts.color || COLORS.black,
    italics: opts.italics || false
  });
}

// Splits a line on **bold** and *italic* spans and returns one TextRun per
// span, so mid-line markdown emphasis (e.g. "**Etiket:** açıklama devamı",
// or *"quoted aside"*) renders as actual Word formatting instead of the
// literal asterisks showing up in the text.
function inlineRuns(text, opts = {}) {
  // Odd split indices are the captured **bold** groups -- determine bold
  // status per part *before* dropping empty strings, otherwise filtering
  // first re-indexes the array and scrambles which parts are bold.
  return text
    .split(/\*\*(.+?)\*\*/g)
    .map((part, i) => ({ part, bold: opts.bold || i % 2 === 1 }))
    .filter(({ part }) => part.length)
    .flatMap(({ part, bold }) => {
      if (bold) return [{ part, bold, italics: opts.italics }];
      // Within a non-bold segment, further split single *italic* spans.
      return part
        .split(/\*(.+?)\*/g)
        .map((sub, i) => ({ part: sub, bold, italics: opts.italics || i % 2 === 1 }))
        .filter((seg) => seg.part.length);
    })
    .map(({ part, bold, italics }) => styledRun(part, { ...opts, bold, italics }));
}

// Splits table-cell text on <br> tags (how the AI represents line breaks
// inside a markdown table cell, since literal newlines aren't possible
// there) into one Paragraph per line, each run through inlineRuns.
function cellParagraphs(text, opts = {}, alignment = AlignmentType.LEFT) {
  const lines = String(text).split(/<br\s*\/?>/i);
  return lines.map((line) => new Paragraph({ alignment, children: inlineRuns(line, opts) }));
}

function p(text, opts = {}) {
  return new Paragraph({
    spacing: { before: 120, after: 120, line: 276 }, // 1.15 line spacing
    alignment: opts.alignment || AlignmentType.JUSTIFIED,
    children: inlineRuns(text, opts)
  });
}

// Thematic break ("---", "***", "___" on their own line) -- rendered as a
// paragraph bottom border instead of literal dashes.
function hr() {
  return new Paragraph({
    spacing: { before: 120, after: 240 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: COLORS.gray, space: 1 } },
    children: []
  });
}

// keepNext (Word's "Keep with next" paragraph property, w:keepNext) tells
// Word's own layout engine never to break the page between this paragraph
// and the one immediately following it -- exactly the built-in mechanism
// for "don't leave a heading alone at the bottom of a page with its body
// starting on the next one". Word evaluates it against whatever actually
// follows at render/reflow time (including on the reader's own machine,
// at their zoom level and page size), so unlike the pdfkit generator this
// needs no manual height lookahead: applying it to every heading paragraph
// is sufficient and can't go stale as content changes.
function h1(text) {
  return new Paragraph({
    spacing: { before: 360, after: 180 },
    alignment: AlignmentType.LEFT,
    heading: HeadingLevel.HEADING_1,
    keepNext: true,
    children: [new TextRun({
      text: text.toUpperCase(),
      font: FONT,
      size: 28, // 14pt
      bold: true,
      color: COLORS.darkBlue
    })]
  });
}

function h2(text) {
  return new Paragraph({
    spacing: { before: 240, after: 120 },
    alignment: AlignmentType.LEFT,
    heading: HeadingLevel.HEADING_2,
    keepNext: true,
    children: [new TextRun({
      text,
      font: FONT,
      size: 24, // 12pt
      bold: true,
      color: COLORS.darkBlue
    })]
  });
}

function h3(text) {
  return new Paragraph({
    spacing: { before: 180, after: 100 },
    keepNext: true,
    children: [new TextRun({
      text,
      font: FONT,
      size: 22,
      bold: true,
      italics: true
    })]
  });
}

function h4(text) {
  return new Paragraph({
    spacing: { before: 160, after: 80 },
    keepNext: true,
    children: [new TextRun({
      text,
      font: FONT,
      size: 22,
      bold: true,
      color: COLORS.darkBlue
    })]
  });
}

function bullet(text) {
  return new Paragraph({
    spacing: { before: 60, after: 60, line: 276 },
    bullet: { level: 0 },
    children: inlineRuns(text)
  });
}

const CODE_FONT = 'Courier New';

// One paragraph per source line (not wrapped/justified) in a monospace font,
// so ASCII-art content like a circuit diagram keeps its column alignment.
function codeLine(text) {
  return new Paragraph({
    spacing: { before: 0, after: 0, line: 240 },
    alignment: AlignmentType.LEFT,
    children: [new TextRun({ text: text.length ? text : ' ', font: CODE_FONT, size: 14 })]
  });
}

// Letter page with 1-inch margins gives a text width of: 12240 - 2×1440 = 9360 twip (DXA)
const PAGE_TEXT_WIDTH_DXA = 9360;

function buildTable(headers, rows, customWidthsPct = null) {
  // Compute column widths in DXA (twip)
  let colWidths;
  if (customWidthsPct) {
    colWidths = customWidthsPct.map(pct => Math.round((pct / 100) * PAGE_TEXT_WIDTH_DXA));
  } else {
    const base = Math.floor(PAGE_TEXT_WIDTH_DXA / headers.length);
    // The last column absorbs the remaining space (avoids rounding error)
    colWidths = headers.map((_, i) =>
      i === headers.length - 1 ? PAGE_TEXT_WIDTH_DXA - base * (headers.length - 1) : base
    );
  }

  const cellMargins = { top: 80, bottom: 80, left: 120, right: 120 };

  const headerCells = headers.map((h, i) => new TableCell({
    width: { size: colWidths[i], type: WidthType.DXA },
    shading: { type: ShadingType.SOLID, color: COLORS.darkBlue, fill: COLORS.darkBlue },
    margins: cellMargins,
    children: cellParagraphs(h, { size: 20, bold: true, color: 'FFFFFF' }, AlignmentType.CENTER)
  }));

  const headerRow = new TableRow({ children: headerCells, tableHeader: true, cantSplit: true });

  const dataRows = rows.map(row => {
    // Normalize row cell count to match the header count
    const normalized = Array.from({ length: headers.length }, (_, i) => row[i] ?? '');
    return new TableRow({
      cantSplit: true,
      children: normalized.map((cell, i) => new TableCell({
        width: { size: colWidths[i], type: WidthType.DXA },
        margins: cellMargins,
        children: cellParagraphs(String(cell), { size: 20 })
      }))
    });
  });

  return new Table({
    width: { size: PAGE_TEXT_WIDTH_DXA, type: WidthType.DXA },
    columnWidths: colWidths,
    rows: [headerRow, ...dataRows],
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: COLORS.darkBlue },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: COLORS.darkBlue },
      left: { style: BorderStyle.SINGLE, size: 4, color: COLORS.darkBlue },
      right: { style: BorderStyle.SINGLE, size: 4, color: COLORS.darkBlue },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: COLORS.gray },
      insideVertical: { style: BorderStyle.SINGLE, size: 2, color: COLORS.gray }
    }
  });
}

/**
 * Simple conversion from markdown to docx elements.
 * Supports headings (## ###), lists (-), tables (|...|), and paragraphs.
 */
function parseMarkdown(md) {
  const lines = md.split('\n');
  const elements = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block (```...```) -- rendered as monospace, one line per
    // paragraph, so ASCII-art content (e.g. a circuit diagram) keeps its
    // column alignment instead of being reflow-justified like prose.
    if (line.trim().startsWith('```')) {
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        elements.push(codeLine(lines[i]));
        i++;
      }
      i++; // skip closing ```
      elements.push(p(''));
      continue;
    }

    // Table
    if (line.trim().startsWith('|') && i + 1 < lines.length && lines[i + 1].includes('---')) {
      const headers = line.split('|').map(s => s.trim()).filter(Boolean);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = lines[i].split('|').map(s => s.trim()).filter(Boolean);
        if (cells.length) rows.push(cells);
        i++;
      }
      elements.push(buildTable(headers, rows));
      elements.push(p(''));
      continue;
    }

    // Thematic break ("---", "***", "___" alone on a line) used as a
    // section divider -- rendered as a rule, not literal dashes.
    if (line.trim().match(/^(-{3,}|\*{3,}|_{3,})$/)) elements.push(hr());
    else if (line.startsWith('#### ')) elements.push(h4(line.slice(5).trim()));
    else if (line.startsWith('### ')) elements.push(h3(line.slice(4).trim()));
    else if (line.startsWith('## ')) elements.push(h2(line.slice(3).trim()));
    else if (line.startsWith('# ')) elements.push(h1(line.slice(2).trim()));
    else if (line.match(/^[-*]\s+/)) elements.push(bullet(line.replace(/^[-*]\s+/, '')));
    else if (line.match(/^\d+\.\s+/)) elements.push(bullet(line.replace(/^\d+\.\s+/, '')));
    else if (line.trim()) {
      elements.push(p(line));
    } else {
      elements.push(p(''));
    }
    i++;
  }

  return elements;
}

/**
 * Cover page — BQI standard cover
 */
function buildCoverPage(category, title, userCode) {
  const dateStr = new Date().toLocaleDateString('tr-TR', { day: '2-digit', month: 'long', year: 'numeric' });
  const docNo = `BQI/${category.toUpperCase()}-${Date.now().toString().slice(-6)}`;

  return [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 1200, after: 240 },
      children: [new TextRun({ text: 'GİZLİ', font: FONT, size: 28, bold: true, color: COLORS.red })]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 240, after: 120 },
      children: [new TextRun({ text: 'BOLD ASKERİ TEKNOLOJİ VE SAVUNMA SANAYİ A.Ş.', font: FONT, size: 26, bold: true })]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 480 },
      children: [new TextRun({ text: 'Stratejik Analiz ve Politika Geliştirme Birimi', font: FONT, size: 22, italics: true })]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 720, after: 120 },
      children: [new TextRun({ text: 'BQI', font: FONT, size: 48, bold: true, color: COLORS.darkBlue })]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 },
      children: [new TextRun({ text: 'Kuantum Tabanlı Ulusal Karar Destek Sistemi', font: FONT, size: 24, italics: true })]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 480, after: 360 },
      children: [new TextRun({ text: title.toUpperCase(), font: FONT, size: 32, bold: true, color: COLORS.darkBlue })]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 240, after: 720 },
      children: [new TextRun({ text: `Kategori: ${category.toUpperCase()}`, font: FONT, size: 22, italics: true })]
    }),
    buildTable(
      ['Belge Bilgisi', 'Değer'],
      [
        ['Belge No', docNo],
        ['Tarih', dateStr],
        ['Hazırlayan', 'BQI'],
        ['Kullanıcı', userCode],
        ['Sınıflandırma', 'GİZLİLİK DERECESİ: GİZLİ'],
        ['Versiyon', 'v1.0']
      ],
      [32, 68]
    ),
    new Paragraph({ children: [new PageBreak()] })
  ];
}

/**
 * Main docx generator function
 */
export async function generateReportDocx({ category, title, content, userCode }) {
  const cover = buildCoverPage(category, title, userCode);
  const body = parseMarkdown(content);

  const doc = new Document({
    creator: 'BQI',
    title: `BQI ${category} Raporu`,
    description: 'Kuantum Tabanlı Ulusal Karar Destek Sistemi Çıktısı',
    styles: {
      default: {
        document: { run: { font: FONT, size: 22 } }
      }
    },
    sections: [{
      properties: {
        page: {
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
        }
      },
      headers: {
        default: new Header({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({
              text: `BQI — ${title}                                                                                                  GİZLİ`,
              font: FONT, size: 16, italics: true, color: COLORS.gray
            })]
          })]
        })
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({
                text: `Bold Askeri Teknoloji ve Savunma Sanayi A.Ş.  |  ${new Date().toLocaleDateString('tr-TR', { month: 'long', year: 'numeric' })}  |  Sayfa `,
                font: FONT, size: 16, color: COLORS.gray
              }),
              new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 16, color: COLORS.gray }),
              new TextRun({ text: '/', font: FONT, size: 16, color: COLORS.gray }),
              new TextRun({ children: [PageNumber.TOTAL_PAGES], font: FONT, size: 16, color: COLORS.gray })
            ]
          })]
        })
      },
      children: [...cover, ...body]
    }]
  });

  return Packer.toBuffer(doc);
}
