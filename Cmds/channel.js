'use strict';

// Owner-controlled CASTRO-MD WhatsApp Channel publishing.
const CHANNEL_LINK = 'https://whatsapp.com/channel/0029VbE0iWxEawdsY3dBaB18';
function channelCode(link) { return (String(link).match(/channel\/([A-Za-z0-9_-]+)/) || [])[1] || ''; }
async function resolveChannel(sock) {
  const code = channelCode(CHANNEL_LINK);
  if (!code) throw new Error('Invalid Channel invite link.');
  const metadata = await sock.newsletterMetadata('invite', code);
  if (!metadata?.id || !String(metadata.id).endsWith('@newsletter')) throw new Error('WhatsApp did not return a valid Channel identity.');
  return metadata;
}
module.exports = [
  {
    name: 'channelstatus', aliases: ['chstatus'], description: 'Check CASTRO-MD Channel access', ownerOnly: true,
    run: async ({ sock, reply }) => {
      try {
        const channel = await resolveChannel(sock);
        await reply('📢 *CASTRO-MD CHANNEL STATUS*\n\n✅ Channel link resolved\n' +
          `📰 Name: ${channel.name || 'CASTRO-MD'}\n🆔 Channel ID: ${channel.id}\n` +
          '🔐 Publishing permission: not yet verified\n\nUse .channeltest to verify publishing access.');
      } catch (error) { console.error('[CHANNEL STATUS]', error); await reply(`❌ Channel access failed: ${error.message}`); }
    },
  },
  {
    name: 'channeltest', aliases: ['chtest'], description: 'Publish a test post to the official Channel', ownerOnly: true,
    run: async ({ sock, reply, settings }) => {
      try {
        const channel = await resolveChannel(sock);
        await sock.sendMessage(channel.id, { text:
          '🧪 *CASTRO-MD CHANNEL SYSTEM TEST*\n\nThe announcement connection is being tested. No feature or command has changed in this test.\n\n' +
          `🤖 ${settings.botName}\n🔗 ${CHANNEL_LINK}` });
        await reply('✅ WhatsApp accepted the test post. Check the Channel to confirm it is visible.');
      } catch (error) {
        console.error('[CHANNEL TEST]', error);
        await reply(`❌ Test post failed. Ensure this paired account is a Channel administrator.\nReason: ${error.message}`);
      }
    },
  },
  {
    name: 'channelannounce', aliases: ['channounce'], description: 'Publish an announcement to the official Channel', ownerOnly: true,
    run: async ({ sock, text, reply, settings, prefix }) => {
      const announcement = String(text || '').trim();
      if (!announcement) return reply(`Usage: ${prefix}channelannounce Your announcement here`);
      if (announcement.length > 3000) return reply('❌ Keep announcements under 3,000 characters.');
      try {
        const channel = await resolveChannel(sock);
        await sock.sendMessage(channel.id, { text:
          '📢 *CASTRO-MD OFFICIAL ANNOUNCEMENT*\n\n' + announcement +
          `\n\n🤖 ${settings.botName}\n🔗 ${CHANNEL_LINK}` });
        await reply('✅ Announcement submitted to the official Channel.');
      } catch (error) {
        console.error('[CHANNEL ANNOUNCE]', error);
        await reply(`❌ Publishing failed. Ensure this paired account is a Channel administrator.\nReason: ${error.message}`);
      }
    },
  },
];
