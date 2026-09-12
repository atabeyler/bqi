// BCI Smart Fuzz's real, bounded, categorized safe-payload catalog. Every
// value here is a fixed BCI-controlled string -- an AI strategy proposal
// (server-side, BQI's own AI infra) may PRIORITIZE which categories
// to spend the probe budget on, but it can never inject an arbitrary
// payload of its own: only a `categoryId` from this list is ever accepted
// (see httpFuzz.js's `selectCases`), so the actual bytes sent to a real
// target always come from here, reviewed and bounded, never from a model.
// All values are GET-safe (no CRLF, no shell metacharacters that could
// break the curl argv) -- this remains SAFE_ACTIVE, observational input
// robustness, not exploitation.
export const FUZZ_CATEGORIES = Object.freeze([
  { id: 'BOUNDARY_EMPTY', value: '', appliesTo: ['generic'] },
  { id: 'BOUNDARY_PERCENT', value: 'BCI_%25_TEST', appliesTo: ['generic'] },
  { id: 'INTEGER_NEGATIVE', value: '-1', appliesTo: ['generic', 'integer'] },
  { id: 'INTEGER_ZERO', value: '0', appliesTo: ['integer'] },
  { id: 'INTEGER_OVERFLOW', value: '2147483648', appliesTo: ['integer'] },
  { id: 'INTEGER_LARGE', value: '999999999', appliesTo: ['integer'] },
  { id: 'STRING_LONG', value: 'A'.repeat(2000), appliesTo: ['generic', 'string'] },
  { id: 'STRING_UNICODE', value: 'ФуЗЗ_テスト', appliesTo: ['generic', 'string'] },
  { id: 'SPECIAL_CHARS', value: `'"<>;()${'{}'}`, appliesTo: ['generic', 'string'] },
  { id: 'PATH_TRAVERSAL_MARKER', value: '../../../../etc/passwd', appliesTo: ['generic', 'string'] },
  { id: 'SQLI_MARKER', value: "' OR '1'='1", appliesTo: ['generic', 'string'] },
  { id: 'XSS_MARKER', value: '<script>bci_fuzz_marker</script>', appliesTo: ['generic', 'string'], reflectionMarker: 'bci_fuzz_marker' },
  { id: 'NULL_LITERAL', value: 'null', appliesTo: ['generic'] },
]);

export function getCategory(id) {
  return FUZZ_CATEGORIES.find((c) => c.id === id) || null;
}

// BCI's own minimum BASE coverage guarantee (per real discovered
// parameter): AI adaptive rounds may only ever ADD on top of this, never
// substitute for or shrink it (httpFuzz.js's buildBasePlan enforces the
// actual count; see engines.activeScan.test.js's regression check that
// defaultCategoriesFor() never drops below this for any real param type).
export const BASE_MIN_TESTS_PER_PARAMETER = 8;

// Every category id BCI is willing to execute at all -- an AI-proposed
// plan (or any external caller) that names anything outside this set is
// rejected wholesale rather than silently dropped (see httpFuzz.js).
export const FUZZ_CATEGORY_IDS = FUZZ_CATEGORIES.map((c) => c.id);

// Real, deterministic default selection when no plan (AI-proposed or
// otherwise) is supplied: every 'generic' category, plus the integer-only
// ones when the parameter looks numeric. This alone is already strictly
// broader per-parameter than the old fixed 8-case list, and it is applied
// PER discovered parameter (see httpFuzz.js's `buildDefaultPlan`), not
// once globally -- a target with 5 real parameters gets a genuinely
// different, larger probe set than one with 1.
export function defaultCategoriesFor(paramType) {
  const generic = FUZZ_CATEGORIES.filter((c) => c.appliesTo.includes('generic')).map((c) => c.id);
  if (paramType === 'integer' || paramType === 'number') {
    const numeric = FUZZ_CATEGORIES.filter((c) => c.appliesTo.includes('integer')).map((c) => c.id);
    return [...new Set([...numeric, ...generic])];
  }
  return generic;
}
