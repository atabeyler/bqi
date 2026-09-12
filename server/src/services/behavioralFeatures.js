/**
 * Derives behavioral AML features from chronological transaction history.
 * All features are computed only from the current/prior rows for an account,
 * avoiding future-data leakage. If account/timestamp/counterparty fields are
 * unavailable, the original transaction is returned unchanged.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function finite(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function enrichBehavioralFeatures(transactions) {
  if (!Array.isArray(transactions) || transactions.length === 0) return transactions || [];

  const prepared = transactions.map((t, index) => ({
    ...t,
    __index: index,
    __ts: t.timestamp ? new Date(t.timestamp).getTime() : NaN,
  }));

  const byAccount = new Map();
  for (const t of prepared) {
    if (!t.account || !Number.isFinite(t.__ts)) continue;
    if (!byAccount.has(t.account)) byAccount.set(t.account, []);
    byAccount.get(t.account).push(t);
  }

  const enriched = prepared.map((t) => ({ ...t }));

  for (const history of byAccount.values()) {
    history.sort((a, b) => a.__ts - b.__ts || a.__index - b.__index);
    const seenCounterparties = new Set();
    const priorAmounts = [];

    for (let i = 0; i < history.length; i++) {
      const t = history[i];
      const target = enriched[t.__index];
      const prior = history.slice(0, i);
      const in10m = prior.filter((p) => t.__ts - p.__ts <= 10 * 60 * 1000);
      const in1h = prior.filter((p) => t.__ts - p.__ts <= HOUR);
      const in24h = prior.filter((p) => t.__ts - p.__ts <= DAY);
      const in7d = prior.filter((p) => t.__ts - p.__ts <= 7 * DAY);

      target.txCount10m = in10m.length + 1;
      target.txCount1h = in1h.length + 1;
      target.amountSum1h = in1h.reduce((s, p) => s + finite(p.amount), 0) + finite(t.amount);
      target.amountSum24h = in24h.reduce((s, p) => s + finite(p.amount), 0) + finite(t.amount);
      target.timeSinceLastTx = i ? Math.max(0, (t.__ts - history[i - 1].__ts) / 1000) : 86400;

      const cp24 = new Set(in24h.map((p) => p.counterparty).filter(Boolean));
      const cp7 = new Set(in7d.map((p) => p.counterparty).filter(Boolean));
      target.newCounterpartyCount24h = cp24.size + (t.counterparty && !cp24.has(t.counterparty) ? 1 : 0);
      target.uniqueCounterparty7d = cp7.size + (t.counterparty && !cp7.has(t.counterparty) ? 1 : 0);

      if (priorAmounts.length >= 3) {
        const mean = priorAmounts.reduce((a, b) => a + b, 0) / priorAmounts.length;
        const variance = priorAmounts.reduce((s, x) => s + (x - mean) ** 2, 0) / priorAmounts.length;
        const std = Math.sqrt(variance) || 1;
        target.amountDeviation = Math.abs((finite(t.amount) - mean) / std);
      } else {
        target.amountDeviation = 0;
      }

      if (t.counterparty) {
        target.newCounterparty = seenCounterparties.has(t.counterparty) ? 0 : 1;
        seenCounterparties.add(t.counterparty);
      }
      priorAmounts.push(finite(t.amount));
    }
  }

  return enriched.map(({ __index, __ts, ...t }) => t);
}
