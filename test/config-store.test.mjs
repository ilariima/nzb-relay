import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { ConfigStore } from '../src/config-store.mjs';

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nzb-relay-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('keeps the SAB key out of the public config and the file owner-only', async t => {
  const directory = await temporaryDirectory(t);

  const first = new ConfigStore(directory);
  await first.load();
  await first.update({
    sabUrl: 'sab.local:8080',
    sabApiKey: 'real-secret',
    nzbRetentionHours: 0,
    expectedEgressIp: '203.0.113.7',
    enforceExpectedEgressIp: true
  });

  const configPath = path.join(directory, 'config.json');
  // The key is stored so the relay can substitute it, but the file it lives in
  // is readable only by its owner.
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);

  const second = new ConfigStore(directory);
  await second.load();
  assert.equal(second.get().sabApiKey, 'real-secret');
  assert.equal(second.get().sabUrl, 'http://sab.local:8080');
  assert.equal(second.get().nzbRetentionHours, 0);
  assert.equal('expectedEgressIp' in second.get(), false);
  assert.equal('enforceExpectedEgressIp' in second.get(), false);

  // The settings API reports only that a key exists, never its value.
  const shown = second.getPublic();
  assert.equal(shown.sabApiKey, '');
  assert.equal(shown.sabApiKeyConfigured, true);
  assert.equal(shown.sabApiKeyNeedsReentry, false);
});

test('discards a keychain-encrypted key from an older build and asks for it again', async t => {
  const directory = await temporaryDirectory(t);
  const configPath = path.join(directory, 'config.json');

  // What a build that used Electron safeStorage left behind.
  await writeFile(configPath, JSON.stringify({
    listenHost: '127.0.0.1',
    listenPort: 9788,
    bridgeApiKey: 'kept-across-the-upgrade',
    sabUrl: 'http://sab.local:8080',
    sabApiKeyEncrypted: 'cHJvdGVjdGVkOnJlYWwtc2VjcmV0'
  }, null, 2), { mode: 0o600 });

  const store = new ConfigStore(directory);
  await store.load();

  // Starting must not fail just because the ciphertext is unreadable.
  assert.equal(store.get().sabApiKey, '');
  assert.equal(store.getPublic().sabApiKeyConfigured, false);
  assert.equal(store.getPublic().sabApiKeyNeedsReentry, true);
  // Everything else survives the upgrade.
  assert.equal(store.get().bridgeApiKey, 'kept-across-the-upgrade');
  assert.equal(store.get().sabUrl, 'http://sab.local:8080');

  // The unreadable ciphertext is not carried forward.
  const rewritten = await readFile(configPath, 'utf8');
  assert.equal(rewritten.includes('sabApiKeyEncrypted'), false);

  // Supplying the key again clears the prompt.
  await store.update({ sabApiKey: 'entered-again' });
  assert.equal(store.getPublic().sabApiKeyNeedsReentry, false);
  assert.equal(store.get().sabApiKey, 'entered-again');
});
