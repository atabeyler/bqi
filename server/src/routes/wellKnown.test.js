import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { default: wellKnownRouter } = await import('./wellKnown.js');

function buildApp() {
  const app = express();
  app.use('/.well-known', wellKnownRouter);
  return app;
}

afterEach(() => {
  delete process.env.ANDROID_PASSKEY_CERT_FINGERPRINTS;
});

describe('GET /.well-known/assetlinks.json', () => {
  it('404s when no fingerprint is configured, rather than serving a broken empty file', async () => {
    const res = await request(buildApp()).get('/.well-known/assetlinks.json');
    expect(res.status).toBe(404);
  });

  it('serves the Digital Asset Links statement for the configured fingerprint(s)', async () => {
    process.env.ANDROID_PASSKEY_CERT_FINGERPRINTS = 'AA:BB:CC, DD:EE:FF';
    const res = await request(buildApp()).get('/.well-known/assetlinks.json');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        relation: ['delegate_permission/common.get_login_creds'],
        target: {
          namespace: 'android_app',
          package_name: 'com.boldas.bqi',
          sha256_cert_fingerprints: ['AA:BB:CC', 'DD:EE:FF'],
        },
      },
    ]);
  });
});
