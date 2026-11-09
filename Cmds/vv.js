// vv.js - reveal a view-once photo/video/voice note (owner only)
// Usage: reply to a view-once message with .vv

let baileys;
try { baileys = require('@whiskeysockets/baileys'); } catch { baileys = require('baileys'); }
const { downloadContentFromMessage } = baileys;

const MAX_BYTES = 30 * 1024 * 1024;

async function download(media, type) {
  const stream = await downloadContentFromMessage(media, type);
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_BYTES) throw Error('too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

module.exports = [
  {
    name: 'vv',
    aliases: ['viewonce', 'reveal'],
    description: 'Reveal a replied-to view-once photo, video or voice note (owner only)',
    ownerOnly: true, // commandHandler.js blocks everyone except owners
    run: async ({ sock, msg, from, reply, prefix }) => {
      // Unwrap disappearing-chat and linked-device wrappers around the .vv message itself.
      let m = msg.message || {};
      for (let i = 0; i < 3; i++) {
        const w = m.ephemeralMessage?.message || m.deviceSentMessage?.message;
        if (!w) break;
        m = w;
      }
      const ctx = m.extendedTextMessage?.contextInfo || m.imageMessage?.contextInfo || m.videoMessage?.contextInfo;
      let q = ctx?.quotedMessage;
      if (!q) return reply('Reply to a view-once message with ' + prefix + 'vv');

      // Unwrap the different view-once containers WhatsApp uses.
      q = q.viewOnceMessage?.message
        || q.viewOnceMessageV2?.message
        || q.viewOnceMessageV2Extension?.message
        || q;

      let type, media;
      if (q.imageMessage) { type = 'image'; media = q.imageMessage; }
      else if (q.videoMessage) { type = 'video'; media = q.videoMessage; }
      else if (q.audioMessage) { type = 'audio'; media = q.audioMessage; }
      else return reply('That message has no photo, video or voice note I can reveal.');

      try {
        const buffer = await download(media, type);
        if (!buffer.length) throw Error('empty');

        if (type === 'image') {
          return sock.sendMessage(from, { image: buffer, caption: media.caption || '' }, { quoted: msg });
        }
        if (type === 'video') {
          return sock.sendMessage(from, { video: buffer, caption: media.caption || '' }, { quoted: msg });
        }
        return sock.sendMessage(
          from,
          { audio: buffer, mimetype: media.mimetype || 'audio/mp4', ptt: !!media.ptt },
          { quoted: msg }
        );
      } catch {
        return reply('Could not download it. It may have expired, already been opened, or be too large.');
      }
    }
  }
];
