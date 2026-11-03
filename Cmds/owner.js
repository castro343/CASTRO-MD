'use strict';

const store = require('../lib/store');

// CASTRO-MD owner commands.

module.exports = [
  {
    name: 'profilename',
    aliases: ['profile-name'],
    description: 'Change the WhatsApp profile name',
    ownerOnly: true,
    run: async ({ sock, text, reply, prefix }) => {
      const name = text?.trim();
      if (!name) return reply(`Usage: ${prefix}profilename Your Name`);
      try {
        await sock.updateProfileName(name);
        await reply(`✅ Profile name updated to: ${name}`);
      } catch (error) {
        console.error('[CASTRO-MD:PROFILENAME]', error);
        await reply('❌ Could not update the WhatsApp profile name.');
      }
    },
  },
  {
    name: 'profilepic',
    aliases: ['setprofilepic'],
    description: 'Update the WhatsApp profile picture',
    ownerOnly: true,
    run: async ({ sock, msg, reply }) => {
      try {
        const context = msg.message?.extendedTextMessage?.contextInfo;
        const quoted = context?.quotedMessage;
        const image = msg.message?.imageMessage || quoted?.imageMessage;
        if (!image) return reply('❌ Send or reply to an image with the .profilepic command.');

        let imageMessage = msg;
        if (!msg.message?.imageMessage && context?.stanzaId) {
          imageMessage = {
            key: {
              remoteJid: msg.key.remoteJid,
              id: context.stanzaId,
              participant: context.participant,
              fromMe: false,
            },
            message: quoted,
          };
        }
        const buffer = await sock.downloadMediaMessage(imageMessage);
        if (!buffer) return reply('❌ Could not download the image.');
        await sock.updateProfilePicture(sock.user.id, buffer);
        await reply('✅ Profile picture updated.');
      } catch (error) {
        console.error('[CASTRO-MD:PROFILEPIC]', error);
        await reply('❌ Could not update the profile picture. Try sending the image directly with the command.');
      }
    },
  },
  {
    name: 'block',
    description: 'Block a WhatsApp contact',
    ownerOnly: true,
    run: async ({ sock, msg, reply }) => {
      try {
        const context = msg.message?.extendedTextMessage?.contextInfo;
        const target = context?.mentionedJid?.[0] || context?.participant;
        if (!target) return reply('Mention or reply to the contact you want to block.');
        await sock.updateBlockStatus(target, 'block');
        await reply('✅ Contact blocked.');
      } catch (error) {
        console.error('[CASTRO-MD:BLOCK]', error);
        await reply('❌ Failed to block that contact.');
      }
    },
  },
  {
    name: 'unblock',
    description: 'Unblock a WhatsApp contact',
    ownerOnly: true,
    run: async ({ sock, msg, reply }) => {
      try {
        const context = msg.message?.extendedTextMessage?.contextInfo;
        const target = context?.mentionedJid?.[0] || context?.participant;
        if (!target) return reply('Mention or reply to the contact you want to unblock.');
        await sock.updateBlockStatus(target, 'unblock');
        await reply('✅ Contact unblocked.');
      } catch (error) {
        console.error('[CASTRO-MD:UNBLOCK]', error);
        await reply('❌ Failed to unblock that contact.');
      }
    },
  },
  {
    name: 'owner',
    aliases: ['creator', 'dev', 'developer'],
    description: 'Show the bot owner and send the contact card',
    ownerOnly: false,
    run: async ({ sock, from, msg, reply, settings }) => {
      const { name, number } = settings.developer;
      await reply(
        '┌───✧ CASTRO-MD OWNER ✧────\n' +
          `│✧ 👨‍💻 Developer: ${name}\n` +
          `│✧ 📞 Number: +${number}\n` +
          `│✧ 💬 Chat: wa.me/${number}\n` +
          '│✧ 🇰🇪 Country: Kenya\n' +
          `│✧ 🤖 Bot: ${settings.botName}\n` +
          '└──────────────'
      );
      try {
        const vcard =
          'BEGIN:VCARD\nVERSION:3.0\n' +
          `FN:${name}\nORG:CASTRO-MD;\n` +
          `TEL;type=CELL;type=VOICE;waid=${number}:+${number}\n` +
          'END:VCARD';
        await sock.sendMessage(from, { contacts: { displayName: name, contacts: [{ vcard }] } }, { quoted: msg });
      } catch (e) {}
    },
  },
  {
    name: 'autoviewstatus',
    aliases: ['autostatus', 'viewstatus', 'autoview'],
    description: 'Turn automatic status viewing on or off: autoviewstatus on|off',
    ownerOnly: true,
    run: async ({ reply, args, settings, prefix }) => {
      const v = (args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(v)) {
        return reply(`Auto view status is ${settings.autoViewStatus ? 'ON' : 'OFF'}.\nUse: ${prefix}autoviewstatus on|off`);
      }
      settings.autoViewStatus = v === 'on';
      if (!store.save(settings)) {
        await reply('⚠️ Auto view status changed for this run, but could not be saved. Check DATA_DIR permissions or persistent storage.');
        return;
      }
      await reply(`✅ Auto view status turned ${v.toUpperCase()} and saved.`);
    },
  },
  {
    name: 'autoread',
    aliases: ['autoseen', 'readall'],
    description: 'Automatically mark incoming chats as read: autoread on|off',
    ownerOnly: true,
    run: async ({ reply, args, settings, prefix }) => {
      const v = (args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(v)) {
        return reply(`Auto read is ${settings.autoRead ? 'ON' : 'OFF'}.\nUse: ${prefix}autoread on|off`);
      }
      settings.autoRead = v === 'on';
      if (!store.save(settings)) {
        await reply('⚠️ Auto read changed for this run, but could not be saved. Check DATA_DIR permissions or persistent storage.');
        return;
      }
      await reply(`✅ Auto read turned ${v.toUpperCase()} and saved.`);
    },
  },
  {
    name: 'anticall',
    aliases: ['autorejectcall', 'rejectcalls'],
    description: 'Automatically reject incoming WhatsApp calls: anticall on|off',
    ownerOnly: true,
    run: async ({ reply, args, settings, prefix }) => {
      const value = String(args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(value)) {
        return reply(`Anti-call is ${settings.antiCall ? 'ON' : 'OFF'}.\\nUse: ${prefix}anticall on|off`);
      }
      settings.antiCall = value === 'on';
      if (!store.save(settings)) {
        await reply('⚠️ Anti-call changed for this run, but could not be saved. Check DATA_DIR permissions or persistent storage.');
        return;
      }
      await reply(`✅ Anti-call turned ${value.toUpperCase()} and saved.`);
    },
  },
  {
    name: 'runtime',
    aliases: ['uptime'],
    description: 'Show bot uptime',
    ownerOnly: false,
    run: async ({ reply }) => {
      const seconds = Math.floor(process.uptime());
      const days = Math.floor(seconds / 86400);
      const hours = Math.floor((seconds % 86400) / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const remainingSeconds = seconds % 60;
      await reply(`⏱️ *CASTRO-MD UPTIME*\n\n${days}d ${hours}h ${minutes}m ${remainingSeconds}s`);
    },
  },
  {
    name: 'restart',
    description: 'Restart the bot process',
    ownerOnly: true,
    run: async ({ reply }) => {
      await reply('🔄 CASTRO-MD is restarting now. Give it a moment to reconnect.');
      // Let the WhatsApp reply leave the process before asking the host/process manager
      // to restart us. SIGTERM also gives the guard module a chance to flush its data.
      setTimeout(() => process.kill(process.pid, 'SIGTERM'), 1200);
    },
  },
];
