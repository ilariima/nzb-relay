import { isIP } from 'node:net';

import { USER_AGENT } from './version.mjs';

export class EgressCheckError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EgressCheckError';
  }
}

export class EgressChecker {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.cacheDurationMs = options.cacheDurationMs ?? 30_000;
    this.cached = null;
  }

  async get(config, { force = false } = {}) {
    if (!force && this.cached && Date.now() - this.cached.checkedAt < this.cacheDurationMs) {
      return { ...this.cached };
    }

    let response;
    try {
      response = await this.fetchImpl(config.egressCheckUrl, {
        headers: {
          accept: 'application/json, text/plain',
          'user-agent': USER_AGENT
        },
        signal: AbortSignal.timeout(config.requestTimeoutMs)
      });
    } catch (error) {
      throw new EgressCheckError(`Unable to check the relay's public IP: ${error.message}`);
    }

    if (!response.ok) {
      throw new EgressCheckError(`Public-IP service returned HTTP ${response.status}.`);
    }

    const raw = (await response.text()).trim();
    let ip = raw;
    try {
      ip = JSON.parse(raw).ip || raw;
    } catch {
      // Plain-text IP services are supported too.
    }

    ip = String(ip).trim();
    if (!isIP(ip)) {
      throw new EgressCheckError('Public-IP service returned an invalid IP address.');
    }

    this.cached = {
      ip,
      checkedAt: Date.now()
    };
    return { ...this.cached };
  }

  async enforce(config) {
    // Every NZB grab gets a new lookup so its audit/archive record reflects the
    // route in use at that moment. No fixed home address is compared or stored.
    return this.get(config, { force: true });
  }
}
