import http from 'node:http';

import { DEFAULT_CONFIG } from '../src/config-store.mjs';

export async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address();
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  };
}

export function fakeConfigStore(overrides = {}) {
  let value = {
    ...DEFAULT_CONFIG,
    listenPort: 9788,
    bridgeApiKey: 'bridge-secret',
    requestTimeoutMs: 5_000,
    ...overrides
  };
  return {
    async load() {},
    get() { return structuredClone(value); },
    getPublic() {
      return {
        ...structuredClone(value),
        sabApiKey: '',
        sabApiKeyConfigured: Boolean(value.sabApiKey),
        sabApiKeyNeedsReentry: false,
        maxNzbMegabytes: Math.round(value.maxNzbBytes / 1024 / 1024)
      };
    },
    async update(input) {
      value = { ...value, ...input };
      return this.getPublic();
    }
  };
}

export async function startRelay(createRelayApp, options) {
  const app = await createRelayApp(options);
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', () => {
      app.server.off('error', reject);
      resolve();
    });
  });
  return {
    app,
    url: `http://127.0.0.1:${app.server.address().port}`
  };
}

export async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}
