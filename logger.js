const pino = require('pino');

// WhatsApp/Signal internals can include private session and ratchet keys in
// debug objects. Never allow an environment variable to enable those logs.
const baileysLogger = pino({ level: 'silent' });

const SENSITIVE_KEY = /(priv.?key|secret|token|password|auth|credential|session|chain.?key|root.?key|base.?key|ephemeral|identity.?key|message.?key)/i;

// Some libsignal versions write ratchet/session diagnostics directly to console,
// bypassing the configured Baileys/Pino logger. Redact sensitive key-value lines
// at the process console boundary as a final safety net.
const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};
const SENSITIVE_TEXT = /((?:rootKey|baseKey|chainKey|privKey|privateKey|ephemeralKeyPair|remoteIdentityKey|identityKey|messageKey|messageKeys|signedIdentityKey|registrationData)\s*:\s*)(?:<Buffer[^>]*>|[^,}\n]{1,500})/gi;
function redactLogText(value) {
  return String(value).replace(SENSITIVE_TEXT, '$1[REDACTED]');
}
function safeLogValue(value, depth = 0) {
  if (value instanceof Error) {
    return { name: value.name, message: redactLogText(value.message || 'Error').slice(0, 300), code: value.code };
  }
  if (Buffer.isBuffer(value)) return '[binary data omitted]';
  if (typeof value === 'string') return redactLogText(value).slice(0, 1000);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 3) return '[object omitted]';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeLogValue(item, depth + 1));

  const safe = {};
  for (const [key, item] of Object.entries(value).slice(0, 40)) {
    safe[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : safeLogValue(item, depth + 1);
  }
  return safe;
}


// Sanitize direct console calls from transitive dependencies as well as app logs.
for (const method of Object.keys(originalConsole)) {
  console[method] = (...args) => originalConsole[method](...args.map((arg) => safeLogValue(arg)));
}

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const write = (method, level, args) => {
  const safeArgs = args.map((arg) => safeLogValue(arg));
  console[method](`[${stamp()}] [${level}]`, ...safeArgs);
};
const log = {
  info: (...a) => write('log', 'INFO', a),
  warn: (...a) => write('warn', 'WARN', a),
  error: (...a) => write('error', 'ERROR', a),
};

module.exports = { log, baileysLogger };
