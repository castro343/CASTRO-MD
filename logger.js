const pino = require('pino');

// WhatsApp/Signal internals can include private session and ratchet keys in
// debug objects. Never allow an environment variable to enable those logs.
const baileysLogger = pino({ level: 'silent' });

const SENSITIVE_KEY = /(priv.?key|secret|token|password|auth|credential|session|chain.?key|root.?key|base.?key|ephemeral|identity.?key|message.?key)/i;

function safeLogValue(value, depth = 0) {
  if (value instanceof Error) {
    return { name: value.name, message: String(value.message || 'Error').slice(0, 300), code: value.code };
  }
  if (Buffer.isBuffer(value)) return '[binary data omitted]';
  if (typeof value === 'string') return value.slice(0, 1000);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 3) return '[object omitted]';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeLogValue(item, depth + 1));

  const safe = {};
  for (const [key, item] of Object.entries(value).slice(0, 40)) {
    safe[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : safeLogValue(item, depth + 1);
  }
  return safe;
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
