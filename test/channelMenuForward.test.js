'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  channelCode,
  messageText,
  matchesChannelMenuMessage,
  findNewsletterMessage,
  buildChannelForwardContent,
} = require('../lib/channelMenuForward');

const proto = {
  Message: {
    decode(buffer) { return JSON.parse(Buffer.from(buffer).toString('utf8')); },
  },
  WebMessageInfo: {
    fromObject(value) { return value; },
  },
};

function nodeFor(id, caption, timestamp = '1793900000') {
  return {
    tag: 'message',
    attrs: { message_id: id, t: timestamp },
    content: [{
      tag: 'plaintext',
      attrs: {},
      content: Buffer.from(JSON.stringify({ imageMessage: { caption } })),
    }],
  };
}

test('extracts the official Channel invite code', () => {
  assert.equal(channelCode('https://whatsapp.com/channel/0029VbE0iWxEawdsY3dBaB18'), '0029VbE0iWxEawdsY3dBaB18');
  assert.equal(channelCode('https://example.com/not-a-channel'), '');
});

test('reads captions from common WhatsApp message types', () => {
  assert.equal(messageText({ message: { imageMessage: { caption: 'CASTRO-MD menu' } } }), 'CASTRO-MD menu');
  assert.equal(messageText({ message: { extendedTextMessage: { text: 'Menu text' } } }), 'Menu text');
  assert.equal(messageText({ message: { conversation: 'Hello' } }), 'Hello');
});

test('matches only the expected live Channel menu post', () => {
  const caption = 'CASTRO-MD menu';
  const state = {
    channelJid: '12345@newsletter',
    status: 'publishing',
    captionHash: crypto.createHash('sha256').update(caption).digest('hex'),
    requestedAt: 1793900000000,
  };
  assert.equal(matchesChannelMenuMessage({
    key: { remoteJid: '12345@newsletter', id: '123456' },
    message: { imageMessage: { caption } },
    messageTimestamp: 1793900000,
  }, state), true);
  assert.equal(matchesChannelMenuMessage({
    key: { remoteJid: '12345@newsletter', id: '123457' },
    message: { imageMessage: { caption: 'not the menu' } },
    messageTimestamp: 1793900000,
  }, state), false);
});

test('extracts a real numeric server ID from the newsletter response', () => {
  const caption = 'CASTRO-MD menu';
  const hash = crypto.createHash('sha256').update(caption).digest('hex');
  const response = {
    tag: 'iq',
    attrs: {},
    content: [{ tag: 'message_updates', attrs: {}, content: [nodeFor('123456', caption)] }],
  };
  const result = findNewsletterMessage(response, proto, '12345@newsletter', hash);
  assert.equal(result.key.remoteJid, '12345@newsletter');
  assert.equal(result.key.id, '123456');
  assert.equal(result.key.fromMe, false);
  assert.equal(result.message.imageMessage.caption, caption);
});

test('rejects unrelated posts and missing server IDs', () => {
  const caption = 'CASTRO-MD menu';
  const hash = crypto.createHash('sha256').update(caption).digest('hex');
  const unrelated = {
    tag: 'iq', attrs: {},
    content: [{ tag: 'message_updates', attrs: {}, content: [nodeFor('123457', 'unrelated')] }],
  };
  const missingId = {
    tag: 'iq', attrs: {},
    content: [{ tag: 'message_updates', attrs: {}, content: [{
      tag: 'message', attrs: { t: '1793900000' },
      content: [{ tag: 'plaintext', attrs: {}, content: Buffer.from(JSON.stringify({ conversation: caption })) }],
    }] }],
  };
  assert.equal(findNewsletterMessage(unrelated, proto, '12345@newsletter', hash), null);
  assert.equal(findNewsletterMessage(missingId, proto, '12345@newsletter', hash), null);
});

test('uses Baileys forced-forward mode and verified Channel attribution', () => {
  const posted = { key: { id: '123456' }, message: { imageMessage: { caption: 'CASTRO-MD menu' } } };
  let forceForward;
  const forwarded = buildChannelForwardContent(
    posted,
    { jid: '12345@newsletter', name: 'CASTRO-MD Official Channel', serverMessageId: 123456 },
    (_message, force) => {
      forceForward = force;
      return { imageMessage: { caption: 'CASTRO-MD menu', contextInfo: { forwardingScore: 1, isForwarded: true } } };
    }
  );
  assert.equal(forceForward, true);
  assert.deepEqual(forwarded.imageMessage.contextInfo.forwardedNewsletterMessageInfo, {
    newsletterJid: '12345@newsletter',
    newsletterName: 'CASTRO-MD Official Channel',
    serverMessageId: 123456,
  });
});

test('refuses invalid Channel server IDs', () => {
  const posted = { key: { id: '123456' }, message: { conversation: 'menu' } };
  assert.throws(() => buildChannelForwardContent(
    posted,
    { jid: '12345@newsletter', name: 'CASTRO-MD', serverMessageId: -1 },
    () => ({ extendedTextMessage: { text: 'menu' } })
  ), /valid WhatsApp Channel server message ID/);
});
