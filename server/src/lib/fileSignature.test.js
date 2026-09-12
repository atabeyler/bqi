import { describe, expect, it } from 'vitest';
import { matchesDeclaredFileType } from './fileSignature.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const PDF = Buffer.from('%PDF-1.4\n...');
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
const OLE2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
const PLAIN_TEXT = Buffer.from('date,amount\n2024-01-01,100');
const EXECUTABLE = Buffer.from([0x4d, 0x5a, 0x90, 0x00]); // Windows PE "MZ" header

describe('matchesDeclaredFileType', () => {
  it('accepts real images and rejects a renamed non-image', () => {
    expect(matchesDeclaredFileType(PNG, 'image')).toBe(true);
    expect(matchesDeclaredFileType(JPEG, 'image')).toBe(true);
    expect(matchesDeclaredFileType(PDF, 'image')).toBe(false);
  });

  it('accepts a real PDF and rejects a renamed non-PDF', () => {
    expect(matchesDeclaredFileType(PDF, 'pdf')).toBe(true);
    expect(matchesDeclaredFileType(ZIP, 'pdf')).toBe(false);
  });

  it('accepts a real docx/xlsx (zip) and rejects a renamed non-zip', () => {
    expect(matchesDeclaredFileType(ZIP, 'office')).toBe(true);
    expect(matchesDeclaredFileType(PDF, 'office')).toBe(false);
  });

  it('accepts legacy .xls in either OLE2 or zip form', () => {
    expect(matchesDeclaredFileType(OLE2, 'legacyOffice')).toBe(true);
    expect(matchesDeclaredFileType(ZIP, 'legacyOffice')).toBe(true);
    expect(matchesDeclaredFileType(PDF, 'legacyOffice')).toBe(false);
  });

  it('accepts plain text and rejects an executable disguised as .txt/.csv', () => {
    expect(matchesDeclaredFileType(PLAIN_TEXT, 'text')).toBe(true);
    expect(matchesDeclaredFileType(EXECUTABLE, 'text')).toBe(false);
    expect(matchesDeclaredFileType(PDF, 'text')).toBe(false);
    expect(matchesDeclaredFileType(ZIP, 'text')).toBe(false);
  });

  it('rejects an empty or too-short buffer outright', () => {
    expect(matchesDeclaredFileType(Buffer.alloc(0), 'text')).toBe(false);
    expect(matchesDeclaredFileType(Buffer.from([1, 2]), 'image')).toBe(false);
  });
});
