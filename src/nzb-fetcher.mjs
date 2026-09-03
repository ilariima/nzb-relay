import path from 'node:path';

import { FETCH_USER_AGENT } from './version.mjs';

export class NzbFetchError extends Error {
  constructor(message, code = 'NZB_FETCH_FAILED') {
    super(message);
    this.name = 'NzbFetchError';
    this.code = code;
  }
}

function assertHttpUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new NzbFetchError('The submitted NZB URL is invalid.', 'INVALID_URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new NzbFetchError('Only HTTP and HTTPS NZB URLs are accepted.', 'INVALID_SCHEME');
  }

  return parsed;
}

async function readLimitedBody(response, maximumBytes) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new NzbFetchError(`NZB response exceeds the ${Math.round(maximumBytes / 1024 / 1024)} MB limit.`, 'TOO_LARGE');
  }

  if (!response.body) {
    throw new NzbFetchError('The indexer returned an empty response.', 'EMPTY_RESPONSE');
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new NzbFetchError(`NZB response exceeds the ${Math.round(maximumBytes / 1024 / 1024)} MB limit.`, 'TOO_LARGE');
    }
    chunks.push(value);
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function filenameFromDisposition(disposition) {
  if (!disposition) return '';

  const encoded = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.trim().replace(/^"|"$/g, ''));
    } catch {
      // Fall through to the plain filename.
    }
  }

  return disposition.match(/filename\s*=\s*"([^"]+)"/i)?.[1]
    || disposition.match(/filename\s*=\s*([^;]+)/i)?.[1]?.trim()
    || '';
}

export function sanitizeFilename(value, fallback = 'download.nzb') {
  const basename = path.basename(String(value || fallback));
  const cleaned = basename
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 180);
  return cleaned || fallback;
}

export function looksLikeNzb(bytes) {
  if (bytes.byteLength < 4) return false;

  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return true;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && [0x03, 0x05, 0x07].includes(bytes[2])) return true;

  const prefix = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 65_536));
  if (/<!doctype\s+html|<html[\s>]/i.test(prefix)) return false;
  return /<nzb(?:\s|>)/i.test(prefix);
}

export async function fetchNzb(sourceUrl, options = {}) {
  const parsed = assertHttpUrl(sourceUrl);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs || 30_000;
  const maximumBytes = options.maximumBytes || 64 * 1024 * 1024;

  let response;
  try {
    response = await fetchImpl(parsed, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: 'application/x-nzb, application/xml, text/xml, application/zip, application/gzip, */*',
        'user-agent': FETCH_USER_AGENT
      }
    });
  } catch (error) {
    throw new NzbFetchError(`Unable to fetch the NZB: ${error.message}`, 'NETWORK_ERROR');
  }

  if (!response.ok) {
    throw new NzbFetchError(`Indexer returned HTTP ${response.status}.`, 'INDEXER_HTTP_ERROR');
  }

  const bytes = await readLimitedBody(response, maximumBytes);
  if (!looksLikeNzb(bytes)) {
    throw new NzbFetchError('The indexer response is not an NZB, ZIP, or GZIP file.', 'INVALID_NZB');
  }

  const suggestedName = options.preferredFilename
    || filenameFromDisposition(response.headers.get('content-disposition'))
    || path.basename(new URL(response.url).pathname)
    || 'download.nzb';

  const filename = sanitizeFilename(suggestedName);
  return {
    bytes,
    filename: /\.(nzb|zip|gz|gzip)$/i.test(filename) ? filename : `${filename}.nzb`,
    contentType: response.headers.get('content-type') || 'application/x-nzb',
    finalUrl: response.url,
    sourceHost: parsed.hostname
  };
}
