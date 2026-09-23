import PDFDocument from 'pdfkit';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');

const COLORS = {
  gold: '#D4AF37',
  black: '#000000',
  red: '#C8102E',
  darkBlue: '#1A2244',
  gray: '#666666',
};

// pdfkit's built-in standard fonts (Times-Roman etc.) only support
// WinAnsiEncoding, which doesn't include Turkish ğ/ş/ı/İ -- those
// characters (and everything after them on the line) render as garbage.
// Liberation Serif/Mono are metric-compatible with Times New Roman/Courier
// New and cover the full Turkish alphabet, so embed them instead.
const FONT = 'Times';
const FONT_BOLD = 'Times-Bold';
const FONT_ITALIC = 'Times-Italic';
const FONT_BOLD_ITALIC = 'Times-BoldItalic';
const CODE_FONT = 'Courier';

function registerFonts(doc) {
  doc.registerFont(FONT, path.join(FONTS_DIR, 'LiberationSerif-Regular.ttf'));
  doc.registerFont(FONT_BOLD, path.join(FONTS_DIR, 'LiberationSerif-Bold.ttf'));
  doc.registerFont(FONT_ITALIC, path.join(FONTS_DIR, 'LiberationSerif-Italic.ttf'));
  doc.registerFont(FONT_BOLD_ITALIC, path.join(FONTS_DIR, 'LiberationSerif-BoldItalic.ttf'));
  doc.registerFont(CODE_FONT, path.join(FONTS_DIR, 'LiberationMono-Regular.ttf'));
}

function drawCoverPage(doc, { category, title, userCode }) {
  const dateStr = new Date().toLocaleDateString('tr-TR', { day: '2-digit', month: 'long', year: 'numeric' });
  const docNo = `BQI/${category.toUpperCase()}-${Date.now().toString().slice(-6)}`;

  doc.moveDown(4);
  doc.font(FONT_BOLD).fontSize(16).fillColor(COLORS.red).text('GİZLİ', { align: 'center' });
  doc.moveDown(1);
  doc.font(FONT_BOLD).fontSize(15).fillColor(COLORS.black).text('BOLD ASKERİ TEKNOLOJİ VE SAVUNMA SANAYİ A.Ş.', { align: 'center' });
  doc.moveDown(0.5);
  doc.font(FONT_ITALIC).fontSize(12).text('Stratejik Analiz ve Politika Geliştirme Birimi', { align: 'center' });
  doc.moveDown(3);
  doc.font(FONT_BOLD).fontSize(28).fillColor(COLORS.darkBlue).text('BQI', { align: 'center' });
  doc.moveDown(0.5);
  doc.font(FONT_ITALIC).fontSize(13).fillColor(COLORS.black).text('Kuantum Tabanlı Ulusal Karar Destek Sistemi', { align: 'center' });
  doc.moveDown(2);
  doc.font(FONT_BOLD).fontSize(18).fillColor(COLORS.darkBlue).text(title.toUpperCase(), { align: 'center' });
  doc.moveDown(1);
  doc.font(FONT_ITALIC).fontSize(12).fillColor(COLORS.black).text(`Kategori: ${category.toUpperCase()}`, { align: 'center' });
  doc.moveDown(3);

  const info = [
    ['Belge No', docNo],
    ['Tarih', dateStr],
    ['Hazırlayan', 'BQI'],
    ['Kullanıcı', userCode],
    ['Sınıflandırma', 'GİZLİLİK DERECESİ: GİZLİ'],
    ['Versiyon', 'v1.0'],
  ];
  const startX = doc.page.margins.left;
  const tableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colWidth = tableWidth / 2;
  let y = doc.y;
  for (const [label, value] of info) {
    doc.font(FONT_BOLD).fontSize(10).fillColor(COLORS.black).text(label, startX, y, { width: colWidth });
    doc.font(FONT).fontSize(10).text(value, startX + colWidth, y, { width: colWidth });
    y = doc.y + 4;
  }

  doc.addPage();
}

// Splits a line on **bold** and *italic* spans into [{ text, bold, italic }]
// parts. Odd split indices are the captured **bold** groups -- bold status
// must be determined per part *before* dropping empty strings, otherwise
// filtering first re-indexes the array and scrambles which parts are bold.
export function splitBoldSegments(text) {
  return String(text)
    .split(/\*\*(.+?)\*\*/g)
    .map((part, i) => ({ text: part, bold: i % 2 === 1 }))
    .filter((seg) => seg.text.length)
    .flatMap((seg) => {
      if (seg.bold) return [seg];
      // Within a non-bold segment, further split single *italic* spans.
      return seg.text
        .split(/\*(.+?)\*/g)
        .map((sub, i) => ({ text: sub, bold: false, italic: i % 2 === 1 }))
        .filter((sub) => sub.text.length);
    });
}

// Writes a line with mid-line **bold**/*italic* spans as alternating font
// runs (pdfkit continued-text chaining), instead of literal asterisks.
function writeInline(doc, text, { size = 10.5, color = COLORS.black, align } = {}) {
  const parts = splitBoldSegments(text);
  if (!parts.length) { doc.text('', { align }); return; }
  parts.forEach(({ text: part, bold, italic }, i) => {
    const isLast = i === parts.length - 1;
    const font = bold && italic ? FONT_BOLD_ITALIC : bold ? FONT_BOLD : italic ? FONT_ITALIC : FONT;
    doc.font(font).fontSize(size).fillColor(color)
      .text(part, { continued: !isLast, align });
  });
}

// Table cells are drawn with plain doc.text() at a fixed x/y/width, so
// unlike prose we don't attempt mixed bold/italic runs there -- just strip
// the markdown emphasis markers, and turn <br> (how the AI represents a
// line break inside a table cell, since literal newlines aren't possible
// there) into a real newline that doc.text() already wraps on.
function stripBoldMarkers(text) {
  return String(text ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1');
}

function drawTable(doc, headers, rows) {
  const startX = doc.page.margins.left;
  const tableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colWidth = tableWidth / headers.length;
  const rowPad = 6;

  const rowHeight = (cells) => {
    let max = 0;
    for (let i = 0; i < cells.length; i++) {
      const h = doc.heightOfString(stripBoldMarkers(cells[i]), { width: colWidth - rowPad * 2 });
      if (h > max) max = h;
    }
    return max + rowPad * 2;
  };

  const drawRow = (cells, opts = {}) => {
    const h = rowHeight(cells);
    if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage();
    const y = doc.y;
    if (opts.header) {
      doc.rect(startX, y, tableWidth, h).fill(COLORS.darkBlue);
    }
    doc.font(opts.header ? FONT_BOLD : FONT).fontSize(9).fillColor(opts.header ? '#FFFFFF' : COLORS.black);
    for (let i = 0; i < cells.length; i++) {
      doc.text(stripBoldMarkers(cells[i]), startX + i * colWidth + rowPad, y + rowPad, { width: colWidth - rowPad * 2 });
    }
    doc.y = y + h;
    doc.moveTo(startX, doc.y).lineTo(startX + tableWidth, doc.y).strokeColor(COLORS.gray).lineWidth(0.5).stroke();
  };

  drawRow(headers, { header: true });
  for (const row of rows) drawRow(row);
  // Each cell was drawn with an explicit x (positioned .text() calls), so
  // doc.x is left wherever the last cell happened to be -- often far from
  // the left margin. Any content drawn next without an explicit x (e.g. a
  // following heading) would inherit that x and get squeezed into
  // whatever sliver of page width remains, wrapping one word per line.
  doc.x = startX;
  doc.moveDown(0.6);
}

// One spec per heading level, shared by parseAndDraw's draw step and its
// keep-with-next lookahead below so the two can never disagree about a
// heading's rendered font/size.
function headingSpec(line) {
  if (line.startsWith('#### ')) return { level: 4, font: FONT_BOLD, size: 11, text: line.slice(5).trim() };
  if (line.startsWith('### ')) return { level: 3, font: FONT_ITALIC, size: 12, text: line.slice(4).trim() };
  if (line.startsWith('## ')) return { level: 2, font: FONT_BOLD, size: 13, text: line.slice(3).trim() };
  if (line.startsWith('# ')) return { level: 1, font: FONT_BOLD, size: 15, text: line.slice(2).trim().toUpperCase() };
  return null;
}

function parseAndDraw(doc, md) {
  const lines = md.split('\n');
  const textWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  let i = 0;

  const ensureSpace = (minHeight = 20) => {
    if (doc.y + minHeight > doc.page.height - doc.page.margins.bottom) doc.addPage();
  };

  // A heading rendered as the very last line on a page (its body text
  // starting fresh on the next page) reads as broken -- the reader can't
  // tell what the heading was even for until they turn the page. Estimates
  // the height of whatever comes right after a heading (skipping blank
  // lines) so ensureSpace can be called for the heading *and* that first
  // real chunk of its content together, forcing both onto the next page as
  // a unit when they don't both fit. A following heading with nothing
  // between (no body to orphan) returns 0. Code blocks/tables are given a
  // fixed floor rather than measured exactly -- exact reflow there depends
  // on drawTable/the code-block loop, not worth duplicating here just for
  // a page-break estimate.
  const peekNextBlockHeight = (fromIdx) => {
    let j = fromIdx;
    while (j < lines.length && !lines[j].trim()) j++;
    if (j >= lines.length) return 0;
    const next = lines[j];
    if (headingSpec(next)) return 0;
    if (next.trim().startsWith('```')) return 30;
    if (next.trim().startsWith('|') && lines[j + 1]?.includes('---')) return 40;
    let text = next;
    let size = 10.5;
    if (next.match(/^[-*]\s+/)) { text = next.replace(/^[-*]\s+/, ''); size = 10; }
    else if (next.match(/^\d+\.\s+/)) { text = next.replace(/^\d+\.\s+/, ''); size = 10; }
    doc.font(FONT).fontSize(size);
    return doc.heightOfString(stripBoldMarkers(text), { width: textWidth });
  };

  while (i < lines.length) {
    const line = lines[i];

    const heading = headingSpec(line);
    if (heading) {
      doc.font(heading.font).fontSize(heading.size);
      const headingHeight = doc.heightOfString(heading.text, { width: textWidth });
      const leadIn = heading.level === 1 ? 0.5 : heading.level === 2 ? 0.4 : heading.level === 3 ? 0 : 0;
      ensureSpace(headingHeight + peekNextBlockHeight(i + 1) + leadIn * doc.currentLineHeight() + 10);
      if (heading.level === 4) {
        doc.font(FONT_BOLD).fontSize(11).fillColor(COLORS.darkBlue).text(heading.text);
        doc.moveDown(0.25);
      } else if (heading.level === 3) {
        doc.font(FONT_ITALIC).fontSize(12).fillColor(COLORS.black).text(heading.text);
        doc.moveDown(0.3);
      } else if (heading.level === 2) {
        doc.moveDown(0.4);
        doc.font(FONT_BOLD).fontSize(13).fillColor(COLORS.darkBlue).text(heading.text);
        doc.moveDown(0.3);
      } else {
        doc.moveDown(0.5);
        doc.font(FONT_BOLD).fontSize(15).fillColor(COLORS.darkBlue).text(heading.text);
        doc.moveDown(0.4);
      }
      i++;
      continue;
    }

    if (line.trim().startsWith('```')) {
      i++;
      ensureSpace();
      doc.font(CODE_FONT).fontSize(8).fillColor(COLORS.black);
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        ensureSpace(12);
        doc.text(lines[i].length ? lines[i] : ' ', { width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
        i++;
      }
      i++;
      doc.moveDown(0.5);
      continue;
    }

    if (line.trim().startsWith('|') && i + 1 < lines.length && lines[i + 1].includes('---')) {
      const headers = line.split('|').map((s) => s.trim()).filter(Boolean);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = lines[i].split('|').map((s) => s.trim()).filter(Boolean);
        if (cells.length) rows.push(cells);
        i++;
      }
      ensureSpace(40);
      drawTable(doc, headers, rows);
      continue;
    }

    // Thematic break ("---", "***", "___" alone on a line) used as a
    // section divider -- drawn as a rule, not literal dashes.
    if (line.trim().match(/^(-{3,}|\*{3,}|_{3,})$/)) {
      ensureSpace(10);
      const startX = doc.page.margins.left;
      const endX = doc.page.width - doc.page.margins.right;
      doc.moveTo(startX, doc.y).lineTo(endX, doc.y).strokeColor(COLORS.gray).lineWidth(0.5).stroke();
      doc.moveDown(0.4);
      i++;
      continue;
    }

    ensureSpace();
    if (line.match(/^[-*]\s+/)) {
      doc.font(FONT).fontSize(10).fillColor(COLORS.black).text('•  ', { indent: 12, continued: true });
      writeInline(doc, line.replace(/^[-*]\s+/, ''), { size: 10 });
    } else if (line.match(/^\d+\.\s+/)) {
      doc.font(FONT).fontSize(10).fillColor(COLORS.black).text('•  ', { indent: 12, continued: true });
      writeInline(doc, line.replace(/^\d+\.\s+/, ''), { size: 10 });
    } else if (line.trim()) {
      writeInline(doc, line, { size: 10.5, align: 'justify' });
    } else {
      doc.moveDown(0.4);
    }
    i++;
  }
}

export async function generateReportPdf({ category, title, content, userCode }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margins: { top: 56, bottom: 56, left: 56, right: 56 }, bufferPages: true });
      registerFonts(doc);
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      drawCoverPage(doc, { category, title, userCode });
      parseAndDraw(doc, content);

      const range = doc.bufferedPageRange();
      const footerY = doc.page.height - doc.page.margins.bottom + 20;
      for (let idx = range.start; idx < range.start + range.count; idx++) {
        doc.switchToPage(idx);
        // footerY sits deliberately below page.maxY() (page.height -
        // margins.bottom) -- inside the bottom margin, where a footer
        // belongs. But pdfkit's text() computes maxY from the page's
        // current margins.bottom and, whenever the given y falls past it,
        // calls addPage() *before* drawing (this isn't gated by
        // lineBreak:false -- confirmed by generating a real report with
        // that alone and still getting the same result below). That
        // silently pushed the footer for every content page onto a new
        // trailing blank page instead, and left the original content
        // pages with no footer at all -- a report with N content pages
        // came out as N pages with no footer followed by N blank pages
        // each showing only "Sayfa X/N". Zeroing this page's bottom
        // margin for the duration of the write makes footerY fall inside
        // maxY (= page.height), so the same call draws in place instead.
        const originalBottomMargin = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        doc.font(FONT).fontSize(8).fillColor(COLORS.gray).text(
          `Bold Askeri Teknoloji ve Savunma Sanayi A.Ş.  |  ${new Date().toLocaleDateString('tr-TR', { month: 'long', year: 'numeric' })}  |  Sayfa ${idx - range.start + 1}/${range.count}`,
          doc.page.margins.left,
          footerY,
          { width: doc.page.width - doc.page.margins.left - doc.page.margins.right, align: 'center', lineBreak: false }
        );
        doc.page.margins.bottom = originalBottomMargin;
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
