const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

let config;
let toastTimer;

// The previous egress reading is kept in memory only, never written to disk.
// Persisting observed public IPs is a privacy decision this project has not
// made — see the audit log, which is deliberately ephemeral for the same reason.
let previousEgress = null;
let currentEgress = null;

function setNotice(message, tone = 'bad') {
  const element = $('#notice');
  clearTimeout(toastTimer);
  element.textContent = message;
  element.className = `toast ${tone}`;
  element.hidden = !message;
  if (message) {
    toastTimer = setTimeout(() => { element.hidden = true; }, tone === 'good' ? 5_000 : 9_000);
  }
}

async function request(path, options = {}) {
  const method = options.method || 'GET';
  const mutation = !['GET', 'HEAD'].includes(method.toUpperCase());
  const response = await fetch(path, {
    ...options,
    method,
    headers: {
      ...(mutation ? { 'x-nzb-relay-ui': '1' } : {}),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers
    }
  });
  const contentType = response.headers.get('content-type') || '';
  const value = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(value.error || value || `Request failed (${response.status})`);
  return value;
}

function icon(path, className = 'glyph') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  node.setAttribute('d', path);
  svg.append(node);
  return svg;
}

const CHECK = 'M4 12.5 9.5 18 20 6.5';

/* ---------- navigation ---------- */

function showView(name) {
  $$('.view').forEach(view => { view.hidden = view.id !== `view-${name}`; });
  $$('.nav-item').forEach(item => {
    const current = item.dataset.view === name;
    item.classList.toggle('is-current', current);
    if (current) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
}

$$('.nav-item').forEach(item => {
  item.addEventListener('click', () => showView(item.dataset.view));
});

/* ---------- config ---------- */

function populateRetention(hours) {
  const amount = $('#retention-amount');
  const unit = $('#retention-unit');
  if (hours === 0) {
    unit.value = 'forever';
    amount.value = 7;
  } else if (hours % 24 === 0) {
    unit.value = 'days';
    amount.value = hours / 24;
  } else {
    unit.value = 'hours';
    amount.value = hours;
  }
  amount.disabled = unit.value === 'forever';
}

function retentionNote(hours) {
  if (hours === 0) return 'Kept forever. Retrying reads the saved file — the indexer is never contacted again.';
  const label = hours % 24 === 0 ? `${hours / 24} day${hours === 24 ? '' : 's'}` : `${hours} hour${hours === 1 ? '' : 's'}`;
  return `Kept ${label}, then removed automatically. Retrying reads the saved file — the indexer is never contacted again.`;
}

const GRAB_MODE_HINTS = {
  send: 'The NZB is fetched, saved, then sent on to SABnzbd.',
  hold: 'The NZB is fetched and saved only. Send it from the inbox when you want it.'
};

function applyGrabMode(mode) {
  $('#grab-mode').value = mode;
  $('#grab-mode-hint').textContent = GRAB_MODE_HINTS[mode] || GRAB_MODE_HINTS.send;
  $('#hold-banner').hidden = mode !== 'hold';
}

function populate(nextConfig) {
  config = nextConfig;
  applyGrabMode(config.grabMode);
  $('#listen-port').textContent = config.listenPort;
  $('#bridge-key').textContent = config.bridgeApiKey;
  $('#sab-url').value = config.sabUrl;
  $('#max-size').value = config.maxNzbMegabytes;
  populateRetention(config.nzbRetentionHours);
  $('#retention-note').textContent = retentionNote(config.nzbRetentionHours);
  const help = $('#sab-key-help');
  $('#sab-key').placeholder = config.sabApiKeyConfigured
    ? 'Leave blank to keep the saved key'
    : 'Paste your SABnzbd API key';
  if (config.sabApiKeyNeedsReentry) {
    help.textContent = 'Enter your SABnzbd API key again. The previous one was stored in the system keychain, which this version no longer uses.';
    help.className = 'hint attention';
  } else {
    help.textContent = config.sabApiKeyConfigured
      ? 'A key is saved. Leave blank to keep it.'
      : 'No key saved yet. Prowlarr never receives this key.';
    help.className = 'hint';
  }
}

async function load() {
  try {
    populate(await request('/relay/config'));
    const health = await request('/relay/health');
    $('#service-dot').className = 'dot good';
    $('#service-text').textContent = 'Running';
    $('#service-version').textContent = health.version;
    await Promise.all([refreshLog(), refreshNzbs()]);
  } catch (error) {
    $('#service-dot').className = 'dot bad';
    $('#service-text').textContent = 'Needs attention';
    setNotice(error.message);
  }
}

/* ---------- egress ---------- */

function relativeTime(timestamp) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'} ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}

function renderPrevious() {
  const box = $('#egress-previous');
  if (!previousEgress) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  $('#previous-ip').textContent = previousEgress.ip;
  $('#previous-detail').textContent = `· ${relativeTime(previousEgress.at)}`;
  const verdict = $('#egress-verdict');
  verdict.replaceChildren();
  const changed = currentEgress && currentEgress.ip !== previousEgress.ip;
  verdict.className = `verdict ${changed ? 'changed' : 'same'}`;
  if (changed) verdict.append(icon(CHECK), 'Address changed');
  else verdict.append('Same address');
}

async function checkEgress() {
  const button = $('#check-egress');
  button.disabled = true;
  try {
    const result = await request('/relay/egress');
    if (currentEgress && currentEgress.ip !== result.ip) previousEgress = currentEgress;
    else if (currentEgress) previousEgress = { ...currentEgress };
    currentEgress = { ip: result.ip, at: Number(result.checkedAt) || Date.now() };
    $('#current-ip').textContent = result.ip;
    $('#egress-detail').textContent = `Fresh lookup ${relativeTime(currentEgress.at)}`;
    renderPrevious();
  } catch (error) {
    setNotice(`Could not check the public IP: ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

/* ---------- settings ---------- */

function retentionHours() {
  const unit = $('#retention-unit').value;
  if (unit === 'forever') return 0;
  const amount = Number($('#retention-amount').value);
  if (!Number.isInteger(amount) || amount < 1) throw new Error('Retention must be at least 1 hour or day.');
  const hours = unit === 'days' ? amount * 24 : amount;
  if (hours > 87_600) throw new Error('Retention cannot exceed 10 years. Choose Forever instead.');
  return hours;
}

async function saveSettings(event) {
  event.preventDefault();
  const submit = event.submitter;
  if (submit) submit.disabled = true;
  $('#save-state').textContent = 'Saving…';
  try {
    populate(await request('/relay/config', {
      method: 'POST',
      body: JSON.stringify({
        sabUrl: $('#sab-url').value.trim(),
        sabApiKey: $('#sab-key').value.trim(),
        grabMode: $('#grab-mode').value,
        maxNzbMegabytes: Number($('#max-size').value),
        nzbRetentionHours: retentionHours()
      })
    }));
    $('#sab-key').value = '';
    $('#save-state').textContent = 'Saved';
    setNotice('Settings saved.', 'good');
    await refreshNzbs();
  } catch (error) {
    $('#save-state').textContent = '';
    setNotice(error.message);
  } finally {
    if (submit) submit.disabled = false;
  }
}

async function testSab() {
  const button = $('#test-sab');
  const result = $('#test-result');
  button.disabled = true;
  result.className = 'test-result';
  result.textContent = 'Contacting SABnzbd…';
  try {
    const value = await request('/relay/test-sab', { method: 'POST', body: '{}' });
    result.className = 'test-result ok';
    result.textContent = `Connected${value.version ? ` — SABnzbd ${value.version}` : ''}`;
  } catch (error) {
    result.className = 'test-result bad';
    result.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

/* ---------- formatting ---------- */

function shortTime(timestamp) {
  if (!timestamp) return 'Never';
  return new Date(timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function emptyRow(body, columns, message) {
  const cell = body.insertRow().insertCell();
  cell.colSpan = columns;
  cell.className = 'empty';
  cell.textContent = message;
}

/* ---------- activity ---------- */

async function refreshLog() {
  try {
    const { entries } = await request('/relay/audit');
    const body = $('#activity-body');
    body.replaceChildren();

    const succeeded = entries.find(entry => entry.outcome.endsWith('uploaded'));
    const summary = $('#last-grab');
    if (succeeded) {
      summary.hidden = false;
      $('#last-grab-detail').textContent = `${succeeded.filename || 'NZB'} · ${shortTime(succeeded.timestamp)} · sent to SABnzbd`;
    } else {
      summary.hidden = true;
    }

    if (!entries.length) {
      emptyRow(body, 5, 'No grabs this session.');
      return;
    }
    for (const entry of entries) {
      const row = body.insertRow();
      row.insertCell().textContent = shortTime(entry.timestamp);

      const outcome = row.insertCell();
      const ok = entry.outcome.endsWith('uploaded');
      const held = entry.outcome === 'held';
      const state = document.createElement('span');
      state.className = `state ${ok ? 'ok' : held ? '' : 'bad'}`;
      state.append(ok ? icon(CHECK) : '', held ? 'held' : entry.outcome);
      outcome.append(state);

      row.insertCell().textContent = entry.sourceHost || '—';

      const file = row.insertCell();
      file.textContent = entry.filename || entry.error || '—';
      if (entry.bytes) {
        const size = document.createElement('span');
        size.className = 'file-meta';
        size.textContent = formatBytes(entry.bytes);
        file.append(size);
      }

      const egress = row.insertCell();
      egress.className = 'end mono';
      egress.textContent = entry.egressIp || '—';
    }
  } catch (error) {
    setNotice(error.message);
  }
}

/* ---------- inbox ---------- */

async function pushNzb(item, button) {
  button.disabled = true;
  button.textContent = 'Sending…';
  try {
    const result = await request(`/relay/nzbs/${encodeURIComponent(item.id)}/push`, { method: 'POST', body: '{}' });
    setNotice(`Sent ${item.filename} to SABnzbd${result.sabJobId ? ` as ${result.sabJobId}` : ''}.`, 'good');
    await Promise.all([refreshNzbs(), refreshLog()]);
  } catch (error) {
    setNotice(`SABnzbd did not accept it: ${error.message}`);
    button.disabled = false;
    button.textContent = 'Retry';
  }
}

async function deleteNzb(item, button) {
  if (!window.confirm(`Delete the saved file “${item.filename}”?`)) return;
  button.disabled = true;
  try {
    await request(`/relay/nzbs/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
    setNotice(`Deleted ${item.filename}.`, 'good');
    await refreshNzbs();
  } catch (error) {
    setNotice(`Could not delete it: ${error.message}`);
    button.disabled = false;
  }
}

async function refreshNzbs() {
  try {
    const result = await request('/relay/nzbs');
    $('#nzb-folder').textContent = result.directory;
    $('#open-nzb-folder').disabled = !result.canOpenFolder;

    const count = $('#inbox-count');
    count.textContent = result.items.length;
    count.hidden = result.items.length === 0;

    const body = $('#nzb-body');
    body.replaceChildren();
    if (!result.items.length) {
      emptyRow(body, 4, 'No saved NZBs.');
      return;
    }

    for (const item of result.items) {
      const row = body.insertRow();

      const file = row.insertCell();
      const name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = item.filename;
      name.title = item.filename;
      const meta = document.createElement('span');
      meta.className = 'file-meta';
      meta.textContent = `${item.sourceHost || 'unknown source'} · ${item.sha256.slice(0, 8)}`;
      file.append(name, meta);

      const size = row.insertCell();
      size.className = 'num';
      size.textContent = formatBytes(item.bytes);

      row.insertCell().textContent = shortTime(item.createdAt);

      const last = row.insertCell();
      last.className = 'end';
      const actions = document.createElement('div');
      actions.className = 'row-actions';

      const failed = item.lastSabStatus && (item.lastSabStatus < 200 || item.lastSabStatus >= 300);
      const state = document.createElement('span');
      if (!item.submitCount) {
        state.className = 'state';
        state.textContent = 'Not sent';
      } else if (failed) {
        state.className = 'state bad';
        state.textContent = 'SAB refused';
      } else {
        state.className = 'state ok';
        state.append(icon(CHECK), 'Sent');
      }

      const push = document.createElement('button');
      push.type = 'button';
      push.className = failed || !item.submitCount ? 'button small primary' : 'button small';
      push.textContent = failed ? 'Retry' : 'Send to SAB';
      push.addEventListener('click', () => pushNzb(item, push));

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'button small danger';
      remove.textContent = 'Delete';
      remove.addEventListener('click', () => deleteNzb(item, remove));

      actions.append(state, push, remove);
      last.append(actions);
    }
  } catch (error) {
    setNotice(`Could not load saved NZBs: ${error.message}`);
  }
}

/* ---------- wiring ---------- */

$('#settings-form').addEventListener('submit', saveSettings);
$('#check-egress').addEventListener('click', checkEgress);
$('#test-sab').addEventListener('click', testSab);
$('#refresh-log').addEventListener('click', refreshLog);
$('#refresh-nzbs').addEventListener('click', refreshNzbs);
$('#grab-mode').addEventListener('change', () => {
  // Preview the change immediately; it only takes effect once saved.
  $('#grab-mode-hint').textContent = GRAB_MODE_HINTS[$('#grab-mode').value];
});
$('#hold-banner-link').addEventListener('click', () => showView('inbox'));
$('#retention-unit').addEventListener('change', () => {
  $('#retention-amount').disabled = $('#retention-unit').value === 'forever';
});
$('#open-nzb-folder').addEventListener('click', async () => {
  try {
    await request('/relay/nzbs/open-folder', { method: 'POST', body: '{}' });
  } catch (error) {
    setNotice(error.message);
  }
});
$('#copy-key').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(config.bridgeApiKey);
    $('#copy-key').textContent = 'Copied';
    setTimeout(() => { $('#copy-key').textContent = 'Copy'; }, 1200);
  } catch {
    setNotice('Could not copy the key. Select it manually.');
  }
});

setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  Promise.all([refreshNzbs(), refreshLog()]);
  if (currentEgress) $('#egress-detail').textContent = `Fresh lookup ${relativeTime(currentEgress.at)}`;
  renderPrevious();
}, 10_000);

load();
