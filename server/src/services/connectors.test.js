import { describe, expect, it } from 'vitest';
import {
  InstitutionalConnector,
  RestInstitutionalConnector,
  registerConnector,
  getConnector,
  listConnectors,
  getConnectorStatuses,
} from './connectors.js';

class TestConnector extends InstitutionalConnector {
  constructor(id) {
    super({ id, name: `Test ${id}`, kind: 'test' });
  }

  async health() {
    return { ok: true, configured: true, message: 'Ready' };
  }

  async fetchNormalizedData() {
    return { type: 'scenarios', records: [{ id: 'A' }] };
  }
}

class TestRestConnector extends RestInstitutionalConnector {
  normalize(raw) {
    return { type: 'normalized', records: raw.items || [] };
  }
}

describe('institutional connectors', () => {
  it('registers and retrieves a connector by id', () => {
    const connector = registerConnector(new TestConnector('unit-register'));
    expect(getConnector('unit-register')).toBe(connector);
    expect(listConnectors()).toContainEqual({ id: 'unit-register', name: 'Test unit-register', kind: 'test' });
  });

  it('rejects objects that do not implement the connector contract', () => {
    expect(() => registerConnector({ id: 'fake' })).toThrow(TypeError);
  });

  it('reports connector health without exposing credentials', async () => {
    registerConnector(new TestConnector('unit-health'));
    const statuses = await getConnectorStatuses();
    const status = statuses.find((item) => item.id === 'unit-health');
    expect(status.ok).toBe(true);
    expect(status.configured).toBe(true);
    expect(status).not.toHaveProperty('token');
  });

  it('keeps an unconfigured REST connector safely offline', async () => {
    const connector = new TestRestConnector({ id: 'rest-offline', name: 'REST Offline', baseUrl: null });
    expect((await connector.health()).configured).toBe(false);
    await expect(connector.fetchNormalizedData('/data')).rejects.toThrow('not configured');
  });

  it('builds bearer authentication only when a token exists', () => {
    const connector = new TestRestConnector({
      id: 'rest-auth',
      name: 'REST Auth',
      baseUrl: 'https://example.invalid/',
      token: 'secret-token',
      headers: { 'x-client': 'bqi' },
    });
    expect(connector.buildHeaders()).toEqual({
      accept: 'application/json',
      authorization: 'Bearer secret-token',
      'x-client': 'bqi',
    });
  });
});
