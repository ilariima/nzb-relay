import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { ConfigStore } from '../src/config-store.mjs';

test('protects and restores the SAB key through the supplied system codec', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nzb-relay-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const codec = {
    encrypt: value => Buffer.from(`protected:${value}`).toString('base64'),
    decrypt: value => Buffer.from(value, 'base64').toString('utf8').replace(/^protected:/, '')
  };

  const first = new ConfigStore(directory, { secretCodec: codec });
  await first.load();
  await first.update({
    sabUrl: 'sab.local:8080',
    sabApiKey: 'real-secret',
    nzbRetentionHours: 0,
    expectedEgressIp: '203.0.113.7',
    enforceExpectedEgressIp: true
  });

  const onDisk = await readFile(path.join(directory, 'config.json'), 'utf8');
  assert.equal(onDisk.includes('real-secret'), false);
  assert.match(onDisk, /sabApiKeyEncrypted/);

  const second = new ConfigStore(directory, { secretCodec: codec });
  await second.load();
  assert.equal(second.get().sabApiKey, 'real-secret');
  assert.equal(second.get().sabUrl, 'http://sab.local:8080');
  assert.equal(second.get().nzbRetentionHours, 0);
  assert.equal('expectedEgressIp' in second.get(), false);
  assert.equal('enforceExpectedEgressIp' in second.get(), false);
  assert.equal(second.getPublic().sabApiKey, '');
  assert.equal(second.getPublic().sabApiKeyProtected, true);
});
