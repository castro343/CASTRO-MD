'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  channelCode,
  messageText,
  findNewsletterMessage,
} = require('../lib/channelMenuForward');

const proto = {
  Message: {
    decode(buffer) {
      return JSON.parse(Buffer.from(buffer).toString('utf8'));
    },
  },
  WebMessageInfo: {
    fromObject(value) {
      return value;
    },
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

test('extracts the invite code from the official Channel link', () => {
  assert.equal(channelCode('https://whatsapp.com/channel/0029VbE0iWxEawdsY3dBaB18'), '0029VbE0iWxEawdsY3dBaB18');
  assert.equal(channelCode('https://example.com/not-a-channel'), '');
});

test('reads captions from decoded newsletter messages', () => {
  assert.equal(messageText({ message: { imageMessage: { caption: 'CASTRO-MD menu' } } }), 'CASTRO-MD menu');
});

test('reconstructs only a real server-addressed newsletter message matching the menu', () => {
  const caption = 'CASTRO-MD menu';
  const hash = crypto.createHash('sha256').update(caption).digest('hex');
  const response = {
    tag: 'iq',
    attrs: {},
    content: [{ tag: 'message_updates', attrs: {}, content: [nodeFor('REAL_SERVER_123', caption)] }],
  };
  const result = findNewsletterMessage(response, proto, '12345@newsletter', hash);
  assert.equal(result.key.remoteJid, '12345@newsletter');
  assert.equal(result.key.id, 'REAL_SERVER_123');
  assert.equal(result.key.fromMe, false);
  assert.equal(result.message.imageMessage.caption, caption);
});

test('does not accept a different post or a missing server message ID', () => {
  const caption = 'CASTRO-MD menu';
  const hash = crypto.createHash('sha256').update(caption).digest('hex');
  const different = {
    tag: 'iq', attrs: {},
    content: [{ tag: 'message_updates', attrs: {}, content: [nodeFor('REAL_SERVER_456', 'unrelated post')] }],
  };
  const noId = {
    tag: 'iq', attrs: {},
    content: [{ tag: 'message_updates', attrs: {}, content: [{
      tag: 'message', attrs: { t: '1793900000' },
      content: [{ tag: 'plaintext', attrs: {}, content: Buffer.from(JSON.stringify({ conversation: caption })) }],
    }] }],
  };
  assert.equal(findNewsletterMessage(different, proto, '12345@newsletter', hash), null);
  assert.equal(findNewsletterMessage(noId, proto, '12345@newsletter', hash), null);
});

test('adds native Channel attribution using the verified server message ID', () => {
  const posted = { key: { id: 'SERVER_123' }, message: { imageMessage: { caption: 'CASTRO-MD menu' } } };
  const forwarded = buildChannelForwardContent(
    posted,
    { jid: '12345@newsletter', name: 'CASTRO-MD Official Channel', serverMessageId: 'SERVER_123' },
    () => ({ imageMessage: { caption: 'CASTRO-MD menu', contextInfo: { forwardingScore: 1, isForwarded: true } } })
  );
  assert.deepEqual(forwarded.imageMessage.contextInfo.forwardedNewsletterMessageInfo, {
    newsletterJid: '12345@newsletter',
    newsletterName: 'CASTRO-MD Official Channel',
    serverMessageId: 'SERVER_123',
  });
  assert.equal(forwarded.imageMessage.contextInfo.isForwarded, true);
});
