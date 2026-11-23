require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { RouterOSAPI, Channel, Receiver } = require('node-routeros');

const app = express();
const db = new Database(path.join(__dirname, 'presdocafe.db'));

/*
 * RouterOS 7.16+ can answer an empty /print with "!empty" followed by "!done".
 * node-routeros 1.6.8 does not know "!empty", closes the channel and then throws
 * when the "!done" arrives (or throws synchronously from an event handler).
 * Treat it as "no rows" and keep the channel open for the final "!done".
 */
const originalProcessPacket = Channel.prototype.processPacket;
Channel.prototype.processPacket = function (packet) {
  if (Array.isArray(packet) && packet[0] === '!empty') {
    packet.shift();
    return;
  }
  return originalProcessPacket.call(this, packet);
};
// Never let an unexpected API reply crash the whole admin portal.
Channel.prototype.onUnknown = function (reply) {
  console.error('[RouterOS] Unexpected API reply "' + String(reply) + '" ignored.');
};

// A late response for a channel that was already closed used to throw from inside
// the socket data handler and take down the process. Log it and resynchronise instead.
const originalSendTagData = Receiver.prototype.sendTagData;
Receiver.prototype.sendTagData = function (tagName) {
  if (!this.tags || !this.tags.get(tagName)) {
    console.error('[RouterOS] Dropped a late response for an unknown API tag; the connection will resynchronise.');
    if (typeof this.cleanUp === 'function') this.cleanUp();
    return;
  }
  return originalSendTagData.call(this, tagName);
};

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/assets', express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' }
}));

/* ------------------------------------------------------------------ */
/* Database                                                            */
/* ------------------------------------------------------------------ */

db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_name TEXT UNIQUE NOT NULL,
    price_ngn INTEGER NOT NULL,
    rate_limit TEXT NOT NULL,
    data_gb REAL NOT NULL,
    uptime_limit TEXT NOT NULL,
    session_timeout TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS vouchers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    plan_profile TEXT NOT NULL,
    price_ngn INTEGER NOT NULL,
    data_bytes INTEGER NOT NULL,
    uptime_limit TEXT NOT NULL,
    rate_limit TEXT NOT NULL DEFAULT '',
    session_timeout TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

function ensureColumn(table, column, definition) {
  const cols = db.prepare('PRAGMA table_info(' + table + ')').all();
  if (!cols.some(c => c.name === column)) {
    db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + definition);
  }
}
ensureColumn('vouchers', 'rate_limit', "TEXT NOT NULL DEFAULT ''");
ensureColumn('vouchers', 'session_timeout', "TEXT NOT NULL DEFAULT ''");
ensureColumn('vouchers', 'created_at', 'TEXT');

/* ------------------------------------------------------------------ */
/* Settings (.env + SQLite fallback)                                  */
/* ------------------------------------------------------------------ */

const SETTING_KEYS = ['MIKROTIK_HOST', 'MIKROTIK_PORT', 'MIKROTIK_USER', 'MIKROTIK_PASS'];

function settingGet(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : undefined;
}
function settingSet(key, value) {
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
    .run(key, String(value));
}
function syncSettingsFromEnv() {
  for (const key of SETTING_KEYS) {
    if (process.env[key] !== undefined) settingSet(key, process.env[key]);
  }
}
syncSettingsFromEnv();

function envOr(key, fallback) {
  if (process.env[key] !== undefined && process.env[key] !== '') return process.env[key];
  const saved = settingGet(key);
  if (saved !== undefined && saved !== '') return saved;
  return fallback;
}

function getRouterConfig() {
  const port = Number(envOr('MIKROTIK_PORT', '8728'));
  return {
    host: envOr('MIKROTIK_HOST', '192.168.88.1'),
    port: Number.isFinite(port) && port > 0 ? port : 8728,
    user: envOr('MIKROTIK_USER', 'admin'),
    password: envOr('MIKROTIK_PASS', '')
  };
}

function quoteEnvValue(value) {
  return JSON.stringify(String(value === null || value === undefined ? '' : value));
}

function updateEnvFile(updates) {
  const envPath = path.join(__dirname, '.env');
  const content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const keys = Object.keys(updates);
  const seen = new Set();

  const lines = content.split(/\r?\n/).map(line => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match && Object.prototype.hasOwnProperty.call(updates, match[1])) {
      seen.add(match[1]);
      return match[1] + '=' + quoteEnvValue(updates[match[1]]);
    }
    return line;
  });

  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const key of keys) {
    if (!seen.has(key)) lines.push(key + '=' + quoteEnvValue(updates[key]));
  }

  const tmp = envPath + '.tmp';
  fs.writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600 });
  fs.renameSync(tmp, envPath);
  for (const key of keys) process.env[key] = String(updates[key]);
}

/* ------------------------------------------------------------------ */
/* RouterOS helpers                                                    */
/* ------------------------------------------------------------------ */

class RouterOSError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'RouterOSError';
    this.cause = cause;
  }
}

function httpError(status, message, hint) {
  const err = new Error(message);
  err.status = status;
  if (hint) err.hint = hint;
  return err;
}

function formatRosError(err) {
  if (!err) return 'Unknown RouterOS error';
  if (typeof err === 'string') return err;
  let message = err.message || String(err);
  if (err.errno && !message.includes(String(err.errno))) message += ' (' + err.errno + ')';
  if (err.code && !message.includes(String(err.code))) message += ' [' + err.code + ']';
  return message;
}

function routerHint(err) {
  const text = ((err && err.message) || '') + ' ' + ((err && err.cause && err.cause.message) || '');
  if (/CANTLOGIN|invalid user name|username or password|password is invalid|login/i.test(text)) {
    return 'Check the API username/password in RouterOS Connection Settings. The RouterOS user also needs read/write policy for hotspot and IP services.';
  }
  if (/ECONNREFUSED/i.test(text)) {
    return 'The API service is refusing connections. Verify the port and run "/ip service enable api" on RouterOS.';
  }
  if (/timeout|timed out|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT/i.test(text)) {
    return 'The router did not answer in time. Verify the host, the API port, and any firewall rules between this server and the router.';
  }
  if (/does not match any value|no such item|not found|invalid value/i.test(text)) {
    return 'RouterOS rejected one of the values. Check the profile name, rate limit (for example 5M/5M), session timeout (for example 1h, 1d or none) and data cap.';
  }
  return 'Open RouterOS Connection Settings, click Test Connection, and check the server console for the full RouterOS error.';
}

function getRouterApi(cfg) {
  const api = new RouterOSAPI({
    host: cfg.host,
    port: Number(cfg.port),
    user: cfg.user,
    password: cfg.password,
    timeout: 12
  });
  api.on('error', err => {
    console.error('[RouterOS] socket error (' + cfg.host + ':' + cfg.port + '): ' + formatRosError(err));
  });
  api.on('close', () => {
    // Normal during shutdown; kept for diagnostics only.
  });
  return api;
}

async function withRouter(fn, cfg) {
  const config = cfg || getRouterConfig();
  const api = getRouterApi(config);
  try {
    await api.connect();
  } catch (err) {
    const reason = formatRosError(err);
    const message = 'Cannot connect to RouterOS at ' + config.host + ':' + config.port +
      ' as "' + config.user + '": ' + reason;
    console.error('[RouterOS] ' + message);
    throw new RouterOSError(message, err);
  }

  try {
    return await fn(api, config);
  } finally {
    try {
      await api.close();
    } catch (err) {
      // Connection may already be closed after a RouterOS failure.
    }
  }
}

async function rosWrite(api, command, params = [], timeoutMs = 20000) {
  let timer;
  try {
    const result = await Promise.race([
      api.write(command, params),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timed out after ' + Math.round(timeoutMs / 1000) + 's')), timeoutMs);
      })
    ]);
    return Array.isArray(result) ? result : [];
  } catch (err) {
    const message = command + ' failed: ' + formatRosError(err);
    console.error('[RouterOS] ' + message);
    throw new RouterOSError(message, err);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

const MAC_LOCK_SCRIPT = `:local u $user; :local m $"mac-address"; :local uu [/ip hotspot user find name=$u]; :if ([:len $uu] > 0) do={ :local c [/ip hotspot user get $uu comment]; :if ([:typeof $c] = "nil") do={ :set c "" }; :local p [:find $c "LOCKED_MAC="]; :if ([:typeof $p] = "nil") do={ /ip hotspot user set $uu comment=($c . " LOCKED_MAC=" . $m) } else={ :local s ($p + 11); :local lk [:pick $c $s ($s + 17)]; :if ($lk != $m) do={ /ip hotspot user disable $uu; /ip hotspot active remove [find user=$u]; :log warning ("HotSpot voucher " . $u . " blocked: MAC " . $m . " != " . $lk) } } }`;

const passwordHash = bcrypt.hashSync(process.env.ADMIN_PASS || 'admin123', 10);

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized. Sign in again.' });
  return res.redirect('/login');
}

function randomCode(prefix = 'PC', len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = prefix + '-';
  for (let i = 0; i < len; i++) out += chars[crypto.randomInt(chars.length)];
  return out;
}

function isSystemProfile(profile) {
  const name = String((profile && profile.name) || '').toLowerCase();
  return Boolean(profile) && (
    profile.default === 'true' ||
    name === 'default' ||
    name === 'default-trial' ||
    name.startsWith('default-')
  );
}

function isSystemUser(user) {
  const name = String((user && user.name) || '').toLowerCase();
  return Boolean(user) && (
    user.default === 'true' ||
    name === 'default-trial' ||
    name.startsWith('default-')
  );
}

function extractLockedMac(comment) {
  const match = String(comment || '').match(/LOCKED_MAC=([0-9A-Fa-f:-]{11,17})/);
  return match ? match[1] : null;
}

function stripLockedMac(comment) {
  return String(comment || '').replace(/\s*LOCKED_MAC=[0-9A-Fa-f:-]+/g, '').trim();
}

function parseRosDuration(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toLowerCase();
  if (!text || text === 'none' || text === 'unlimited' || text === 'never') return null;

  if (text.includes(':')) {
    let days = 0;
    let rest = text;
    const dayMatch = rest.match(/^(\d+)d(.*)$/);
    if (dayMatch) {
      days = Number(dayMatch[1]);
      rest = dayMatch[2];
    }
    const parts = rest.split(':').map(Number);
    if (!parts.length || parts.some(n => !Number.isFinite(n))) return null;
    let seconds = days * 86400;
    if (parts.length >= 3) seconds += parts[0] * 3600 + parts[1] * 60 + parts[2];
    else if (parts.length === 2) seconds += parts[0] * 60 + parts[1];
    else seconds += parts[0];
    return seconds;
  }

  const units = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };
  const re = /(\d+(?:\.\d+)?)\s*(w|d|h|m|s)/g;
  let total = 0;
  let matched = false;
  let match;
  while ((match = re.exec(text)) !== null) {
    matched = true;
    total += Number(match[1]) * units[match[2]];
  }
  if (matched) return Math.round(total);
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text));
  return null;
}

function buildPlanRows(profiles, dbPlans) {
  const savedByProfile = new Map(dbPlans.map(p => [p.profile_name, p]));
  const rows = [];
  const seen = new Set();

  for (const profile of profiles) {
    if (!profile || !profile.name || isSystemProfile(profile)) continue;
    const saved = savedByProfile.get(profile.name);
    seen.add(profile.name);
    rows.push({
      profile_name: profile.name,
      price_ngn: saved ? saved.price_ngn : null,
      rate_limit: profile['rate-limit'] || '',
      data_gb: saved ? saved.data_gb : null,
      uptime_limit: profile['session-timeout'] || (saved ? saved.uptime_limit : 'none'),
      session_timeout: profile['session-timeout'] || 'none',
      shared_users: profile['shared-users'] || '1',
      live: true,
      router_id: profile['.id'] || null
    });
  }

  // Profiles saved in SQLite but missing on the router are still shown so they can be recreated.
  for (const plan of dbPlans) {
    if (seen.has(plan.profile_name)) continue;
    rows.push({
      profile_name: plan.profile_name,
      price_ngn: plan.price_ngn,
      rate_limit: plan.rate_limit,
      data_gb: plan.data_gb,
      uptime_limit: plan.uptime_limit,
      session_timeout: plan.session_timeout,
      shared_users: '1',
      live: false,
      router_id: null
    });
  }

  rows.sort((a, b) => a.profile_name.localeCompare(b.profile_name));
  return rows;
}

function buildVoucherRows(dbVouchers, users, activeSessions, planRows, profiles) {
  const userByName = new Map(users.filter(u => u && u.name && !isSystemUser(u)).map(u => [u.name, u]));
  const activeByUser = new Map(activeSessions.filter(a => a && a.user).map(a => [a.user, a]));
  const planByName = new Map(planRows.map(p => [p.profile_name, p]));
  const liveProfileByName = new Map(profiles.filter(p => p && p.name).map(p => [p.name, p]));
  const dbByCode = new Map(dbVouchers.map(v => [v.code, v]));
  const rows = [];
  const seen = new Set();

  function makeRow(voucher, user) {
    const code = (voucher && voucher.code) || (user && user.name);
    if (!code) return null;
    const profileName = (voucher && voucher.plan_profile) || (user && user.profile) || '';
    const plan = planByName.get(profileName);
    const liveProfile = liveProfileByName.get(profileName);
    const active = activeByUser.get(code) || null;
    const comment = (user && user.comment) || '';
    const overseasCap = Number((user && user['limit-bytes-total']) || 0);
    const savedCap = Number((voucher && voucher.data_bytes) || 0);
    const capBytes = overseasCap > 0 ? overseasCap : savedCap;
    const usedBytes = user ? Number(user['bytes-in'] || 0) + Number(user['bytes-out'] || 0) : null;
    const uptimeLimit = (user && user['limit-uptime']) || (voucher && voucher.uptime_limit) || 'none';
    const uptimeUsed = user ? (user.uptime || '0s') : null;
    const limitSeconds = parseRosDuration(uptimeLimit);
    const usedSeconds = parseRosDuration(uptimeUsed);

    return {
      code,
      plan_profile: profileName,
      price_ngn: voucher ? voucher.price_ngn : (plan ? plan.price_ngn : null),
      data_gb: plan ? plan.data_gb : null,
      rate_limit: (voucher && voucher.rate_limit) ||
        (liveProfile && liveProfile['rate-limit']) ||
        (plan && plan.rate_limit) || '',
      data_bytes: capBytes,
      data_used_bytes: usedBytes,
      remaining_data_bytes: capBytes > 0 && usedBytes !== null ? Math.max(0, capBytes - usedBytes) : null,
      uptime_limit: uptimeLimit,
      uptime_used: uptimeUsed,
      remaining_uptime_seconds: limitSeconds !== null && usedSeconds !== null
        ? Math.max(0, limitSeconds - usedSeconds) : null,
      session_timeout: (voucher && voucher.session_timeout) ||
        (liveProfile && liveProfile['session-timeout']) || (plan && plan.session_timeout) || 'none',
      created_at: voucher ? voucher.created_at : null,
      comment,
      locked_mac: extractLockedMac(comment),
      disabled: user ? user.disabled === 'true' : null,
      live: Boolean(user),
      in_db: Boolean(voucher),
      online: Boolean(active),
      active_id: active ? active['.id'] : null,
      mac: active ? (active['mac-address'] || null) : null,
      address: active ? (active.address || null) : null,
      session_time_left: active ? (active['session-time-left'] || null) : null,
      session_bytes: active
        ? Number(active['bytes-in'] || 0) + Number(active['bytes-out'] || 0)
        : null
    };
  }

  for (const voucher of dbVouchers) {
    const user = userByName.get(voucher.code);
    seen.add(voucher.code);
    rows.push(makeRow(voucher, user));
  }
  for (const user of userByName.values()) {
    if (seen.has(user.name)) continue;
    rows.push(makeRow(dbByCode.get(user.name) || null, user));
  }

  return rows.filter(Boolean);
}

function enrichActiveSessions(activeSessions, voucherRows) {
  const voucherByCode = new Map(voucherRows.map(v => [v.code, v]));
  return activeSessions.filter(a => a && a.user).map(a => {
    const voucher = voucherByCode.get(a.user);
    return {
      ...a,
      active_id: a['.id'] || null,
      plan_profile: voucher ? voucher.plan_profile : (a.profile || ''),
      price_ngn: voucher ? voucher.price_ngn : null,
      rate_limit: voucher ? voucher.rate_limit : '',
      data_cap_bytes: voucher ? voucher.data_bytes : 0,
      session_bytes: Number(a['bytes-in'] || 0) + Number(a['bytes-out'] || 0)
    };
  });
}

function sendApiError(res, err) {
  console.error('[api] ' + ((err && err.stack) || err));
  if (err && err.status) {
    const payload = { error: err.message };
    if (err.hint) payload.hint = err.hint;
    return res.status(err.status).json(payload);
  }
  if (err instanceof RouterOSError) {
    return res.status(502).json({
      error: err.message,
      router_error: true,
      hint: routerHint(err)
    });
  }
  return res.status(500).json({ error: (err && err.message) || 'Unexpected server error.' });
}

/* ------------------------------------------------------------------ */
/* Auth pages                                                          */
/* ------------------------------------------------------------------ */

app.get('/login', (req, res) => {
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PresdoCafe Admin Login</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:system-ui,-apple-system,sans-serif;background:radial-gradient(circle at top,#13233a,#070b14 70%);color:#f8fafc;display:grid;place-items:center;min-height:100vh;margin:0;padding:1.25rem}
    form{background:rgba(15,23,42,.9);backdrop-filter:blur(14px);padding:2rem;border-radius:20px;border:1px solid rgba(148,163,184,.2);width:min(360px,100%);display:grid;gap:.85rem;box-shadow:0 24px 60px rgba(0,0,0,.5)}
    .brand{display:flex;align-items:center;gap:.85rem;margin-bottom:.25rem}
    .brand img{width:68px;height:68px;object-fit:cover;border-radius:14px;border:1px solid rgba(56,189,248,.35);background:#020617}
    .eyebrow{font-size:.7rem;text-transform:uppercase;letter-spacing:.12em;color:#38bdf8;font-weight:800}
    h2{margin:.15rem 0 0;font-size:1.35rem}
    small{color:#94a3b8}
    input,button{padding:.78rem .9rem;border-radius:10px;border:1px solid rgba(148,163,184,.25);font-size:.95rem;width:100%}
    input{background:rgba(2,6,23,.8);color:#fff}
    button{background:linear-gradient(135deg,#0284c7,#0ea5e9);color:#fff;border:none;cursor:pointer;font-weight:700}
    button:hover{filter:brightness(1.08)}
  </style></head>
  <body><form method="POST" action="/login">
    <div class="brand"><img src="/assets/cell_tower.png" alt="PresdoCafe cell tower"><div><div class="eyebrow">PresdoCafe Network</div><h2>Admin Sign In</h2></div></div>
    <small>MikroTik CCR2004 hotspot control • presdocafe.ng</small>
    <input name="username" placeholder="Admin username" autocomplete="username" required />
    <input name="password" type="password" placeholder="Admin password" autocomplete="current-password" required />
    <button type="submit">Enter Dashboard</button>
  </form></body></html>`);
});

app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === (process.env.ADMIN_USER || 'admin') && bcrypt.compareSync(password || '', passwordHash)) {
    req.session.authenticated = true;
    return res.redirect('/');
  }
  return res.status(401).send('Invalid admin credentials. <a href="/login" style="color:#38bdf8">Try again</a>');
});

app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

/* ------------------------------------------------------------------ */
/* Settings API                                                        */
/* ------------------------------------------------------------------ */

app.get('/api/settings', requireAuth, (req, res) => {
  const cfg = getRouterConfig();
  res.json({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    password_set: Boolean(cfg.password)
  });
});

app.post('/api/settings', requireAuth, (req, res) => {
  const body = req.body || {};
  const host = String(body.host || '').trim();
  const port = Number(body.port);
  const user = String(body.user || '').trim();
  const password = typeof body.password === 'string' ? body.password : undefined;

  if (!host) return res.status(400).json({ error: 'RouterOS host is required.' });
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ error: 'RouterOS API port must be a whole number between 1 and 65535 (normally 8728).' });
  }
  if (!user) return res.status(400).json({ error: 'RouterOS API username is required.' });

  const updates = {
    MIKROTIK_HOST: host,
    MIKROTIK_PORT: String(port),
    MIKROTIK_USER: user
  };
  if (password !== undefined) updates.MIKROTIK_PASS = password;

  try {
    updateEnvFile(updates);
    for (const key of Object.keys(updates)) settingSet(key, updates[key]);
  } catch (err) {
    console.error('[settings] Could not persist credentials: ' + err.message);
    return res.status(500).json({ error: 'Could not save credentials to .env/SQLite: ' + err.message });
  }

  console.log('[settings] Saved RouterOS credentials for ' + user + '@' + host + ':' + port + ' to .env and SQLite.');
  res.json({ ok: true, host, port, user, password_set: Boolean(envOr('MIKROTIK_PASS', '')) });
});

app.post('/api/settings/test', requireAuth, async (req, res) => {
  const body = req.body || {};
  const current = getRouterConfig();
  const cfg = {
    host: String(body.host || current.host).trim(),
    port: Number(body.port || current.port),
    user: String(body.user || current.user).trim(),
    password: typeof body.password === 'string' ? body.password : current.password
  };

  try {
    const info = await withRouter(async api => {
      const resource = await rosWrite(api, '/system/resource/print');
      const profiles = await rosWrite(api, '/ip/hotspot/user/profile/print');
      const first = resource[0] || {};
      return {
        version: first.version || 'unknown',
        board: first['board-name'] || 'RouterOS',
        profiles: profiles.filter(p => p && p.name && !isSystemProfile(p)).length
      };
    }, cfg);
    res.json({ ok: true, ...info, host: cfg.host, port: cfg.port, user: cfg.user });
  } catch (err) {
    console.error('[settings] Connection test failed: ' + err.message);
    res.status(502).json({ error: err.message, hint: routerHint(err) });
  }
});

/* ------------------------------------------------------------------ */
/* State API                                                           */
/* ------------------------------------------------------------------ */

app.get('/api/state', requireAuth, async (req, res) => {
  const dbPlans = db.prepare('SELECT * FROM plans').all();
  const dbVouchers = db.prepare('SELECT * FROM vouchers ORDER BY id DESC LIMIT 500').all();
  const stats = db.prepare(`SELECT COUNT(*) AS total_vouchers,
    COALESCE(SUM(price_ngn), 0) AS total_ngn FROM vouchers`).get();

  let profiles = [];
  let activeSessions = [];
  let users = [];
  const routerErrors = [];
  const cfg = getRouterConfig();

  try {
    await withRouter(async api => {
      const read = async command => {
        try {
          return await rosWrite(api, command);
        } catch (err) {
          routerErrors.push(err.message);
          return [];
        }
      };
      profiles = await read('/ip/hotspot/user/profile/print');
      activeSessions = await read('/ip/hotspot/active/print');
      users = await read('/ip/hotspot/user/print');
    });
  } catch (err) {
    routerErrors.push(err.message);
    console.error('[state] RouterOS unavailable: ' + err.message);
  }

  const plans = buildPlanRows(profiles, dbPlans);
  const voucherRows = buildVoucherRows(dbVouchers, users, activeSessions, plans, profiles);
  const active = enrichActiveSessions(activeSessions, voucherRows);

  res.json({
    plans,
    vouchers: voucherRows,
    users: users.filter(u => u && u.name && !isSystemUser(u)),
    active,
    stats,
    router: {
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      connected: routerErrors.length === 0,
      error: routerErrors[0] || null,
      errors: routerErrors,
      hint: routerErrors.length ? routerHint(new RouterOSError(routerErrors[0])) : null
    }
  });
});

/* ------------------------------------------------------------------ */
/* Plan APIs                                                           */
/* ------------------------------------------------------------------ */

app.post('/api/plans', requireAuth, async (req, res) => {
  const body = req.body || {};
  const originalName = String(body.original_name || '').trim();
  const profileName = String(body.profile_name || '').trim();
  const rateLimit = String(body.rate_limit || '').trim();
  const uptimeLimit = String(body.uptime_limit || '').trim();
  const priceNgn = Number(body.price_ngn === '' || body.price_ngn === null ? 0 : body.price_ngn);
  const dataGb = Number(body.data_gb === '' || body.data_gb === null ? 0 : body.data_gb);

  if (!profileName) {
    return res.status(400).json({ error: 'Profile name is required (for example 1h-2gb-5m).' });
  }
  if (!/^[^\x00-\x1F]{1,64}$/.test(profileName)) {
    return res.status(400).json({ error: 'Profile names must be 1-64 characters and cannot contain line breaks or control characters.' });
  }
  if (profileName.toLowerCase() === 'default') {
    return res.status(400).json({ error: 'The RouterOS "default" profile is a system profile and cannot be edited.' });
  }
  if (!rateLimit) {
    return res.status(400).json({ error: 'Rate limit is required (for example 5M/5M).' });
  }
  if (!uptimeLimit) {
    return res.status(400).json({ error: 'Session timeout / uptime limit is required (for example 1h, 1d, 7d or none).' });
  }
  if (!Number.isFinite(priceNgn) || priceNgn < 0) {
    return res.status(400).json({ error: 'Price must be a number of NGN, 0 or greater.' });
  }
  if (!Number.isFinite(dataGb) || dataGb < 0) {
    return res.status(400).json({ error: 'Data cap must be a number of GB, 0 or greater (0 means unlimited).' });
  }

  try {
    const result = await withRouter(async api => {
      const findByProfile = name =>
        rosWrite(api, '/ip/hotspot/user/profile/print', ['?name=' + name]);

      if (!originalName) {
        const existing = await findByProfile(profileName);
        if (existing.length) {
          throw httpError(409,
            'A RouterOS profile named "' + profileName + '" already exists. Use Edit on that plan to update it.',
            'If you want to adopt the existing profile, click Edit on it in the plans table, adjust the values and save.');
        }
        await rosWrite(api, '/ip/hotspot/user/profile/add', [
          '=name=' + profileName,
          '=rate-limit=' + rateLimit,
          '=shared-users=1',
          '=session-timeout=' + uptimeLimit,
          '=status-autorefresh=1m',
          '=on-login=' + MAC_LOCK_SCRIPT
        ]);
        return { action: 'created' };
      }

      let matches = await findByProfile(originalName);
      if (!matches.length) matches = await findByProfile(profileName);

      if (!matches.length) {
        // Metadata exists locally but the profile is gone from RouterOS: recreate it.
        await rosWrite(api, '/ip/hotspot/user/profile/add', [
          '=name=' + profileName,
          '=rate-limit=' + rateLimit,
          '=shared-users=1',
          '=session-timeout=' + uptimeLimit,
          '=status-autorefresh=1m',
          '=on-login=' + MAC_LOCK_SCRIPT
        ]);
        return { action: 'created' };
      }

      const target = matches[0];
      if (profileName !== target.name) {
        const clash = await findByProfile(profileName);
        if (clash.length && clash[0]['.id'] !== target['.id']) {
          throw httpError(409,
            'Cannot rename to "' + profileName + '": another RouterOS profile already uses that name.');
        }
      }

      await rosWrite(api, '/ip/hotspot/user/profile/set', [
        '=.id=' + target['.id'],
        '=name=' + profileName,
        '=rate-limit=' + rateLimit,
        '=shared-users=1',
        '=session-timeout=' + uptimeLimit,
        '=status-autorefresh=1m',
        '=on-login=' + MAC_LOCK_SCRIPT
      ]);

      return { action: profileName !== target.name ? 'renamed' : 'updated' };
    });

    const tx = db.transaction(() => {
      if (originalName && originalName !== profileName) {
        db.prepare('DELETE FROM plans WHERE profile_name = ?').run(originalName);
        db.prepare('UPDATE vouchers SET plan_profile = ? WHERE plan_profile = ?').run(profileName, originalName);
      }
      db.prepare(`INSERT INTO plans
        (profile_name, price_ngn, rate_limit, data_gb, uptime_limit, session_timeout)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(profile_name) DO UPDATE SET
          price_ngn = excluded.price_ngn,
          rate_limit = excluded.rate_limit,
          data_gb = excluded.data_gb,
          uptime_limit = excluded.uptime_limit,
          session_timeout = excluded.session_timeout`)
        .run(profileName, Math.round(priceNgn), rateLimit, dataGb, uptimeLimit, uptimeLimit);
    });
    tx();

    console.log('[plans] ' + result.action + ' "' + profileName + '" on RouterOS and saved metadata.');
    res.json({ ok: true, ...result, plan_name: profileName });
  } catch (err) {
    sendApiError(res, err);
  }
});

app.post('/api/plans/delete', requireAuth, async (req, res) => {
  const profileName = String((req.body && req.body.profile_name) || '').trim();
  if (!profileName) return res.status(400).json({ error: 'Profile name is required.' });
  if (profileName.toLowerCase() === 'default') {
    return res.status(400).json({ error: 'The RouterOS default profile cannot be deleted.' });
  }

  let warning = null;
  try {
    await withRouter(async api => {
      const rows = await rosWrite(api, '/ip/hotspot/user/profile/print', ['?name=' + profileName]);
      if (rows.length) {
        await rosWrite(api, '/ip/hotspot/user/profile/remove', ['=.id=' + rows[0]['.id']]);
      } else {
        warning = 'The profile was not present on RouterOS; local metadata was removed.';
      }
    });
  } catch (err) {
    return sendApiError(res, err);
  }

  const usedBy = db.prepare('SELECT COUNT(*) AS count FROM vouchers WHERE plan_profile = ?').get(profileName).count;
  db.prepare('DELETE FROM plans WHERE profile_name = ?').run(profileName);
  if (usedBy > 0 && !warning) {
    warning = usedBy + ' issued voucher(s) still reference this plan name; their saved price/speed/data metadata was kept.';
  }
  res.json({ ok: true, warning });
});

/* ------------------------------------------------------------------ */
/* Voucher & session APIs                                              */
/* ------------------------------------------------------------------ */

app.post('/api/vouchers/generate', requireAuth, async (req, res) => {
  const planProfile = String((req.body && req.body.plan_profile) || '').trim();
  const count = Math.max(1, Math.min(200, parseInt(req.body && req.body.count, 10) || 5));
  let prefix = String((req.body && req.body.prefix) || 'PC').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (!prefix) prefix = 'PC';

  const plan = db.prepare('SELECT * FROM plans WHERE profile_name = ?').get(planProfile);
  if (!plan) {
    return res.status(400).json({
      error: 'Save the plan metadata (price, data cap, speed and uptime) before generating vouchers.'
    });
  }

  const dataBytes = Math.max(0, Math.round(Number(plan.data_gb || 0) * 1073741824));
  const created = [];
  const errors = [];
  let rateLimit = plan.rate_limit || '';
  let sessionTimeout = plan.session_timeout || plan.uptime_limit || 'none';
  let uptimeLimit = plan.uptime_limit || 'none';

  const insertVoucher = db.prepare(`INSERT INTO vouchers
    (code, plan_profile, price_ngn, data_bytes, uptime_limit, rate_limit, session_timeout, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const deleteVoucher = db.prepare('DELETE FROM vouchers WHERE code = ?');

  try {
    await withRouter(async api => {
      const profiles = await rosWrite(api, '/ip/hotspot/user/profile/print', ['?name=' + planProfile]);
      if (!profiles.length) {
        throw httpError(409,
          'The RouterOS hotspot profile "' + planProfile + '" was not found. Click Sync Now, then save the plan again before generating vouchers.');
      }
      const liveProfile = profiles[0];
      rateLimit = liveProfile['rate-limit'] || rateLimit;
      sessionTimeout = liveProfile['session-timeout'] || sessionTimeout;
      uptimeLimit = liveProfile['session-timeout'] || uptimeLimit;

      const existingUsers = await rosWrite(api, '/ip/hotspot/user/print');
      const usedCodes = new Set(existingUsers.map(u => u && u.name).filter(Boolean));
      for (const row of db.prepare('SELECT code FROM vouchers').all()) usedCodes.add(row.code);

      let failureStreak = 0;

      for (let i = 0; i < count; i++) {
        let code;
        do {
          code = randomCode(prefix, 6);
        } while (usedCodes.has(code));
        usedCodes.add(code);

        const now = new Date().toISOString();
        const comment = 'NGN:' + plan.price_ngn +
          ' PLAN:' + plan.profile_name +
          ' SPEED:' + (rateLimit || 'unlimited') +
          ' CAP:' + (Number(plan.data_gb) > 0 ? plan.data_gb + 'GB' : 'UNLIM') +
          ' TIME:' + (uptimeLimit || sessionTimeout);

        try {
          insertVoucher.run(
            code,
            plan.profile_name,
            Math.round(Number(plan.price_ngn || 0)),
            dataBytes,
            uptimeLimit || 'none',
            rateLimit || '',
            sessionTimeout || 'none',
            now
          );
        } catch (dbErr) {
          errors.push(code + ': could not save voucher metadata (' + dbErr.message + ')');
          continue;
        }

        const args = [
          '=name=' + code,
          '=password=' + code,
          '=profile=' + planProfile,
          '=comment=' + comment
        ];
        if (dataBytes > 0) args.push('=limit-bytes-total=' + dataBytes);
        if (uptimeLimit && !/^(none|unlimited)$/i.test(String(uptimeLimit))) {
          args.push('=limit-uptime=' + uptimeLimit);
        }

        try {
          await rosWrite(api, '/ip/hotspot/user/add', args);
          failureStreak = 0;
          created.push({
            code,
            plan_profile: plan.profile_name,
            price_ngn: Math.round(Number(plan.price_ngn || 0)),
            data_gb: Number(plan.data_gb || 0),
            data_bytes: dataBytes,
            rate_limit: rateLimit || '',
            uptime_limit: uptimeLimit || 'none',
            session_timeout: sessionTimeout || 'none',
            created_at: now
          });
        } catch (addErr) {
          deleteVoucher.run(code);
          errors.push(code + ': ' + addErr.message);
          failureStreak++;
          if (failureStreak >= 3) {
            errors.push('Stopped after 3 consecutive RouterOS failures. Check the router connection and try again.');
            break;
          }
        }
      }
    });
  } catch (err) {
    if (created.length) {
      return res.json({
        ok: true,
        partial: true,
        created,
        errors: errors.concat([err.message]),
        error: err.message
      });
    }
    return sendApiError(res, err);
  }

  if (!created.length) {
    return res.status(errors.length ? 502 : 500).json({
      error: errors.length ? 'No vouchers were created. ' + errors[0] : 'No vouchers were created.',
      errors
    });
  }

  if (errors.length) {
    console.error('[vouchers] Partial generation: ' + errors.join(' | '));
  }
  res.json({ ok: true, created, errors, partial: errors.length > 0 });
});

app.post('/api/vouchers/delete', requireAuth, async (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'Voucher code is required.' });

  try {
    await withRouter(async api => {
      const activeRows = await rosWrite(api, '/ip/hotspot/active/print', ['?user=' + name]);
      const rows = await rosWrite(api, '/ip/hotspot/user/print', ['?name=' + name]);

      if (rows.length) {
        await rosWrite(api, '/ip/hotspot/user/remove', ['=.id=' + rows[0]['.id']]);
      }
      for (const session of activeRows) {
        try {
          await rosWrite(api, '/ip/hotspot/active/remove', ['=.id=' + session['.id']]);
        } catch (err) {
          console.error('[vouchers] Could not remove active session for ' + name + ': ' + err.message);
        }
      }
    });
  } catch (err) {
    return sendApiError(res, err);
  }

  db.prepare('DELETE FROM vouchers WHERE code = ?').run(name);
  res.json({ ok: true });
});

app.post('/api/vouchers/unlock-mac', requireAuth, async (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'Voucher code is required.' });

  try {
    await withRouter(async api => {
      const rows = await rosWrite(api, '/ip/hotspot/user/print', ['?name=' + name]);
      if (!rows.length) {
        throw httpError(404, 'Voucher "' + name + '" was not found on RouterOS. Click Sync Now and try again.');
      }
      const user = rows[0];
      const cleanedComment = stripLockedMac(user.comment);
      await rosWrite(api, '/ip/hotspot/user/set', [
        '=.id=' + user['.id'],
        '=disabled=no',
        '=comment=' + cleanedComment
      ]);

      // Best effort: clear MAC cookies so the voucher can bind to a new device.
      try {
        const cookies = await rosWrite(api, '/ip/hotspot/cookie/print', ['?user=' + name]);
        for (const cookie of cookies) {
          await rosWrite(api, '/ip/hotspot/cookie/remove', ['=.id=' + cookie['.id']]);
        }
      } catch (cookieErr) {
        console.error('[vouchers] MAC cookie cleanup skipped for ' + name + ': ' + cookieErr.message);
      }
    });
  } catch (err) {
    return sendApiError(res, err);
  }

  res.json({ ok: true });
});

app.post('/api/sessions/kick', requireAuth, async (req, res) => {
  const id = String((req.body && req.body.id) || '').trim();
  const user = String((req.body && req.body.user) || '').trim();

  try {
    await withRouter(async api => {
      let activeId = id;
      if (!activeId && user) {
        const rows = await rosWrite(api, '/ip/hotspot/active/print', ['?user=' + user]);
        if (rows.length) activeId = rows[0]['.id'];
      }
      if (!activeId) {
        throw httpError(404, 'Active session not found. It may have already disconnected.');
      }
      await rosWrite(api, '/ip/hotspot/active/remove', ['=.id=' + activeId]);
    });
  } catch (err) {
    return sendApiError(res, err);
  }

  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

app.use((err, req, res, next) => {
  console.error('[http] ' + ((err && err.stack) || err));
  if (req.path.startsWith('/api/')) {
    return res.status(err.status || 500).json({ error: (err && err.message) || 'Server error' });
  }
  next(err);
});

app.listen(process.env.PORT || 3000, () => {
  const cfg = getRouterConfig();
  console.log('PresdoCafe Admin UI listening on http://0.0.0.0:' + (process.env.PORT || 3000));
  console.log('RouterOS target: ' + cfg.user + '@' + cfg.host + ':' + cfg.port);
});
