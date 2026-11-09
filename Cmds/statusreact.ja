// Cmds/statusreact.js
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'statusreact.json');
const EMOJIS = ['💔', '🥹', '👍'];

const load = () => {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { return { enabled: false }; }
};
const save = (data) => fs.writeFileSync(FILE, JSON.stringify(data));

// Call this from your messages.upsert handler
async function handleStatusReact(sock, m) {
  if (!load().enabled) return;
  if (m.key.remoteJid !== 'status@broadcast') return;
  if (m.key.fromMe) return;
  const poster = m.key.participant || m.participant;
  if (!poster) return;

  const emoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
  try {
    await sock.sendMessage(
      'status@broadcast',
      { react: { text: emoji, key: m.key } },
      { statusJidList: [poster, sock.user.id.split(':')[0] + '@s.whatsapp.net'] }
    );
  } catch (e) {
    console.log('statusreact error:', e.message);
  }
}

module.exports = {
  name: 'statusreact',
  alias: ['sr'],
  category: 'owner',
  handleStatusReact,

  run: async (m, { sock, args, isOwner, reply }) => {
    if (!isOwner) return reply('Owner only command.');
    const opt = (args[0] || '').toLowerCase();

    if (opt === 'on') {
      save({ enabled: true });
      return reply('✅ Status react is now *ON*');
    }
    if (opt === 'off') {
      save({ enabled: false });
      return reply('❌ Status react is now *OFF*');
    }
    return reply(`Usage: .statusreact on/off\nCurrent: ${load().enabled ? 'ON' : 'OFF'}`);
  }
};