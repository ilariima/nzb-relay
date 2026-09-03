import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { NzbArchive } from '../src/nzb-archive.mjs';

const NZB_BYTES = Buffer.from('<?xml version="1.0"?><nzb><file subject="saved"></file></nzb>');

test('persists NZBs, restores submission parameters, and supports manual resubmission data', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nzb-archive-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = Date.parse('2026-09-02T05:00:00Z');
  const archive = new NzbArchive(directory, { now: () => now });
  await archive.load();

  const saved = await archive.save({
    bytes: NZB_BYTES,
    filename: 'release.nzb',
    contentType: 'application/x-nzb'
  }, new URLSearchParams({ cat: 'movies', priority: '-1' }), {
    sourceHost: 'indexer.example',
    egressIp: '203.0.113.7'
  });

  assert.equal(saved.filename, 'release.nzb');
  assert.equal(saved.bytes, NZB_BYTES.byteLength);
  assert.equal(saved.submitCount, 0);
  assert.deepEqual(await readFile(path.join(directory, saved.storedFilename)), NZB_BYTES);

  const restored = new NzbArchive(directory, { now: () => now });
  await restored.load();
  const record = await restored.read(saved.id);
  assert.deepEqual(record.nzb.bytes, NZB_BYTES);
  assert.equal(record.parameters.get('cat'), 'movies');
  assert.equal(record.parameters.get('priority'), '-1');

  const submitted = await restored.markSubmitted(saved.id, { sabJobId: 'SAB-1', sabStatus: 200 });
  assert.equal(submitted.submitCount, 1);
  assert.equal(submitted.sabJobId, 'SAB-1');
});

test('deletes expired NZBs but keeps them indefinitely when retention is Forever', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nzb-retention-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = Date.parse('2026-09-02T05:00:00Z');
  const archive = new NzbArchive(directory, { now: () => now });
  await archive.load();

  await archive.save({ bytes: NZB_BYTES, filename: 'expiring.nzb', contentType: 'application/x-nzb' }, new URLSearchParams());
  now += 2 * 60 * 60 * 1000;
  assert.deepEqual(await archive.cleanup(1), { removed: 1 });
  assert.equal(archive.list().length, 0);

  await archive.save({ bytes: NZB_BYTES, filename: 'forever.nzb', contentType: 'application/x-nzb' }, new URLSearchParams());
  now += 20 * 365 * 24 * 60 * 60 * 1000;
  assert.deepEqual(await archive.cleanup(0), { removed: 0 });
  assert.equal(archive.list().length, 1);
});
