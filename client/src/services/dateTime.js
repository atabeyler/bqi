import { localeFor } from './i18n.js';

export function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function formatLocalDateTime(value, lang, options = {}) {
  if (value == null || value === '') return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const { timeZone = localTimeZone(), ...formatOptions } = options;
  return new Intl.DateTimeFormat(localeFor(lang), {
    dateStyle: 'medium',
    timeStyle: 'medium',
    ...formatOptions,
    timeZone,
  }).format(date);
}

export function formatLocalDate(value, lang, options = {}) {
  if (value == null || value === '') return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const { timeZone = localTimeZone(), ...formatOptions } = options;
  const presentation = Object.keys(formatOptions).length ? formatOptions : { dateStyle: 'medium' };
  return new Intl.DateTimeFormat(localeFor(lang), { ...presentation, timeZone }).format(date);
}

export function formatLocalTime(value, lang, options = {}) {
  if (value == null || value === '') return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const { timeZone = localTimeZone(), ...formatOptions } = options;
  const presentation = Object.keys(formatOptions).length ? formatOptions : { timeStyle: 'medium' };
  return new Intl.DateTimeFormat(localeFor(lang), { ...presentation, timeZone }).format(date);
}
