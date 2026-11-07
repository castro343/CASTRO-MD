'use strict';

const store = require('../lib/store');

// CASTRO-MD owner commands.

module.exports = [
  {
  {
    name: 'channelannounce',
    aliases: ['channelpost'],
    description: 'Manage CASTRO-MD WhatsApp Channel announcements',
    ownerOnly: true,
    run: async ({ sock, args, reply, settings, prefix }) => {
      const action = String(args[0] || 'status').toLowerCase();
      if (action === 'status') return reply('📢 CHANNEL ANNOUNCEMENTS\\nAutomatic deploy posts: ' + (settings.channelAnnounceEnabled ? 'ON' : 'OFF') + '\\nUse: ' + prefix + 'channelannounce on|off|test|status; ' + prefix + 'channelannounce post Your message');
      if (action === 'on' || action === 'off') {
        const old = settings.channelAnnounceEnabled;
        settings.channelAnnounceEnabled = action === 'on';
        try { await store.save(settings); } catch (e) { settings.channelAnnounceEnabled = old; return reply('Could not save Channel settings.'); }
        return reply(action === 'on' ? '✅ Automatic deployment announcements enabled. The next new deployment will be announced after reconnect, if this account can post to the Channel.' : '🔕 Automatic announcements disabled.');
      }
      if (!['test', 'post'].includes(action)) return reply('Use: ' + prefix + 'channelannounce on|off|test|status or ' + prefix + 'channelannounce post Your message');
      if (action === 'test' && !settings.channelAnnounceEnabled) return reply('Enable announcements first with ' + prefix + 'channelannounce on.');
      const body = action === 'test' ? '🧪 CASTRO-MD CHANNEL TEST\\n\\nChannel publishing is connected.\\n🤖 CASTRO-MD • Official Updates' : args.slice(1).join(' ').trim();
      if (!body) return reply('Add text after ' + prefix + 'channelannounce post.');
      try {
        const link = settings.channelLink || 'https://whatsapp.com/channel/0029VbE0iWxEawdsY3dBaB18';
        const code = (link.match(/channel\\/([A-Za-z0-9_-]+)/) || [])[1];
        if (!code || typeof sock.newsletterMetadata !== 'function') throw new Error('Channel lookup is unavailable.');
        const meta = await sock.newsletterMetadata('invite', code);
        if (!meta?.id || !String(meta.id).endsWith('@newsletter')) throw new Error('Invalid Channel metadata.');
        await sock.sendMessage(meta.id, { text: body + '\\n\\n🔗 Official CASTRO-MD updates' });
        return reply('✅ Published to the CASTRO-MD Channel.');
      } catch (e) {
        console.error('[CHANNEL ANNOUNCEMENTS]', e);
        return reply('❌ Could not publish. Confirm this linked WhatsApp account is a Channel admin with posting permission. ' + String(e.message || e).slice(0, 130));
      }
    },
  },
    name: 'mode',
    description: 'Set command access to private or public: mode private|public',
    ownerOnly: true,
    run: async ({ args, reply, settings, prefix }) => {
      const requested = String(args[0] || '').toLowerCase();
      if (!requested) {
        return reply(`🔐 Current bot mode: ${settings.mode.toUpperCase()}\nUse: ${prefix}mode private or ${prefix}mode public`);
      }
      if (!['private', 'public'].includes(requested)) {
        return reply(`❌ Invalid mode. Use: ${prefix}mode private or ${prefix}mode public`);
      }
      const previous = settings.mode;
      settings.mode = requested;
      try {
        await store.save(settings);
      } catch (error) {
        settings.mode = previous;
        return reply('❌ Could not save the mode. Your previous mode is unchanged.');
      }
      return reply(requested === 'private'
        ? '🔒 PRIVATE MODE enabled. Only this bot account owner can trigger commands.'
        : '🌍 PUBLIC MODE enabled. Anyone can use public commands; owner-only commands remain protected.');
    },
  },
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
      try { await store.save(settings); } catch (error) {
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
      try { await store.save(settings); } catch (error) {
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
        return reply(`Anti-call is ${settings.antiCall ? 'ON' : 'OFF'}.\nUse: ${prefix}anticall on|off`);
      }
      settings.antiCall = value === 'on';
      try { await store.save(settings); } catch (error) {
        await reply('⚠️ Anti-call changed for this run, but could not be saved. Check DATA_DIR permissions or persistent storage.');
        return;
      }
      await reply(`✅ Anti-call turned ${value.toUpperCase()} and saved.`);
    },
  },
  {
    name: 'antidelete',
    aliases: ['antidel'],
    description: 'Notify the owner when a recent incoming text message is deleted: antidelete on|off',
    ownerOnly: true,
    run: async ({ reply, args, settings, prefix }) => {
      const value = String(args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(value)) {
        return reply(`Anti-delete is ${settings.antiDelete ? 'ON' : 'OFF'}.\\nUse: ${prefix}antidelete on|off`);
      }
      settings.antiDelete = value === 'on';
      try { await store.save(settings); } catch (error) { return reply('⚠️ Anti-delete changed for this run, but could not be saved. Check persistent storage permissions.'); }
      await reply(`✅ Anti-delete turned ${value.toUpperCase()} and saved. It reports recovered text only; media recovery is not enabled.`);
    },
  },
  {
    name: 'alwaysonline',
    aliases: ['online', 'keeponline'],
    description: 'Keep WhatsApp presence online: alwaysonline on|off',
    ownerOnly: true,
    run: async ({ sock, reply, args, settings, prefix }) => {
      const value = String(args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(value)) {
        return reply(`Always-online is ${settings.alwaysOnline ? 'ON' : 'OFF'}.\nUse: ${prefix}alwaysonline on|off`);
      }
      settings.alwaysOnline = value === 'on';
      try { await sock.sendPresenceUpdate(settings.alwaysOnline ? 'available' : 'unavailable'); }
      catch (error) { console.error('[CASTRO-MD:ALWAYSONLINE]', error); }
      try { await store.save(settings); } catch (error) { return reply('⚠️ Presence changed for this run, but could not be saved. Check persistent storage permissions.'); }
      await reply(`✅ Always-online turned ${value.toUpperCase()} and saved.`);
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
