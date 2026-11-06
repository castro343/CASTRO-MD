'use strict';

const crypto = require('crypto');
const persistence = require('./mongoPersistence');

const COLLECTION = 'channel_menu_posts';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function channelCode(link) {
  return (String(link || '').match(/whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/i) || [])[1] || '';
}

function messageText(message) {
  const m = message?.message || {};
  return String(
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.extendedTextMessage?.text ||
    m.conversation ||
    ''
  );
}

function captionHash(caption) {
  return crypto.createHash('sha256').update(String(caption)).digest('hex');
}

function validServerMessageId(id) {
  const value = Number(id);
  return Number.isInteger(value) && value > 0 && value <= 2147483647 ? value : null;
}

/**
 * Called by index.js for live @newsletter messages. It only captures a post
 * when its Channel JID and exact menu caption match the pending one-time post.
 * The ID is taken from WhatsApp's incoming server event, never sendMessage().
 */
async function captureChannelMenuPost(message, settings) {
  if (!settings?.mongoUri) return false;
  const jid = String(message?.key?.remoteJid || '');
  const serverMessageId = validServerMessageId(message?.key?.id);
  if (!jid.endsWith('@newsletter') || !serverMessageId || !message?.message) return false;

  const state = await persistence.readDocument(COLLECTION, settings.mongoUri, settings.mongoDb);
  if (!state || state.status !== 'pending_capture' || state.channelJid !== jid) return false;
  if (captionHash(messageText(message)) !== state.captionHash) return false;

  const { proto } = require('@whiskeysockets/baileys');
  const serializedMessage = proto.WebMessageInfo.encode(message).finish().toString('base64');
  await persistence.writeDocument(COLLECTION, {
    ...state,
    status: 'ready',
    serverMessageId,
    serializedMessage,
    capturedAt: Date.now(),
  }, settings.mongoUri, settings.mongoDb);
  return true;
}

function buildChannelForwardContent(posted, channel, generateForwardMessageContent) {
  if (typeof generateForwardMessageContent !== 'function') {
    throw new Error('Baileys forward-content helper is unavailable.');
  }
  const content = generateForwardMessageContent(posted, true);
  const messageType = Object.keys(content || {})[0];
  const body = messageType ? content[messageType] : null;
  if (!body || typeof body !== 'object') throw new Error('Unsupported Channel message content.');

  const serverMessageId = validServerMessageId(channel.serverMessageId);
  if (!serverMessageId) throw new Error('A verified WhatsApp Channel message ID is required.');

  body.contextInfo = {
    ...(body.contextInfo || {}),
    forwardedNewsletterMessageInfo: {
      newsletterJid: channel.jid,
      newsletterName: String(channel.name || ''),
      serverMessageId,
    },
  };
  return content;
}

async function readState(settings) {
  if (!settings?.mongoUri) throw new Error('Persistent MongoDB storage is required for one-time Channel publishing.');
  return persistence.readDocument(COLLECTION, settings.mongoUri, settings.mongoDb);
}

async function writeState(settings, state) {
  if (!settings?.mongoUri) throw new Error('Persistent MongoDB storage is required for one-time Channel publishing.');
  await persistence.writeDocument(COLLECTION, state, settings.mongoUri, settings.mongoDb);
}

async function waitForCapturedPost(settings, channelJid, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readState(settings);
    if (state?.channelJid !== channelJid) return null;
    if (state.status === 'ready' && state.serializedMessage && validServerMessageId(state.serverMessageId)) return state;
    if (state.status !== 'pending_capture') return null;
    await sleep(500);
  }
  return null;
}

/**
 * Publish the generic menu once, capture WhatsApp's live Channel event, then
 * forward that exact server-confirmed post. MongoDB prevents duplicate posts
 * across workers/restarts. If any verification step fails, caller sends the
 * existing direct menu instead.
 */
async function forwardMenu({ sock, from, channelLink, image, caption, settings }) {
  const code = channelCode(channelLink);
  if (!code || !sock?.newsletterMetadata || !sock?.relayMessage) return false;

  try {
    if (!settings?.mongoUri) return false;
    const metadata = await sock.newsletterMetadata('invite', code);
    if (!metadata?.id || !String(metadata.id).endsWith('@newsletter')) return false;

    const channelJid = metadata.id;
    const hash = captionHash(caption);
    let state = await readState(settings);

    if (!state) {
      const initial = {
        channelJid,
        channelName: metadata.name || 'CASTRO-MD',
        captionHash: hash,
        status: 'pending_capture',
        requestedAt: Date.now(),
      };
      // Atomic insert: only one worker can publish the initial Channel post.
      const claimed = await persistence.createDocument(
        COLLECTION, initial, settings.mongoUri, settings.mongoDb
      );
      state = claimed ? initial : await readState(settings);

      if (claimed) {
        try {
          const payload = image?.length
            ? { image, caption: String(caption) }
            : { text: String(caption) };
          await sock.sendMessage(channelJid, payload);
        } catch (error) {
          // Do not blindly retry an ambiguous failure: WhatsApp may have accepted it.
          await writeState(settings, {
            ...initial,
            status: 'publish_failed',
            error: String(error?.message || error).slice(0, 300),
          });
          return false;
        }
      }
    }

    if (!state || state.channelJid !== channelJid) return false;
    if (state.status === 'pending_capture') {
      state = await waitForCapturedPost(settings, channelJid);
    }
    if (!state || state.status !== 'ready' ||
        !validServerMessageId(state.serverMessageId) ||
        !state.serializedMessage) return false;

    const { proto, generateForwardMessageContent } = require('@whiskeysockets/baileys');
    const posted = proto.WebMessageInfo.decode(Buffer.from(state.serializedMessage, 'base64'));
    if (!posted?.message || String(posted.key?.id) !== String(state.serverMessageId) ||
        posted.key?.remoteJid !== channelJid) return false;

    const forwarded = buildChannelForwardContent(
      posted,
      {
        jid: channelJid,
        name: state.channelName || metadata.name || 'CASTRO-MD',
        serverMessageId: state.serverMessageId,
      },
      generateForwardMessageContent
    );
    await sock.relayMessage(from, forwarded, {});
    return true;
  } catch (error) {
    console.error('[CHANNEL MENU] Native forward unavailable; using regular menu:', error?.message || error);
    return false;
  }
}

module.exports = {
  channelCode,
  messageText,
  captionHash,
  validServerMessageId,
  captureChannelMenuPost,
  buildChannelForwardContent,
  forwardMenu,
};
