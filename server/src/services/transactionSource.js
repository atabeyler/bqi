/** Pluggable transaction data-source layer for BDDK/BTK fraud analysis. */
import { normalizeHeader, findColumn, toBool01, toNumber, extractHour, readSheetRows } from './tableParsing.js';
import { enrichBehavioralFeatures } from './behavioralFeatures.js';

const MAX_ROWS = 3000;
const COLUMN_ALIASES = {
  amount: ['tutar', 'amount', 'miktar', 'tutar (tl)', 'işlem tutarı', 'islem tutari'],
  hour: ['saat', 'hour', 'saat (0-23)'],
  timestamp: ['tarih', 'date', 'zaman', 'timestamp', 'islem tarihi', 'işlem tarihi'],
  frequency: ['sıklık', 'siklik', 'frequency', 'adet', 'işlem sayısı', 'islem sayisi'],
  newCounterparty: ['yeni taraf', 'yeni taraf (0/1)', 'new counterparty', 'yeni_taraf'],
  crossBorder: ['sınır ötesi', 'sinir otesi', 'sınır ötesi (0/1)', 'cross border', 'yurtdışı', 'yurtdisi'],
  id: ['işlem id', 'islem id', 'id', 'txn', 'transaction id'],
  account: ['hesap', 'account', 'account id', 'account_id', 'from account', 'gönderen hesap', 'gonderen hesap'],
  counterparty: ['karşı hesap', 'karsi hesap', 'counterparty', 'counterparty id', 'to account', 'alıcı hesap', 'alici hesap'],
};
function findTxCol(headers, field) { return findColumn(headers, COLUMN_ALIASES[field]); }

export function parseTransactionFile(buffer, filename) {
  const name = (filename || '').toLowerCase();
  if (!/\.(csv|xlsx|xls)$/.test(name)) return null;
  let rows;
  try { rows = readSheetRows(buffer); } catch { return null; }
  if (!rows.length) return null;

  const headers = rows[0].map(normalizeHeader);
  const allDataRows = rows.slice(1).filter((r) => r.some((c) => String(c).trim() !== ''));
  const dataRows = allDataRows.slice(0, MAX_ROWS);
  if (!dataRows.length) return null;

  const idCol = findTxCol(headers, 'id');
  const amountCol = findTxCol(headers, 'amount');
  const hourCol = findTxCol(headers, 'hour');
  const timestampCol = findTxCol(headers, 'timestamp');
  const freqCol = findTxCol(headers, 'frequency');
  const newCounterpartyCol = findTxCol(headers, 'newCounterparty');
  const crossBorderCol = findTxCol(headers, 'crossBorder');
  const accountCol = findTxCol(headers, 'account');
  const counterpartyCol = findTxCol(headers, 'counterparty');
  if (amountCol === -1 || (hourCol === -1 && timestampCol === -1)) return null;

  const warnings = [];
  if (freqCol === -1) warnings.push('Sıklık sütunu bulunamadı — varsayılan 1 kullanıldı.');
  if (newCounterpartyCol === -1 && counterpartyCol === -1) warnings.push('Yeni Taraf/karşı hesap bilgisi bulunamadı — varsayılan 0 kullanıldı.');
  if (crossBorderCol === -1) warnings.push('Sınır Ötesi sütunu bulunamadı — varsayılan 0 kullanıldı.');
  if (accountCol === -1 || timestampCol === -1) warnings.push('Hesap + zaman bilgisi eksik — davranışsal zaman-penceresi özellikleri hesaplanamadı; mevcut özelliklerle devam edildi.');
  if (allDataRows.length > MAX_ROWS) warnings.push(`Dosyada ${allDataRows.length} kayıt var, ilk ${MAX_ROWS} kayıt işlendi.`);

  const transactions = dataRows.map((row, i) => ({
    id: idCol !== -1 && row[idCol] ? String(row[idCol]) : `TXN-${i + 1}`,
    amount: toNumber(row[amountCol]),
    hour: hourCol !== -1 ? toNumber(row[hourCol]) : extractHour(row[timestampCol]),
    frequency: freqCol !== -1 ? toNumber(row[freqCol]) : 1,
    newCounterparty: newCounterpartyCol !== -1 ? toBool01(row[newCounterpartyCol]) : 0,
    crossBorder: crossBorderCol !== -1 ? toBool01(row[crossBorderCol]) : 0,
    ...(timestampCol !== -1 && row[timestampCol] ? { timestamp: String(row[timestampCol]) } : {}),
    ...(accountCol !== -1 && row[accountCol] ? { account: String(row[accountCol]) } : {}),
    ...(counterpartyCol !== -1 && row[counterpartyCol] ? { counterparty: String(row[counterpartyCol]) } : {}),
  }));

  return { transactions: enrichBehavioralFeatures(transactions), warnings };
}
