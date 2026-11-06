'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  channelCode,
  messageText,
  captionHash,
  validServerMessageId,
  buildChannelForwardContent,
} = require('../lib/channelMenuForward');

test('extracts the official WhatsApp Channel invite code', () => {
  assert.equal(
    channelCode('https://whatsapp.com/channel/0029VbE0iWxEawdsY3dBaB18'),
    '0029VbE0iWxEawdsY3dBaB18'
  );
  assert.equal(channelCode('https://example.com/not-a-channel'), '');
});

test('reads captions from common WhatsApp message types', () => {
  assert.equal(messageText({ message: { imageMessage: { caption: 'CASTRO-MD menu' } } }), 'CASTRO-MD menu');
  assert.equal(messageText({ message: { extendedTextMessage: { text: 'Menu text' } } }), 'Menu text');
  assert.equal(messageText({ message: { conversation: 'Hello' } }), 'Hello');
});

test('hashes the exact caption and validates WhatsApp server IDs', () => {
  assert.equal(captionHash('CASTRO-MD menu'), captionHash('CASTRO-MD menu'));
  assert.notEqual(captionHash('CASTRO-MD menu'), captionHash('Other menu'));
  assert.equal(validServerMessageId('123456'), 123456);
  assert.equal(validServerMessageId('0'), null);
  assert.equal(validServerMessageId('-1'), null);
  assert.equal(validServerMessageId('not-an-id'), null);
  assert.equal(validServerMessageId('2147483648'), null);
});

test('builds Channel-attributed forward content using a verified server ID', () => {
  const posted = {
    key: { remoteJid: '12345@newsletter', id: '123456', fromMe: true },
    message: { imageMessage: { caption: 'CASTRO-MD menu' } },
  };
  const content = buildChannelForwardContent(
    posted,
    { jid: '12345@newsletter', name: 'CASTRO-MD Official Channel', serverMessageId: 123456 },
    () => ({
      imageMessage: {
        caption: 'CASTRO-MD menu',
        contextInfo: { forwardingScore: 1, isForwarded: true },
      },
    })
  );
  assert.deepEqual(content.imageMessage.contextInfo.forwardedNewsletterMessageInfo, {
    newsletterJid: '12345@newsletter',
    newsletterName: 'CASTRO-MD Official Channel',
    serverMessageId: 123456,
  });
  assert.equal(content.imageMessage.contextInfo.isForwarded, true);
});

test('refuses invalid Channel IDs rather than fabricating attribution', () => {
  const posted = { key: { id: '123456' }, message: { conversation: 'menu' } };
  assert.throws(() => buildChannelForwardContent(
    posted,
    { jid: '12345@newsletter', name: 'CASTRO-MD', serverMessageId: -1 },
    () => ({ conversation: 'menu' })
  ), /verified WhatsApp Channel message ID/);
});
