const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PREFIX = 'CASTRO-MD~';
const LEGACY_PREFIX = 'NEXUS~';
const credsPath = (dir) => path.join(dir, 'creds.json');

// New session IDs use CASTRO-MD branding. Existing NEXUS IDs remain restorable
// so users do not lose a previously linked WhatsApp account during the upgrade.
function createSessionId(dir) {
  const file = credsPath(dir);
  if (!fs.existsSync(file)) return null;
  return PREFIX + zlib.gzipSync(fs.readFileSync(file)).toString('base64');
}

function restoreSession(dir, sessionId) {
  if (!sessionId) return false;
  const prefix = sessionId.startsWith(PREFIX)
    ? PREFIX
    : sessionId.startsWith(LEGACY_PREFIX)
      ? LEGACY_PREFIX
      : null;
  if (!prefix) return false;

  fs.mkdirSync(dir, { recursive: true });
  const json = zlib.gunzipSync(Buffer.from(sessionId.slice(prefix.length), 'base64'));
  JSON.parse(json.toString());
  fs.writeFileSync(credsPath(dir), json);
  return true;
}

module.exports = { createSessionId, restoreSession };
