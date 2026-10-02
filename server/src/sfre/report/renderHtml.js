import { buildDocModel } from './docModel.js';

/** Self-contained HTML (no scripts, no external loads) rendered from the language-aware document model; right-to-left for Arabic. */
const COLORS = { 0: '#1b7f4b', 1: '#b7791f', 2: '#b42318' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => v.toFixed(2);

function barsSvg(b) {
  const data = b.weeks; if (data.length < 2) return '';
  const W = 640; const H = 170; const pad = { l: 40, r: 10, t: 12, b: 26 };
  const max = Math.max(b.alarm * 1.4, ...data.map((d) => d.breadth)); const bw = (W - pad.l - pad.r) / data.length; const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const bars = data.map((d, i) => `<rect x="${(pad.l + i * bw + 1).toFixed(1)}" y="${y(d.breadth).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${(H - pad.b - y(d.breadth)).toFixed(1)}" fill="${d.flagged ? COLORS[2] : '#5b7db1'}"><title>${esc(d.label)}: ${esc(b.pctLabel(d.breadth))}</title></rect>`).join('');
  const ticks = [0, 0.5, 1].map((f) => `<text x="${pad.l - 6}" y="${(y(max * f) + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="#667085">${esc(b.pctLabel(max * f))}</text>`).join('');
  const ay = y(b.alarm).toFixed(1);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" style="width:100%;height:auto;direction:ltr">${ticks}${bars}<line x1="${pad.l}" x2="${W - pad.r}" y1="${ay}" y2="${ay}" stroke="${COLORS[2]}" stroke-dasharray="4 3"/><text x="${pad.l + 4}" y="${(y(b.alarm) - 4).toFixed(1)}" font-size="9" fill="${COLORS[2]}" style="unicode-bidi:plaintext">${esc(b.alarmLabel)}</text><text x="${pad.l}" y="${H - 8}" font-size="9" fill="#667085">${esc(data[0].label)}</text><text x="${W - pad.r}" y="${H - 8}" text-anchor="end" font-size="9" fill="#667085">${esc(data[data.length - 1].label)}</text></svg>`;
}

function lineSvg(b) {
  const pts = b.points; if (pts.length < 2) return '';
  const W = 640; const H = 150; const pad = { l: 44, r: 10, t: 10, b: 24 };
  const vs = pts.map((p) => p.value); const lo = Math.min(...vs); const hi = Math.max(...vs); const span = hi - lo || 1;
  const x = (i) => pad.l + ((W - pad.l - pad.r) * i) / (pts.length - 1); const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - (v - lo) / span);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const marks = b.flags.map((f) => { const i = pts.findIndex((p) => p.date === f); return i < 0 ? '' : `<circle cx="${x(i).toFixed(1)}" cy="${y(pts[i].value).toFixed(1)}" r="3.5" fill="${COLORS[2]}"><title>${esc(f)}</title></circle>`; }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" style="width:100%;height:auto;direction:ltr"><path d="${d}" fill="none" stroke="#1d4e89" stroke-width="1.6"/>${marks}<text x="${pad.l - 6}" y="${pad.t + 8}" text-anchor="end" font-size="9" fill="#667085">${num(hi)}</text><text x="${pad.l - 6}" y="${H - pad.b}" text-anchor="end" font-size="9" fill="#667085">${num(lo)}</text><text x="${pad.l}" y="${H - 8}" font-size="9" fill="#667085">${esc(b.first)}</text><text x="${W - pad.r}" y="${H - 8}" text-anchor="end" font-size="9" fill="#667085">${esc(b.last)}</text></svg>`;
}

function block(b) {
  switch (b.t) {
    case 'p': return `<p>${esc(b.text)}</p>`;
    case 'small': return `<p class="small">${esc(b.text)}</p>`;
    case 'ul': return `<ul>${b.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
    case 'status': return `<div class="status" style="border-inline-start:8px solid ${COLORS[b.level]}"><div class="lv" style="color:${COLORS[b.level]}">${esc(b.levelText)}</div><div><ul>${b.drivers.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></div></div>`;
    case 'kpis': return `<div class="grid">${b.items.map((k) => `<div class="kpi"><b>${esc(k.v)}</b><span>${esc(k.l)}</span></div>`).join('')}</div>`;
    case 'bars': return barsSvg(b);
    case 'line': return lineSvg(b);
    case 'note': return `<div class="note">${esc(b.text)}</div>`;
    case 'table': return `<div class="tw"><table><thead><tr>${b.head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${b.rows.map((r, ri) => `<tr>${r.map((c, ci) => {
      const lv = b.levelCol === ci ? b.levels?.[ri] : null;
      return lv !== null && lv !== undefined ? `<td><span class="chip" style="background:${COLORS[lv]}">${esc(c)}</span></td>` : `<td>${esc(c)}</td>`;
    }).join('')}</tr>`).join('')}</tbody></table></div>`;
    default: return '';
  }
}

const CSS = `@page{size:A4;margin:16mm 14mm}*{box-sizing:border-box}body{margin:0;background:#eef1f5;color:#1d2433;font:13px/1.55 "Segoe UI",Tahoma,system-ui,-apple-system,Arial,sans-serif}
.page{max-width:820px;margin:20px auto;background:#fff;padding:36px 44px;box-shadow:0 1px 12px rgba(16,24,40,.12)}
header{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #0b2545;padding-bottom:12px;gap:12px}
.brand{font-size:26px;font-weight:700;letter-spacing:.14em;color:#0b2545}.brand small{display:block;font-size:10px;font-weight:500;letter-spacing:.12em;color:#667085}
.meta{text-align:end;font-size:11px;color:#667085}h1{font-size:19px;margin:22px 0 4px;color:#0b2545}h2{font-size:14px;margin:26px 0 8px;color:#0b2545;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #d0d5dd;padding-bottom:4px}
[dir=rtl] .brand,[dir=rtl] h2{letter-spacing:0}
.status{display:flex;gap:18px;align-items:center;border:1px solid #d0d5dd;border-radius:6px;padding:14px 18px;margin:14px 0}
.status .lv{font-size:26px;font-weight:700;min-width:130px}.status ul{margin:0;padding-inline-start:18px}
table{width:100%;border-collapse:collapse;margin:8px 0;font-size:12px}th,td{border-bottom:1px solid #e4e7ec;padding:6px 8px;text-align:start;vertical-align:top}th{background:#f4f6f9;color:#344054;font-weight:600}
.chip{display:inline-block;color:#fff;font-size:10px;font-weight:700;letter-spacing:.06em;padding:2px 8px;border-radius:10px}
.note{background:#fff8e6;border:1px solid #f0d58a;border-radius:6px;padding:10px 14px;font-size:12px}.small{font-size:11px;color:#667085}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:10px 0}.kpi{border:1px solid #e4e7ec;border-radius:6px;padding:10px 12px}.kpi b{display:block;font-size:20px;color:#0b2545}.kpi span{font-size:11px;color:#667085}
footer{margin-top:30px;border-top:1px solid #d0d5dd;padding-top:10px;font-size:10.5px;color:#667085}
@media screen and (max-width:640px){.page{margin:0;padding:18px 14px;box-shadow:none}header{flex-direction:column;align-items:flex-start;gap:8px}.meta{text-align:start}.status{flex-direction:column;align-items:flex-start;gap:6px}.status .lv{min-width:0}.grid{grid-template-columns:1fr}.tw{overflow-x:auto}th,td{min-width:84px}td,th,li,p{overflow-wrap:anywhere}}
@media print{body{background:#fff}.page{box-shadow:none;margin:0;padding:0;max-width:none}h2{break-after:avoid}table,.status,.kpi,svg{break-inside:avoid}}`;

export function renderModelHtml(model) {
  const sections = model.sections.map((s) => `${s.key === 'status' ? `<h1>${esc(s.h)}</h1>` : `<h2>${esc(s.h)}</h2>`}${s.blocks.map(block).join('')}`).join('\n');
  return `<!doctype html><html lang="${model.lang}" dir="${model.rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(model.title)} ${esc(model.id)}</title><style>${CSS}</style></head><body><div class="page">
<header><div class="brand">${esc(model.brand)}<small>${esc(model.subtitle)}</small></div><div class="meta">${esc(model.title)}<br>${esc(model.labels.docNo)}: <b>${esc(model.id)}</b><br>${esc(model.labels.generated)}: ${esc(model.dateText)}</div></header>
${sections}
<footer>${esc(model.footer)}</footer>
</div></body></html>`;
}

export function renderReportHtml(parts, lang = 'tr') { return renderModelHtml(buildDocModel(parts, lang)); }
