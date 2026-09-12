/**
 * Institutional data connector framework.
 *
 * No live bank, telecom or government endpoint is assumed here. Connectors
 * are registered only when an authorised integration is configured. Every
 * connector must return a normalized payload so the downstream BQI
 * analysis pipeline remains independent of the source system.
 */

const connectors = new Map();

export class InstitutionalConnector {
  constructor({ id, name, kind = 'rest' }) {
    if (!id || !name) throw new Error('Connector id and name are required');
    this.id = id;
    this.name = name;
    this.kind = kind;
  }

  async health() {
    return { ok: false, configured: false, message: 'Connector health() not implemented' };
  }

  async fetchNormalizedData() {
    throw new Error('Connector fetchNormalizedData() not implemented');
  }
}

export function registerConnector(connector) {
  if (!(connector instanceof InstitutionalConnector)) {
    throw new TypeError('connector must extend InstitutionalConnector');
  }
  connectors.set(connector.id, connector);
  return connector;
}

export function getConnector(id) {
  return connectors.get(id) || null;
}

export function listConnectors() {
  return Array.from(connectors.values()).map((connector) => ({
    id: connector.id,
    name: connector.name,
    kind: connector.kind,
  }));
}

export async function getConnectorStatuses() {
  return Promise.all(Array.from(connectors.values()).map(async (connector) => {
    try {
      const status = await connector.health();
      return { id: connector.id, name: connector.name, kind: connector.kind, ...status };
    } catch (err) {
      return {
        id: connector.id,
        name: connector.name,
        kind: connector.kind,
        ok: false,
        configured: true,
        message: err?.message || String(err),
      };
    }
  }));
}

/**
 * Generic authorised REST connector base. Institution-specific adapters can
 * extend this class and implement normalize(). Credentials and endpoint
 * details stay in environment/configuration, never in source code.
 */
export class RestInstitutionalConnector extends InstitutionalConnector {
  constructor({ id, name, baseUrl, token = null, headers = {} }) {
    super({ id, name, kind: 'rest' });
    this.baseUrl = baseUrl;
    this.token = token;
    this.headers = headers;
  }

  get configured() {
    return !!this.baseUrl;
  }

  buildHeaders() {
    return {
      accept: 'application/json',
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      ...this.headers,
    };
  }

  async health() {
    return {
      ok: this.configured,
      configured: this.configured,
      message: this.configured ? 'Configured' : 'Endpoint not configured',
    };
  }

  async request(path = '', options = {}) {
    if (!this.configured) throw new Error(`${this.name} connector is not configured`);
    const url = new URL(path, this.baseUrl);
    const response = await fetch(url, {
      ...options,
      headers: { ...this.buildHeaders(), ...(options.headers || {}) },
      signal: options.signal || AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`${this.name} returned HTTP ${response.status}`);
    return response.json();
  }

  normalize() {
    throw new Error('Institution-specific normalize() must be implemented');
  }

  async fetchNormalizedData(path = '', options = {}) {
    const raw = await this.request(path, options);
    return this.normalize(raw);
  }
}
