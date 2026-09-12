import { describe, expect, it } from 'vitest';
import { repairLegacyText } from './textRepair.js';

describe('repairLegacyText', () => {
  it('reverses UTF-8-bytes-read-as-Latin-1 mojibake for the known Turkish letter pairs', () => {
    expect(repairLegacyText('gÃ¼venlik senaryosu')).toBe('güvenlik senaryosu');
    expect(repairLegacyText('Ã–ZEL')).toBe('ÖZEL');
  });

  it('reverses Windows-1254-read-as-Latin-1 corruption for all six affected letters', () => {
    expect(repairLegacyText('kaýýt')).toBe('kaııt');
    expect(repairLegacyText('baþladý')).toBe('başladı');
  });

  it('leaves already-correct Turkish text untouched', () => {
    expect(repairLegacyText('Görüntülü toplantı başlatıldı')).toBe('Görüntülü toplantı başlatıldı');
  });

  it('reconstructs the known replacement-character-corrupted legacy phrases', () => {
    expect(repairLegacyText('G�r�nt�l� toplant� ba�lat�ld�')).toBe('Görüntülü toplantı başlatıldı');
  });

  it('reconstructs known ASCII-stripped legacy phrases without a shorter pattern shadowing a longer one', () => {
    expect(repairLegacyText('goruntulu toplantiyi baslatildi')).toBe('görüntülü toplantıyı başlatıldı');
    expect(repairLegacyText('toplantiya katilabilirsiniz')).toBe('toplantıya katılabilirsiniz');
  });

  it('handles null/undefined without throwing', () => {
    expect(repairLegacyText(null)).toBe('');
    expect(repairLegacyText(undefined)).toBe('');
  });
});
