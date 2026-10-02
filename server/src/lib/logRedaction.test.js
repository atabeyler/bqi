import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { HTTP_LOG_REDACT } from './logger.js';

describe('request logging never contains credentials', () => {
  it('redacts the session cookie, Authorization, API-key headers and Set-Cookie, but keeps non-secret fields', async () => {
    const lines = [];
    const stream = { write: (l) => lines.push(l) };
    const app = express();
    app.use(pinoHttp({ logger: pino({ level: 'info' }, stream), redact: HTTP_LOG_REDACT }));
    app.get('/x', (_req, res) => { res.setHeader('Set-Cookie', 'bqi_jwt=SECRET_SET_COOKIE; HttpOnly'); res.json({ ok: true }); });
    await request(app).get('/x').set('Cookie', 'bqi_jwt=SECRET_JWT_VALUE; theme=dark').set('Authorization', 'Bearer SECRET_BEARER').set('X-Api-Key', 'SECRET_KEY').set('User-Agent', 'vitest-agent');
    const out = lines.join('');
    for (const secret of ['SECRET_JWT_VALUE', 'SECRET_BEARER', 'SECRET_KEY', 'SECRET_SET_COOKIE']) expect(out).not.toContain(secret);
    expect(out).toContain('vitest-agent'); // ordinary headers are still logged
    expect(out).toContain('[Redacted]');
  });
});
