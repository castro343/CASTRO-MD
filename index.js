const http = require('http');
const { fork } = require('child_process');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  Browsers,
} = require('@whiskeysockets/baileys');

const settings = require('./settings');
const { log, baileysLogger } = require('./logger');
const { loadCommands, handle, warm, commandCount } = require('./commandHandler');
const store = require('./lib/store');
const { createSessionId, restoreSession } = require('./lib/session');
const { getText } = require('./lib/utils');
const { FOOTER } = require('./lib/brand');
const { box } = require('./lib/table');

// Group protection is optional: if its file is missing or broken, the bot still starts and replies.
let guard;
try {
  guard = require('./lib/guard');
} catch (e) {
  log.error('Group protection is off (could not load lib/guard.js):', e.message);
  guard = { init: async () => {}, flush: async () => {}, onMessage: async () => {}, onParticipants: async () => {} };
}


let restoredFromEnv = false;
// Recently sent messages, so WhatsApp can ask for a resend when a phone could not decrypt a reply
// (the "Waiting for this message" problem).
const sentCache = new Map();
let mongoLogged = false;
let activeSocket = null;
let activeCredentialsRegistered = false;
let presenceTimer = null;
let shuttingDown = false;
const tenantId = process.env.TENANT_ID || '';

// Log in from SESSION_ID if provided (only when no local session exists yet).
if (settings.sessionId && !fs.existsSync(path.join(settings.sessionDir, 'creds.json'))) {
  try {
    restoreSession(settings.sessionDir, settings.sessionId);
    restoredFromEnv = true;
    log.info('Session restored from SESSION_ID');
  } catch (e) {
    log.error('SESSION_ID is invalid:', e.message);
  }
}

// Tiny web server so hosts like Render/Heroku see an open port and keep the service alive.
const hits = new Map(); // ip -> [timestamps] for a simple rate limit on pairing requests
const pairingRequests = new Map(); // phone -> last request time
const limited = (ip) => {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 5;
};
const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const tenantWorkers = new Map();
const tenantRestartAttempts = new Map();
const tenantRestartTimers = new Map();
let tenantRegistry;
async function getTenantRegistry() {
  if (!settings.mongoUri) throw new Error('Multi-user pairing requires MongoDB to be configured.');
  if (!tenantRegistry) tenantRegistry = require('./lib/tenantRegistry').createTenantRegistry({
    uri: settings.mongoUri, dbName: settings.mongoDb,
  });
  return tenantRegistry;
}

function launchTenant(tenant, pairingNumber = '') {
  const existing = tenantWorkers.get(tenant.id);
  if (existing && existing.exitCode === null && !existing.killed && existing.signalCode === null) return existing;
  if (existing && (existing.exitCode !== null || existing.killed || existing.signalCode !== null)) tenantWorkers.delete(tenant.id);
  const sessionRoot = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'tenants', tenant.id);
  const child = fork(__filename, [], {
    env: {
      ...process.env,
      TENANT_ID: tenant.id,
      SESSION_DIR: path.join(sessionRoot, 'session'),
      DATA_DIR: path.join(sessionRoot, 'data'),
      PAIRING_NUMBER: pairingNumber,
      KEEP_ALIVE_URL: '',
      RENDER_EXTERNAL_URL: '',
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  tenantWorkers.set(tenant.id, child);
  child.on('message', async (message) => {
    if (!message || message.tenantId !== tenant.id) return;
    if (message.type === 'connected') {
      tenantRestartAttempts.delete(tenant.id);
      const pending = tenantRestartTimers.get(tenant.id);
      if (pending) clearTimeout(pending);
      tenantRestartTimers.delete(tenant.id);
      try { await (await getTenantRegistry()).markConnected(tenant.id); }
      catch (e) { log.error('Could not update tenant connection status:', e.message); }
    }
    if (message.type === 'connection-replaced') {
      tenantRestartAttempts.set(tenant.id, -1);
      const pending = tenantRestartTimers.get(tenant.id);
      if (pending) clearTimeout(pending);
      tenantRestartTimers.delete(tenant.id);
      try { await (await getTenantRegistry()).markDisconnected(tenant.id); }
      catch (e) { log.error('Could not update replaced tenant connection status:', e.message); }
      log.warn(`Tenant ${tenant.id} was replaced by another WhatsApp connection; automatic retries stopped to prevent a reconnect loop.`);
    }
    if (message.type === 'logged-out') {
      tenantRestartAttempts.set(tenant.id, -1);
      const pending = tenantRestartTimers.get(tenant.id);
      if (pending) clearTimeout(pending);
      tenantRestartTimers.delete(tenant.id);
      try { await (await getTenantRegistry()).markNeedsPairing(tenant.id); }
      catch (e) { log.error('Could not mark tenant as needing a new pairing:', e.message); }
      log.warn(`Tenant bot ${tenant.id} was logged out; automatic restarts stopped and fresh pairing is required.`);
    }
  });
  child.on('exit', async (code) => {
    if (tenantWorkers.get(tenant.id) === child) tenantWorkers.delete(tenant.id);
    try { await (await getTenantRegistry()).markDisconnected(tenant.id); } catch {}
    log.warn(`Tenant bot ${tenant.id} worker exited (${code}).`);
    // Recover previously linked accounts after an unexpected worker crash.
    // Never auto-retry provisioning accounts: their first pairing must be completed by the user.
    if (!shuttingDown && tenantRestartAttempts.get(tenant.id) !== -1) {
      try {
        const latest = await (await getTenantRegistry()).get(tenant.id);
        if (latest && (latest.status === 'disconnected' || latest.status === 'connected')) {
          const attempts = tenantRestartAttempts.get(tenant.id) || 0;
          if (attempts < 5) {
            const delay = Math.min(60000, 3000 * (2 ** attempts));
            tenantRestartAttempts.set(tenant.id, attempts + 1);
            const timer = setTimeout(() => {
              tenantRestartTimers.delete(tenant.id);
              if (shuttingDown || tenantWorkers.has(tenant.id)) return;
              const restarted = launchTenant(latest, '');
              restarted.send({ type: 'start', tenantId: tenant.id });
              log.info(`Restarted tenant worker ${tenant.id} (attempt ${attempts + 1}/5).`);
            }, delay);
            timer.unref();
            tenantRestartTimers.set(tenant.id, timer);
          } else {
            tenantRestartAttempts.set(tenant.id, -1);
            log.error(`Tenant worker ${tenant.id} reached its restart limit; manual intervention is required.`);
          }
        }
      } catch (e) {
        log.error(`Could not schedule tenant worker recovery for ${tenant.id}:`, e.message);
      }
    }
  });
  return child;
}

async function requestTenantPairing(phone) {
  const registry = await getTenantRegistry();
  const tenant = await registry.create(phone);
  if (tenant.status === 'disabled') throw new Error('This bot account is disabled. Contact the platform owner.');
  if (tenant.status === 'connected') throw new Error('This WhatsApp number already has a CASTRO-MD account.');
  if (tenantWorkers.has(tenant.id)) throw new Error('A pairing request is already active for this number. Wait a moment and try again.');
  const child = launchTenant(tenant, phone);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error('Pairing service timed out. Please try again.')), 25000);
    const finish = async (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('message', onMessage);
      child.removeListener('exit', onExit);
      if (error) {
        if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
        // Persist the retryable state before rejecting the HTTP request. Otherwise a fast
        // retry can race this write and see the tenant stuck in "provisioning".
        try {
          await (await getTenantRegistry()).markNeedsPairing(tenant.id);
        } catch (e) {
          log.error('Could not reset failed pairing state:', e.message);
        }
        reject(error);
      } else resolve(code);
    };
    const onMessage = (message) => {
      if (message?.tenantId !== tenant.id) return;
      if (message.type === 'pairing-code') finish(null, message.code);
      if (message.type === 'pairing-error') finish(new Error(message.error || 'WhatsApp rejected the pairing request.'));
    };
    const onExit = () => finish(new Error('The bot worker stopped before generating a pairing code.'));
    child.on('message', onMessage);
    child.once('exit', onExit);
    // Begin the worker only after the pairing listener is attached.
    child.send({ type: 'start', tenantId: tenant.id });
  });
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    // Public PWA assets; keep this allowlist narrow.
    const pwaAssets = {
      '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
      '/sw.js': ['sw.js', 'application/javascript; charset=utf-8'],
      '/icon.svg': ['icon.svg', 'image/svg+xml'],
    };
    if (pwaAssets[url.pathname]) {
      try {
        const [file, contentType] = pwaAssets[url.pathname];
        const body = fs.readFileSync(path.join(__dirname, 'public', file));
        res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': file === 'sw.js' ? 'no-cache' : 'public, max-age=3600' });
        return res.end(body);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('PWA asset not found');
      }
    }

    if (url.pathname === '/pair' || url.pathname === '/pair.html') {
      try {
        const page = fs.readFileSync(path.join(__dirname, 'public', 'pair.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(page);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Pair page not found');
      }
    }

    if (url.pathname === '/api/pair') {
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      if (limited(ip)) return json(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
      try {
        const number = String(url.searchParams.get('number') || '').replace(/\D/g, '');
        if (number.length < 8 || number.length > 15) {
          return json(res, 400, { error: 'Enter your full WhatsApp number with country code.' });
        }
        const previous = pairingRequests.get(number) || 0;
        if (Date.now() - previous < 60000) {
          return json(res, 429, { error: 'Wait one minute before requesting another code.' });
        }
        pairingRequests.set(number, Date.now());
        const code = await requestTenantPairing(number);
        return json(res, 200, { code });
      } catch (e) {
        log.error('Tenant pairing request failed:', e.message);
        return json(res, 400, { error: e.message || 'Could not generate a pairing code.' });
      }
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`${settings.botName} is running`);
  });
if (!tenantId) server.listen(settings.port, () => log.info(`Web server on port ${settings.port} (pair page at /pair)`));

// Rehydrate previously linked customer bots after the platform manager starts.
if (!tenantId) {
  setTimeout(async () => {
    try {
      const registry = await getTenantRegistry();
      const tenants = await registry.list({ limit: 500 });
      for (const tenant of tenants) {
        if (tenant.status === 'connected' || tenant.status === 'disconnected') {
          const worker = launchTenant(tenant, '');
          worker.send({ type: 'start', tenantId: tenant.id });
          log.info(`Restoring customer bot worker ${tenant.id}`);
        }
      }
    } catch (e) {
      log.error('Could not restore customer bot workers:', e.message);
    }
  }, 5000).unref();
}

// WhatsApp alert to you (the linked account and any OWNER_NUMBER) whenever the bot connects.
// A 2-minute cooldown prevents spam if the connection keeps flapping.
let lastAlert = 0;
async function notifyConnected(sock) {
  if (!settings.connectAlert || Date.now() - lastAlert < 2 * 60 * 1000) return;
  lastAlert = Date.now();
  try {
    const me = sock.user.id.replace(/:\d+@/, '@');
    const targets = new Set([me, `${settings.owners[0]}@s.whatsapp.net`]);
    const platform = process.env.RENDER
      ? 'Render'
      : process.env.DYNO
      ? 'Heroku'
      : process.env.RAILWAY_ENVIRONMENT
      ? 'Railway'
      : 'Server';
    const time = new Date().toLocaleString('en-GB', {
      timeZone: settings.timezone,
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const mode = settings.mode.charAt(0).toUpperCase() + settings.mode.slice(1);
    const info = box(`${settings.botName.toUpperCase()} ONLINE`, [
      '🟢 Status: Connected',
      `🤖 Bot: ${settings.botName}`,
      `⌨️ Prefix: [ ${settings.prefix} ]`,
      `🌍 Mode: ${mode}`,
      `👤 Owner: ${settings.developer.name} (+${settings.owners[0]})`,
      `👁️ Auto view status: ${settings.autoViewStatus ? 'ON' : 'OFF'}`,
      `⚙️ Commands: ${commandCount()}`,
      `☁️ Host: ${platform}`,
      `🔐 Session: ${restoredFromEnv ? 'Restored' : 'Linked'}`,
      `🕒 Time: ${time}`,
      `🔗 Repo: ${settings.repo}`,
    ]);
    const text =
      `${info}\n\n` +
      `Type *${settings.prefix}menu* to get started.\n\n` +
      FOOTER;
    for (const jid of targets) await sock.sendMessage(jid, { text });
  } catch (e) {
    log.error('Could not send connect alert:', e.message);
  }
}

async function start() {
  await store.load(settings);
  await guard.init?.();
  loadCommands();
  fs.mkdirSync(settings.sessionDir, { recursive: true });
  let authStore;
  if (tenantId && !settings.mongoUri) {
    throw new Error('Tenant sessions require MongoDB; refusing non-persistent local authentication.');
  }
  if (settings.mongoUri) {
    try {
      authStore = await require('./lib/mongoAuth').useMongoAuthState(settings.mongoUri, {
        dbName: settings.mongoDb,
        seedFile: path.join(settings.sessionDir, 'creds.json'),
        tenantId: tenantId || 'default',
      });
      if (!mongoLogged) log.info('Session storage: MongoDB (login and keys survive redeploys)');
      mongoLogged = true;
    } catch (e) {
      log.error('MongoDB authentication storage unavailable:', e.message);
      // A tenant must never pair against a local-only session: it would appear to
      // work but disappear on restart/redeploy and could violate account isolation.
      if (tenantId) {
        if (process.send) process.send({ type: 'pairing-error', tenantId, error: 'Persistent session storage is unavailable. Please try again later.' });
        throw e;
      }
    }
  }
  if (!authStore) authStore = await useMultiFileAuthState(settings.sessionDir);
  const { state, saveCreds } = authStore;
  activeCredentialsRegistered = !!state.creds.registered;
  // Never wait long for the version lookup: if it is slow, start with the version built into Baileys.
  const { version } = await Promise.race([
    fetchLatestBaileysVersion(),
    new Promise((resolve) => setTimeout(() => resolve({}), 3000)),
  ]).catch(() => ({}));

  const sock = makeWASocket({
    version,
    logger: baileysLogger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    // Faster start and less work: don't download old chat history, don't build link previews.
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    generateHighQualityLinkPreview: false,
    // Keep the connection alive so WhatsApp doesn't drop it quietly.
    keepAliveIntervalMs: 25000,
    connectTimeoutMs: 60000,
    // Faster replies: ask the sender to resend an undecryptable message sooner than the default.
    retryRequestDelayMs: 150,
    getMessage: async (key) => sentCache.get(key.id),
  });

  activeSocket = sock;

  const origSend = sock.sendMessage.bind(sock);
  sock.sendMessage = async (...args) => {
    const res = await origSend(...args);
    if (res?.key?.id && res.message) {
      sentCache.set(res.key.id, res.message);
      if (sentCache.size > 500) sentCache.delete(sentCache.keys().next().value);
    }
    return res;
  };

  // Pairing-code login (no QR) when PAIRING_NUMBER is set and the device is not yet registered.
  if (settings.pairingNumber && !sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(settings.pairingNumber);
        const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
        log.info(`Pairing code: ${formattedCode}`);
        if (tenantId && process.send) process.send({ type: 'pairing-code', tenantId, code: formattedCode });
        log.info('WhatsApp > Linked devices > Link with phone number, then enter the code.');
      } catch (e) {
        log.error('Could not request pairing code:', e.message);
        if (tenantId && process.send) process.send({ type: 'pairing-error', tenantId, error: e.message });
      }
    }, 3000);
  }

  sock.ev.on('creds.update', saveCreds);

  // Group protection: welcome/goodbye messages, ban list, country filter.
  // Reject incoming calls only when the owner has explicitly enabled anti-call.
  sock.ev.on('call', async (calls) => {
    if (!settings.antiCall || shuttingDown) return;
    for (const call of calls || []) {
      if (call.status !== 'offer' || !call.id || !call.from) continue;
      try {
        await sock.rejectCall(call.id, call.from);
        log.info(`Rejected incoming ${call.isVideo ? 'video' : 'voice'} call from ${call.from}`);
      } catch (e) {
        log.warn(`Could not reject incoming call from ${call.from}: ${e.message}`);
      }
    }
  });

  sock.ev.on('group-participants.update', (update) => {
    guard.onParticipants(sock, update).catch((e) => log.error('Guard (members) error:', e));
  });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr && !settings.pairingNumber) {
      log.info('Scan this QR with WhatsApp > Linked devices:');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      activeCredentialsRegistered = true;
      log.info(`${settings.botName} connected as ${sock.user?.id}`);
      if (tenantId && process.send) process.send({ type: 'connected', tenantId, jid: sock.user?.id || null });
      clearInterval(presenceTimer);
      if (settings.alwaysOnline) {
        sock.sendPresenceUpdate('available').catch((e) => log.warn(`Could not set online presence: ${e.message}`));
        presenceTimer = setInterval(() => {
          if (!shuttingDown && settings.alwaysOnline) sock.sendPresenceUpdate('available').catch((e) => log.warn(`Online presence refresh failed: ${e.message}`));
        }, 4 * 60 * 1000);
      }
      // Credentials are saved directly by Baileys into the configured session directory.
      // No manual SESSION_ID copy is needed for a normal pairing.
      warm(sock); // look up the forwarding channel now, so the first reply is not slow
      setTimeout(() => notifyConnected(sock), 3000);
    }
    if (connection === 'close') {
      if (shuttingDown) return;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        log.error('Logged out. A fresh pairing is required for this account.');
        if (authStore.clear) await authStore.clear().catch(() => {});
        if (tenantId && process.send) {
          try { process.send({ type: 'logged-out', tenantId }); } catch {}
        }
        process.exit(1);
      }
      // 440: the same session was opened somewhere else (for example an overlapping deploy).
      // Stop this copy instead of fighting the other one.
      if (code === DisconnectReason.connectionReplaced) {
        // Another copy took over this login. Stay idle instead of exiting: on Render/Heroku an exit makes the
        // host restart this copy, which then kicks the other one out again, and the two fight forever.
        log.error('Session opened somewhere else (440). Stopping this worker and suppressing automatic restart.');
        if (tenantId && process.send) {
          try { process.send({ type: 'connection-replaced', tenantId }); } catch {}
        }
        setTimeout(() => process.exit(0), 250);
        return;
      }
      clearInterval(presenceTimer);
      presenceTimer = null;
      log.warn(`Connection closed (${code}). Reconnecting...`);
      setTimeout(() => {
        start().catch((error) => {
          log.error('WhatsApp reconnect startup failed:', error.message);
          if (tenantId && process.send) {
            try { process.send({ type: 'pairing-error', tenantId, error: 'Persistent tenant storage is unavailable. The bot worker will restart safely.' }); } catch {}
          }
          process.exit(1);
        });
      }, 3000);
    }
  });

  // Short-lived cache for anti-delete text alerts. Media is intentionally not recovered or forwarded.
  const receivedCache = new Map();
  const messageCacheKey = (key) => `${key?.remoteJid || ''}|${key?.id || ''}`;
  const cacheMessage = (msg) => {
    if (!msg?.key?.id || msg.key.fromMe || !msg.message || msg.key.remoteJid === 'status@broadcast') return;
    receivedCache.set(messageCacheKey(msg.key), { msg, at: Date.now() });
    if (receivedCache.size > 1000) receivedCache.delete(receivedCache.keys().next().value);
  };

  sock.ev.on('messages.update', async (updates) => {
    if (!settings.antiDelete || shuttingDown) return;
    for (const item of updates || []) {
      const protocol = item?.update?.message?.protocolMessage;
      const deletedKey = protocol?.key;
      // Baileys represents a revoke as protocolMessage type 0 (REVOKE).
      if (Number(protocol?.type) !== 0 || !deletedKey?.id) continue;
      const cached = receivedCache.get(messageCacheKey(deletedKey));
      if (!cached || Date.now() - cached.at > 24 * 60 * 60 * 1000) continue;
      receivedCache.delete(messageCacheKey(deletedKey));
      const original = cached.msg;
      const body = getText(original.message) || '[No recoverable text; this may have been a media message.]';
      const notice =
        '*CASTRO-MD ANTI-DELETE*\\n\\n' +
        'A message was deleted for everyone.\\n' +
        `Chat: ${original.key.remoteJid || 'Unknown chat'}\\n` +
        `Sender: ${original.key.participant || original.key.remoteJid || 'Unknown sender'}\\n\\n` +
        `Recovered text: ${body.slice(0, 3500)}\\n\\n` +
        '_Only text is reported. Media is not downloaded or forwarded._';
      for (const number of settings.owners || []) {
        sock.sendMessage(`${number}@s.whatsapp.net`, { text: notice }).catch((e) => log.warn(`Anti-delete owner notice failed: ${e.message}`));
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      // Channel posts arrive as live newsletter events; capture the server-assigned
      // ID and exact protobuf before normal command handling can ignore them.
      if (String(msg.key?.remoteJid || '').endsWith('@newsletter')) {
        const channelMessage = require('./lib/channelMenuForward');
        const messageShape = Object.keys(msg.message || {});
        const textLength = channelMessage.messageText(msg).length;
        log.info('[CHANNEL MENU] Live newsletter event received:', JSON.stringify({
          remoteJid: msg.key?.remoteJid || null,
          messageIdPresent: !!msg.key?.id,
          messageIdType: typeof msg.key?.id,
          fromMe: !!msg.key?.fromMe,
          upsertType: type || null,
          messageShape,
          textLength,
          timestampPresent: !!msg.messageTimestamp,
        }));
        try {
          const captured = await channelMessage.captureChannelMenuPost(msg, settings);
          if (captured) {
            log.info('[CHANNEL MENU] Captured published Channel post from live event.');
          } else {
            const diagnostic = await channelMessage.diagnoseChannelMenuPost(msg, settings).catch((error) => ({
              reason: 'diagnostic_read_failed',
              error: error.message,
            }));
            log.info('[CHANNEL MENU] Newsletter event not captured:', JSON.stringify({
              reason: diagnostic.reason,
              stateStatus: diagnostic.stateStatus || null,
              expectedChannel: diagnostic.expectedChannel || null,
              receivedChannel: msg.key?.remoteJid || null,
              messageIdPresent: !!msg.key?.id,
              messageShape,
              textLength,
              timestampPresent: !!msg.messageTimestamp,
            }));
          }
        } catch (error) {
          log.warn('[CHANNEL MENU] Could not capture live Channel post:', error.message);
        }
        continue;
      }
      // Status updates are never commands: just mark them as seen when auto view is on.
      if (msg.key.remoteJid === 'status@broadcast') {
        if (settings.autoViewStatus && type === 'notify' && !msg.key.fromMe && msg.message) {
          sock.readMessages([msg.key]).catch((e) => log.warn(`Could not view status: ${e.message}`));
        }
        continue;
      }
      // Accept live messages, plus your own recent messages synced from your phone.
      const age = Date.now() / 1000 - Number(String(msg.messageTimestamp || 0));
      if (type !== 'notify' && !(type === 'append' && msg.key.fromMe && age < 60)) continue;
      // Cache only accepted live incoming messages so old history is not treated as current.
      cacheMessage(msg);
      if (getText(msg.message).startsWith(settings.prefix)) {
        log.info(`[MSG] ${type} from=${msg.key.remoteJid} fromMe=${!!msg.key.fromMe} text="${getText(msg.message).slice(0, 40)}"`);
      }
      if (settings.autoRead && !msg.key.fromMe) sock.readMessages([msg.key]).catch(() => {});
      // Not awaited: each message is handled on its own, so one slow command
      // (a download, an AI answer) never makes the other messages wait.
      guard.onMessage(sock, msg).catch((e) => log.error('Guard (message) error:', e));
      handle(sock, msg).catch((e) => log.error('Handler error:', e));
    }
  });
}

// Render's free plan puts a service to sleep after ~15 minutes without web traffic, and a
// sleeping bot answers slowly or not at all. Pinging our own public address every 10 minutes
// keeps it awake. Render sets RENDER_EXTERNAL_URL automatically; you can also set KEEP_ALIVE_URL.
const keepAliveUrl =
  process.env.KEEP_ALIVE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  (process.env.HEROKU_APP_NAME ? `https://${process.env.HEROKU_APP_NAME}.herokuapp.com` : '');
if (keepAliveUrl && !tenantId) {
  var keepAliveTimer = setInterval(() => {
    fetch(keepAliveUrl, { signal: AbortSignal.timeout(15000) }).catch(() => {});
  }, 4 * 60 * 1000);
  log.info(`Keep-alive ping enabled for ${keepAliveUrl}`);
}

process.on('unhandledRejection', (e) => log.error('Unhandled rejection:', e));
process.on('uncaughtException', (e) => log.error('Uncaught exception:', e));

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Received ${signal}; shutting down CASTRO-MD gracefully...`);
  clearInterval(keepAliveTimer);
  clearInterval(presenceTimer);
  presenceTimer = null;
  try { await guard.flush?.(); } catch (e) { log.error('Guard save during shutdown failed:', e.message); }
  try {
    if (!tenantId) {
      for (const timer of tenantRestartTimers.values()) clearTimeout(timer);
      tenantRestartTimers.clear();
      for (const child of tenantWorkers.values()) child.kill('SIGTERM');
    }
    if (activeSocket) activeSocket.end(new Error('CASTRO-MD is restarting'));
  } catch (e) {
    log.warn('WhatsApp socket close warning:', e.message);
  }
  const forceExit = setTimeout(() => process.exit(0), 8000);
  forceExit.unref();
  server.close(() => {
    clearTimeout(forceExit);
    process.exit(0);
  });
}

process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.once('SIGINT', () => gracefulShutdown('SIGINT'));

if (tenantId) {
  // Wait for the manager to attach IPC listeners before opening WhatsApp.
  process.once('message', (message) => {
    if (message?.type === 'start' && message.tenantId === tenantId) {
      start().catch((error) => {
        log.error('Tenant worker startup failed:', error.message);
        if (process.send) {
          try { process.send({ type: 'pairing-error', tenantId, error: 'Persistent tenant storage is unavailable. Please try again later.' }); } catch {}
        }
        process.exit(1);
      });
    }
  });
} else {
  start().catch((error) => {
    log.error('CASTRO-MD startup failed:', error);
    process.exit(1);
  });
}
