import { describe, expect, it } from 'vitest';
import {
  annotateFraudConfirmation,
  buildFraudSecondaryReviewSection,
  classifyFraudConfirmation,
  splitFraudConfirmation,
  summarizeFraudConfirmation,
} from './fraudSecondaryFilter.js';

describe('fraudSecondaryFilter', () => {
  it('marks strong cases as confirmed and borderline cases as review', () => {
    expect(classifyFraudConfirmation({
      classicalScore: 70,
      riskScore: 80,
      amount: 20000,
      frequency: 5,
      newCounterparty: 1,
    })).toMatchObject({ reviewTier: 'confirmed' });

    expect(classifyFraudConfirmation({
      riskScore: 45,
      amount: 1200,
      frequency: 1,
      classicalScore: 20,
      newCounterparty: 0,
    })).toMatchObject({ reviewTier: 'review' });
  });

  it('annotates and splits transactions without mutating the originals', () => {
    const input = [
      { id: 'A', riskScore: 80, amount: 20000, frequency: 5, classicalScore: 70, newCounterparty: 1 },
      { id: 'B', riskScore: 45, amount: 1200, frequency: 1, classicalScore: 20, newCounterparty: 0 },
    ];

    const annotated = annotateFraudConfirmation(input);
    const split = splitFraudConfirmation(input);

    expect(annotated[0]).toMatchObject({ reviewTier: 'confirmed', reviewRule: 'high_classical_score' });
    expect(annotated[1]).toMatchObject({ reviewTier: 'review' });
    expect(split.summary).toMatchObject({ total: 2, confirmedCount: 1, reviewCount: 1 });
  });

  it('builds a secondary review section', () => {
    const section = buildFraudSecondaryReviewSection({
      transactions: [
        { id: 'A', riskScore: 80, classicalScore: 70, frequency: 5, amount: 20000, newCounterparty: 1 },
        { id: 'B', riskScore: 45, classicalScore: 20, frequency: 1, amount: 1200, newCounterparty: 0 },
      ],
    });

    expect(section).toContain('İkincil Onay Katmanı');
    expect(section).toContain('Güçlü onaylanan: 1');
    expect(section).toContain('| A | 80 | 70 | 5 | 20000 |');
  });

  it('summarizes confirmed and review ids for the app layer', () => {
    const summary = summarizeFraudConfirmation([
      { id: 'A', riskScore: 82, classicalScore: 50, frequency: 3, amount: 1000 },
      { id: 'B', riskScore: 40, classicalScore: 20, frequency: 1, amount: 1200 },
    ]);

    expect(summary).toMatchObject({
      total: 2,
      confirmedCount: 1,
      reviewCount: 1,
      confirmedIds: ['A'],
      reviewIds: ['B'],
    });
  });
});
