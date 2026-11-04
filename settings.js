const path = require('path');
require('dotenv').config({ path: path.join(__dirname, 'set.env') });

const digits = (v) => (v || '').replace(/\D/g, '');

// The developer is platform metadata, not automatically an owner of every customer bot.
const DEVELOPER = { name: 'Castro', number: '254739082713' };
const envOwners = (process.env.OWNER_NUMBER || '').split(',').map(digits).filter(Boolean);
const tenantOwner = digits(process.env.PAIRING_NUMBER);
const isTenant = Boolean(process.env.TENANT_ID);

module.exports = {
  botName: process.env.BOT_NAME || 'CASTRO-MD',
  prefix: process.env.PREFIX || '.',
  developer: DEVELOPER,
  // Customer bots are controlled by their own paired number. Platform owners remain
  // owners only on the legacy/platform bot, never on every tenant automatically.
  owners: [...new Set(isTenant ? (tenantOwner ? [tenantOwner] : []) : [DEVELOPER.number, ...envOwners])],
  mode: (process.env.MODE || 'private').toLowerCase(),
  pairingNumber: tenantOwner,
  sessionId: (process.env.SESSION_ID || '').trim(),
  sessionDir: process.env.SESSION_DIR || path.join(__dirname, 'session'),
  port: Number(process.env.PORT) || 3000,
  connectAlert: String(process.env.CONNECT_ALERT || 'true') !== 'false',
  menuImage: process.env.MENU_IMAGE || '',
  timezone: process.env.TIMEZONE || 'Africa/Nairobi',
  repo: process.env.REPO_URL || 'https://github.com/castro343/CASTRO-MD',
  autoRead: String(process.env.AUTO_READ || 'false') === 'true',
  antiCall: String(process.env.ANTI_CALL || 'false') === 'true',
  antiDelete: String(process.env.ANTI_DELETE || 'false') === 'true',
  alwaysOnline: String(process.env.ALWAYS_ONLINE || 'false') === 'true',
  autoViewStatus: String(process.env.AUTO_VIEW_STATUS || 'true') !== 'false',
  mongoUri: (process.env.MONGODB_URI || '').trim(),
  mongoDb: process.env.MONGODB_DB || 'castro_md',
};
