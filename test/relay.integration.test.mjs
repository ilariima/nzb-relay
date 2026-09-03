import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { createRelayApp } from '../src/relay-server.mjs';
import { fakeConfigStore, listen, readRequestBody, startRelay } from './helpers.mjs';

const SAMPLE_NZB = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><file subject="relay test"><groups><group>alt.test</group></groups><segments><segment bytes="1" number="1">id@test</segment></segments></file></nzb>`);

describe('Prowlarr-to-SAB relay', () => {
  const cleanups = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()();
  });

  async function temporaryDataDirectory() {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nzb-relay-integration-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    return directory;
  }

  test('turns addurl into a local fetch followed by SAB addfile', async () => {
    let indexerHits = 0;
    const indexer = await listen((request, response) => {
      indexerHits += 1;
      assert.equal(request.url, '/download/42');
      response.writeHead(200, {
        'content-type': 'application/x-nzb',
        'content-disposition': 'attachment; filename="release.nzb"'
      });
      response.end(SAMPLE_NZB);
    });
    cleanups.push(() => indexer.close());

    const sabRequests = [];
    const sab = await listen(async (request, response) => {
      const body = await readRequestBody(request);
      sabRequests.push({ url: request.url, method: request.method, headers: request.headers, body });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: true, nzo_ids: ['SAB-job-1'] }));
    });
    cleanups.push(() => sab.close());

    let egressChecks = 0;
    const egressChecker = {
      async enforce() {
        egressChecks += 1;
        return { ip: '203.0.113.7' };
      }
    };
    const configStore = fakeConfigStore({ sabUrl: sab.url, sabApiKey: 'real-sab-secret' });
    const relay = await startRelay(createRelayApp, {
      configStore,
      egressChecker,
      dataDirectory: await temporaryDataDirectory()
    });
    cleanups.push(() => relay.app.stop());

    const parameters = new URLSearchParams({
      mode: 'addurl',
      output: 'json',
      apikey: 'bridge-secret',
      name: `${indexer.url}/download/42`,
      cat: 'movies',
      priority: '-1'
    });
    const response = await fetch(`${relay.url}/api?${parameters}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: true, nzo_ids: ['SAB-job-1'] });

    assert.equal(egressChecks, 1);
    assert.equal(indexerHits, 1);
    assert.equal(sabRequests.length, 1);
    const sabRequest = sabRequests[0];
    const sabUrl = new URL(sabRequest.url, sab.url);
    assert.equal(sabRequest.method, 'POST');
    assert.equal(sabUrl.pathname, '/api');
    assert.equal(sabUrl.searchParams.get('mode'), null, 'mode is not duplicated in the query string');
    assert.equal(sabUrl.searchParams.get('apikey'), 'real-sab-secret');
    assert.equal(sabUrl.searchParams.get('cat'), null, 'category is supplied only in the multipart form');
    assert.equal(sabUrl.searchParams.get('priority'), null, 'priority is supplied only in the multipart form');
    assert.match(sabRequest.headers['content-type'], /^multipart\/form-data; boundary=/);
    const multipartBody = sabRequest.body.toString('utf8');
    assert.equal((multipartBody.match(/name="mode"/g) || []).length, 1);
    assert.match(multipartBody, /name="mode"\r\n\r\naddfile/);
    assert.match(multipartBody, /name="cat"\r\n\r\nmovies/);
    assert.match(multipartBody, /name="priority"\r\n\r\n-1/);
    assert.match(multipartBody, /filename="release\.nzb"/);
    assert.ok(sabRequest.body.includes(SAMPLE_NZB), 'multipart upload contains the exact NZB bytes');
    assert.equal(sabRequest.body.includes(Buffer.from('bridge-secret')), false);

    const [entry] = relay.app.auditLog.list();
    assert.equal(entry.outcome, 'uploaded');
    assert.equal(entry.egressIp, '203.0.113.7');
    assert.equal(entry.sabJobId, 'SAB-job-1');
    assert.equal(entry.bytes, SAMPLE_NZB.byteLength);

    const archiveResponse = await fetch(`${relay.url}/relay/nzbs`);
    const archive = await archiveResponse.json();
    assert.equal(archive.items.length, 1);
    assert.equal(archive.items[0].filename, 'release.nzb');
    assert.equal(archive.items[0].bytes, SAMPLE_NZB.byteLength);
    assert.equal(archive.items[0].submitCount, 1);

    const manualResponse = await fetch(`${relay.url}/relay/nzbs/${archive.items[0].id}/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nzb-relay-ui': '1' },
      body: '{}'
    });
    assert.equal(manualResponse.status, 200);
    assert.equal((await manualResponse.json()).sabJobId, 'SAB-job-1');
    assert.equal(sabRequests.length, 2);
    assert.ok(sabRequests[1].body.includes(SAMPLE_NZB), 'manual retry uses the saved NZB bytes');
  });

  test('passes SAB capability checks through while replacing the API key', async () => {
    let received;
    const sab = await listen(async (request, response) => {
      received = request.url;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ version: '4.5.3' }));
    });
    cleanups.push(() => sab.close());

    const relay = await startRelay(createRelayApp, {
      configStore: fakeConfigStore({ sabUrl: `${sab.url}/sabnzbd`, sabApiKey: 'real-key' }),
      egressChecker: { async enforce() { throw new Error('must not run'); } },
      dataDirectory: await temporaryDataDirectory()
    });
    cleanups.push(() => relay.app.stop());

    const response = await fetch(`${relay.url}/api?mode=version&output=json&apikey=bridge-secret`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { version: '4.5.3' });
    const target = new URL(received, sab.url);
    assert.equal(target.pathname, '/sabnzbd/api');
    assert.equal(target.searchParams.get('mode'), 'version');
    assert.equal(target.searchParams.get('apikey'), 'real-key');
    assert.equal(received.includes('bridge-secret'), false);
  });

  test('blocks when the fresh public-IP lookup fails before contacting the indexer', async () => {
    let indexerHits = 0;
    const indexer = await listen((_request, response) => {
      indexerHits += 1;
      response.end(SAMPLE_NZB);
    });
    cleanups.push(() => indexer.close());

    let sabHits = 0;
    const sab = await listen((_request, response) => {
      sabHits += 1;
      response.end('{}');
    });
    cleanups.push(() => sab.close());

    const relay = await startRelay(createRelayApp, {
      configStore: fakeConfigStore({ sabUrl: sab.url, sabApiKey: 'real-key' }),
      egressChecker: {
        async enforce() {
          throw new Error('Unable to check the relay public IP.');
        }
      },
      dataDirectory: await temporaryDataDirectory()
    });
    cleanups.push(() => relay.app.stop());

    const response = await fetch(`${relay.url}/api?mode=addurl&output=json&apikey=bridge-secret&name=${encodeURIComponent(`${indexer.url}/file.nzb`)}`);
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /Unable to check/);
    assert.equal(indexerHits, 0);
    assert.equal(sabHits, 0);
  });

  test('keeps the fetched NZB available when SAB returns an error', async () => {
    const indexer = await listen((_request, response) => {
      response.writeHead(200, {
        'content-type': 'application/x-nzb',
        'content-disposition': 'attachment; filename="retry-me.nzb"'
      });
      response.end(SAMPLE_NZB);
    });
    cleanups.push(() => indexer.close());

    const sab = await listen(async (request, response) => {
      await readRequestBody(request);
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: false, error: 'Temporary SAB failure' }));
    });
    cleanups.push(() => sab.close());

    const relay = await startRelay(createRelayApp, {
      configStore: fakeConfigStore({ sabUrl: sab.url, sabApiKey: 'real-key' }),
      egressChecker: { async enforce() { return { ip: '203.0.113.7' }; } },
      dataDirectory: await temporaryDataDirectory()
    });
    cleanups.push(() => relay.app.stop());

    const response = await fetch(`${relay.url}/api?mode=addurl&output=json&apikey=bridge-secret&name=${encodeURIComponent(`${indexer.url}/retry`)}`);
    assert.equal(response.status, 500);
    const archive = await (await fetch(`${relay.url}/relay/nzbs`)).json();
    assert.equal(archive.items.length, 1);
    assert.equal(archive.items[0].filename, 'retry-me.nzb');
    assert.equal(archive.items[0].lastSabStatus, 500);
    assert.equal(archive.items[0].submitCount, 1);
  });

  test('treats an HTML page from SAB as a failure rather than a successful upload', async () => {
    const indexer = await listen((_request, response) => {
      response.writeHead(200, {
        'content-type': 'application/x-nzb',
        'content-disposition': 'attachment; filename="misrouted.nzb"'
      });
      response.end(SAMPLE_NZB);
    });
    cleanups.push(() => indexer.close());

    // A wrong SAB URL base serves the web interface with HTTP 200 instead of the API.
    const sab = await listen(async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><html><body>SABnzbd</body></html>');
    });
    cleanups.push(() => sab.close());

    const relay = await startRelay(createRelayApp, {
      configStore: fakeConfigStore({ sabUrl: sab.url, sabApiKey: 'real-key' }),
      egressChecker: { async enforce() { return { ip: '203.0.113.7' }; } },
      dataDirectory: await temporaryDataDirectory()
    });
    cleanups.push(() => relay.app.stop());

    await fetch(`${relay.url}/api?mode=addurl&output=json&apikey=bridge-secret&name=${encodeURIComponent(`${indexer.url}/grab`)}`);

    const { entries } = await (await fetch(`${relay.url}/relay/audit`)).json();
    assert.equal(entries[0].outcome, 'sab-error');

    // The NZB must survive so it can be pushed again once SAB is reachable.
    const archive = await (await fetch(`${relay.url}/relay/nzbs`)).json();
    assert.equal(archive.items.length, 1);
    assert.equal(archive.items[0].filename, 'misrouted.nzb');
  });

  test('rejects an HTML login/error page instead of uploading it', async () => {
    const indexer = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><html><title>Sign in</title></html>');
    });
    cleanups.push(() => indexer.close());

    let sabHits = 0;
    const sab = await listen((_request, response) => {
      sabHits += 1;
      response.end('{}');
    });
    cleanups.push(() => sab.close());

    const relay = await startRelay(createRelayApp, {
      configStore: fakeConfigStore({ sabUrl: sab.url, sabApiKey: 'real-key' }),
      egressChecker: { async enforce() { return { ip: '203.0.113.7' }; } },
      dataDirectory: await temporaryDataDirectory()
    });
    cleanups.push(() => relay.app.stop());

    const response = await fetch(`${relay.url}/api?mode=addurl&apikey=bridge-secret&name=${encodeURIComponent(`${indexer.url}/file.nzb`)}`);
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /not an NZB/i);
    assert.equal(sabHits, 0);
  });

  test('reports a failed SAB version response instead of treating HTTP 200 as connected', async () => {
    const sab = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: false, error: 'API Key Incorrect' }));
    });
    cleanups.push(() => sab.close());

    const relay = await startRelay(createRelayApp, {
      configStore: fakeConfigStore({ sabUrl: sab.url, sabApiKey: 'wrong-key' }),
      egressChecker: {},
      dataDirectory: await temporaryDataDirectory()
    });
    cleanups.push(() => relay.app.stop());

    const response = await fetch(`${relay.url}/relay/test-sab`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nzb-relay-ui': '1' },
      body: '{}'
    });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /API Key Incorrect/);
  });

  test('requires the bridge key and protects settings mutations from browser CSRF', async () => {
    const relay = await startRelay(createRelayApp, {
      configStore: fakeConfigStore({ sabUrl: 'http://127.0.0.1:1', sabApiKey: 'real-key' }),
      egressChecker: {},
      dataDirectory: await temporaryDataDirectory()
    });
    cleanups.push(() => relay.app.stop());

    const sabResponse = await fetch(`${relay.url}/api?mode=version&apikey=wrong`);
    assert.equal(sabResponse.status, 403);

    const configResponse = await fetch(`${relay.url}/relay/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sabUrl: 'http://attacker.invalid' })
    });
    assert.equal(configResponse.status, 403);
  });
});
