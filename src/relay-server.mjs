import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AuditLog } from './audit-log.mjs';
import { ConfigStore } from './config-store.mjs';
import { EgressChecker } from './egress-checker.mjs';
import { NzbArchive } from './nzb-archive.mjs';
import { fetchNzb } from './nzb-fetcher.mjs';
import { collectParameters, forwardSabRequest, uploadNzbToSab } from './sab-client.mjs';
import { APP_VERSION } from './version.mjs';

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const uiDirectory = path.join(sourceDirectory, 'ui');
const MAX_ADMIN_BODY_BYTES = 1024 * 1024;

function json(response, status, value) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.byteLength,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  response.end(body);
}

function sendBuffer(response, result) {
  response.writeHead(result.status, {
    'content-type': result.contentType,
    'content-length': result.body.byteLength,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  response.end(result.body);
}

async function readBody(request, maximumBytes = MAX_ADMIN_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.byteLength;
    if (total > maximumBytes) {
      const error = new Error('Request body is too large.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function keyMatches(provided, expected) {
  if (!provided || !expected) return false;
  const left = Buffer.from(String(provided));
  const right = Buffer.from(String(expected));
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function extractBridgeKey(request, parameters) {
  return request.headers['x-api-key'] || parameters.get('apikey') || '';
}

function requireLocalUiRequest(request) {
  if (request.headers['x-nzb-relay-ui'] !== '1') {
    const error = new Error('This endpoint is only available to the NZB Relay interface.');
    error.statusCode = 403;
    throw error;
  }
}

function publicError(error) {
  const message = String(error?.message || 'Unexpected relay error.');
  return message
    .replace(/([?&](?:apikey|api_key|token|key)=)[^&\s]+/gi, '$1[redacted]')
    .slice(0, 500);
}

function hostnameOf(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return 'invalid-url';
  }
}

function sabJobId(result) {
  try {
    const parsed = JSON.parse(result.body.toString('utf8'));
    return parsed.nzo_ids?.[0] || parsed.nzo_id || '';
  } catch {
    return '';
  }
}

function looksLikeHtml(body) {
  return /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(body.toString('utf8').slice(0, 512));
}

function sabAccepted(result) {
  if (result.status < 200 || result.status >= 300) return false;
  // SABnzbd serves its web interface with HTTP 200 when the API path or URL base
  // is wrong. An HTML body is never a valid API response, so treating it as
  // success would report a grab as uploaded that SAB never received.
  if (looksLikeHtml(result.body)) return false;
  try {
    return JSON.parse(result.body.toString('utf8')).status !== false;
  } catch {
    // Non-JSON output modes such as output=xml stay permissive.
    return true;
  }
}

function sabErrorMessage(result) {
  if (looksLikeHtml(result.body)) {
    return 'SABnzbd returned a web page instead of an API response. Check the SABnzbd URL and its URL base.';
  }
  try {
    return JSON.parse(result.body.toString('utf8')).error || `SABnzbd rejected the NZB (HTTP ${result.status}).`;
  } catch {
    return `SABnzbd rejected the NZB (HTTP ${result.status}).`;
  }
}

async function serveStatic(requestPath, response) {
  const files = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8']
  };
  const selected = files[requestPath];
  if (!selected) return false;

  const body = await readFile(path.join(uiDirectory, selected[0]));
  response.writeHead(200, {
    'content-type': selected[1],
    'content-length': body.byteLength,
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'",
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY'
  });
  response.end(body);
  return true;
}

export async function createRelayApp(options = {}) {
  const configStore = options.configStore || new ConfigStore(options.dataDirectory, { secretCodec: options.secretCodec });
  await configStore.load();
  const auditLog = options.auditLog || new AuditLog();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const egressChecker = options.egressChecker || new EgressChecker({ fetchImpl });
  const nzbArchive = options.nzbArchive || new NzbArchive(path.join(options.dataDirectory, 'nzbs'));
  await nzbArchive.load();
  await nzbArchive.cleanup(configStore.get().nzbRetentionHours);
  const openNzbDirectory = options.openNzbDirectory || null;

  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, 'http://localhost');

    try {
      if (request.method === 'GET' && await serveStatic(requestUrl.pathname, response)) return;

      if (requestUrl.pathname === '/relay/health' && request.method === 'GET') {
        json(response, 200, { status: 'ok', version: APP_VERSION });
        return;
      }

      if (requestUrl.pathname === '/relay/config' && request.method === 'GET') {
        json(response, 200, configStore.getPublic());
        return;
      }

      if (requestUrl.pathname === '/relay/config' && request.method === 'POST') {
        requireLocalUiRequest(request);
        const body = await readBody(request);
        const input = JSON.parse(body.toString('utf8') || '{}');
        const updated = await configStore.update(input);
        await nzbArchive.cleanup(configStore.get().nzbRetentionHours);
        json(response, 200, updated);
        return;
      }

      if (requestUrl.pathname === '/relay/egress' && request.method === 'GET') {
        const result = await egressChecker.get(configStore.get(), { force: true });
        json(response, 200, result);
        return;
      }

      if (requestUrl.pathname === '/relay/audit' && request.method === 'GET') {
        json(response, 200, { entries: auditLog.list() });
        return;
      }

      if (requestUrl.pathname === '/relay/nzbs' && request.method === 'GET') {
        await nzbArchive.cleanup(configStore.get().nzbRetentionHours);
        json(response, 200, {
          items: nzbArchive.list(),
          directory: nzbArchive.directory,
          canOpenFolder: Boolean(openNzbDirectory)
        });
        return;
      }

      if (requestUrl.pathname === '/relay/nzbs/open-folder' && request.method === 'POST') {
        requireLocalUiRequest(request);
        if (!openNzbDirectory) {
          const error = new Error('Opening the folder is available in the desktop app.');
          error.statusCode = 501;
          throw error;
        }
        const openError = await openNzbDirectory(nzbArchive.directory);
        if (openError) throw new Error(openError);
        json(response, 200, { status: true });
        return;
      }

      const pushMatch = requestUrl.pathname.match(/^\/relay\/nzbs\/([^/]+)\/push$/);
      if (pushMatch && request.method === 'POST') {
        requireLocalUiRequest(request);
        const config = configStore.get();
        if (!config.sabUrl || !config.sabApiKey) throw new Error('Configure the SABnzbd URL and API key first.');
        const saved = await nzbArchive.read(decodeURIComponent(pushMatch[1]));
        const result = await uploadNzbToSab(saved.nzb, saved.parameters, config, { fetchImpl });
        const jobId = sabJobId(result);
        const updated = await nzbArchive.markSubmitted(saved.item.id, {
          sabJobId: jobId,
          sabStatus: result.status
        });
        const accepted = sabAccepted(result);
        auditLog.add({
          outcome: accepted ? 'manual-uploaded' : 'manual-sab-error',
          sourceHost: saved.item.sourceHost,
          egressIp: saved.item.egressIp,
          filename: saved.item.filename,
          bytes: saved.item.bytes,
          sabJobId: jobId,
          sabStatus: result.status,
          archiveId: saved.item.id
        });
        if (!accepted) {
          json(response, 502, { status: false, error: sabErrorMessage(result), item: updated });
          return;
        }
        json(response, 200, { status: true, sabJobId: jobId, item: updated });
        return;
      }

      const deleteMatch = requestUrl.pathname.match(/^\/relay\/nzbs\/([^/]+)$/);
      if (deleteMatch && request.method === 'DELETE') {
        requireLocalUiRequest(request);
        await nzbArchive.remove(decodeURIComponent(deleteMatch[1]));
        json(response, 200, { status: true });
        return;
      }

      if (requestUrl.pathname === '/relay/test-sab' && request.method === 'POST') {
        requireLocalUiRequest(request);
        const config = configStore.get();
        if (!config.sabUrl || !config.sabApiKey) throw new Error('Configure the SABnzbd URL and API key first.');
        const fakeRequest = {
          method: 'GET',
          url: '/api?mode=version&output=json',
          headers: {}
        };
        const result = await forwardSabRequest(fakeRequest, Buffer.alloc(0), config, { fetchImpl });
        if (!sabAccepted(result)) {
          json(response, 502, { status: false, error: sabErrorMessage(result) });
          return;
        }
        try {
          if (!JSON.parse(result.body.toString('utf8')).version) {
            json(response, 502, { status: false, error: 'SABnzbd responded, but did not return its version.' });
            return;
          }
        } catch {
          json(response, 502, { status: false, error: 'SABnzbd returned an invalid version response.' });
          return;
        }
        sendBuffer(response, result);
        return;
      }

      if (requestUrl.pathname === '/api') {
        const body = await readBody(request, 4 * 1024 * 1024);
        const contentType = request.headers['content-type'] || '';
        const parameters = collectParameters(request.url, body, contentType);
        const config = configStore.get();

        if (!keyMatches(extractBridgeKey(request, parameters), config.bridgeApiKey)) {
          json(response, 403, { status: false, error: 'API Key Incorrect' });
          return;
        }

        if (!config.sabUrl || !config.sabApiKey) {
          json(response, 503, { status: false, error: 'Real SABnzbd is not configured in NZB Relay.' });
          return;
        }

        if (parameters.get('mode') !== 'addurl') {
          const result = await forwardSabRequest(request, body, config, { fetchImpl });
          sendBuffer(response, result);
          return;
        }

        const sourceUrl = parameters.get('name') || parameters.get('url');
        if (!sourceUrl) {
          json(response, 400, { status: false, error: 'SAB addurl request did not contain an NZB URL.' });
          return;
        }

        let egress;
        try {
          egress = await egressChecker.enforce(config);
          await nzbArchive.cleanup(config.nzbRetentionHours);
          const nzb = await fetchNzb(sourceUrl, {
            fetchImpl,
            timeoutMs: config.requestTimeoutMs,
            maximumBytes: config.maxNzbBytes,
            preferredFilename: parameters.get('nzbname') || ''
          });
          const archived = await nzbArchive.save(nzb, parameters, {
            sourceHost: hostnameOf(nzb.finalUrl),
            egressIp: egress.ip
          });
          const result = await uploadNzbToSab(nzb, parameters, config, { fetchImpl });
          await nzbArchive.markSubmitted(archived.id, {
            sabJobId: sabJobId(result),
            sabStatus: result.status
          });

          auditLog.add({
            outcome: sabAccepted(result) ? 'uploaded' : 'sab-error',
            sourceHost: hostnameOf(nzb.finalUrl),
            egressIp: egress.ip,
            filename: nzb.filename,
            bytes: nzb.bytes.byteLength,
            sabJobId: sabJobId(result),
            sabStatus: result.status,
            archiveId: archived.id
          });
          sendBuffer(response, result);
        } catch (error) {
          const message = publicError(error);
          auditLog.add({
            outcome: 'blocked-or-failed',
            sourceHost: hostnameOf(sourceUrl),
            egressIp: egress?.ip || '',
            error: message
          });
          json(response, 502, { status: false, error: message });
        }
        return;
      }

      json(response, 404, { status: false, error: 'Not found' });
    } catch (error) {
      json(response, error.statusCode || 500, { status: false, error: publicError(error) });
    }
  });

  return {
    server,
    configStore,
    auditLog,
    egressChecker,
    nzbArchive,
    async start() {
      const config = configStore.get();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.listenPort, config.listenHost, () => {
          server.off('error', reject);
          resolve();
        });
      });
      return server.address();
    },
    async stop() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  };
}
