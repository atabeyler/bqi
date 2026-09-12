import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from 'docx';
import { jsPDF } from 'jspdf';

// Offline DOCX/PDF export for local-engine (local-llm / local-data) results,
// which never have the cloud's server-side generateReportDocx()/pdfkit
// output (server/src/services/docx.js, .../pdf.js) since an offline device
// never makes that round-trip. Deliberately much simpler than the server's
// generator (no cover page, no tables, no header/footer branding) -- local
// results are short by design (llmProvider.js's GENERATE_INSTRUCTION asks
// for 2-3 items) and this only needs to turn that markdown-lite text into a
// real, openable Word/PDF file instead of the plain .txt fallback.

const FONT = 'Times New Roman';

// Minimal markdown-lite -> paragraph split: headings (##), bullets (-/*),
// numbered items (1.), everything else is a plain paragraph. Mirrors the
// subset of server/src/services/docx.js's parseMarkdown() that local-LLM
// output actually uses (short instruction-following text, no tables/code
// fences expected).
function splitLines(content) {
  return String(content || '').split('\n');
}

export async function buildLocalDocxBlob({ title, content, category, subtitle = 'BQI — LOCAL AI (OFFLINE)' }) {
  const children = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [new TextRun({ text: subtitle, font: FONT, size: 20, italics: true, color: '666666' })],
    }),
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 240 },
      children: [new TextRun({ text: title || `${category || ''} analizi`, font: FONT, size: 32, bold: true, color: '1A2244' })],
    }),
  ];

  for (const line of splitLines(content)) {
    const trimmed = line.trim();
    if (!trimmed) {
      children.push(new Paragraph({ children: [] }));
    } else if (trimmed.startsWith('### ')) {
      children.push(new Paragraph({ spacing: { before: 180, after: 100 }, children: [new TextRun({ text: trimmed.slice(4), font: FONT, size: 22, bold: true })] }));
    } else if (trimmed.startsWith('## ')) {
      children.push(new Paragraph({ spacing: { before: 240, after: 120 }, children: [new TextRun({ text: trimmed.slice(3), font: FONT, size: 24, bold: true, color: '1A2244' })] }));
    } else if (/^[-*]\s+/.test(trimmed)) {
      children.push(new Paragraph({ bullet: { level: 0 }, spacing: { before: 60, after: 60 }, children: [new TextRun({ text: trimmed.replace(/^[-*]\s+/, ''), font: FONT, size: 22 })] }));
    } else if (/^\d+\.\s+/.test(trimmed)) {
      children.push(new Paragraph({ bullet: { level: 0 }, spacing: { before: 60, after: 60 }, children: [new TextRun({ text: trimmed.replace(/^\d+\.\s+/, ''), font: FONT, size: 22 })] }));
    } else {
      children.push(new Paragraph({ spacing: { before: 120, after: 120, line: 276 }, alignment: AlignmentType.JUSTIFIED, children: [new TextRun({ text: trimmed, font: FONT, size: 22 })] }));
    }
  }

  const doc = new Document({
    creator: 'BQI',
    title: title || 'BQI Raporu',
    styles: { default: { document: { run: { font: FONT, size: 22 } } } },
    sections: [{ properties: { page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } }, children }],
  });

  return Packer.toBlob(doc);
}

export function buildLocalPdfBlob({ title, content, category, subtitle = 'BQI — LOCAL AI (OFFLINE)' }) {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const marginX = 56;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const maxWidth = pageWidth - marginX * 2;
  let y = 64;

  const ensureSpace = (lineHeight) => {
    if (y + lineHeight > pageHeight - 56) {
      doc.addPage();
      y = 64;
    }
  };

  doc.setFont('times', 'italic');
  doc.setFontSize(9);
  doc.setTextColor('#666666');
  doc.text(subtitle, marginX, y);
  y += 28;

  doc.setFont('times', 'bold');
  doc.setFontSize(18);
  doc.setTextColor('#1A2244');
  const titleLines = doc.splitTextToSize(title || `${category || ''} analizi`, maxWidth);
  for (const line of titleLines) {
    ensureSpace(24);
    doc.text(line, marginX, y);
    y += 24;
  }
  y += 12;

  for (const raw of splitLines(content)) {
    const trimmed = raw.trim();
    if (!trimmed) { y += 10; continue; }

    let text = trimmed;
    let bold = false;
    let size = 11;
    let indent = 0;

    if (trimmed.startsWith('## ')) { text = trimmed.slice(3); bold = true; size = 13; }
    else if (trimmed.startsWith('### ')) { text = trimmed.slice(4); bold = true; size = 12; }
    else if (/^[-*]\s+/.test(trimmed)) { text = `•  ${trimmed.replace(/^[-*]\s+/, '')}`; indent = 12; }
    else if (/^\d+\.\s+/.test(trimmed)) { text = trimmed; indent = 12; }

    doc.setFont('times', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    doc.setTextColor(bold ? '#1A2244' : '#000000');
    const lines = doc.splitTextToSize(text, maxWidth - indent);
    for (const line of lines) {
      ensureSpace(size + 6);
      doc.text(line, marginX + indent, y);
      y += size + 6;
    }
    y += 4;
  }

  return doc.output('blob');
}
