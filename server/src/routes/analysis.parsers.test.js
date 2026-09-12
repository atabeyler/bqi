import { describe, it, expect } from 'vitest';
import { toNumber, parseScenarios, parseTransactions, parseOptimizationProblem } from '../services/analysisParsers.js';

describe('toNumber', () => {
  it('parses plain integers and decimals', () => {
    expect(toNumber('35')).toBe(35);
    expect(toNumber('0.5')).toBe(0.5);
  });

  it('parses Turkish-formatted amounts ("." thousands, "," decimal)', () => {
    expect(toNumber('15.000,50')).toBe(15000.5);
    expect(toNumber('125.500,75 TL')).toBe(125500.75);
  });

  it('parses a bare Turkish decimal comma without a thousands separator', () => {
    expect(toNumber('60,5')).toBe(60.5);
  });

  it('treats a pure digit-grouped amount as thousands, not a decimal', () => {
    expect(toNumber('15.000')).toBe(15000);
    expect(toNumber('1.234.567')).toBe(1234567);
  });

  it('returns 0 for unparseable input', () => {
    expect(toNumber('')).toBe(0);
    expect(toNumber('—')).toBe(0);
    expect(toNumber(undefined)).toBe(0);
  });
});

describe('parseScenarios', () => {
  it('returns null when the matrix heading is missing', () => {
    expect(parseScenarios('no matrix here')).toBeNull();
  });

  it('parses scenario rows out of the quantum probability matrix table', () => {
    const content = `## KUANTUM OLASILIK MATRİSİ
| Senaryo | Olasılık | Zaman | Tetikleyici |
|---|---|---|---|
| SENARYO A (Birincil) | %42 | 6 ay | Örnek tetikleyici |
| SENARYO B | %31 | 12 ay | Diğer tetikleyici |
`;
    const scenarios = parseScenarios(content);
    expect(scenarios).toHaveLength(2);
    expect(scenarios[0]).toMatchObject({ title: 'SENARYO A (Birincil)', probability: '%42', timeframe: '6 ay' });
    expect(scenarios[1].title).toBe('SENARYO B');
  });

  it('parses scenario rows even when the AI wraps the title cell in markdown bold', () => {
    // Regression test: a real Gemini response wrapped the scenario cell as
    // "| **SENARYO-A (Birincil):** ... |", which a plain
    // startsWith('| SENARYO') check missed entirely -- silently dropping
    // every scenario and disabling quantum computation for the whole
    // report, with the client never told why.
    const content = `## KUANTUM OLASILIK MATRİSİ
| Senaryo | Olasılık | Zaman | Tetikleyici |
|---|---|---|---|
| **SENARYO-A (Birincil):** Kontrollü Dezenflasyon | %65 | 0-12 ay | Sıkı para politikası |
| **SENARYO-B (Alternatif):** Jeopolitik Şok | %25 | 6-24 ay | Enerji kesintisi |
`;
    const scenarios = parseScenarios(content);
    expect(scenarios).toHaveLength(2);
    expect(scenarios[0].title).toBe('SENARYO-A (Birincil): Kontrollü Dezenflasyon');
    expect(scenarios[0].title).not.toContain('*');
    expect(scenarios[1].probability).toBe('%25');
  });
});

describe('parseTransactions', () => {
  it('returns null when the transaction table heading is missing', () => {
    expect(parseTransactions('no table here')).toBeNull();
  });

  it('parses transaction rows with Turkish-formatted amounts', () => {
    const content = `## İŞLEM KAYITLARI
| ID | Tutar | Saat | Sıklık | Yeni Taraf | Sınır Ötesi |
|---|---|---|---|---|---|
| TXN-001 | 15.000,50 | 3 | 4 | 1 | 0 |
| TXN-002 | 250 | 14 | 1 | 0 | 1 |
`;
    const transactions = parseTransactions(content);
    expect(transactions).toHaveLength(2);
    expect(transactions[0]).toMatchObject({ id: 'TXN-001', amount: 15000.5, hour: 3, frequency: 4, newCounterparty: 1, crossBorder: 0 });
    expect(transactions[1].amount).toBe(250);
  });

  it('parses transaction rows even when the AI wraps the id cell in markdown bold', () => {
    const content = `## İŞLEM KAYITLARI
| ID | Tutar | Saat | Sıklık | Yeni Taraf | Sınır Ötesi |
|---|---|---|---|---|---|
| **TXN-001** | 500 | 3 | 4 | 1 | 0 |
`;
    const transactions = parseTransactions(content);
    expect(transactions).toHaveLength(1);
    expect(transactions[0].id).toBe('TXN-001');
  });
});

describe('parseOptimizationProblem', () => {
  it('returns null when the heading is missing', () => {
    expect(parseOptimizationProblem('no problem section here')).toBeNull();
  });

  it('finds the heading despite the Turkish dotted İ, not just ASCII I', () => {
    // Regression test: this previously matched literal ASCII "OPTIMIZASYON",
    // but the AI's actual uppercase Turkish text uses İ (U+0130) at both
    // internal positions, and İ is not case-fold-equivalent to ASCII I/i in
    // Unicode -- so the heading never matched and this parser always
    // returned null in production, confirmed against a live report.
    const content = `## OPTİMİZASYON PROBLEMİ
Bütçe: %60
| Kalem | Değer | Maliyet |
|---|---|---|
| A | 35 | 30 |
| B | 28 | 25 |
`;
    const problem = parseOptimizationProblem(content);
    expect(problem).not.toBeNull();
    expect(problem.budgetPercent).toBe(60);
    expect(problem.items).toHaveLength(2);
  });

  it('picks the percentage next to "bütçe" rather than an unrelated one', () => {
    const content = `## OPTİMİZASYON PROBLEMİ
Hedef: %80 verimlilik ile %60 bütçe kısıtı altında en yüksek değeri seç.
| Kalem | Değer | Maliyet |
|---|---|---|
| A | 35 | 30 |
| B | 28 | 25 |
`;
    const problem = parseOptimizationProblem(content);
    expect(problem.budgetPercent).toBe(60);
    expect(problem.items).toEqual([
      { id: 'A', value: 35, cost: 30 },
      { id: 'B', value: 28, cost: 25 },
    ]);
  });

  it('parses Turkish-formatted item values and costs', () => {
    const content = `## OPTİMİZASYON PROBLEMİ
Bütçe: %60
| Kalem | Değer | Maliyet |
|---|---|---|
| A | 1.500 | 30 |
| B | 28 | 25 |
`;
    const problem = parseOptimizationProblem(content);
    expect(problem.items[0]).toEqual({ id: 'A', value: 1500, cost: 30 });
  });

  it('strips markdown bold from item ids instead of leaving literal asterisks', () => {
    const content = `## OPTİMİZASYON PROBLEMİ
Bütçe: %60
| Kalem | Değer | Maliyet |
|---|---|---|
| **Proje-1: Siber Güvenlik** | 90 | 20 |
| Proje-2 | 70 | 15 |
`;
    const problem = parseOptimizationProblem(content);
    expect(problem.items[0].id).toBe('Proje-1: Siber Güvenlik');
  });
});
