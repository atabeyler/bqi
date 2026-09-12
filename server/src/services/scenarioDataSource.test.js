import { describe, it, expect } from 'vitest';
import { parseScenarioFile, parseOptimizationFile } from './scenarioDataSource.js';

function csv(text) {
  return Buffer.from(text, 'utf-8');
}

describe('parseScenarioFile', () => {
  it('returns null for a non-CSV/XLSX filename', () => {
    expect(parseScenarioFile(csv('x'), 'report.pdf')).toBeNull();
  });

  it('returns null when Senaryo/Olasilik columns are missing', () => {
    const buf = csv('Tutar,Saat\n100,5\n200,6\n');
    expect(parseScenarioFile(buf, 'data.csv')).toBeNull();
  });

  it('parses a scenario CSV with all columns', () => {
    const buf = csv(
      'Senaryo,Olasilik,Zaman Ufku,Tetikleyici\n' +
      'Fiyat artar,35,0-6 ay,Talep artisi\n' +
      'Fiyat sabit,40,0-6 ay,Piyasa durgunlugu\n' +
      'Fiyat duser,25,0-6 ay,Rekabet\n'
    );
    const result = parseScenarioFile(buf, 'senaryolar.csv');
    expect(result).not.toBeNull();
    expect(result.scenarios).toHaveLength(3);
    expect(result.scenarios[0]).toEqual({
      id: 'SRC-1', title: 'Fiyat artar', probability: '%35', timeframe: '0-6 ay', trigger: 'Talep artisi',
    });
    expect(result.warnings).toEqual([]);
  });

  it('warns when optional columns are absent', () => {
    const buf = csv('Senaryo,Olasilik\nA,50\nB,50\n');
    const result = parseScenarioFile(buf, 'basit.csv');
    expect(result).not.toBeNull();
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe('parseOptimizationFile', () => {
  it('returns null when Kalem/Deger/Maliyet columns are missing', () => {
    const buf = csv('Senaryo,Olasilik\nA,50\nB,50\n');
    expect(parseOptimizationFile(buf, 'data.csv')).toBeNull();
  });

  it('parses an optimization CSV with an explicit budget column', () => {
    const buf = csv(
      'Kalem,Deger,Maliyet,Butce\n' +
      'Proje-A,35,30,60\n' +
      'Proje-B,28,25,60\n'
    );
    const result = parseOptimizationFile(buf, 'kalemler.csv');
    expect(result).not.toBeNull();
    expect(result.budgetPercent).toBe(60);
    expect(result.items).toEqual([
      { id: 'Proje-A', value: 35, cost: 30 },
      { id: 'Proje-B', value: 28, cost: 25 },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('defaults the budget to 60% and warns when no budget column exists', () => {
    const buf = csv('Kalem,Deger,Maliyet\nA,10,20\nB,15,25\n');
    const result = parseOptimizationFile(buf, 'basit.csv');
    expect(result).not.toBeNull();
    expect(result.budgetPercent).toBe(60);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
