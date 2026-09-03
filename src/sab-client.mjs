export const FORWARDED_ADD_PARAMETERS = [
  'cat',
  'priority',
  'pp',
  'script',
  'password',
  'nzbname',
  'dupe_key',
  'dupe_score',
  'dupe_mode'
];

export function buildSabApiUrl(sabUrl) {
  if (!sabUrl) throw new Error('SABnzbd URL is not configured.');
  const target = new URL(sabUrl);
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new Error('SABnzbd URL must use HTTP or HTTPS.');
  }
  target.pathname = `${target.pathname.replace(/\/+$/, '')}/api`;
  target.search = '';
  target.hash = '';
  return target;
}

export function collectParameters(requestUrl, body, contentType = '') {
  const combined = new URLSearchParams(new URL(requestUrl, 'http://localhost').searchParams);
  if (body?.byteLength && contentType.toLowerCase().includes('application/x-www-form-urlencoded')) {
    const bodyParameters = new URLSearchParams(body.toString('utf8'));
    for (const [key, value] of bodyParameters) combined.set(key, value);
  }
  return combined;
}

export async function uploadNzbToSab(nzb, incomingParameters, config, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const target = buildSabApiUrl(config.sabUrl);
  target.searchParams.set('output', incomingParameters.get('output') || 'json');
  target.searchParams.set('apikey', config.sabApiKey);

  const form = new FormData();
  form.append('mode', 'addfile');
  for (const parameter of FORWARDED_ADD_PARAMETERS) {
    const value = incomingParameters.get(parameter);
    if (value !== null && value !== '') {
      form.append(parameter, value);
    }
  }

  form.append('name', new Blob([nzb.bytes], { type: nzb.contentType }), nzb.filename);

  const response = await fetchImpl(target, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(config.requestTimeoutMs)
  });
  const responseBody = Buffer.from(await response.arrayBuffer());

  return {
    status: response.status,
    statusText: response.statusText,
    contentType: response.headers.get('content-type') || 'application/json',
    body: responseBody
  };
}

export async function forwardSabRequest(request, body, config, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const incoming = new URL(request.url, 'http://localhost');
  const target = buildSabApiUrl(config.sabUrl);
  const query = new URLSearchParams(incoming.searchParams);
  query.set('apikey', config.sabApiKey);
  target.search = query.toString();

  const headers = {};
  const contentType = request.headers['content-type'];
  let outgoingBody = body?.byteLength ? body : undefined;

  if (outgoingBody && contentType?.toLowerCase().includes('application/x-www-form-urlencoded')) {
    const bodyParameters = new URLSearchParams(outgoingBody.toString('utf8'));
    if (bodyParameters.has('apikey')) bodyParameters.set('apikey', config.sabApiKey);
    outgoingBody = Buffer.from(bodyParameters.toString());
    headers['content-type'] = 'application/x-www-form-urlencoded';
  } else if (outgoingBody && contentType) {
    headers['content-type'] = contentType;
  }

  const response = await fetchImpl(target, {
    method: request.method,
    headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : outgoingBody,
    signal: AbortSignal.timeout(config.requestTimeoutMs)
  });

  return {
    status: response.status,
    statusText: response.statusText,
    contentType: response.headers.get('content-type') || 'application/json',
    body: Buffer.from(await response.arrayBuffer())
  };
}
