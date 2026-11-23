'use strict';

let cachedPlans = [];
let cachedVouchers = [];
let cachedActive = [];
let lastGenerated = [];
let loadingState = false;
let savingPlan = false;
let toastTimer = null;

const $ = id => document.getElementById(id);

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                  */
/* ------------------------------------------------------------------ */

function esc(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function fmtNgn(value) {
  if (value === null || value === undefined || value === '') return 'Not set';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'Not set';
  return '\u20a6' + n.toLocaleString();
}

function fmtGb(value) {
  if (value === null || value === undefined || value === '') return 'Not set';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'Not set';
  if (n <= 0) return 'Unlimited';
  if (n < 1) return Math.round(n * 1024) + ' MB';
  return (Number.isInteger(n) ? n : n.toFixed(2)) + ' GB';
}

function fmtBytes(value) {
  if (value === null || value === undefined || value === '') return '\u2014';
  const n = Number(value);
  if (!Number.isFinite(n)) return '\u2014';
  if (n <= 0) return '0 MB';
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined) return '\u2014';
  let n = Math.max(0, Math.round(Number(seconds)));
  if (!Number.isFinite(n)) return '\u2014';
  const days = Math.floor(n / 86400);
  n %= 86400;
  const hours = Math.floor(n / 3600);
  n %= 3600;
  const mins = Math.floor(n / 60);
  const secs = n % 60;
  if (days) return days + 'd' + (hours ? ' ' + hours + 'h' : '');
  if (hours) return hours + 'h' + (mins ? ' ' + mins + 'm' : '');
  if (mins) return mins + 'm';
  return secs + 's';
}

function fmtDate(value) {
  if (!value) return '\u2014';
  const text = String(value);
  const iso = text.includes('T') ? text : text.replace(' ', 'T') + 'Z';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? text : date.toLocaleString();
}

function setStatus(id, message, type) {
  const el = $(id);
  if (!el) return;
  el.textContent = message || '';
  el.className = 'status-line' + (type ? ' ' + type : '');
}

function toast(message, isError) {
  const el = $('toast');
  if (!el) return;
  el.textContent = message;
  el.className = 'toast show' + (isError ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = 'toast' + (isError ? ' err' : '');
  }, 5500);
}

async function api(path, options) {
  const opts = Object.assign({}, options || {});
  opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);

  const response = await fetch(path, opts);
  if (response.status === 401) {
    window.location.href = '/login';
    throw new Error('Session expired. Sign in again.');
  }

  let data = null;
  try {
    data = await response.json();
  } catch (err) {
    data = null;
  }

  if (!response.ok) {
    const error = new Error((data && data.error) || ('Request failed with HTTP ' + response.status));
    error.data = data || {};
    throw error;
  }
  return data || {};
}

function errorText(err) {
  if (!err) return 'Unknown error';
  let text = err.message || String(err);
  if (err.data && err.data.hint) text += ' ' + err.data.hint;
  return text;
}

async function withButton(button, busyText, work) {
  if (!button) return work();
  const original = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  try {
    return await work();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

/* ------------------------------------------------------------------ */
/* Router banner                                                       */
/* ------------------------------------------------------------------ */

function renderBanner(router) {
  const el = $('router_banner');
  if (!el) return;

  if (!router || (!router.connected && !router.error)) {
    el.className = 'banner warn';
    el.innerHTML = 'RouterOS status is unavailable. Click <strong>Sync Now</strong> to retry.';
    return;
  }

  if (router.connected) {
    el.className = 'banner ok';
    el.innerHTML = '<strong>RouterOS connected</strong> &middot; ' +
      esc(router.user) + '@' + esc(router.host) + ':' + esc(router.port) +
      ' &middot; ' + cachedPlans.filter(p => p.live).length + ' live hotspot profile(s) loaded.';
    return;
  }

  el.className = 'banner err';
  const extra = router.errors && router.errors.length > 1
    ? ' <span class="muted">(' + (router.errors.length - 1) + ' more RouterOS read error(s); see server console.)</span>'
    : '';
  el.innerHTML = '<strong>RouterOS error:</strong> ' + esc(router.error || 'Unknown error') +
    (router.hint ? '<br><span class="muted">' + esc(router.hint) + '</span>' : '') + extra;
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

async function loadSettings() {
  try {
    const settings = await api('/api/settings');
    $('s_host').value = settings.host || '';
    $('s_port').value = settings.port || 8728;
    $('s_user').value = settings.user || '';
    $('s_pass').value = settings.password || '';
    setStatus('settings_status',
      settings.password_set
        ? 'Credentials loaded from saved settings. Use Test Connection to verify them.'
        : 'No API password saved. Enter the RouterOS API password and click Save Credentials.',
      'info');
  } catch (err) {
    setStatus('settings_status', 'Could not load settings: ' + errorText(err), 'err');
  }
}

async function saveSettings() {
  const button = $('save_settings_btn');
  const host = $('s_host').value.trim();
  const port = Number($('s_port').value);
  const user = $('s_user').value.trim();
  const password = $('s_pass').value;

  if (!host) {
    setStatus('settings_status', 'RouterOS host is required.', 'err');
    return;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    setStatus('settings_status', 'Port must be a whole number between 1 and 65535 (normally 8728).', 'err');
    return;
  }
  if (!user) {
    setStatus('settings_status', 'RouterOS API username is required.', 'err');
    return;
  }

  await withButton(button, 'Saving\u2026', async () => {
    setStatus('settings_status', 'Saving credentials to .env and SQLite\u2026', 'info');
    try {
      await api('/api/settings', { method: 'POST', body: { host, port, user, password } });
      setStatus('settings_status', 'Saved. All voucher and plan actions now use these credentials automatically.', 'ok');
      toast('RouterOS credentials saved to .env and SQLite.');
      await loadState();
    } catch (err) {
      setStatus('settings_status', errorText(err), 'err');
      toast(errorText(err), true);
    }
  });
}

async function testSettings() {
  const button = $('test_settings_btn');
  const payload = {
    host: $('s_host').value.trim(),
    port: Number($('s_port').value),
    user: $('s_user').value.trim(),
    password: $('s_pass').value
  };

  await withButton(button, 'Testing\u2026', async () => {
    setStatus('settings_status', 'Connecting to RouterOS at ' + payload.host + ':' + payload.port + '\u2026', 'info');
    try {
      const result = await api('/api/settings/test', { method: 'POST', body: payload });
      setStatus('settings_status',
        'Connected: RouterOS ' + result.version + ' on ' + result.board + ' \u2022 ' +
        result.profiles + ' hotspot profile(s).',
        'ok');
      toast('RouterOS connection successful.');
    } catch (err) {
      setStatus('settings_status', errorText(err), 'err');
      toast(errorText(err), true);
    }
  });
}

function togglePassword() {
  const input = $('s_pass');
  const button = $('toggle_pass_btn');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  button.textContent = show ? 'Hide' : 'Show';
}

/* ------------------------------------------------------------------ */
/* Main state                                                          */
/* ------------------------------------------------------------------ */

async function loadState() {
  if (loadingState) return;
  loadingState = true;
  try {
    const data = await api('/api/state');
    cachedPlans = Array.isArray(data.plans) ? data.plans : [];
    cachedVouchers = Array.isArray(data.vouchers) ? data.vouchers : [];
    cachedActive = Array.isArray(data.active) ? data.active : [];

    $('k_active').textContent = cachedActive.length;
    $('k_total').textContent = (data.stats && data.stats.total_vouchers) || 0;
    $('k_ngn').textContent = fmtNgn((data.stats && data.stats.total_ngn) || 0);
    $('k_plans').textContent = cachedPlans.filter(p => p.live).length;

    renderBanner(data.router);
    updatePlanSelect();
    renderPlans();
    renderVouchers();
    renderSessions();
    $('sync_time').textContent = 'Synced ' + new Date().toLocaleTimeString();
  } catch (err) {
    console.error('[state]', err);
    renderBanner({ connected: false, error: err.message, hint: err.data && err.data.hint });
    $('sync_time').textContent = 'Sync failed';
  } finally {
    loadingState = false;
  }
}

function updatePlanSelect() {
  const select = $('v_plan');
  const previous = select.value;
  if (!cachedPlans.length) {
    select.innerHTML = '<option value="">No plans available — save a plan first</option>';
    return;
  }
  select.innerHTML = cachedPlans.map(plan =>
    '<option value="' + esc(plan.profile_name) + '">' +
    esc(plan.profile_name) + ' \u2014 ' + esc(fmtNgn(plan.price_ngn)) +
    ' (' + esc(fmtGb(plan.data_gb)) + ', ' + esc(plan.uptime_limit || 'none') + ')' +
    (plan.live ? '' : ' [missing on router]') +
    '</option>'
  ).join('');
  if (cachedPlans.some(plan => plan.profile_name === previous)) select.value = previous;
}

/* ------------------------------------------------------------------ */
/* Plans                                                               */
/* ------------------------------------------------------------------ */

function renderPlans() {
  const tbody = $('plans_tb');
  if (!cachedPlans.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">No hotspot profiles found. Create one above or click Sync Now.</td></tr>';
    return;
  }

  tbody.innerHTML = cachedPlans.map(plan => {
    const status = plan.live
      ? '<span class="badge b-ok">Live</span>'
      : '<span class="badge b-miss">Missing on router</span>';
    return '<tr>' +
      '<td><strong>' + esc(plan.profile_name) + '</strong></td>' +
      '<td>' + esc(fmtNgn(plan.price_ngn)) + '</td>' +
      '<td>' + esc(plan.rate_limit || '\u2014') + '</td>' +
      '<td>' + esc(fmtGb(plan.data_gb)) + '</td>' +
      '<td>' + esc(plan.uptime_limit || 'none') + '</td>' +
      '<td>' + esc(plan.shared_users || '1') + '</td>' +
      '<td>' + status + '</td>' +
      '<td class="actions">' +
        '<button type="button" class="sec" data-act="edit-plan" data-name="' + esc(plan.profile_name) + '">Edit</button> ' +
        '<button type="button" class="del" data-act="delete-plan" data-name="' + esc(plan.profile_name) + '">Delete</button>' +
      '</td>' +
    '</tr>';
  }).join('');
}

function editPlan(name) {
  const plan = cachedPlans.find(p => p.profile_name === name);
  if (!plan) return;

  $('p_orig').value = plan.profile_name;
  $('p_name').value = plan.profile_name;
  $('p_price').value = plan.price_ngn === null || plan.price_ngn === undefined ? '' : plan.price_ngn;
  $('p_rate').value = plan.rate_limit || '';
  $('p_gb').value = plan.data_gb === null || plan.data_gb === undefined ? '' : plan.data_gb;
  $('p_uptime').value = plan.uptime_limit || 'none';
  $('plan_form_title').textContent = 'Editing Plan: ' + plan.profile_name;
  setStatus('plan_status', 'Loaded "' + plan.profile_name + '" from RouterOS. Edit the values and save.', 'info');
  $('plan_card').scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('p_name').focus();
}

function resetPlanForm() {
  $('p_orig').value = '';
  $('p_name').value = '';
  $('p_price').value = '';
  $('p_rate').value = '';
  $('p_gb').value = '';
  $('p_uptime').value = '';
  $('plan_form_title').textContent = 'Create / Edit Plan Profile';
}

async function savePlan() {
  if (savingPlan) return;
  const payload = {
    original_name: $('p_orig').value.trim(),
    profile_name: $('p_name').value.trim(),
    price_ngn: $('p_price').value,
    rate_limit: $('p_rate').value.trim(),
    data_gb: $('p_gb').value,
    uptime_limit: $('p_uptime').value.trim()
  };

  if (!payload.profile_name) {
    setStatus('plan_status', 'Profile name is required.', 'err');
    $('p_name').focus();
    return;
  }
  if (!payload.rate_limit) {
    setStatus('plan_status', 'Rate limit is required (for example 5M/5M).', 'err');
    $('p_rate').focus();
    return;
  }
  if (!payload.uptime_limit) {
    setStatus('plan_status', 'Session timeout / uptime is required (for example 1h, 1d or none).', 'err');
    $('p_uptime').focus();
    return;
  }

  const button = $('save_plan_btn');
  savingPlan = true;
  await withButton(button, 'Saving to RouterOS\u2026', async () => {
    setStatus('plan_status', 'Updating RouterOS profile "' + payload.profile_name + '"\u2026', 'info');
    try {
      const result = await api('/api/plans', { method: 'POST', body: payload });
      resetPlanForm();
      toast('Plan "' + result.plan_name + '" ' + (result.action || 'saved') + ' on MikroTik.');
      await loadState();
      setStatus('plan_status',
        'Plan "' + result.plan_name + '" ' + (result.action || 'saved') +
        ' on RouterOS and saved to SQLite. The plans list has been refreshed.', 'ok');
    } catch (err) {
      setStatus('plan_status', errorText(err), 'err');
      toast(errorText(err), true);
    } finally {
      savingPlan = false;
    }
  });
}

async function deletePlan(name) {
  const plan = cachedPlans.find(p => p.profile_name === name);
  const suffix = plan && !plan.live ? ' (it is already missing on RouterOS)' : '';
  if (!window.confirm('Delete plan "' + name + '" from RouterOS and SQLite?' + suffix)) return;

  try {
    const result = await api('/api/plans/delete', { method: 'POST', body: { profile_name: name } });
    toast('Plan "' + name + '" deleted.' + (result.warning ? ' ' + result.warning : ''), Boolean(result.warning));
    if ($('p_orig').value === name) {
      resetPlanForm();
      setStatus('plan_status', 'Deleted plan "' + name + '".', 'ok');
    }
    await loadState();
  } catch (err) {
    toast(errorText(err), true);
    setStatus('plan_status', errorText(err), 'err');
  }
}

/* ------------------------------------------------------------------ */
/* Vouchers                                                            */
/* ------------------------------------------------------------------ */

function voucherCard(voucher) {
  return '<div class="vcard" data-act="copy" data-code="' + esc(voucher.code) + '" title="Click to copy voucher code">' +
    '<div class="vcard-brand">PRESDOCAFE WI-FI</div>' +
    '<div class="vcard-code">' + esc(voucher.code) + '</div>' +
    '<div class="vcard-row">Plan: <b>' + esc(voucher.plan_profile || '\u2014') + '</b></div>' +
    '<div class="vcard-row">Price: <b>' + esc(fmtNgn(voucher.price_ngn)) + '</b></div>' +
    '<div class="vcard-row">Speed: <b>' + esc(voucher.rate_limit || '\u2014') + '</b></div>' +
    '<div class="vcard-row">Data: <b>' + esc(fmtGb(voucher.data_gb)) + '</b></div>' +
    '<div class="vcard-row">Uptime: <b>' + esc(voucher.uptime_limit || 'none') + '</b></div>' +
    '<div class="vcard-row muted">Created: ' + esc(fmtDate(voucher.created_at)) + '</div>' +
    '<div class="vcard-hint">Click to copy code</div>' +
  '</div>';
}

function renderGeneratedCards(list) {
  const area = $('print_area');
  if (!list || !list.length) {
    area.innerHTML = '';
    return;
  }
  area.innerHTML = list.map(voucherCard).join('');
}

async function generateVouchers() {
  const planProfile = $('v_plan').value;
  const count = Math.max(1, Math.min(200, parseInt($('v_count').value, 10) || 5));
  const prefix = ($('v_prefix').value.trim() || 'PC').toUpperCase();

  if (!planProfile) {
    setStatus('voucher_status', 'Save a plan first, then select it.', 'err');
    return;
  }

  const button = $('gen_btn');
  await withButton(button, 'Generating\u2026', async () => {
    setStatus('voucher_status', 'Creating ' + count + ' voucher(s) on RouterOS\u2026', 'info');
    try {
      const result = await api('/api/vouchers/generate', {
        method: 'POST',
        body: { plan_profile: planProfile, count, prefix }
      });
      lastGenerated = result.created || [];
      renderGeneratedCards(lastGenerated);

      let message = 'Created ' + lastGenerated.length + ' voucher(s) for ' + planProfile + '.';
      if (result.errors && result.errors.length) {
        message += ' ' + result.errors.length + ' failed. ' + result.errors.slice(0, 2).join(' | ');
        setStatus('voucher_status', message, 'err');
        toast('Partial success: ' + result.errors[0], true);
      } else {
        setStatus('voucher_status', message + ' Click a card to copy its code, or print the slips.', 'ok');
        toast(message);
      }
      await loadState();
    } catch (err) {
      setStatus('voucher_status', errorText(err), 'err');
      toast(errorText(err), true);
    }
  });
}

function renderVouchers() {
  const tbody = $('users_tb');
  const query = ($('u_filter').value || '').toLowerCase().trim();
  const rows = cachedVouchers.filter(voucher => {
    if (!query) return true;
    return [voucher.code, voucher.plan_profile, voucher.comment, voucher.locked_mac, voucher.mac]
      .some(value => String(value || '').toLowerCase().includes(query));
  });

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">' +
      (cachedVouchers.length ? 'No vouchers match that filter.' : 'No vouchers yet. Generate some above.') +
      '</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(voucher => {
    const cap = Number(voucher.data_bytes || 0);
    const hasCap = cap > 0;
    const usedText = voucher.data_used_bytes === null || voucher.data_used_bytes === undefined
      ? '\u2014'
      : fmtBytes(voucher.data_used_bytes);
    let capText;
    if (hasCap) capText = fmtBytes(cap);
    else if (voucher.data_gb === 0) capText = 'Unlimited';
    else capText = '\u2014';

    let dataSub = '';
    if (voucher.remaining_data_bytes !== null && voucher.remaining_data_bytes !== undefined) {
      dataSub = '<span class="sub">' + fmtBytes(voucher.remaining_data_bytes) + ' left</span>';
    } else if (!hasCap) {
      dataSub = '<span class="sub">Unlimited data</span>';
    }

    const remainingTime = voucher.session_time_left ||
      (voucher.remaining_uptime_seconds !== null && voucher.remaining_uptime_seconds !== undefined
        ? fmtDuration(voucher.remaining_uptime_seconds)
        : null);

    const badges = [];
    if (voucher.online) badges.push('<span class="badge b-on">Online</span>');
    if (voucher.locked_mac) badges.push('<span class="badge b-lock">MAC Locked</span>');
    if (voucher.disabled) badges.push('<span class="badge b-dis">Disabled</span>');
    if (!voucher.live) badges.push('<span class="badge b-miss">Not on router</span>');
    if (!badges.length) badges.push('<span class="badge b-ok">Ready</span>');

    const mac = voucher.locked_mac || voucher.mac || '\u2014';
    const actions = '<td class="actions">' +
      '<button type="button" class="sec" data-act="copy" data-code="' + esc(voucher.code) + '">Copy</button> ' +
      '<button type="button" class="sec" data-act="print-voucher" data-code="' + esc(voucher.code) + '">Print</button> ' +
      (voucher.live
        ? '<button type="button" class="sec" data-act="unlock" data-name="' + esc(voucher.code) + '">Reset MAC</button> '
        : '') +
      (voucher.online
        ? '<button type="button" class="sec" data-act="kick" data-id="' + esc(voucher.active_id) + '" data-name="' + esc(voucher.code) + '">Kick</button> '
        : '') +
      '<button type="button" class="del" data-act="delete-voucher" data-name="' + esc(voucher.code) + '">Delete</button>' +
    '</td>';

    return '<tr>' +
      '<td><strong>' + esc(voucher.code) + '</strong>' +
        (voucher.comment ? '<span class="sub">' + esc(voucher.comment) + '</span>' : '') + '</td>' +
      '<td>' + esc(voucher.plan_profile || '\u2014') +
        '<span class="sub">' + esc(fmtNgn(voucher.price_ngn)) + '</span></td>' +
      '<td>' + esc(voucher.rate_limit || '\u2014') + '</td>' +
      '<td>' + usedText + ' / ' + capText + dataSub + '</td>' +
      '<td>' + esc(voucher.uptime_used || '\u2014') + ' / ' + esc(voucher.uptime_limit || 'none') +
        (remainingTime ? '<span class="sub">' + esc(remainingTime) + ' left</span>' : '') + '</td>' +
      '<td>' + badges.join(' ') + '<span class="sub">MAC: ' + esc(mac) + '</span></td>' +
      '<td>' + esc(fmtDate(voucher.created_at)) + '</td>' +
      actions +
    '</tr>';
  }).join('');
}

async function resetMac(name) {
  if (!window.confirm('Reset the MAC lock for voucher "' + name + '"? The voucher will be re-enabled and can bind to a new device on next login.')) return;
  try {
    await api('/api/vouchers/unlock-mac', { method: 'POST', body: { name } });
    toast('MAC lock reset for ' + name + '.');
    await loadState();
  } catch (err) {
    toast(errorText(err), true);
  }
}

async function deleteVoucher(name) {
  if (!window.confirm('Delete voucher "' + name + '" from RouterOS and SQLite? This also disconnects an active session.')) return;
  try {
    await api('/api/vouchers/delete', { method: 'POST', body: { name } });
    toast('Voucher ' + name + ' deleted.');
    await loadState();
  } catch (err) {
    toast(errorText(err), true);
  }
}

/* ------------------------------------------------------------------ */
/* Active sessions                                                     */
/* ------------------------------------------------------------------ */

function renderSessions() {
  const tbody = $('active_tb');
  if (!cachedActive.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty">No active HotSpot sessions.</td></tr>';
    return;
  }

  tbody.innerHTML = cachedActive.map(session => {
    return '<tr>' +
      '<td><strong>' + esc(session.user || '\u2014') + '</strong></td>' +
      '<td>' + esc(session.plan_profile || '\u2014') + '</td>' +
      '<td>' + esc(fmtNgn(session.price_ngn)) + '</td>' +
      '<td>' + esc(session.rate_limit || '\u2014') + '</td>' +
      '<td>' + esc(session.address || '\u2014') + '</td>' +
      '<td>' + esc(session['mac-address'] || '\u2014') + '</td>' +
      '<td>' + esc(session.uptime || '\u2014') + '</td>' +
      '<td>' + esc(session['session-time-left'] || '\u2014') + '</td>' +
      '<td>' + esc(fmtBytes(session.session_bytes)) + '</td>' +
      '<td class="actions">' +
        '<button type="button" class="del" data-act="kick" data-id="' + esc(session.active_id) + '" data-name="' + esc(session.user) + '">Kick</button>' +
      '</td>' +
    '</tr>';
  }).join('');
}

async function kickSession(id, name) {
  if (!window.confirm('Kick active session for "' + (name || 'this voucher') + '"?')) return;
  try {
    await api('/api/sessions/kick', { method: 'POST', body: { id, user: name } });
    toast('Session kicked' + (name ? ' for ' + name : '') + '.');
    await loadState();
  } catch (err) {
    toast(errorText(err), true);
  }
}

/* ------------------------------------------------------------------ */
/* Copy / print                                                        */
/* ------------------------------------------------------------------ */

async function copyText(text) {
  if (!text) return;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    toast('Copied ' + text);
  } catch (err) {
    toast('Copy failed: ' + err.message, true);
  }
}

function findVoucher(code) {
  return lastGenerated.find(v => v.code === code) ||
    cachedVouchers.find(v => v.code === code) ||
    null;
}

function printVoucher(code) {
  const voucher = findVoucher(code);
  if (!voucher) {
    toast('Voucher ' + code + ' not found in the current list.', true);
    return;
  }
  const area = $('print_area');
  const backup = area.innerHTML;
  area.innerHTML = voucherCard(voucher);
  toast('Opening print dialog for ' + code + '\u2026');
  const restore = () => {
    area.innerHTML = backup;
    window.removeEventListener('afterprint', restore);
  };
  window.addEventListener('afterprint', restore);
  window.print();
}

function printAllSlips() {
  const rows = cachedVouchers.filter(voucher => voucher.live);
  if (!rows.length) {
    toast('No live vouchers to print. Generate vouchers first.', true);
    return;
  }
  $('print_area').innerHTML = rows.map(voucherCard).join('');
  toast('Printing ' + rows.length + ' voucher slip(s)\u2026');
  window.print();
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

document.addEventListener('click', async event => {
  const target = event.target.closest('[data-act]');
  if (!target) return;
  const action = target.dataset.act;

  try {
    if (action === 'copy') {
      await copyText(target.dataset.code);
    } else if (action === 'print-voucher') {
      printVoucher(target.dataset.code);
    } else if (action === 'edit-plan') {
      editPlan(target.dataset.name);
    } else if (action === 'delete-plan') {
      await deletePlan(target.dataset.name);
    } else if (action === 'unlock') {
      await resetMac(target.dataset.name);
    } else if (action === 'kick') {
      await kickSession(target.dataset.id, target.dataset.name);
    } else if (action === 'delete-voucher') {
      await deleteVoucher(target.dataset.name);
    }
  } catch (err) {
    toast(errorText(err), true);
  }
});

document.addEventListener('DOMContentLoaded', () => {
  $('save_plan_btn').addEventListener('click', savePlan);
  $('clear_plan_btn').addEventListener('click', () => {
    resetPlanForm();
    setStatus('plan_status', 'Form cleared. Enter a new plan or click Edit on an existing plan.', 'info');
  });
  $('gen_btn').addEventListener('click', generateVouchers);
  $('print_all_btn').addEventListener('click', printAllSlips);
  $('save_settings_btn').addEventListener('click', saveSettings);
  $('test_settings_btn').addEventListener('click', testSettings);
  $('toggle_pass_btn').addEventListener('click', togglePassword);
  $('u_filter').addEventListener('input', renderVouchers);
  $('sync_btn').addEventListener('click', async () => {
    await withButton($('sync_btn'), 'Syncing\u2026', async () => {
      await loadState();
      toast('Plans, vouchers and sessions synchronised.');
    });
  });

  loadSettings();
  loadState();
  setInterval(() => {
    if (document.visibilityState === 'visible' && !savingPlan) loadState();
  }, 12000);
});
