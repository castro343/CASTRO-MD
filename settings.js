const path = require('path');
require('dotenv').config({ path: path.join(__dirname, 'set.env') });

const digits = (v) => (v || '').replace(/\D/g, '');

// CASTRO-MD owner / developer. OWNER_NUMBER may add additional owners.
const DEVELOPER = { name: 'Castro', number: '254739082713' };
const envOwners = (process.env.OWNER_NUMBER || '').split(',').map(digits).filter(Boolean);

module.exports = {
  botName: process.env.BOT_NAME || 'CASTRO-MD',
  prefix: process.env.PREFIX || '.',
  developer: DEVELOPER,
  owners: [...new Set([DEVELOPER.number, ...envOwners])],
  mode: (process.env.MODE || 'public').toLowerCase(),
  pairingNumber: digits(process.env.PAIRING_NUMBER),
  sessionId: (process.env.SESSION_ID || '').trim(),
  sessionDir: process.env.SESSION_DIR || path.join(__dirname, 'session'),
  port: Number(process.env.PORT) || 3000,
  connectAlert: String(process.env.CONNECT_ALERT || 'true') !== 'false',
  menuImage: process.env.MENU_IMAGE || '',
  timezone: process.env.TIMEZONE || 'Africa/Nairobi',
  repo: process.env.REPO_URL || 'https://github.com/castro343/CASTRO-MD',
  autoRead: String(process.env.AUTO_READ || 'false') === 'true',
  antiCall: String(process.env.ANTI_CALL || 'false') === 'true',
  autoViewStatus: String(process.env.AUTO_VIEW_STATUS || 'true') !== 'false',
  mongoUri: (process.env.MONGODB_URI || '').trim(),
  mongoDb: process.env.MONGODB_DB || 'castro_md',
};
