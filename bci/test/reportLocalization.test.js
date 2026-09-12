import { describe, expect, it } from 'vitest';
import { addLocalizedPresentation } from '../src/services/reports.js';

describe('report presentation localization', () => {
  it.each(['en', 'tr', 'fr', 'de', 'ar'])('produces localized metadata for every report type in %s', (language) => {
    for (const reportType of ['EXECUTIVE', 'TECHNICAL', 'REMEDIATION', 'AUDIT', 'FULL']) {
      const technical = { content_hash: 'a'.repeat(64), engine_id: 'nuclei' };
      const content = addLocalizedPresentation(reportType, technical, language);
      expect(content.language).toBe(language);
      expect(content.presentation.title).toBeTruthy();
      expect(content.presentation.description).toBeTruthy();
      expect(content.content_hash).toBe(technical.content_hash);
      expect(content.engine_id).toBe('nuclei');
    }
  });
});
