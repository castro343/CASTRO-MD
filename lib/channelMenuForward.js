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
    const id = node.attrs.message_id || node.attrs.server_id;
    if (!id || !/^[A-Za-z0-9_-]{4,}$/.test(String(id))) return;
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
        key: { remoteJid: jid, id: String(id), fromMe: false },
        message: decoded,
        messageTimestamp: timestamp,
      });
    } catch {
      // Ignore malformed or unsupported Channel entries; never invent an ID.
    }
  });
  return found;
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
    Math.max(0, Number(since || 0) - MAX_LOOKUP_SECONDS),
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
      // A unique Mongo _id makes the first-publish claim atomic across workers.
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
          state = { ...state, status: 'publish_failed', error: String(error?.message || error) };
          await writeState(settings, state);
          return false;
        }
      }
    }

    // Never republish if a previous attempt has already claimed this menu.
    if (state.channelJid !== jid) return false;
    // An ambiguous send failure is not retried automatically: the server may
    // have accepted the post before the connection failed. Avoid Channel spam.
    if (state.status === 'publish_failed') {
      // Only an explicit permission denial is safe to retry: ambiguous network
      // failures may have been accepted by WhatsApp and must never be reposted.
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
      // This also recovers an interrupted publish if WhatsApp accepted it but
      // the process stopped before the fetched server ID was persisted.
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

    await sock.sendMessage(from, { forward: posted });
    return true;
  } catch (error) {
    console.error('[CHANNEL MENU] Native forward unavailable; using regular menu:', error?.message || error);
    return false;
  }
}

module.exports = { channelCode, messageText, findNewsletterMessage, forwardMenu };
