'use strict';

const DEFAULT_CHANNEL_LINK = 'https://whatsapp.com/channel/0029VbE0iWxEawdsY3dBaB18';

async function publishDeployment(sock, settings, store, log) {
  if (!settings.channelAnnounceEnabled) return false;
  const commit = String(process.env.RENDER_GIT_COMMIT || process.env.SOURCE_VERSION || '').trim();
  if (!commit || commit === settings.channelLastAnnouncedCommit) return false;
  try {
    const link = settings.channelLink || DEFAULT_CHANNEL_LINK;
    const code = (link.match(/channel\/([A-Za-z0-9_-]+)/) || [])[1];
    if (!code || typeof sock.newsletterMetadata !== 'function') return false;
    const metadata = await sock.newsletterMetadata('invite', code);
    if (!metadata?.id || !String(metadata.id).endsWith('@newsletter')) return false;
    const text =
      '🚀 *CASTRO-MD UPDATE DEPLOYED*\n\n' +
      'A new CASTRO-MD version has successfully started.\n\n' +
      '✨ Improvements and maintenance updates\n' +
      '🛠️ Performance and reliability work\n' +
      '🔖 Build: ' + commit.slice(0, 7) + '\n\n' +
      '🤖 *CASTRO-MD*\nOfficial updates • New features • Fixes\n\n' +
      '🔗 ' + (settings.repo || 'https://github.com/castro343/CASTRO-MD');
    await sock.sendMessage(metadata.id, { text });
    settings.channelLastAnnouncedCommit = commit;
    await store.save(settings);
    log.info('[CHANNEL ANNOUNCEMENTS] Published deployment ' + commit.slice(0, 7));
    return true;
  } catch (error) {
    log.warn('[CHANNEL ANNOUNCEMENTS] Deployment post skipped: ' + (error?.message || error));
    return false;
  }
}

module.exports = { publishDeployment };
