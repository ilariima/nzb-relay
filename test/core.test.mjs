import assert from 'node:assert/strict';
import { test } from 'node:test';

import { looksLikeNzb, sanitizeFilename } from '../src/nzb-fetcher.mjs';
import { buildSabApiUrl, collectParameters } from '../src/sab-client.mjs';

test('recognizes XML, ZIP, and GZIP NZB payloads but rejects HTML', () => {
  assert.equal(looksLikeNzb(Buffer.from('<?xml version="1.0"?><nzb></nzb>')), true);
  assert.equal(looksLikeNzb(Buffer.from([0x50, 0x4b, 0x03, 0x04])), true);
  assert.equal(looksLikeNzb(Buffer.from([0x1f, 0x8b, 0x08, 0x00])), true);
  assert.equal(looksLikeNzb(Buffer.from('<html><body>Login</body></html>')), false);
});

test('sanitizes filenames and preserves SAB URL bases', () => {
  assert.equal(sanitizeFilename('../../bad:name?.nzb'), 'bad_name_.nzb');
  assert.equal(buildSabApiUrl('https://sab.example/sabnzbd/').href, 'https://sab.example/sabnzbd/api');
});

test('collects query and form parameters', () => {
  const parameters = collectParameters('/api?mode=addurl&cat=tv', Buffer.from('cat=movies&priority=-1'), 'application/x-www-form-urlencoded');
  assert.equal(parameters.get('mode'), 'addurl');
  assert.equal(parameters.get('cat'), 'movies');
  assert.equal(parameters.get('priority'), '-1');
});
