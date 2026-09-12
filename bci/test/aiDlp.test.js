import { describe, it, expect } from 'vitest';
import { redactForExternalAi } from '../src/ai/dlp.js';

describe('AI DLP layer (pure)', () => {
  it('redacts an AWS access key', () => {
    const text = 'key=AKIAABCDEFGHIJKLMNOP rest of text';
    expect(redactForExternalAi(text)).not.toContain('AKIAABCDEFGHIJKLMNOP');
  });

  it('redacts a bearer token', () => {
    expect(redactForExternalAi('Authorization: Bearer abc123.def456')).not.toContain('abc123.def456');
  });

  it('redacts generic password/secret/token assignments', () => {
    expect(redactForExternalAi('password: "hunter2hunter2"')).not.toContain('hunter2hunter2');
    expect(redactForExternalAi("api_key = 'sk-1234567890'")).not.toContain('sk-1234567890');
  });

  it('redacts a PEM private key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK...\n-----END RSA PRIVATE KEY-----';
    expect(redactForExternalAi(pem)).not.toContain('MIIBOgIBAAJBAK');
  });

  it('leaves ordinary text untouched', () => {
    const text = 'This finding affects the login endpoint and should be prioritized.';
    expect(redactForExternalAi(text)).toBe(text);
  });
});
