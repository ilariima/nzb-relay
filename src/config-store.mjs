import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_CONFIG = Object.freeze({
  listenHost: '127.0.0.1',
  listenPort: 9788,
  bridgeApiKey: '',
  sabUrl: '',
  sabApiKey: '',
  egressCheckUrl: 'https://api.ipify.org?format=json',
  requestTimeoutMs: 30_000,
  maxNzbBytes: 64 * 1024 * 1024,
  nzbRetentionHours: 7 * 24
});

function generateApiKey() {
  return randomBytes(24).toString('hex');
}

function normalizeSabUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

function normalizeConfig(value = {}) {
  const timeout = Number(value.requestTimeoutMs);
  const maxBytes = Number(value.maxNzbBytes);
  const port = Number(value.listenPort);
  const retentionHours = Number(value.nzbRetentionHours);

  return {
    ...DEFAULT_CONFIG,
    listenHost: '127.0.0.1',
    listenPort: Number.isInteger(port) && port > 0 && port < 65_536 ? port : DEFAULT_CONFIG.listenPort,
    bridgeApiKey: String(value.bridgeApiKey || generateApiKey()),
    sabUrl: normalizeSabUrl(value.sabUrl),
    sabApiKey: String(value.sabApiKey || '').trim(),
    egressCheckUrl: String(value.egressCheckUrl || DEFAULT_CONFIG.egressCheckUrl).trim(),
    requestTimeoutMs: Number.isFinite(timeout) && timeout >= 1_000 && timeout <= 120_000
      ? Math.round(timeout)
      : DEFAULT_CONFIG.requestTimeoutMs,
    maxNzbBytes: Number.isFinite(maxBytes) && maxBytes >= 1_048_576 && maxBytes <= 268_435_456
      ? Math.round(maxBytes)
      : DEFAULT_CONFIG.maxNzbBytes,
    nzbRetentionHours: Number.isFinite(retentionHours) && retentionHours >= 0 && retentionHours <= 87_600
      ? Math.round(retentionHours)
      : DEFAULT_CONFIG.nzbRetentionHours
  };
}

export class ConfigStore {
  constructor(dataDirectory, options = {}) {
    this.dataDirectory = dataDirectory;
    this.filePath = path.join(dataDirectory, 'config.json');
    this.secretCodec = options.secretCodec || null;
    this.value = normalizeConfig();
  }

  async load() {
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });

    try {
      const raw = await readFile(this.filePath, 'utf8');
      const stored = JSON.parse(raw);
      if (stored.sabApiKeyEncrypted) {
        if (!this.secretCodec) {
          throw new Error('The SABnzbd API key is protected by the desktop app. Open NZB Relay in desktop mode to use this configuration.');
        }
        stored.sabApiKey = this.secretCodec.decrypt(stored.sabApiKeyEncrypted);
      }
      this.value = normalizeConfig(stored);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      this.value = normalizeConfig();
      await this.save();
    }

    return this.get();
  }

  get() {
    return structuredClone(this.value);
  }

  getPublic() {
    return {
      ...this.get(),
      sabApiKey: '',
      sabApiKeyConfigured: Boolean(this.value.sabApiKey),
      sabApiKeyProtected: Boolean(this.secretCodec),
      maxNzbMegabytes: Math.round(this.value.maxNzbBytes / 1024 / 1024)
    };
  }

  async update(input = {}) {
    const candidate = {
      ...this.value,
      sabUrl: input.sabUrl ?? this.value.sabUrl,
      sabApiKey: input.sabApiKey ? input.sabApiKey : this.value.sabApiKey,
      egressCheckUrl: input.egressCheckUrl ?? this.value.egressCheckUrl,
      requestTimeoutMs: input.requestTimeoutMs ?? this.value.requestTimeoutMs,
      nzbRetentionHours: input.nzbRetentionHours ?? this.value.nzbRetentionHours,
      maxNzbBytes: input.maxNzbMegabytes
        ? Number(input.maxNzbMegabytes) * 1024 * 1024
        : this.value.maxNzbBytes
    };

    this.value = normalizeConfig(candidate);
    await this.save();
    return this.getPublic();
  }

  async save() {
    const temporaryPath = `${this.filePath}.tmp`;
    const stored = { ...this.value };
    if (this.secretCodec && stored.sabApiKey) {
      stored.sabApiKeyEncrypted = this.secretCodec.encrypt(stored.sabApiKey);
      delete stored.sabApiKey;
    }
    await writeFile(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.filePath);
    await chmod(this.filePath, 0o600);
  }
}
