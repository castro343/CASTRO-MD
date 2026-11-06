'use strict';

const crypto = require('crypto');
const persistence = require('./mongoPersistence');

const COLLECTION = 'channel_menu_posts';
const MIGRATION_CLAIMS = 'channel_menu_migration_claims';
const MAX_LOOKUP_SECONDS = 15 * 60;
const CHANNEL_LOOKUP_TIMEOUT_MS = 10000;

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

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

function matchesChannelMenuMessage(msg, state) {
  if (!msg?.key?.remoteJid || msg.key.remoteJid !== state?.channelJid) return false;
  if (!['publishing', 'pending_lookup'].includes(state.status)) return false;
  const serverMessageId = Number(msg.key.id);
  if (!Number.isInteger(serverMessageId) || serverMessageId <= 0 || serverMessageId > 2147483647) return false;
  const text = messageText(msg);
  if (!text) return false;
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  if (hash !== state.captionHash) return false;
  const sentAt = Number(state.sentAt || state.requestedAt || 0);
  const sentSeconds = sentAt > 100000000000 ? Math.floor(sentAt / 1000) : Math.floor(sentAt);
  const messageSeconds = Number(msg.messageTimestamp || 0);
  return !sentSeconds || !messageSeconds || messageSeconds >= sentSeconds - 60;
}

async function captureChannelMenuPost(msg, settings) {
  const state = await readState(settings);
  if (!state || !matchesChannelMenuMessage(msg, state)) return false;
  const { proto } = require('@whiskeysockets/baileys');
  const serializedMessage = proto.WebMessageInfo.encode(msg).finish().toString('base64');
  const serverMessageId = Number(msg.key.id);
  await writeState(settings, {
    ...state,
    status: 'ready',
    serverMessageId: String(serverMessageId),
    serverMessageTimestamp: Number(msg.messageTimestamp) || null,
    serializedMessage,
    resolvedAt: Date.now(),
    resolutionSource: 'live_newsletter_event',
  });
  return true;
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
  const content = generateForwardMessageContent(posted, true);
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

async function subscribeToChannelLiveUpdates(sock, jid) {
  if (typeof sock?.subscribeNewsletterUpdates !== 'function') {
    throw new Error('Baileys newsletter live-update subscription is unavailable.');
  }
  try {
    return await sock.subscribeNewsletterUpdates(jid);
  } catch (error) {
    throw new Error(`Channel live-update subscription failed: ${error?.message || error}`);
  }
}

async function fetchPostedMessage(sock, jid, hash, since) {
  const result = await withTimeout(
    sock.newsletterFetchMessages(jid, 30, lookupSinceSeconds(since), 0),
    CHANNEL_LOOKUP_TIMEOUT_MS,
    'Channel message lookup'
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
    const metadata = await withTimeout(
      sock.newsletterMetadata('invite', code),
      5000,
      'Channel metadata lookup'
    );
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
          await subscribeToChannelLiveUpdates(sock, jid);
          const payload = image
            ? { image, caption: String(caption) }
            : { text: String(caption) };
          const sent = await sock.sendMessage(jid, payload);
          const latest = await readState(settings);
          state = latest?.status === 'ready' ? latest : {
            ...state,
            status: 'pending_lookup',
            localMessageId: sent?.key?.id || null,
            sentAt: Date.now(),
          };
          if (state.status !== 'ready') await writeState(settings, state);
        } catch (error) {
          const errorText = String(error?.message || error);
          const statusCode = Number(error?.output?.statusCode || error?.statusCode || 0);
          const permissionDenied = statusCode === 403 || /not.?authorized|not an admin|forbidden|not permitted/i.test(errorText);
          const retryableSubscriptionFailure = /live-update subscription/i.test(errorText);
          state = {
            ...state,
            status: 'publish_failed',
            error: errorText,
            retryablePermissionDenied: permissionDenied || retryableSubscriptionFailure,
            retryAfter: permissionDenied || retryableSubscriptionFailure ? Date.now() + 60 * 1000 : null,
          };
          await writeState(settings, state);
          return false;
        }
      }
    }

    if (state.channelJid !== jid) return false;

    // Controlled one-time migration: the original menu post predates newsletter
    // subscriptions, so its live event cannot be recovered. An explicit Render
    // flag enables exactly one replacement post for this tenant. The atomic
    // claim is persisted before sending so concurrent .menu commands/restarts
    // cannot publish duplicates.
    if (
      process.env.CHANNEL_MENU_REPUBLISH_ONCE === 'true' &&
      state.status === 'pending_lookup' &&
      state.migrationRepublishAttempted !== true
    ) {
      // This Channel may be used by more than one connected bot account.
      // Claim the public replacement globally by Channel JID so only one
      // tenant can publish the approved replacement post.
      const globalClaimed = await persistence.createDocument(
        MIGRATION_CLAIMS,
        {
          _id: `channel:${jid}`,
          channelJid: jid,
          tenantId: String(state._id || ''),
          claimedAt: Date.now(),
          status: 'claimed',
        },
        settings.mongoUri,
        settings.mongoDb
      );
      if (!globalClaimed) return false;

      const claimed = await persistence.claimDocument(
        COLLECTION,
        { _id: state._id, status: 'pending_lookup', migrationRepublishAttempted: { $ne: true } },
        {
          $set: {
            migrationRepublishAttempted: true,
            status: 'publishing',
            captionHash: hash,
            channelName: metadata.name || state.channelName || '',
            requestedAt: Date.now(),
            sentAt: null,
            localMessageId: null,
            serverMessageId: null,
            serializedMessage: null,
            resolvedAt: null,
            resolutionSource: null,
          },
        },
        settings.mongoUri,
        settings.mongoDb
      );
      if (claimed) {
        const migrationState = await readState(settings);
        try {
          await subscribeToChannelLiveUpdates(sock, jid);
          const payload = image
            ? { image, caption: String(caption) }
            : { text: String(caption) };
          const sent = await sock.sendMessage(jid, payload);
          const latest = await readState(settings);
          state = latest?.status === 'ready' ? latest : {
            ...migrationState,
            status: 'pending_lookup',
            localMessageId: sent?.key?.id || null,
            sentAt: Date.now(),
          };
          if (state.status !== 'ready') await writeState(settings, state);
          console.info('[CHANNEL MENU] Published the one-time replacement Channel menu post.');
        } catch (error) {
          const errorText = String(error?.message || error);
          state = {
            ...migrationState,
            status: 'publish_failed',
            error: errorText,
            migrationRepublishAttempted: true,
            retryablePermissionDenied: false,
            retryAfter: null,
          };
          await writeState(settings, state);
          console.error('[CHANNEL MENU] One-time replacement post failed; automatic republishing is disabled:', errorText);
          return false;
        }
      }
      state = await readState(settings);
    }

    if (state.status === 'publish_failed') {
      if (!state.retryablePermissionDenied || Date.now() < Number(state.retryAfter || 0)) return false;
      try {
        await subscribeToChannelLiveUpdates(sock, jid);
        const payload = image ? { image, caption: String(caption) } : { text: String(caption) };
        const sent = await sock.sendMessage(jid, payload);
        const latest = await readState(settings);
        state = latest?.status === 'ready' ? latest : { ...state, status: 'pending_lookup', localMessageId: sent?.key?.id || null, sentAt: Date.now() };
        if (state.status !== 'ready') await writeState(settings, state);
      } catch (error) {
        const errorText = String(error?.message || error);
        const statusCode = Number(error?.output?.statusCode || error?.statusCode || 0);
        const permissionDenied = statusCode === 403 || /not.?authorized|not an admin|forbidden|not permitted/i.test(errorText);
        const retryableSubscriptionFailure = /live-update subscription/i.test(errorText);
        state = { ...state, error: errorText, retryablePermissionDenied: permissionDenied || retryableSubscriptionFailure, retryAfter: permissionDenied || retryableSubscriptionFailure ? Date.now() + 60 * 1000 : null };
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

module.exports = { channelCode, messageText, matchesChannelMenuMessage, captureChannelMenuPost, lookupSinceSeconds, findNewsletterMessage, buildChannelForwardContent, subscribeToChannelLiveUpdates, forwardMenu };
