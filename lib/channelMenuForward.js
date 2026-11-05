'use strict';

const crypto = require('crypto');
const persistence = require('./mongoPersistence');

const COLLECTION = 'channel_menu_posts';
const MAX_LOOKUP_SECONDS = 15 * 60;

function channelCode(link) {
  return (String(link || '').match(/channel\/([A-Za-z0-9_-]+)/) || [])[1] || '';
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

function lookupSinceSeconds(timestamp) {
  const value = Number(timestamp || 0);
  // Persisted state timestamps are Date.now() milliseconds, while Baileys'
  // newsletterFetchMessages API expects Unix seconds. Accept seconds too.
  const seconds = value > 100000000000 ? Math.floor(value / 1000) : Math.floor(value);
  return Math.max(0, seconds - MAX_LOOKUP_SECONDS);
}

function walkNodes(value, visit) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) walkNodes(item, visit);
    return;
  }
  visit(value);
  if (Array.isArray(value.content)) walkNodes(value.content, visit);
}

function findNewsletterMessage(response, proto, jid, expectedHash) {
  let found = null;
  walkNodes(response, (node) => {
    if (found || node.tag !== 'message' || !node.attrs) return;
    const rawId = node.attrs.message_id || node.attrs.server_id;
    const serverMessageId = Number(rawId);
    if (!Number.isInteger(serverMessageId) || serverMessageId <= 0 || serverMessageId > 2147483647) return;
    const plain = (node.content || []).find((child) => child?.tag === 'plaintext')?.content;
    if (!plain) return;
    try {
      const bytes = Buffer.isBuffer(plain) ? plain : Buffer.from(plain, typeof plain === 'string' ? 'binary' : undefined);
      const decoded = proto.Message.decode(bytes);
      const text = messageText({ message: decoded });
      const hash = crypto.createHash('sha256').update(text).digest('hex');
      if (expectedHash && hash !== expectedHash) return;
      const timestamp = Number(node.attrs.t) || Math.floor(Date.now() / 1000);
      found = proto.WebMessageInfo.fromObject({
        key: { remoteJid: jid, id: String(serverMessageId), fromMe: false },
        message: decoded,
        messageTimestamp: timestamp,
      });
    } catch {
      // Ignore malformed or unsupported Channel entries; never invent an ID.
    }
  });
  return found;
}

function buildChannelForwardContent(posted, channel, generateForwardMessageContent) {
  if (typeof generateForwardMessageContent !== 'function') {
    throw new Error('Baileys forward-content helper is unavailable.');
  }
  const content = generateForwardMessageContent(posted);
  const messageType = Object.keys(content || {})[0];
  const body = messageType ? content[messageType] : null;
  if (!body || typeof body !== 'object') {
    throw new Error('Unsupported Channel message content.');
  }
  const serverMessageId = Number(channel.serverMessageId);
  if (!Number.isInteger(serverMessageId) || serverMessageId <= 0 || serverMessageId > 2147483647) {
    throw new Error('A valid WhatsApp Channel server message ID is required.');
  }
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

async function fetchPostedMessage(sock, jid, hash, since) {
  const result = await sock.newsletterFetchMessages(
    jid,
    30,
    lookupSinceSeconds(since),
    0
  );
  const { proto } = require('@whiskeysockets/baileys');
  return findNewsletterMessage(result, proto, jid, hash);
}

/**
 * Publish the menu once, then forward the actual server-fetched Channel message.
 * Persistent storage is mandatory: without it the bot falls back rather than
 * risking a new Channel post on every .menu command or after a restart.
 */
async function forwardMenu({ sock, from, channelLink, image, caption, settings }) {
  const code = channelCode(channelLink);
  if (!code || !sock?.newsletterMetadata || !sock?.newsletterFetchMessages) return false;

  let state;
  try {
    const metadata = await sock.newsletterMetadata('invite', code);
    if (!metadata?.id || !String(metadata.id).endsWith('@newsletter')) return false;
    const jid = metadata.id;
    const hash = crypto.createHash('sha256').update(String(caption)).digest('hex');

    state = await readState(settings);
    if (!state) {
      const initial = {
        channelJid: jid,
        channelName: metadata.name || '',
        captionHash: hash,
        status: 'publishing',
        requestedAt: Date.now(),
      };
      const claimed = await persistence.createDocument(COLLECTION, initial, settings.mongoUri, settings.mongoDb);
      state = claimed ? initial : await readState(settings);
      if (!state) return false;

      if (claimed) {
        try {
          const payload = image
            ? { image, caption: String(caption) }
            : { text: String(caption) };
          const sent = await sock.sendMessage(jid, payload);
          state = {
            ...state,
            status: 'pending_lookup',
            localMessageId: sent?.key?.id || null,
            sentAt: Date.now(),
          };
          await writeState(settings, state);
        } catch (error) {
          const errorText = String(error?.message || error);
          const statusCode = Number(error?.output?.statusCode || error?.statusCode || 0);
          const permissionDenied = statusCode === 403 || /not.?authorized|not an admin|forbidden|not permitted/i.test(errorText);
          state = {
            ...state,
            status: 'publish_failed',
            error: errorText,
            retryablePermissionDenied: permissionDenied,
            retryAfter: permissionDenied ? Date.now() + 60 * 1000 : null,
          };
          await writeState(settings, state);
          return false;
        }
      }
    }

    if (state.channelJid !== jid) return false;
    if (state.status === 'publish_failed') {
      if (!state.retryablePermissionDenied || Date.now() < Number(state.retryAfter || 0)) return false;
      try {
        const payload = image ? { image, caption: String(caption) } : { text: String(caption) };
        const sent = await sock.sendMessage(jid, payload);
        state = { ...state, status: 'pending_lookup', localMessageId: sent?.key?.id || null, sentAt: Date.now() };
        await writeState(settings, state);
      } catch (error) {
        const errorText = String(error?.message || error);
        const statusCode = Number(error?.output?.statusCode || error?.statusCode || 0);
        const permissionDenied = statusCode === 403 || /not.?authorized|not an admin|forbidden|not permitted/i.test(errorText);
        state = { ...state, error: errorText, retryablePermissionDenied: permissionDenied, retryAfter: permissionDenied ? Date.now() + 60 * 1000 : null };
        await writeState(settings, state);
        return false;
      }
    }

    const { proto } = require('@whiskeysockets/baileys');
    let posted = null;
    if (state.status === 'ready' && state.serializedMessage) {
      try {
        posted = proto.WebMessageInfo.decode(Buffer.from(state.serializedMessage, 'base64'));
        if (posted?.key?.id !== state.serverMessageId) posted = null;
      } catch {
        posted = null;
      }
    }

    if (!posted) {
      // WhatsApp expects Unix seconds here. State timestamps are milliseconds;
      // fetchPostedMessage normalizes them before calling Baileys.
      posted = await fetchPostedMessage(sock, jid, state.captionHash || hash, state.sentAt || state.requestedAt);
      if (!posted?.key?.id || !posted.message) return false;
      const serializedMessage = proto.WebMessageInfo.encode(posted).finish().toString('base64');
      state = {
        ...state,
        status: 'ready',
        serverMessageId: posted.key.id,
        serverMessageTimestamp: Number(posted.messageTimestamp) || null,
        serializedMessage,
        resolvedAt: Date.now(),
      };
      await writeState(settings, state);
    }

    if (typeof sock.relayMessage !== 'function') return false;
    const { generateForwardMessageContent } = require('@whiskeysockets/baileys');
    const forwardedContent = buildChannelForwardContent(
      posted,
      {
        jid,
        name: state.channelName || metadata.name || '',
        serverMessageId: state.serverMessageId || posted.key.id,
      },
      generateForwardMessageContent
    );
    await sock.relayMessage(from, forwardedContent, {});
    return true;
  } catch (error) {
    console.error('[CHANNEL MENU] Native forward unavailable; using regular menu:', error?.message || error);
    return false;
  }
}

module.exports = { channelCode, messageText, lookupSinceSeconds, findNewsletterMessage, buildChannelForwardContent, forwardMenu };
