import { describe, it, expect } from 'vitest';
import { fundamentalMetrics } from '../engines/fundamentals.js';
import { multiples, valuationDivergence } from '../engines/valuation.js';
import { fundamentalPriceDivergence } from '../engines/divergence.js';
import { accountingQuality, beneishMScore, BENEISH } from '../engines/accountingQuality.js';
import { classifyDisclosure, disclosureEvents, extractClaims } from '../engines/disclosure.js';
import { evaluateClaim, ClaimLedger } from '../engines/claimReality.js';

const stmt = (o = {}) => ({ revenue: 1000, cogs: 700, ebitda: 200, net_income: 100, cfo: 120, capex: -50, total_assets: 2000, receivables: 150, inventory: 120, cash: 100, debt: 500, shares_outstanding: 1e6, ppe: 600, depreciation: 60, sga: 90, current_assets: 700, securities: 20, current_liabilities: 400, lt_debt: 300, ...o });

describe('fundamentals', () => {
  it('ratios known answers; non-meaningful values are null (never 0)', () => {
    const r = fundamentalMetrics(stmt(), stmt({ revenue: 800, shares_outstanding: 0.9e6 }));
    expect(r.value.ebitdaMargin).toBeCloseTo(0.2, 12); expect(r.value.fcf).toBe(70); expect(r.value.netDebtToEbitda).toBeCloseTo(2, 12); expect(r.value.revenueGrowth).toBeCloseTo(0.25, 12); expect(r.value.dilution).toBeCloseTo(1e6 / 0.9e6 - 1, 12);
    const neg = fundamentalMetrics(stmt({ ebitda: -5, net_income: -3 }));
    expect(neg.value.netDebtToEbitda).toBeNull(); expect(neg.value.cfoToNetIncome).toBeNull();
  });
  it('missing statement fields are listed; status is INSUFFICIENT_OBSERVABILITY', () => {
    const r = fundamentalMetrics(stmt({ cfo: null }));
    expect(r.status).toBe('INSUFFICIENT_OBSERVABILITY'); expect(r.unobserved).toContain('statement.cfo'); expect(r.value.fcf).toBeNull();
  });
});

describe('valuation', () => {
  const peerSet = Array.from({ length: 8 }, (_, i) => ({ market_cap: 1000 + 40 * i, debt: 100, cash: 50, revenue: 500, ebitda: 100 + 3 * i, net_income: 60, equity: 400, fcf: 40 }));
  it('NOT_MEANINGFUL multiples are null; peer z uses robust log scale; needs >=5 peers', () => {
    const m = multiples({ market_cap: 1000, debt: 0, cash: 0, revenue: 500, ebitda: -10, net_income: 50, equity: -1, fcf: 10 });
    expect(m.ev_ebitda).toBeNull(); expect(m.pb).toBeNull(); expect(m.pe).toBeCloseTo(20, 12);
    const r = valuationDivergence({ target: { market_cap: 5000, debt: 100, cash: 50, revenue: 500, ebitda: 100, net_income: 60, equity: 400, fcf: 40 }, peers: peerSet });
    expect(r.value.rows.find((x) => x.multiple === 'ev_sales').peerRobustZ).toBeGreaterThan(5);
    const few = valuationDivergence({ target: { market_cap: 5000, debt: 100, cash: 50, revenue: 500, ebitda: 100, net_income: 60, equity: 400, fcf: 40 }, peers: peerSet.slice(0, 3) });
    expect(few.value.rows[0].peerRobustZ).toBeNull(); expect(few.status).toBe('INSUFFICIENT_DATA');
    expect(r.notes.join(' ')).toMatch(/never states a fair/);
  });
});

describe('fundamental-price divergence', () => {
  const peers = Array.from({ length: 9 }, (_, i) => ({ dLnMcap: 0.02 + 0.01 * (i % 3), dLnRevenue: 0.05 + 0.01 * (i % 4), dCfoOverAssets: 0.005 + 0.002 * (i % 3), dNetDebtOverAssets: 0.0 + 0.003 * (i % 3), dilution: 0.0 + 0.002 * (i % 2) }));
  it('big market-cap move with deteriorating fundamentals -> DIVERGENCE_SUSPECTED (vector output)', () => {
    const r = fundamentalPriceDivergence({ target: { dLnMcap: 1.2, dLnRevenue: -0.05, dCfoOverAssets: -0.05, dNetDebtOverAssets: 0.2, dilution: 0.3 }, peers, marketReturn: 0.05 });
    expect(r.status).toBe('SIGNAL'); expect(r.value.label).toBe('DIVERGENCE_SUSPECTED'); expect(r.value.robustZ.dLnMcap).toBeGreaterThan(3.5); expect(r.value.notSupportiveCount).toBeGreaterThanOrEqual(2);
  });
  it('big market-cap move WITH supportive fundamentals -> no divergence', () => {
    const r = fundamentalPriceDivergence({ target: { dLnMcap: 1.2, dLnRevenue: 0.9, dCfoOverAssets: 0.08, dNetDebtOverAssets: -0.1, dilution: 0 }, peers, marketReturn: 0.05 });
    expect(r.status).toBe('NO_SIGNAL');
  });
  it('unobserved fundamentals are NOT counted as unsupportive', () => {
    const r = fundamentalPriceDivergence({ target: { dLnMcap: 1.2, dLnRevenue: null, dCfoOverAssets: null, dNetDebtOverAssets: null, dilution: null }, peers, marketReturn: 0.05 });
    expect(r.status).toBe('INSUFFICIENT_OBSERVABILITY'); expect(r.unobserved).toContain('target.dLnRevenue');
    const one = fundamentalPriceDivergence({ target: { dLnMcap: 1.2, dLnRevenue: -0.2, dCfoOverAssets: null, dNetDebtOverAssets: null, dilution: null }, peers, marketReturn: 0.05 });
    expect(one.status).toBe('INSUFFICIENT_OBSERVABILITY');
  });
  it('peer-adjustment matters: a move equal to the peer median is not divergent', () => {
    const r = fundamentalPriceDivergence({ target: { dLnMcap: 0.03, dLnRevenue: -0.2, dCfoOverAssets: -0.1, dNetDebtOverAssets: 0.3, dilution: 0.2 }, peers, marketReturn: 0.0 });
    expect(r.status).toBe('NO_SIGNAL');
  });
});

describe('accounting quality', () => {
  const cur = stmt(); const pri = stmt({ revenue: 900, cogs: 620, receivables: 110, net_income: 90, cfo: 100, total_assets: 1800, sga: 80, ppe: 560, depreciation: 55, current_assets: 650, securities: 25, current_liabilities: 380, lt_debt: 280, inventory: 100, debt: 450, shares_outstanding: 0.95e6 });
  it('Beneish M-score equals the published linear combination of its eight indices', () => {
    const b = beneishMScore(cur, pri); expect(b.computable).toBe(true);
    const i = b.indices; const M = BENEISH.intercept + BENEISH.DSRI * i.DSRI + BENEISH.GMI * i.GMI + BENEISH.AQI * i.AQI + BENEISH.SGI * i.SGI + BENEISH.DEPI * i.DEPI + BENEISH.SGAI * i.SGAI + BENEISH.TATA * i.TATA + BENEISH.LVGI * i.LVGI;
    expect(b.M).toBeCloseTo(M, 12); expect(i.SGI).toBeCloseTo(1000 / 900, 12); expect(i.TATA).toBeCloseTo((100 - 120) / 2000, 12);
  });
  it('any missing component -> M-score UNOBSERVED (no neutral imputation) and flagged', () => {
    const b = beneishMScore({ ...cur, sga: null }, pri); expect(b.computable).toBe(false); expect(b.unobserved).toContain('t.sga');
    const r = accountingQuality({ current: { ...cur, sga: null }, prior: pri });
    expect(r.value.beneish.M).toBeNull(); expect(r.unobserved).toContain('beneish_m_score');
  });
  it('outputs indicators with an explicit not-fraud-evidence disclaimer; never a verdict', () => {
    const r = accountingQuality({ current: cur, prior: pri, marginHistory: Array.from({ length: 10 }, (_, i) => 0.19 + 0.002 * i), auditOpinion: 'QUALIFIED', relatedPartyRevenue: 300, oneOffIncome: 20 });
    expect(r.value.kind).toBe('ACCOUNTING_QUALITY_INDICATORS'); expect(r.value.disclaimer).toMatch(/not evidence of fraud|No model/i); expect(r.value.indicators.auditOpinion).toBe('QUALIFIED');
    expect(r.value.indicators.relatedPartyRevenueShare).toBeCloseTo(0.3, 12); expect(JSON.stringify(r)).not.toMatch(/"fraud":/);
    expect(r.value.beneish.calibration).toBe('UNCALIBRATED_FOR_BIST');
  });
});

describe('disclosure intelligence', () => {
  it('types Turkish disclosures; unmatched is UNCLASSIFIED (not benign)', () => {
    const t = (title) => classifyDisclosure({ id: 'x', company: 'C', published_time: '2026-01-10T08:00:00Z', title }).events.map((e) => e.type);
    expect(t('Yeni tesis yatırımı ve kapasite artırımı hakkında')).toEqual(expect.arrayContaining(['INVESTMENT', 'CAPACITY_INCREASE']));
    expect(t('Bedelli sermaye artırımı kararı')).toContain('CAPITAL_INCREASE');
    expect(t('Bağımsız denetim kuruluşu değişikliği')).toContain('AUDITOR_CHANGE');
    expect(t('Proje iptal edilmiştir')).toContain('PROJECT_CANCELLED');
    expect(classifyDisclosure({ id: 'y', title: 'Genel kurul toplantı tutanağı', published_time: '2026-01-10T08:00:00Z' }).unclassified).toBe(true);
  });
  it('PIT: disclosures published after asOf are excluded', () => {
    const d = [{ id: '1', company: 'C', published_time: '2026-01-10T00:00:00Z', title: 'Sözleşme imzalandı' }, { id: '2', company: 'C', published_time: '2026-03-10T00:00:00Z', title: 'Sözleşme imzalandı' }];
    const r = disclosureEvents(d, '2026-02-01T00:00:00Z');
    expect(r.value.rows).toHaveLength(1); expect(r.coverage.fraction).toBe(0.5);
  });
  it('extracts claims with deadlines (Q3, 3. çeyrek, yıl sonu); no deadline -> null; always needs human review', () => {
    const base = { id: 'd', company: 'C', published_time: '2026-02-01T09:00:00Z' };
    expect(extractClaims({ ...base, title: 'Yeni tesis Q3 2026 itibarıyla devreye alınacaktır, yatırım' })[0].deadline).toBe('2026-09-30T23:59:59Z');
    expect(extractClaims({ ...base, title: 'Fabrika 4. çeyrekte işletmeye açılacak' })[0].deadline).toBe('2026-12-31T23:59:59Z');
    expect(extractClaims({ ...base, title: 'Kapasite artırımı 2027 yılı sonuna kadar' })[0].deadline).toBe('2027-12-31T23:59:59Z');
    const c = extractClaims({ ...base, title: 'Yeni tesis yatırımı yapılacak' }); expect(c[0].deadline).toBeNull(); expect(c[0].requiresHumanReview).toBe(true);
    expect(extractClaims({ ...base, title: 'Genel kurul' })).toEqual([]);
  });
});

describe('claim vs reality', () => {
  const claim = { claim_id: 'c1', company: 'C', stated_time: '2026-02-01T00:00:00Z', type: 'FACILITY_OPENING', deadline: '2026-09-30T23:59:59Z' };
  const ev = (o) => ({ id: 'e1', kind: 'CONFIRMS', event_time: '2026-09-01T00:00:00Z', published_time: '2026-09-02T00:00:00Z', available_time: '2026-09-02T00:00:00Z', source: 'official:kap', tier: 'OFFICIAL_REGULATOR', ...o });
  const v = (evidence, asOf, cov) => evaluateClaim(claim, evidence, asOf, cov ? { sourceCoverage: cov } : undefined).value;
  it('CONFIRMED / DELAYED / PARTIALLY_CONFIRMED / CONTRADICTED each carry evidence ids and a rule', () => {
    expect(v([ev()], '2026-10-15T00:00:00Z')).toMatchObject({ verdict: 'CONFIRMED', evidence_ids: ['e1'], rule: 'CONFIRMED_ON_OR_BEFORE_DEADLINE' });
    const late = v([ev({ event_time: '2026-11-10T00:00:00Z', published_time: '2026-11-11T00:00:00Z', available_time: '2026-11-11T00:00:00Z' })], '2026-12-01T00:00:00Z');
    expect(late.verdict).toBe('DELAYED'); expect(late.delayDays).toBeGreaterThan(30);
    expect(v([ev({ realizedFraction: 0.4 })], '2026-10-15T00:00:00Z')).toMatchObject({ verdict: 'PARTIALLY_CONFIRMED', realizedFraction: 0.4 });
    expect(v([ev({ kind: 'CONTRADICTS' })], '2026-10-15T00:00:00Z').verdict).toBe('CONTRADICTED');
  });
  it('NOT_CONFIRMED only with adequate source coverage; otherwise INSUFFICIENT_EVIDENCE; before deadline = PENDING', () => {
    expect(v([], '2026-12-01T00:00:00Z', { adequate: true, sourcesChecked: ['official:kap', 'company:ir'] }).verdict).toBe('NOT_CONFIRMED');
    expect(v([], '2026-12-01T00:00:00Z', { adequate: false, sourcesChecked: [] })).toMatchObject({ verdict: 'INSUFFICIENT_EVIDENCE', rule: 'INADEQUATE_SOURCE_COVERAGE' });
    expect(v([], '2026-06-01T00:00:00Z')).toMatchObject({ verdict: 'INSUFFICIENT_EVIDENCE', phase: 'PENDING', rule: 'DEADLINE_NOT_REACHED' });
  });
  it('look-ahead firewall: evidence not yet available at asOf is ignored and counted', () => {
    const r = v([ev({ available_time: '2026-10-20T00:00:00Z' })], '2026-10-01T00:00:00Z', { adequate: true, sourcesChecked: ['kap'] });
    expect(r.verdict).toBe('NOT_CONFIRMED'); expect(r.evidenceExcludedByFirewall).toBe(1);
  });
  it('a later contradiction overrides an earlier confirmation; a later confirmation overrides a contradiction', () => {
    const c1 = ev({ id: 'a', event_time: '2026-08-01T00:00:00Z' }); const x = ev({ id: 'b', kind: 'CONTRADICTS', event_time: '2026-09-10T00:00:00Z' });
    expect(v([c1, x], '2026-10-15T00:00:00Z').verdict).toBe('CONTRADICTED');
    const c2 = ev({ id: 'c', event_time: '2026-09-20T00:00:00Z' }); expect(v([c1, x, c2], '2026-10-15T00:00:00Z').verdict).toBe('CONFIRMED');
  });
  it('corroboration counts independent sources', () => {
    const r = v([ev({ id: 'a' }), ev({ id: 'b', source: 'company:ir', tier: 'COMPANY_IR' })], '2026-10-15T00:00:00Z');
    expect(r.corroboration).toEqual({ independentSources: 1, hasPrimary: true }); // only the first full-confirmation evidence is the decisive one
  });
  it('claim ledger never forgets claims and respects as-of', () => {
    const l = new ClaimLedger(); l.register(claim);
    expect(l.list('2026-01-01T00:00:00Z')).toHaveLength(0); expect(l.list('2026-03-01T00:00:00Z')).toHaveLength(1);
    expect(l.evaluateAll({}, '2026-03-01T00:00:00Z')[0].value.verdict).toBe('INSUFFICIENT_EVIDENCE');
  });
});
