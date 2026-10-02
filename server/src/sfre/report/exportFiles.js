import PDFDocument from 'pdfkit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, ShadingType, BorderStyle, Header, Footer, PageNumber } from 'docx';

/** Renders a docModel (see docModel.js) to a PDF or DOCX Buffer. Liberation Serif is embedded so Turkish letters (ğ ş ı İ) render correctly. */
const FONTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'assets', 'fonts');
const COL = { navy: '#0b2545', text: '#1d2433', grey: '#667085', line: '#d0d5dd', head: '#f4f6f9', blue: '#5b7db1', 0: '#1b7f4b', 1: '#b7791f', 2: '#b42318' };
const DOCX_COL = { navy: '0B2545', grey: '667085', 0: '1B7F4B', 1: 'B7791F', 2: 'B42318' };
const LEVEL_OF = { NORMAL: 0, 'İZLEME': 1, ALARM: 2 };

export function renderReportPdf(model) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 50, bottom: 56, left: 48, right: 48 }, bufferPages: true, info: { Title: `${model.title} ${model.id}`, Author: 'BFI', Subject: 'Sistemik risk durum raporu' } });
    const chunks = []; doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    doc.registerFont('R', path.join(FONTS, 'LiberationSerif-Regular.ttf')); doc.registerFont('B', path.join(FONTS, 'LiberationSerif-Bold.ttf')); doc.registerFont('I', path.join(FONTS, 'LiberationSerif-Italic.ttf'));
    const L = doc.page.margins.left; const W = doc.page.width - L - doc.page.margins.right; const bottom = () => doc.page.height - doc.page.margins.bottom;
    const need = (h) => { if (doc.y + h > bottom()) doc.addPage(); };

    doc.font('B').fontSize(26).fillColor(COL.navy).text('BFI', L, 50, { characterSpacing: 4 });
    doc.font('R').fontSize(8).fillColor(COL.grey).text(model.subtitle, L, 80, { characterSpacing: 1 });
    doc.font('R').fontSize(9).fillColor(COL.grey).text(`Durum Raporu\nBelge No: ${model.id}\nÜretim: ${model.dateText}`, L, 50, { width: W, align: 'right' });
    doc.moveTo(L, 98).lineTo(L + W, 98).lineWidth(2.5).strokeColor(COL.navy).stroke(); doc.y = 112;

    for (const s of model.sections) {
      need(60); doc.moveDown(0.6);
      doc.font('B').fontSize(s.h === 'Genel Durum' ? 16 : 11.5).fillColor(COL.navy).text(s.h === 'Genel Durum' ? s.h : s.h.toLocaleUpperCase('tr-TR'), L, doc.y, { width: W, characterSpacing: s.h === 'Genel Durum' ? 0 : 0.6 });
      if (s.h !== 'Genel Durum') { doc.moveTo(L, doc.y + 1).lineTo(L + W, doc.y + 1).lineWidth(0.6).strokeColor(COL.line).stroke(); }
      doc.moveDown(0.5);
      for (const b of s.blocks) pdfBlock(doc, b, { L, W, need });
    }
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i); doc.page.margins.bottom = 0; // allow drawing in the footer band without triggering a new page
      doc.font('R').fontSize(7.5).fillColor(COL.grey).text(`${model.footer}   —   Sayfa ${i - range.start + 1} / ${range.count}`, L, doc.page.height - 38, { width: W, align: 'center', lineBreak: false });
    }
    doc.end();
  });
}

function pdfBlock(doc, b, { L, W, need }) {
  const y0 = () => doc.y;
  if (b.t === 'p') { need(40); doc.font('R').fontSize(10.5).fillColor(COL.text).text(b.text, L, y0(), { width: W, lineGap: 2 }); doc.moveDown(0.5); }
  else if (b.t === 'small') { doc.font('I').fontSize(8.5).fillColor(COL.grey).text(b.text, L, y0(), { width: W }); doc.moveDown(0.4); }
  else if (b.t === 'ul') { for (const it of b.items) { need(20); doc.font('R').fontSize(10.5).fillColor(COL.text).text(`•  ${it}`, L + 8, y0(), { width: W - 8, lineGap: 2 }); } doc.moveDown(0.3); }
  else if (b.t === 'status') {
    need(90); const top = y0(); const color = COL[b.level];
    doc.font('R').fontSize(10.5); const textH = b.drivers.reduce((h, d) => h + doc.heightOfString(`•  ${d}`, { width: W - 170 }) + 3, 0); const h = Math.max(56, textH + 20);
    doc.rect(L, top, W, h).lineWidth(0.8).strokeColor(COL.line).stroke(); doc.rect(L, top, 6, h).fill(color);
    doc.font('B').fontSize(24).fillColor(color).text(b.levelTr, L + 20, top + h / 2 - 14, { width: 130, lineBreak: false });
    let ty = top + 10; for (const d of b.drivers) { doc.font('R').fontSize(10.5).fillColor(COL.text).text(`•  ${d}`, L + 160, ty, { width: W - 175 }); ty = doc.y + 3; }
    doc.y = top + h + 10;
  } else if (b.t === 'kpis') {
    need(60); const top = y0(); const w = (W - 16) / b.items.length;
    b.items.forEach((k, i) => { const x = L + i * (w + 8); doc.rect(x, top, w, 46).lineWidth(0.6).strokeColor(COL.line).stroke(); doc.font('B').fontSize(17).fillColor(COL.navy).text(k.v, x + 8, top + 6, { width: w - 16, lineBreak: false }); doc.font('R').fontSize(8).fillColor(COL.grey).text(k.l, x + 8, top + 29, { width: w - 16, lineBreak: false }); });
    doc.y = top + 56;
  } else if (b.t === 'table') pdfTable(doc, b, { L, W, need });
  else if (b.t === 'note') {
    doc.font('R').fontSize(10); const h = doc.heightOfString(b.text, { width: W - 24 }) + 18; need(h + 6); const top = y0();
    doc.rect(L, top, W, h).fillAndStroke('#fff8e6', '#f0d58a'); doc.fillColor(COL.text).font('R').fontSize(10).text(b.text, L + 12, top + 9, { width: W - 24 }); doc.y = top + h + 8;
  } else if (b.t === 'bars') pdfBars(doc, b, { L, W, need });
  else if (b.t === 'line') pdfLine(doc, b, { L, W, need });
}

function pdfTable(doc, b, { L, W, need }) {
  const n = b.head.length; const wide = n === 2 ? [0.25, 0.75] : n === 3 ? [0.38, 0.14, 0.48] : null; const cw = wide ? wide.map((f) => f * W) : Array(n).fill(W / n);
  const rowH = (cells, font) => Math.max(...cells.map((c, i) => { doc.font(font).fontSize(9.5); return doc.heightOfString(String(c), { width: cw[i] - 12 }); })) + 10;
  const drawRow = (cells, font, fill, level) => {
    const h = rowH(cells, font); need(h); const top = doc.y; if (fill) doc.rect(L, top, W, h).fill(fill);
    let x = L; cells.forEach((c, i) => {
      const isLevel = level === i && LEVEL_OF[c] !== undefined;
      doc.font(isLevel ? 'B' : font).fontSize(9.5).fillColor(isLevel ? COL[LEVEL_OF[c]] : COL.text).text(String(c), x + 6, top + 5, { width: cw[i] - 12 }); x += cw[i];
    });
    doc.moveTo(L, top + h).lineTo(L + W, top + h).lineWidth(0.4).strokeColor(COL.line).stroke(); doc.y = top + h;
  };
  drawRow(b.head, 'B', COL.head, null); for (const r of b.rows) drawRow(r, 'R', null, b.levelCol); doc.moveDown(0.6);
}

function pdfBars(doc, b, { L, W, need }) {
  const data = b.weeks; if (data.length < 2) return; const H = 120; need(H + 30); const top = doc.y + 6; const padL = 34;
  const max = Math.max(b.alarm * 1.4, ...data.map((d) => d.breadth)); const bw = (W - padL) / data.length; const y = (v) => top + H - (H * v) / max;
  data.forEach((d, i) => doc.rect(L + padL + i * bw + 1, y(d.breadth), bw - 2, top + H - y(d.breadth)).fill(d.flagged ? COL[2] : COL.blue));
  doc.moveTo(L + padL, y(b.alarm)).lineTo(L + W, y(b.alarm)).lineWidth(0.8).dash(3, { space: 2 }).strokeColor(COL[2]).stroke().undash();
  const fmt = (v) => `${(v * 100).toFixed(0)}%`;
  doc.font('R').fontSize(7.5).fillColor(COL.grey).text(fmt(max), L, top - 3, { width: padL - 4, align: 'right', lineBreak: false }).text('0%', L, top + H - 6, { width: padL - 4, align: 'right', lineBreak: false });
  doc.fillColor(COL[2]).text(`alarm seviyesi ${(b.alarm * 100).toFixed(1).replace('.', ',')}%`, L + padL + 4, y(b.alarm) - 10, { width: 140, lineBreak: false });
  const dt = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
  doc.fillColor(COL.grey).text(dt(data[0].date), L + padL, top + H + 4, { lineBreak: false }).text(dt(data[data.length - 1].date), L + W - 80, top + H + 4, { width: 80, align: 'right', lineBreak: false });
  doc.y = top + H + 20;
}

function pdfLine(doc, b, { L, W, need }) {
  const pts = b.points; const H = 110; need(H + 30); const top = doc.y + 6; const padL = 40; const vs = pts.map((p) => p.value); const lo = Math.min(...vs); const hi = Math.max(...vs); const span = hi - lo || 1;
  const x = (i) => L + padL + ((W - padL) * i) / (pts.length - 1); const y = (v) => top + H - (H * (v - lo)) / span;
  pts.forEach((p, i) => (i ? doc.lineTo(x(i), y(p.value)) : doc.moveTo(x(i), y(p.value)))); doc.lineWidth(1.2).strokeColor('#1d4e89').stroke();
  for (const d of b.flags) { const i = pts.findIndex((p) => p.date === d); if (i >= 0) doc.circle(x(i), y(pts[i].value), 3).fill(COL[2]); }
  const num = (v) => v.toFixed(2).replace('.', ',');
  doc.font('R').fontSize(7.5).fillColor(COL.grey).text(num(hi), L, top - 3, { width: padL - 4, align: 'right', lineBreak: false }).text(num(lo), L, top + H - 6, { width: padL - 4, align: 'right', lineBreak: false });
  const dt = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
  doc.text(dt(pts[0].date), L + padL, top + H + 4, { lineBreak: false }).text(dt(pts[pts.length - 1].date), L + W - 80, top + H + 4, { width: 80, align: 'right', lineBreak: false });
  doc.y = top + H + 20;
}

// ---------- DOCX ----------
const FONT = 'Calibri';
const run = (text, o = {}) => new TextRun({ text: String(text), font: FONT, size: 21, ...o });
const para = (children, o = {}) => new Paragraph({ spacing: { after: 100, line: 276 }, children: Array.isArray(children) ? children : [run(children)], ...o });
const border = { style: BorderStyle.SINGLE, size: 4, color: 'D0D5DD' };
const cell = (text, o = {}) => new TableCell({ width: o.width ? { size: o.width, type: WidthType.PERCENTAGE } : undefined, shading: o.fill ? { type: ShadingType.CLEAR, fill: o.fill, color: 'auto' } : undefined, margins: { top: 60, bottom: 60, left: 100, right: 100 }, borders: { top: border, bottom: border, left: border, right: border }, children: [new Paragraph({ children: [run(text, { size: 19, bold: !!o.bold, color: o.color })] })] });

export async function renderReportDocx(model) {
  const children = [
    new Paragraph({ spacing: { after: 0 }, children: [run('BFI', { size: 52, bold: true, color: DOCX_COL.navy })] }),
    new Paragraph({ spacing: { after: 60 }, children: [run(model.subtitle, { size: 16, color: DOCX_COL.grey })] }),
    new Paragraph({ spacing: { after: 200 }, border: { bottom: { style: BorderStyle.SINGLE, size: 18, color: DOCX_COL.navy, space: 4 } }, children: [run(`Durum Raporu · Belge No: ${model.id} · Üretim: ${model.dateText}`, { size: 18, color: DOCX_COL.grey })] }),
  ];
  for (const s of model.sections) {
    children.push(new Paragraph({ spacing: { before: 260, after: 100 }, keepNext: true, border: s.h === 'Genel Durum' ? undefined : { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'D0D5DD', space: 2 } }, children: [run(s.h === 'Genel Durum' ? s.h : s.h.toLocaleUpperCase('tr-TR'), { size: s.h === 'Genel Durum' ? 32 : 23, bold: true, color: DOCX_COL.navy })] }));
    for (const b of s.blocks) children.push(...docxBlock(b));
  }
  const doc = new Document({
    creator: 'BFI', title: `${model.title} ${model.id}`, description: 'Sistemik risk durum raporu',
    styles: { default: { document: { run: { font: FONT, size: 21 } } } },
    sections: [{
      properties: { page: { margin: { top: 1000, bottom: 1000, left: 1100, right: 1100 } } },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [run(`${model.footer}   —   Sayfa `, { size: 14, color: DOCX_COL.grey }), new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 14, color: DOCX_COL.grey })] })] }) },
      headers: { default: new Header({ children: [new Paragraph({ children: [] })] }) },
      children,
    }],
  });
  return Packer.toBuffer(doc);
}

function docxBlock(b) {
  if (b.t === 'p') return [para(b.text)];
  if (b.t === 'small') return [para([run(b.text, { size: 17, italics: true, color: DOCX_COL.grey })])];
  if (b.t === 'ul') return b.items.map((it) => new Paragraph({ bullet: { level: 0 }, spacing: { after: 60 }, children: [run(it)] }));
  if (b.t === 'status') return [new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ children: [
    new TableCell({ width: { size: 22, type: WidthType.PERCENTAGE }, shading: { type: ShadingType.CLEAR, fill: 'F4F6F9', color: 'auto' }, margins: { top: 120, bottom: 120, left: 140, right: 100 }, borders: { top: border, bottom: border, right: border, left: { style: BorderStyle.SINGLE, size: 36, color: DOCX_COL[b.level] } }, children: [new Paragraph({ children: [run(b.levelTr, { size: 40, bold: true, color: DOCX_COL[b.level] })] })] }),
    new TableCell({ width: { size: 78, type: WidthType.PERCENTAGE }, margins: { top: 100, bottom: 100, left: 140, right: 100 }, borders: { top: border, bottom: border, left: border, right: border }, children: b.drivers.map((d) => new Paragraph({ bullet: { level: 0 }, children: [run(d)] })) }),
  ] })] }), para('')];
  if (b.t === 'kpis') return [new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ children: b.items.map((k) => new TableCell({ margins: { top: 80, bottom: 80, left: 120, right: 100 }, borders: { top: border, bottom: border, left: border, right: border }, children: [new Paragraph({ children: [run(k.v, { size: 34, bold: true, color: DOCX_COL.navy })] }), new Paragraph({ children: [run(k.l, { size: 16, color: DOCX_COL.grey })] })] })) })] }), para('')];
  if (b.t === 'table') {
    const n = b.head.length; const wide = n === 2 ? [25, 75] : n === 3 ? [38, 14, 48] : Array(n).fill(Math.floor(100 / n));
    return [new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ tableHeader: true, children: b.head.map((h, i) => cell(h, { bold: true, fill: 'F4F6F9', width: wide[i] })) }), ...b.rows.map((r) => new TableRow({ cantSplit: true, children: r.map((c, i) => { const lv = b.levelCol === i ? LEVEL_OF[c] : undefined; return cell(c, { width: wide[i], bold: lv !== undefined, color: lv !== undefined ? DOCX_COL[lv] : undefined }); }) }))] }), para('')];
  }
  if (b.t === 'note') return [new Paragraph({ spacing: { before: 60, after: 120 }, shading: { type: ShadingType.CLEAR, fill: 'FFF8E6', color: 'auto' }, border: { top: { style: BorderStyle.SINGLE, size: 4, color: 'F0D58A', space: 4 }, bottom: { style: BorderStyle.SINGLE, size: 4, color: 'F0D58A', space: 4 }, left: { style: BorderStyle.SINGLE, size: 4, color: 'F0D58A', space: 6 }, right: { style: BorderStyle.SINGLE, size: 4, color: 'F0D58A', space: 6 } }, children: [run(b.text, { size: 20 })] })];
  if (b.t === 'bars') { // Word has no native chart without an image: give the numbers (last 12 weeks); the chart is in the PDF/HTML versions
    const last = b.weeks.slice(-12); const f = (v) => `${(v * 100).toFixed(1).replace('.', ',')}%`; const dt = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
    return [para([run('Son haftalar (grafik PDF ve HTML sürümündedir):', { size: 18, color: DOCX_COL.grey })]), new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ tableHeader: true, children: ['Hafta', 'Yaygınlık', 'Durum'].map((h, i) => cell(h, { bold: true, fill: 'F4F6F9', width: [34, 33, 33][i] })) }), ...last.map((w) => new TableRow({ children: [cell(dt(w.date), { width: 34 }), cell(f(w.breadth), { width: 33 }), cell(w.flagged ? 'ALARM' : '–', { width: 33, bold: w.flagged, color: w.flagged ? DOCX_COL[2] : undefined })] }))] }), para('')];
  }
  if (b.t === 'line') {
    const vs = b.points.map((p) => p.value); const num = (v) => v.toFixed(2).replace('.', ',');
    return [para(`Dönem: ${b.points[0].date} → ${b.points[b.points.length - 1].date}; en düşük ${num(Math.min(...vs))}, en yüksek ${num(Math.max(...vs))}, son ${num(vs[vs.length - 1])}. Şok günleri: ${b.flags.length ? b.flags.join(', ') : 'yok'}. (Grafik PDF ve HTML sürümündedir.)`)];
  }
  return [];
}
