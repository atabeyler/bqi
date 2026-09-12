import React, { useRef, useState } from 'react';
import { useLang } from '../services/langContext.jsx';

// Fixed categorical/status colors, validated against the app's dark navy
// panel surface (#11172a) with scripts/validate_palette.js from the dataviz
// skill (lightness band, chroma floor, CVD separation, contrast all pass).
const SERIES_LLM = '#5fbcd3';       // BQI cyan-dark — categorical slot 1 (AI estimate)
const SERIES_QUANTUM = '#0891b2';   // cyan-600 — categorical slot 2 (quantum result)
const STATUS_GOOD = '#0ca30c';      // selected / included
const STATUS_CRITICAL = '#d03b3b';  // flagged / anomalous
const STATUS_MUTED = '#8a93ad';     // normal / not selected — not a status, just muted ink
const STATUS_REVIEW = '#d9a441';    // review / secondary check
const GRID = 'rgba(88,221,255,0.12)';
const AXIS = 'rgba(88,221,255,0.28)';

function roundedTopBarPath(x, yTop, width, height, radius) {
  if (height <= 0) return '';
  const r = Math.min(radius, width / 2, height);
  const yBottom = yTop + height;
  return `M ${x} ${yBottom} L ${x} ${yTop + r} Q ${x} ${yTop} ${x + r} ${yTop} ` +
    `L ${x + width - r} ${yTop} Q ${x + width} ${yTop} ${x + width} ${yTop + r} L ${x + width} ${yBottom} Z`;
}

function useTooltip() {
  const containerRef = useRef(null);
  const [tip, setTip] = useState(null); // { x, y, lines: [] }
  const show = (evt, lines) => {
    const box = containerRef.current?.getBoundingClientRect();
    if (!box) return;
    setTip({ x: evt.clientX - box.left, y: evt.clientY - box.top, lines });
  };
  const hide = () => setTip(null);
  return { containerRef, tip, show, hide };
}

function Tooltip({ tip }) {
  if (!tip) return null;
  return (
    <div
      className="absolute z-10 pointer-events-none bg-navy border border-gold/50 rounded px-2.5 py-1.5 text-[14px] font-mono shadow-lg whitespace-nowrap"
      style={{ left: tip.x, top: tip.y, transform: 'translate(-50%, -110%)' }}
    >
      {tip.lines.map((l, i) => (
        <div key={i} className={i === 0 ? 'text-gold/90 font-bold' : 'text-gold/60'}>{l}</div>
      ))}
    </div>
  );
}

function Legend({ items }) {
  return (
    <div className="flex flex-wrap gap-4 mb-2">
      {items.map((it) => (
        <div key={it.label} className="flex items-center gap-1.5 text-xs text-gold/60 tracking-wide">
          <span className="inline-block w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: it.color }} />
          {it.icon && <span>{it.icon}</span>}
          {it.label}
        </div>
      ))}
    </div>
  );
}

function ChartCard({ title, subtitle, legend, children, tableToggle, showTable, onToggleTable }) {
  return (
    <div className="bg-navy-light/70 border border-gold/30 rounded-lg p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-1">
        <div>
          <h4 className="font-display text-gold/90 tracking-widest text-xs uppercase">{title}</h4>
          {subtitle && <p className="text-xs text-gold/40 mt-0.5">{subtitle}</p>}
        </div>
        {tableToggle && (
          <button onClick={onToggleTable} className="text-xs text-gold/50 hover:text-gold border border-gold/20 hover:border-gold/50 rounded px-2 py-1 tracking-wide flex-shrink-0">
            {showTable ? 'Grafik gorunumu' : 'Tablo gorunumu'}
          </button>
        )}
      </div>
      {legend}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1) Scenario comparison: LLM estimate vs quantum-circuit result, per scenario,
//    with the confidence-interval range as a whisker on the quantum bar.
// ---------------------------------------------------------------------------
export function ScenarioComparisonChart({ scenarios }) {
  const { containerRef, tip, show, hide } = useTooltip();
  const [showTable, setShowTable] = useState(false);
  const data = (scenarios || []).filter((s) => s.quantumProbability !== undefined);
  if (data.length === 0) return null;

  const H = 200;
  const padTop = 16, padBottom = 34, padLeft = 4, padRight = 4;
  const plotH = H - padTop - padBottom;
  const groupW = 96;
  const barW = 24;
  const gap = 10;
  const W = padLeft + padRight + data.length * groupW;
  const maxVal = 100;
  const yFor = (v) => padTop + plotH - (v / maxVal) * plotH;

  return (
    <ChartCard
      title="Senaryo Karsilastirmasi: YZ Tahmini vs Kuantum Donusumlu Senaryo Dagilimi"
      subtitle="YZ'nin ilk tahmini, bir kuantum devresine yuklenerek olcum yoluyla yeniden ifade edilir (ince cizgi guven araligini gosterir). Bu deger bagimsiz gercek-dunya olcumu veya dogrulanmis olay gerceklesme olasiligi DEGILDIR -- YZ tahmininin kuantum donusumlu bir yeniden ifadesidir."
      legend={<Legend items={[{ label: 'YZ Tahmini', color: SERIES_LLM }, { label: 'Kuantum Donusumlu Dagilim (guven araligi ile)', color: SERIES_QUANTUM }]} />}
      tableToggle
      showTable={showTable}
      onToggleTable={() => setShowTable((v) => !v)}
    >
      {showTable ? (
        <ScenarioTable data={data} />
      ) : (
        <div ref={containerRef} className="relative overflow-x-auto">
          <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ minWidth: '100%' }}>
            {[0, 25, 50, 75, 100].map((g) => (
              <g key={g}>
                <line x1={padLeft} x2={W - padRight} y1={yFor(g)} y2={yFor(g)} stroke={GRID} strokeWidth="1" />
                <text x={2} y={yFor(g) - 2} fontSize="8" fill="rgba(88,221,255,0.5)">{g}%</text>
              </g>
            ))}
            <line x1={padLeft} x2={W - padRight} y1={yFor(0)} y2={yFor(0)} stroke={AXIS} strokeWidth="1" />

            {data.map((s, i) => {
              const gx = padLeft + i * groupW;
              const llmH = plotH - (yFor(s.llmEstimate) - padTop);
              const qH = plotH - (yFor(s.quantumProbability) - padTop);
              const llmX = gx + (groupW - (barW * 2 + gap)) / 2;
              const qX = llmX + barW + gap;
              const hasRange = s.quantumRangeLow !== undefined && s.quantumRangeHigh !== undefined;
              return (
                <g key={s.id}>
                  <path d={roundedTopBarPath(llmX, yFor(s.llmEstimate), barW, llmH, 4)} fill={SERIES_LLM}
                    onMouseMove={(e) => show(e, [`YZ Tahmini: %${s.llmEstimate}`, s.title])}
                    onMouseLeave={hide} style={{ cursor: 'pointer' }} />
                  <path d={roundedTopBarPath(qX, yFor(s.quantumProbability), barW, qH, 4)} fill={SERIES_QUANTUM}
                    onMouseMove={(e) => show(e, [`Kuantum Donusumlu Dagilim: %${s.quantumProbability}`, hasRange ? `Aralik: %${s.quantumRangeLow}-%${s.quantumRangeHigh}` : '', s.title].filter(Boolean))}
                    onMouseLeave={hide} style={{ cursor: 'pointer' }} />
                  {hasRange && (
                    <line x1={qX + barW / 2} x2={qX + barW / 2} y1={yFor(s.quantumRangeHigh)} y2={yFor(s.quantumRangeLow)} stroke="rgba(255,255,255,0.6)" strokeWidth="1.5" />
                  )}
                  <text x={llmX + barW / 2} y={yFor(s.llmEstimate) - 4} fontSize="8" textAnchor="middle" fill="rgba(88,221,255,0.7)">{s.llmEstimate}%</text>
                  <text x={qX + barW / 2} y={yFor(s.quantumProbability) - 4} fontSize="8" textAnchor="middle" fill="rgba(88,221,255,0.7)">{s.quantumProbability}%</text>
                  <text x={gx + groupW / 2} y={H - padBottom + 14} fontSize="8" textAnchor="middle" fill="rgba(88,221,255,0.5)">
                    {truncate(s.title, 14)}
                  </text>
                </g>
              );
            })}
          </svg>
          <Tooltip tip={tip} />
        </div>
      )}
    </ChartCard>
  );
}

function ScenarioTable({ data }) {
  const { t } = useLang();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[14px] font-mono text-gold/70">
        <thead><tr className="text-gold/40 text-left"><th className="py-1 pr-3">{t('tableScenario')}</th><th className="py-1 pr-3">{t('tableAiEstimate')}</th><th className="py-1 pr-3">{t('tableQuantumResult')}</th><th className="py-1">{t('tableConfidenceInterval')}</th></tr></thead>
        <tbody>
          {data.map((s) => (
            <tr key={s.id} className="border-t border-gold/10">
              <td className="py-1 pr-3">{s.title}</td>
              <td className="py-1 pr-3">%{s.llmEstimate}</td>
              <td className="py-1 pr-3">%{s.quantumProbability}</td>
              <td className="py-1">{s.quantumRangeLow !== undefined ? `%${s.quantumRangeLow} - %${s.quantumRangeHigh}` : '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2) Fraud/AML risk scores: one bar per transaction, status-colored by
//    whether the quantum kernel flagged it as anomalous.
// ---------------------------------------------------------------------------
export function FraudRiskChart({ transactions, confirmedIds = [] }) {
  const { containerRef, tip, show, hide } = useTooltip();
  const [showTable, setShowTable] = useState(false);
  const data = transactions || [];
  if (data.length === 0) return null;
  const confirmedSet = new Set(confirmedIds || []);

  const H = 200;
  const padTop = 16, padBottom = 34, padLeft = 4, padRight = 4;
  const plotH = H - padTop - padBottom;
  const slotW = 34;
  const barW = 20;
  const W = padLeft + padRight + data.length * slotW;
  const maxVal = 100;
  const yFor = (v) => padTop + plotH - (v / maxVal) * plotH;

  return (
    <ChartCard
      title="Kuantum Anomali Tespiti: Islem Risk Skorlari"
      subtitle={confirmedSet.size
        ? 'Onaylanan islemler yesil, ikinci incelemeye kalan islemler turuncu, normal islemler gri gorunur.'
        : 'Her cubuk bir islem kaydinin kuantum cekirdek benzerlik matrisinden hesaplanan risk skorudur (0-100).'}
      legend={<Legend items={confirmedSet.size
        ? [
            { label: 'Onaylandi', color: STATUS_GOOD, icon: '✓' },
            { label: 'Inceleme', color: STATUS_REVIEW, icon: '•' },
            { label: 'Normal', color: STATUS_MUTED },
          ]
        : [
            { label: 'Isaretlendi', color: STATUS_CRITICAL, icon: '⚠' },
            { label: 'Normal', color: STATUS_MUTED },
          ]} />}
      tableToggle
      showTable={showTable}
      onToggleTable={() => setShowTable((v) => !v)}
    >
      {showTable ? (
        <FraudTable data={data} />
      ) : (
        <div ref={containerRef} className="relative overflow-x-auto">
          <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ minWidth: '100%' }}>
            {[0, 25, 50, 75, 100].map((g) => (
              <g key={g}>
                <line x1={padLeft} x2={W - padRight} y1={yFor(g)} y2={yFor(g)} stroke={GRID} strokeWidth="1" />
                <text x={2} y={yFor(g) - 2} fontSize="8" fill="rgba(88,221,255,0.5)">{g}</text>
              </g>
            ))}
            <line x1={padLeft} x2={W - padRight} y1={yFor(0)} y2={yFor(0)} stroke={AXIS} strokeWidth="1" />

            {data.map((t, i) => {
              const x = padLeft + i * slotW + (slotW - barW) / 2;
              const h = plotH - (yFor(t.riskScore) - padTop);
              const color = t.flagged
                ? (confirmedSet.has(t.id) ? STATUS_GOOD : STATUS_REVIEW)
                : STATUS_MUTED;
              const statusLabel = t.flagged
                ? (confirmedSet.has(t.id) ? '✓ Onaylandi' : '• Inceleme')
                : 'Normal';
              return (
                <g key={t.id}>
                  <path d={roundedTopBarPath(x, yFor(t.riskScore), barW, h, 4)} fill={color}
                    onMouseMove={(e) => show(e, [`Risk: ${t.riskScore}`, t.id, statusLabel, `${t.amount} TL`])}
                    onMouseLeave={hide} style={{ cursor: 'pointer' }} />
                  <text x={x + barW / 2} y={H - padBottom + 14} fontSize="7" textAnchor="middle" fill="rgba(88,221,255,0.5)">
                    {truncate(t.id, 6)}
                  </text>
                </g>
              );
            })}
          </svg>
          <Tooltip tip={tip} />
        </div>
      )}
    </ChartCard>
  );
}

function FraudTable({ data }) {
  const { t: translate } = useLang();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[14px] font-mono text-gold/70">
        <thead><tr className="text-gold/40 text-left"><th className="py-1 pr-3">{translate('tableTxnId')}</th><th className="py-1 pr-3">{translate('tableAmount')}</th><th className="py-1 pr-3">{translate('tableRiskScore')}</th><th className="py-1">{translate('tableStatus')}</th></tr></thead>
        <tbody>
          {data.map((row) => (
            <tr key={row.id} className="border-t border-gold/10">
              <td className="py-1 pr-3">{row.id}</td>
              <td className="py-1 pr-3">{row.amount} TL</td>
              <td className="py-1 pr-3">{row.riskScore}</td>
              <td className="py-1">{row.flagged ? '⚠ Isaretlendi' : '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3) QAOA resource-allocation result: value per candidate item, status-colored
//    by whether it was included in the budget-feasible optimal selection.
// ---------------------------------------------------------------------------
export function OptimizerChart({ items }) {
  const { containerRef, tip, show, hide } = useTooltip();
  const [showTable, setShowTable] = useState(false);
  const data = items || [];
  if (data.length === 0) return null;

  const H = 200;
  const padTop = 16, padBottom = 34, padLeft = 4, padRight = 4;
  const plotH = H - padTop - padBottom;
  const slotW = 56;
  const barW = 28;
  const W = padLeft + padRight + data.length * slotW;
  const maxVal = Math.max(1, ...data.map((it) => it.value));
  const yFor = (v) => padTop + plotH - (v / maxVal) * plotH;

  return (
    <ChartCard
      title="Kuantum Kaynak Tahsisi Optimizasyonu (QAOA)"
      subtitle="Cubuk yuksekligi kalemin degerini gosterir; secilenler butce kisiti icinde toplam degeri maksimize eden QAOA sonucudur."
      legend={<Legend items={[{ label: 'Secildi', color: STATUS_GOOD, icon: '✓' }, { label: 'Secilmedi', color: STATUS_MUTED }]} />}
      tableToggle
      showTable={showTable}
      onToggleTable={() => setShowTable((v) => !v)}
    >
      {showTable ? (
        <OptimizerTable data={data} />
      ) : (
        <div ref={containerRef} className="relative overflow-x-auto">
          <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ minWidth: '100%' }}>
            {[0, 0.25, 0.5, 0.75, 1].map((f) => (
              <line key={f} x1={padLeft} x2={W - padRight} y1={yFor(f * maxVal)} y2={yFor(f * maxVal)} stroke={GRID} strokeWidth="1" />
            ))}
            <line x1={padLeft} x2={W - padRight} y1={yFor(0)} y2={yFor(0)} stroke={AXIS} strokeWidth="1" />

            {data.map((it, i) => {
              const x = padLeft + i * slotW + (slotW - barW) / 2;
              const h = plotH - (yFor(it.value) - padTop);
              const color = it.selected ? STATUS_GOOD : STATUS_MUTED;
              return (
                <g key={it.id}>
                  <path d={roundedTopBarPath(x, yFor(it.value), barW, h, 4)} fill={color}
                    onMouseMove={(e) => show(e, [`Deger: ${it.value}`, it.id, `Maliyet: %${it.cost}`, it.selected ? '✓ Secildi' : 'Secilmedi'])}
                    onMouseLeave={hide} style={{ cursor: 'pointer' }} />
                  <text x={x + barW / 2} y={yFor(it.value) - 4} fontSize="8" textAnchor="middle" fill="rgba(88,221,255,0.7)">{it.value}</text>
                  <text x={x + barW / 2} y={H - padBottom + 14} fontSize="8" textAnchor="middle" fill="rgba(88,221,255,0.5)">
                    {truncate(it.id, 8)}
                  </text>
                </g>
              );
            })}
          </svg>
          <Tooltip tip={tip} />
        </div>
      )}
    </ChartCard>
  );
}

function OptimizerTable({ data }) {
  const { t } = useLang();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[14px] font-mono text-gold/70">
        <thead><tr className="text-gold/40 text-left"><th className="py-1 pr-3">{t('tableItem')}</th><th className="py-1 pr-3">{t('tableValue')}</th><th className="py-1 pr-3">{t('tableCost')}</th><th className="py-1">{t('tableStatus')}</th></tr></thead>
        <tbody>
          {data.map((it) => (
            <tr key={it.id} className="border-t border-gold/10">
              <td className="py-1 pr-3">{it.id}</td>
              <td className="py-1 pr-3">{it.value}</td>
              <td className="py-1 pr-3">%{it.cost}</td>
              <td className="py-1">{it.selected ? '✓ Secildi' : '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function truncate(str, n) {
  if (!str) return '';
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}
