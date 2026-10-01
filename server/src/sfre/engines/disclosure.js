import { makeResult, STATUS, CALIBRATION, coverageOf } from '../core/result.js';
import { parseTime } from '../data/observation.js';
import { hashOf } from '../core/canonical.js';

const ENGINE = 'disclosure';
export const RULESET_VERSION = 'DISC-RULES-1.0.0';

// Interpretable rule table (Turkish + English). Precision/recall of these rules is UNMEASURED -> UNCALIBRATED.
export const RULES = Object.freeze([
  { id: 'R-CONTRACT', type: 'CONTRACT', re: /(sözleşme|anlaşma|sipariş|ihale)|\bcontract\b|order received/ },
  { id: 'R-INVESTMENT', type: 'INVESTMENT', re: /yatırım|investment|\bcapex\b/ },
  { id: 'R-CAPACITY', type: 'CAPACITY_INCREASE', re: /kapasite\s*art|capacity (increase|expansion)/ },
  { id: 'R-CAPITAL', type: 'CAPITAL_INCREASE', re: /sermaye\s*art|bedelli|bedelsiz|rights issue|capital increase/ },
  { id: 'R-SHAREHOLDER-SALE', type: 'SHAREHOLDER_SALE', re: /(ortak|pay sahib|hakim).*(satış|sattı|satıl|devir)|pay satış|hisse satış|block sale|shares sold/ },
  { id: 'R-AUDITOR', type: 'AUDITOR_CHANGE', re: /bağımsız denetim.*(değiş|atan|görev)|denetçi.*değişikli|auditor (change|appoint)/ },
  { id: 'R-MGMT', type: 'MANAGEMENT_CHANGE', re: /(genel müdür|yönetim kurulu|ceo|cfo|başkan).*(istifa|atan|değiş|görevden)|\bresign|\bappointed\b/ },
  { id: 'R-CANCEL', type: 'PROJECT_CANCELLED', re: /iptal|vazgeç|\bcancel/ },
  { id: 'R-POSTPONE', type: 'PROJECT_POSTPONED', re: /ertelen|erteleme|ötele|\bpostpone|\bdelayed?\b/ },
  { id: 'R-FACILITY', type: 'FACILITY_OPENING', re: /(tesis|fabrika|santral|hat).*(açıl|devreye|işletmeye|faaliyete)|\bcommission|plant.*(open|start)/ },
]);

const norm = (s) => String(s || '').toLocaleLowerCase('tr-TR');

export function classifyDisclosure(d) {
  const text = norm(`${d.title || ''} ${d.body || ''}`).slice(0, 20000); // bound regex work (ReDoS hardening)
  const matches = RULES.filter((r) => r.re.test(text)).map((r) => ({ rule: r.id, type: r.type }));
  return { id: d.id, company: d.company, published_time: d.published_time, events: matches, unclassified: matches.length === 0 };
}

export function disclosureEvents(disclosures, asOf) {
  const t = parseTime(asOf);
  const visible = disclosures.filter((d) => parseTime(d.published_time) <= t); // PIT: published at/before asOf
  const rows = visible.map(classifyDisclosure);
  return makeResult({
    engine: ENGINE, modelId: 'M40.disclosure_rules', status: STATUS.UNCALIBRATED, value: { rows, rulesetVersion: RULESET_VERSION },
    coverage: coverageOf(visible.length, disclosures.length), calibration: CALIBRATION.UNCALIBRATED, parameters: { rulesetVersion: RULESET_VERSION },
    inputHashes: visible.map((d) => hashOf(d)),
    notes: ['rule-based typing; UNCLASSIFIED does not mean benign', visible.length < disclosures.length ? `${disclosures.length - visible.length} disclosures published after asOf were excluded` : ''].filter(Boolean),
  });
}

const ORD = { birinci: 1, ikinci: 2, 'üçüncü': 3, 'dördüncü': 4 };
function quarterEnd(year, q) { return new Date(Date.UTC(year, q * 3, 1) - 1).toISOString().replace(/\.\d{3}Z$/, 'Z'); }

/** Heuristic claim extractor (Turkish). Always flagged requiresHumanReview; UNCALIBRATED. */
export function extractClaims(d) {
  const cls = classifyDisclosure(d);
  const claimTypes = cls.events.filter((e) => ['FACILITY_OPENING', 'CAPACITY_INCREASE', 'INVESTMENT', 'CONTRACT'].includes(e.type));
  if (!claimTypes.length) return [];
  const text = norm(`${d.title || ''} ${d.body || ''}`).slice(0, 20000);
  const year = new Date(d.published_time).getUTCFullYear();
  let deadline = null; let basis = null; let m;
  if ((m = text.match(/\bq([1-4])\b(?:\s*['’]?\s*(20\d\d))?/))) { deadline = quarterEnd(m[2] ? +m[2] : year, +m[1]); basis = m[0]; }
  else if ((m = text.match(/([1-4])\.\s*çeyrek/))) { deadline = quarterEnd(year, +m[1]); basis = m[0]; }
  else if ((m = text.match(/(birinci|ikinci|üçüncü|dördüncü)\s+çeyrek/))) { deadline = quarterEnd(year, ORD[m[1]]); basis = m[0]; }
  else if ((m = text.match(/(20\d\d)\s*(yılı\s*)?(sonu|sonuna)/))) { deadline = `${m[1]}-12-31T23:59:59Z`; basis = m[0]; }
  return claimTypes.map((e) => ({
    claim_id: `claim_${hashOf({ id: d.id, type: e.type }).slice(0, 16)}`, company: d.company, stated_time: d.published_time, type: e.type,
    deadline, deadline_basis: basis, source_disclosure: d.id, rule: e.rule, requiresHumanReview: true,
  }));
}
