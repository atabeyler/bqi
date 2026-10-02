import PDFDocument from 'pdfkit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, ShadingType, BorderStyle, Footer, PageNumber } from 'docx';

/**
 * Renders a docModel (see docModel.js) to a PDF or DOCX Buffer.
 * PDF: Liberation Serif (Latin incl. Turkish) and Noto Naskh Arabic are embedded. pdfkit has no bidi engine, so right-to-left text is laid out
 * here: words are wrapped logically, Arabic words are shaped with the font's "rtla" feature, and runs of Latin/digits stay left-to-right.
 * Word: Arabic uses the document's own bidi/shaping (rightToLeft runs, bidirectional paragraphs, visually-RTL tables).
 */
const FONTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'assets', 'fonts');
const COL = { navy: '#0b2545', text: '#1d2433', grey: '#667085', line: '#d0d5dd', head: '#f4f6f9', blue: '#5b7db1', 0: '#1b7f4b', 1: '#b7791f', 2: '#b42318' };
const DOCX_COL = { navy: '0B2545', grey: '667085', 0: '1B7F4B', 1: 'B7791F', 2: 'B42318' };
const AR_RE = /[؀-ۿݐ-ݿ]/;

const isAr = (c) => /[؀-ۿݐ-ݿ]/.test(c);
const isLatin = (c) => /[A-Za-z0-9À-ɏ]/.test(c);
const STICK = '.,:/-%+';
const MIRROR = { '(': ')', ')': '(', '[': ']', ']': '[' };

/**
 * Minimal bidi for a right-to-left paragraph: Arabic letters are R, Latin letters/digits are L; punctuation touching a Latin/digit
 * stays with it ("10.4%"); other neutrals take the surrounding direction if both sides agree, else RTL. Returns drawable parts in
 * left-to-right visual order: {text, ar}. Brackets inside RTL runs are mirrored. Arabic words stay together (with the spaces between them)
 * so the font shapes them as one run.
 */
export function bidiParts(text) {
  const ch = [...String(text)]; const n = ch.length;
  const dir = ch.map((c) => (isAr(c) ? 'R' : isLatin(c) ? 'L' : null));
  for (let i = 0; i < n; i++) if (dir[i] === null && STICK.includes(ch[i]) && dir[i - 1] === 'L') dir[i] = 'L';
  for (let i = n - 1; i >= 0; i--) if (dir[i] === null && STICK.includes(ch[i]) && dir[i + 1] === 'L') dir[i] = 'L';
  for (let i = 0; i < n; i++) {
    if (dir[i] !== null) continue; let j = i; while (j < n && dir[j] === null) j++;
    const prev = i > 0 ? dir[i - 1] : 'R'; const next = j < n ? dir[j] : 'R'; const d = prev === next ? prev : 'R'; for (let k = i; k < j; k++) dir[k] = d; i = j - 1;
  }
  const runs = []; for (let i = 0; i < n; i++) { const last = runs[runs.length - 1]; if (last && last.dir === dir[i]) last.chars.push(ch[i]); else runs.push({ dir: dir[i], chars: [ch[i]] }); }
  const out = [];
  for (const r of runs.reverse()) {
    const parts = []; // logical order inside the run
    r.chars.forEach((c, i) => {
      const arab = r.dir === 'R' && (isAr(c) || (c === ' ' && isAr(r.chars[i - 1] ?? '') && isAr(r.chars[i + 1] ?? '')));
      const last = parts[parts.length - 1]; const t = r.dir === 'R' && !arab ? (MIRROR[c] ?? c) : c;
      if (last && last.ar === arab) last.text += t; else parts.push({ text: t, ar: arab });
    });
    if (r.dir === 'R') for (const p of parts) if (!p.ar) p.text = [...p.text].reverse().join(''); // neutrals inside an RTL run read right-to-left too
    out.push(...(r.dir === 'R' ? parts.reverse() : parts));
  }
  return out;
}

function makeWriter(doc, rtl) {
  const face = (ar, bold, italic) => (ar ? (bold ? 'ARB' : 'AR') : bold ? 'B' : italic ? 'I' : 'R');
  const partW = (p, size, bold, italic) => { doc.font(face(p.ar, bold, italic)).fontSize(size); return doc.widthOfString(p.text, p.ar ? { features: ['rtla'] } : {}); };
  const textW = (t, size, bold, italic) => bidiParts(t).reduce((s, p) => s + partW(p, size, bold, italic), 0);
  const spaceW = (size, bold, italic) => { doc.font(face(false, bold, italic)).fontSize(size); return doc.widthOfString(' '); };
  const lineH = (size) => size * 1.25;

  function wrap(text, width, size, bold, italic) { // logical word wrap
    const lines = []; let cur = []; let w = 0; const sp = spaceW(size, bold, italic);
    for (const word of String(text).split(/\s+/).filter(Boolean)) {
      const ww = textW(word, size, bold, italic);
      if (cur.length && w + sp + ww > width) { lines.push(cur); cur = []; w = 0; }
      w += (cur.length ? sp : 0) + ww; cur.push(word);
    }
    if (cur.length) lines.push(cur); return lines.length ? lines : [[]];
  }

  /** Draws text in a box; returns the y below it. LTR delegates to pdfkit; RTL does its own layout. */
  function put(text, x, y, width, { size = 10.5, bold = false, italic = false, color = COL.text, align = rtl ? 'right' : 'left', gap = 2, characterSpacing = 0 } = {}) {
    if (!rtl) { doc.font(face(false, bold, italic)).fontSize(size).fillColor(color).text(String(text), x, y, { width, align, lineGap: gap, characterSpacing }); return doc.y; }
    let cy = y;
    for (const words of wrap(text, width, size, bold, italic)) {
      const parts = bidiParts(words.join(' ')); const widths = parts.map((p) => partW(p, size, bold, italic)); const total = widths.reduce((s, v) => s + v, 0);
      let cx = align === 'right' ? x + width - total : align === 'center' ? x + (width - total) / 2 : x;
      parts.forEach((p, i) => { doc.font(face(p.ar, bold, italic)).fontSize(size).fillColor(color).text(p.text, cx, cy, { lineBreak: false, features: p.ar ? ['rtla'] : [] }); cx += widths[i]; });
      cy += lineH(size) + gap;
    }
    doc.y = cy; return cy;
  }
  function height(text, width, { size = 10.5, bold = false, italic = false, gap = 2 } = {}) {
    if (!rtl) { doc.font(face(false, bold, italic)).fontSize(size); return doc.heightOfString(String(text), { width, lineGap: gap }); }
    return wrap(text, width, size, bold, italic).length * (lineH(size) + gap);
  }
  return { put, height };
}

export function renderReportPdf(model) {
  return new Promise((resolve, reject) => {
    const rtl = !!model.rtl;
    const doc = new PDFDocument({ size: 'A4', margins: { top: 50, bottom: 56, left: 48, right: 48 }, bufferPages: true, info: { Title: `${model.title} ${model.id}`, Author: 'BFI', Subject: model.subtitle } });
    const chunks = []; doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    doc.registerFont('R', path.join(FONTS, 'LiberationSerif-Regular.ttf')); doc.registerFont('B', path.join(FONTS, 'LiberationSerif-Bold.ttf')); doc.registerFont('I', path.join(FONTS, 'LiberationSerif-Italic.ttf'));
    if (rtl) { doc.registerFont('AR', path.join(FONTS, 'NotoNaskhArabic-Regular.ttf')); doc.registerFont('ARB', path.join(FONTS, 'NotoNaskhArabic-Bold.ttf')); }
    const wr = makeWriter(doc, rtl);
    const L = doc.page.margins.left; const W = doc.page.width - L - doc.page.margins.right; const bottom = () => doc.page.height - doc.page.margins.bottom;
    const need = (h) => { if (doc.y + h > bottom()) doc.addPage(); };
    const ctx = { doc, wr, L, W, need, rtl };

    // header: brand on the leading side, document facts on the trailing side
    wr.put(model.brand, rtl ? L + W / 2 : L, 46, W / 2, { size: 26, bold: true, color: COL.navy, align: rtl ? 'right' : 'left', characterSpacing: rtl ? 0 : 4 });
    wr.put(model.subtitle, rtl ? L + W * 0.3 : L, 80, W * 0.7, { size: 8, color: COL.grey, align: rtl ? 'right' : 'left', gap: 0 });
    wr.put(`${model.title}  ·  ${model.labels.docNo}: ${model.id}  ·  ${model.labels.generated}: ${model.dateText}`, rtl ? L : L + W / 2, 52, W / 2, { size: 8.5, color: COL.grey, align: rtl ? 'left' : 'right', gap: 0 });
    doc.moveTo(L, 98).lineTo(L + W, 98).lineWidth(2.5).strokeColor(COL.navy).stroke(); doc.y = 112;

    for (const s of model.sections) {
      need(60); doc.y += 8; const main = s.key === 'status';
      const yEnd = wr.put(main ? s.h : s.h.toLocaleUpperCase(model.lang), L, doc.y, W, { size: main ? 16 : 11.5, bold: true, color: COL.navy, characterSpacing: main || rtl ? 0 : 0.6, gap: 0 });
      if (!main) doc.moveTo(L, yEnd + 1).lineTo(L + W, yEnd + 1).lineWidth(0.6).strokeColor(COL.line).stroke();
      doc.y = yEnd + 6;
      for (const b of s.blocks) pdfBlock(b, ctx);
    }
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i); doc.page.margins.bottom = 0; // allow drawing in the footer band without triggering a new page
      makeWriter(doc, rtl).put(`${model.footer}  —  ${model.labels.page(i - range.start + 1, range.count)}`, L, doc.page.height - 40, W, { size: 7.5, color: COL.grey, align: 'center', gap: 0 });
    }
    doc.end();
  });
}

function pdfBlock(b, { doc, wr, L, W, need, rtl }) {
  const al = rtl ? 'right' : 'left';
  if (b.t === 'p') { need(40); const y = wr.put(b.text, L, doc.y, W, {}); doc.y = y + 4; }
  else if (b.t === 'small') { const y = wr.put(b.text, L, doc.y, W, { size: 8.5, italic: true, color: COL.grey }); doc.y = y + 3; }
  else if (b.t === 'ul') {
    for (const it of b.items) {
      need(24); const y0 = doc.y; const h = wr.height(it, W - 14, {});
      wr.put('•', rtl ? L + W - 8 : L, y0, 8, { align: al, gap: 0 }); const y = wr.put(it, rtl ? L : L + 14, y0, W - 14, {}); doc.y = Math.max(y, y0 + h) + 2;
    }
    doc.y += 2;
  } else if (b.t === 'status') {
    need(90); const top = doc.y; const color = COL[b.level]; const textW = W - 190;
    const textH = b.drivers.reduce((h, d) => h + wr.height(`•  ${d}`, textW, {}) + 3, 0); const h = Math.max(58, textH + 20);
    doc.rect(L, top, W, h).lineWidth(0.8).strokeColor(COL.line).stroke(); doc.rect(rtl ? L + W - 6 : L, top, 6, h).fill(color);
    wr.put(b.levelText, rtl ? L + W - 150 : L + 16, top + h / 2 - 14, 134, { size: 22, bold: true, color, align: al, gap: 0 });
    let ty = top + 10; for (const d of b.drivers) { ty = wr.put(`•  ${d}`, rtl ? L + 12 : L + 160, ty, textW, {}) + 3; }
    doc.y = top + h + 10;
  } else if (b.t === 'kpis') {
    need(60); const top = doc.y; const w = (W - 16) / b.items.length; const items = rtl ? [...b.items].reverse() : b.items;
    items.forEach((k, i) => { const x = L + i * (w + 8); doc.rect(x, top, w, 48).lineWidth(0.6).strokeColor(COL.line).stroke(); wr.put(k.v, x + 8, top + 6, w - 16, { size: 17, bold: true, color: COL.navy, align: al, gap: 0 }); wr.put(k.l, x + 8, top + 30, w - 16, { size: 8, color: COL.grey, align: al, gap: 0 }); });
    doc.y = top + 58;
  } else if (b.t === 'table') pdfTable(b, { doc, wr, L, W, need, rtl });
  else if (b.t === 'note') {
    const h = wr.height(b.text, W - 24, { size: 10 }) + 18; need(h + 6); const top = doc.y;
    doc.rect(L, top, W, h).fillAndStroke('#fff8e6', '#f0d58a'); wr.put(b.text, L + 12, top + 9, W - 24, { size: 10 }); doc.y = top + h + 8;
  } else if (b.t === 'bars') pdfBars(b, { doc, L, W, need });
  else if (b.t === 'line') pdfLine(b, { doc, L, W, need });
}

function pdfTable(b, { doc, wr, L, W, need, rtl }) {
  const n = b.head.length; const wide = n === 2 ? [0.25, 0.75] : n === 3 ? [0.38, 0.14, 0.48] : null; const frac = wide || Array(n).fill(1 / n);
  const order = [...Array(n).keys()]; if (rtl) order.reverse(); // Arabic reads from the right: first column on the right
  const cw = order.map((i) => frac[i] * W);
  const drawRow = (cells, o) => {
    const vis = order.map((i) => cells[i]);
    const h = Math.max(...vis.map((c, i) => wr.height(String(c), cw[i] - 12, { size: 9.5, bold: o.bold, gap: 0 }))) + 10; need(h); const top = doc.y; if (o.fill) doc.rect(L, top, W, h).fill(o.fill);
    let x = L; vis.forEach((c, i) => {
      const colIdx = order[i]; const lv = !o.bold && b.levelCol === colIdx ? b.levels?.[o.row] : null; const has = lv !== null && lv !== undefined;
      wr.put(String(c), x + 6, top + 5, cw[i] - 12, { size: 9.5, bold: o.bold || has, color: has ? COL[lv] : COL.text, align: rtl ? 'right' : 'left', gap: 0 }); x += cw[i];
    });
    doc.moveTo(L, top + h).lineTo(L + W, top + h).lineWidth(0.4).strokeColor(COL.line).stroke(); doc.y = top + h;
  };
  drawRow(b.head, { bold: true, fill: COL.head }); b.rows.forEach((r, ri) => drawRow(r, { row: ri })); doc.y += 8;
}

function pdfBars(b, { doc, L, W, need }) {
  const data = b.weeks; if (data.length < 2) return; const H = 120; need(H + 30); const top = doc.y + 6; const padL = 34;
  const max = Math.max(b.alarm * 1.4, ...data.map((d) => d.breadth)); const bw = (W - padL) / data.length; const y = (v) => top + H - (H * v) / max;
  data.forEach((d, i) => doc.rect(L + padL + i * bw + 1, y(d.breadth), bw - 2, top + H - y(d.breadth)).fill(d.flagged ? COL[2] : COL.blue));
  doc.moveTo(L + padL, y(b.alarm)).lineTo(L + W, y(b.alarm)).lineWidth(0.8).dash(3, { space: 2 }).strokeColor(COL[2]).stroke().undash();
  const ltr = makeWriter(doc, false); const lab = { size: 7.5, color: COL.grey, gap: 0 };
  ltr.put(b.pctLabel(max), L, top - 3, padL - 4, { ...lab, align: 'right' }); ltr.put(b.pctLabel(0), L, top + H - 6, padL - 4, { ...lab, align: 'right' });
  makeWriter(doc, AR_RE.test(b.alarmLabel)).put(b.alarmLabel, L + padL + 4, y(b.alarm) - 10, 160, { size: 7.5, color: COL[2], align: 'left', gap: 0 });
  ltr.put(data[0].label, L + padL, top + H + 4, 90, { ...lab, align: 'left' }); ltr.put(data[data.length - 1].label, L + W - 90, top + H + 4, 90, { ...lab, align: 'right' });
  doc.y = top + H + 20;
}

function pdfLine(b, { doc, L, W, need }) {
  const pts = b.points; const H = 110; need(H + 30); const top = doc.y + 6; const padL = 40; const vs = pts.map((p) => p.value); const lo = Math.min(...vs); const hi = Math.max(...vs); const span = hi - lo || 1;
  const x = (i) => L + padL + ((W - padL) * i) / (pts.length - 1); const y = (v) => top + H - (H * (v - lo)) / span;
  pts.forEach((p, i) => (i ? doc.lineTo(x(i), y(p.value)) : doc.moveTo(x(i), y(p.value)))); doc.lineWidth(1.2).strokeColor('#1d4e89').stroke();
  for (const d of b.flags) { const i = pts.findIndex((p) => p.date === d); if (i >= 0) doc.circle(x(i), y(pts[i].value), 3).fill(COL[2]); }
  const ltr = makeWriter(doc, false); const lab = { size: 7.5, color: COL.grey, gap: 0 };
  ltr.put(hi.toFixed(2), L, top - 3, padL - 4, { ...lab, align: 'right' }); ltr.put(lo.toFixed(2), L, top + H - 6, padL - 4, { ...lab, align: 'right' });
  ltr.put(b.first, L + padL, top + H + 4, 90, { ...lab, align: 'left' }); ltr.put(b.last, L + W - 90, top + H + 4, 90, { ...lab, align: 'right' });
  doc.y = top + H + 20;
}

// ---------- DOCX ----------
const FONT = 'Arial';
const border = { style: BorderStyle.SINGLE, size: 4, color: 'D0D5DD' };

export async function renderReportDocx(model) {
  const rtl = !!model.rtl;
  const run = (text, o = {}) => new TextRun({ text: String(text), font: rtl ? { ascii: FONT, hAnsi: FONT, cs: FONT } : FONT, size: 21, rightToLeft: rtl || undefined, ...o });
  const para = (children, o = {}) => new Paragraph({ bidirectional: rtl || undefined, spacing: { after: 100, line: 276 }, children: Array.isArray(children) ? children : [run(children)], ...o });
  const cell = (text, o = {}) => new TableCell({ width: o.width ? { size: o.width, type: WidthType.PERCENTAGE } : undefined, shading: o.fill ? { type: ShadingType.CLEAR, fill: o.fill, color: 'auto' } : undefined, margins: { top: 60, bottom: 60, left: 100, right: 100 }, borders: { top: border, bottom: border, left: border, right: border }, children: [new Paragraph({ bidirectional: rtl || undefined, children: [run(text, { size: 19, bold: !!o.bold, color: o.color })] })] });
  const table = (rows) => new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, visuallyRightToLeft: rtl || undefined, rows });
  const kpiHead = model.sections.find((s) => s.key === 'breadth')?.blocks.find((x) => x.t === 'kpis')?.items[0].l.replace(/\s*\(.*$/, '') ?? '';

  const children = [
    new Paragraph({ bidirectional: rtl || undefined, spacing: { after: 0 }, children: [run(model.brand, { size: 52, bold: true, color: DOCX_COL.navy })] }),
    new Paragraph({ bidirectional: rtl || undefined, spacing: { after: 60 }, children: [run(model.subtitle, { size: 16, color: DOCX_COL.grey })] }),
    new Paragraph({ bidirectional: rtl || undefined, spacing: { after: 200 }, border: { bottom: { style: BorderStyle.SINGLE, size: 18, color: DOCX_COL.navy, space: 4 } }, children: [run(`${model.title} · ${model.labels.docNo}: ${model.id} · ${model.labels.generated}: ${model.dateText}`, { size: 18, color: DOCX_COL.grey })] }),
  ];
  const block = (b) => {
    if (b.t === 'p') return [para(b.text)];
    if (b.t === 'small') return [para([run(b.text, { size: 17, italics: true, color: DOCX_COL.grey })])];
    if (b.t === 'ul') return b.items.map((it) => new Paragraph({ bidirectional: rtl || undefined, bullet: { level: 0 }, spacing: { after: 60 }, children: [run(it)] }));
    if (b.t === 'status') {
      const accent = { style: BorderStyle.SINGLE, size: 36, color: DOCX_COL[b.level] };
      return [table([new TableRow({ children: [
        new TableCell({ width: { size: 22, type: WidthType.PERCENTAGE }, shading: { type: ShadingType.CLEAR, fill: 'F4F6F9', color: 'auto' }, margins: { top: 120, bottom: 120, left: 140, right: 140 }, borders: { top: border, bottom: border, right: rtl ? accent : border, left: rtl ? border : accent }, children: [new Paragraph({ bidirectional: rtl || undefined, children: [run(b.levelText, { size: 40, bold: true, color: DOCX_COL[b.level] })] })] }),
        new TableCell({ width: { size: 78, type: WidthType.PERCENTAGE }, margins: { top: 100, bottom: 100, left: 140, right: 140 }, borders: { top: border, bottom: border, left: border, right: border }, children: b.drivers.map((d) => new Paragraph({ bidirectional: rtl || undefined, bullet: { level: 0 }, children: [run(d)] })) }),
      ] })]), para('')];
    }
    if (b.t === 'kpis') return [table([new TableRow({ children: b.items.map((k) => new TableCell({ margins: { top: 80, bottom: 80, left: 120, right: 120 }, borders: { top: border, bottom: border, left: border, right: border }, children: [new Paragraph({ bidirectional: rtl || undefined, children: [run(k.v, { size: 34, bold: true, color: DOCX_COL.navy })] }), new Paragraph({ bidirectional: rtl || undefined, children: [run(k.l, { size: 16, color: DOCX_COL.grey })] })] })) })]), para('')];
    if (b.t === 'table') {
      const n = b.head.length; const wide = n === 2 ? [25, 75] : n === 3 ? [38, 14, 48] : Array(n).fill(Math.floor(100 / n));
      return [table([new TableRow({ tableHeader: true, children: b.head.map((h, i) => cell(h, { bold: true, fill: 'F4F6F9', width: wide[i] })) }), ...b.rows.map((r, ri) => new TableRow({ cantSplit: true, children: r.map((c, i) => { const lv = b.levelCol === i ? b.levels?.[ri] : null; const has = lv !== null && lv !== undefined; return cell(c, { width: wide[i], bold: has, color: has ? DOCX_COL[lv] : undefined }); }) }))]), para('')];
    }
    if (b.t === 'note') return [new Paragraph({ bidirectional: rtl || undefined, spacing: { before: 60, after: 120 }, shading: { type: ShadingType.CLEAR, fill: 'FFF8E6', color: 'auto' }, border: { top: { style: BorderStyle.SINGLE, size: 4, color: 'F0D58A', space: 4 }, bottom: { style: BorderStyle.SINGLE, size: 4, color: 'F0D58A', space: 4 }, left: { style: BorderStyle.SINGLE, size: 4, color: 'F0D58A', space: 6 }, right: { style: BorderStyle.SINGLE, size: 4, color: 'F0D58A', space: 6 } }, children: [run(b.text, { size: 20 })] })];
    if (b.t === 'bars') { // Word has no native chart without an image: give the numbers (last 12 weeks); the chart is in the PDF/HTML versions
      const last = b.weeks.slice(-12);
      return [table([new TableRow({ tableHeader: true, children: [kpiHead, '%', '●'].map((h, i) => cell(h, { bold: true, fill: 'F4F6F9', width: [40, 30, 30][i] })) }), ...last.map((w) => new TableRow({ children: [cell(w.label, { width: 40 }), cell(b.pctLabel(w.breadth), { width: 30 }), cell(w.flagged ? '●' : '–', { width: 30, bold: w.flagged, color: w.flagged ? DOCX_COL[2] : undefined })] }))]), para('')];
    }
    if (b.t === 'line') {
      const vs = b.points.map((p) => p.value);
      return [para(`${b.first} → ${b.last}:  min ${Math.min(...vs).toFixed(2)} · max ${Math.max(...vs).toFixed(2)} · last ${vs[vs.length - 1].toFixed(2)}${b.flags.length ? ` · ● ${b.flags.join(', ')}` : ''}`)];
    }
    return [];
  };
  for (const s of model.sections) {
    const main = s.key === 'status';
    children.push(new Paragraph({ bidirectional: rtl || undefined, spacing: { before: 260, after: 100 }, keepNext: true, border: main ? undefined : { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'D0D5DD', space: 2 } }, children: [run(main ? s.h : s.h.toLocaleUpperCase(model.lang), { size: main ? 32 : 23, bold: true, color: DOCX_COL.navy })] }));
    for (const b of s.blocks) children.push(...block(b));
  }
  const doc = new Document({
    creator: 'BFI', title: `${model.title} ${model.id}`, description: model.subtitle,
    styles: { default: { document: { run: { font: FONT, size: 21 } } } },
    sections: [{
      properties: { page: { margin: { top: 1000, bottom: 1000, left: 1100, right: 1100 } } },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, bidirectional: rtl || undefined, children: [run(`${model.footer}  —  `, { size: 14, color: DOCX_COL.grey }), new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 14, color: DOCX_COL.grey })] })] }) },
      children,
    }],
  });
  return Packer.toBuffer(doc);
}
