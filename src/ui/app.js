const $ = selector => document.querySelector(selector);

let config;
let toastTimer;

function setNotice(message, good = false) {
  const element = $('#notice');
  clearTimeout(toastTimer);
  element.textContent = message;
  element.className = `toast${good ? ' good' : ''}`;
  element.hidden = !message;
  if (message) {
    toastTimer = setTimeout(() => {
      element.hidden = true;
    }, good ? 5_000 : 9_000);
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

function populate(nextConfig) {
  config = nextConfig;
  $('#listen-port').textContent = config.listenPort;
  $('#bridge-key').textContent = config.bridgeApiKey;
  $('#sab-url').value = config.sabUrl;
  $('#max-size').value = config.maxNzbMegabytes;
  populateRetention(config.nzbRetentionHours);
  $('#sab-key-help').textContent = config.sabApiKeyConfigured
    ? `A key is saved${config.sabApiKeyProtected ? ' using protected system storage' : ''}. Leave this blank to keep it.`
    : 'No key is saved yet.';
}

async function load() {
  try {
    populate(await request('/relay/config'));
    const health = await request('/relay/health');
    $('#service-status').className = 'pill good';
    $('#service-status').innerHTML = `<span></span>Running · v${health.version}`;
    await Promise.all([refreshLog(), refreshNzbs()]);
  } catch (error) {
    $('#service-status').className = 'pill bad';
    $('#service-status').innerHTML = '<span></span>Needs attention';
    setNotice(error.message);
  }
}

async function checkEgress() {
  const button = $('#check-egress');
  button.disabled = true;
  button.textContent = 'Checking…';
  try {
    const result = await request('/relay/egress');
    $('#current-ip').textContent = result.ip;
    $('#current-ip').style.color = 'var(--accent)';
    const checked = new Date(result.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    $('#egress-detail').textContent = `Fresh lookup at ${checked}. Compare this address before and after connecting your VPN.`;
    setNotice(`NZB Relay is currently using ${result.ip}.`, true);
  } catch (error) {
    setNotice(`Egress check failed: ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = 'Check IP';
  }
}

function retentionHours() {
  const unit = $('#retention-unit').value;
  if (unit === 'forever') return 0;
  const amount = Number($('#retention-amount').value);
  if (!Number.isInteger(amount) || amount < 1) throw new Error('NZB retention must be at least 1 hour or day.');
  const hours = unit === 'days' ? amount * 24 : amount;
  if (hours > 87_600) throw new Error('NZB retention cannot exceed 10 years. Choose Forever for unlimited retention.');
  return hours;
}

async function saveSettings(event) {
  event.preventDefault();
  const submit = event.submitter;
  if (submit) submit.disabled = true;
  $('#save-state').textContent = 'Saving…';
  try {
    const payload = {
      sabUrl: $('#sab-url').value.trim(),
      sabApiKey: $('#sab-key').value.trim(),
      maxNzbMegabytes: Number($('#max-size').value),
      nzbRetentionHours: retentionHours()
    };
    populate(await request('/relay/config', { method: 'POST', body: JSON.stringify(payload) }));
    $('#sab-key').value = '';
    $('#save-state').textContent = 'Saved';
    setNotice('Settings saved.', true);
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
  button.disabled = true;
  button.textContent = 'Testing…';
  setNotice('Contacting SABnzbd…', true);
  try {
    const result = await request('/relay/test-sab', { method: 'POST', body: '{}' });
    const version = result.version ? ` v${result.version}` : '';
    setNotice(`SABnzbd connected${version}.`, true);
  } catch (error) {
    setNotice(`SABnzbd test failed: ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = 'Test SABnzbd';
  }
}

function shortTime(timestamp) {
  if (!timestamp) return 'Never';
  return new Date(timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function refreshLog() {
  try {
    const { entries } = await request('/relay/audit');
    const body = $('#activity-body');
    body.replaceChildren();
    if (!entries.length) {
      const row = body.insertRow();
      const cell = row.insertCell();
      cell.colSpan = 5;
      cell.className = 'empty';
      cell.textContent = 'No grabs this session.';
      return;
    }
    for (const entry of entries) {
      const row = body.insertRow();
      const values = [shortTime(entry.timestamp), entry.outcome, entry.sourceHost || '—', entry.filename || entry.error || '—', entry.egressIp || '—'];
      values.forEach((value, index) => {
        const cell = row.insertCell();
        cell.textContent = value;
        if (index === 1) cell.className = entry.outcome.endsWith('uploaded') ? 'outcome-ok' : 'outcome-bad';
      });
    }
  } catch (error) {
    setNotice(error.message);
  }
}

function archiveEmpty(body) {
  const row = body.insertRow();
  const cell = row.insertCell();
  cell.colSpan = 5;
  cell.className = 'empty';
  cell.textContent = 'No saved NZBs.';
}

async function pushNzb(item, button) {
  button.disabled = true;
  button.textContent = 'Pushing…';
  try {
    const result = await request(`/relay/nzbs/${encodeURIComponent(item.id)}/push`, { method: 'POST', body: '{}' });
    setNotice(`Sent ${item.filename} to SABnzbd${result.sabJobId ? ` as ${result.sabJobId}` : ''}.`, true);
    await Promise.all([refreshNzbs(), refreshLog()]);
  } catch (error) {
    setNotice(`SAB submission failed: ${error.message}`);
    button.disabled = false;
    button.textContent = 'Push to SAB';
  }
}

async function deleteNzb(item, button) {
  if (!window.confirm(`Delete the saved file “${item.filename}”?`)) return;
  button.disabled = true;
  try {
    await request(`/relay/nzbs/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
    setNotice(`Deleted ${item.filename}.`, true);
    await refreshNzbs();
  } catch (error) {
    setNotice(`Could not delete the NZB: ${error.message}`);
    button.disabled = false;
  }
}

async function refreshNzbs() {
  try {
    const result = await request('/relay/nzbs');
    $('#nzb-folder').textContent = result.directory;
    $('#open-nzb-folder').disabled = !result.canOpenFolder;
    const body = $('#nzb-body');
    body.replaceChildren();
    if (!result.items.length) {
      archiveEmpty(body);
      return;
    }
    for (const item of result.items) {
      const row = body.insertRow();
      row.insertCell().textContent = shortTime(item.createdAt);

      const fileCell = row.insertCell();
      const name = document.createElement('span');
      name.className = 'file-main';
      name.textContent = item.filename;
      name.title = item.filename;
      const proof = document.createElement('span');
      proof.className = 'file-meta';
      proof.textContent = `${item.sourceHost || 'unknown source'} · SHA-256 ${item.sha256.slice(0, 12)}…`;
      fileCell.append(name, proof);

      row.insertCell().textContent = formatBytes(item.bytes);
      const submission = row.insertCell();
      submission.textContent = item.submitCount
        ? `${shortTime(item.submittedAt)} · ${item.submitCount} attempt${item.submitCount === 1 ? '' : 's'}`
        : 'Not submitted';
      if (item.lastSabStatus && (item.lastSabStatus < 200 || item.lastSabStatus >= 300)) submission.className = 'outcome-bad';

      const actions = row.insertCell();
      const wrapper = document.createElement('div');
      wrapper.className = 'row-actions';
      const push = document.createElement('button');
      push.type = 'button';
      push.className = 'mini-button';
      push.textContent = 'Push to SAB';
      push.addEventListener('click', () => pushNzb(item, push));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'mini-button delete-button';
      remove.textContent = 'Delete';
      remove.addEventListener('click', () => deleteNzb(item, remove));
      wrapper.append(push, remove);
      actions.append(wrapper);
    }
  } catch (error) {
    setNotice(`Could not load saved NZBs: ${error.message}`);
  }
}

$('#settings-form').addEventListener('submit', saveSettings);
$('#check-egress').addEventListener('click', checkEgress);
$('#test-sab').addEventListener('click', testSab);
$('#refresh-log').addEventListener('click', refreshLog);
$('#refresh-nzbs').addEventListener('click', refreshNzbs);
$('#retention-unit').addEventListener('change', () => {
  $('#retention-amount').disabled = $('#retention-unit').value === 'forever';
});
$('#open-nzb-folder').addEventListener('click', async () => {
  try {
    await request('/relay/nzbs/open-folder', { method: 'POST', body: '{}' });
    setNotice('Opened the saved NZB folder.', true);
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
  if (document.visibilityState === 'visible') Promise.all([refreshNzbs(), refreshLog()]);
}, 10_000);

load();
