import { describe, expect, it } from 'vitest';
import { formatLocalDateTime } from './dateTime.js';

describe('location-aware date/time formatting', () => {
  it('formats the same instant for the supplied IANA time zone', () => {
    const instant = '2026-01-15T12:00:00.000Z';
    expect(formatLocalDateTime(instant, 'en', { timeZone: 'Europe/Istanbul' })).toContain('15:00:00');
    expect(formatLocalDateTime(instant, 'en', { timeZone: 'Europe/London' })).toContain('12:00:00');
    expect(formatLocalDateTime(instant, 'en', { timeZone: 'America/New_York' })).toContain('07:00:00');
  });

  it('does not invent a date for invalid input', () => {
    expect(formatLocalDateTime('not-a-date', 'tr')).toBe('not-a-date');
  });
});
