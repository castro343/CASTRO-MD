'use strict';

// Persistent registry for independent CASTRO-MD bot tenants.
// This module deliberately does not create WhatsApp sockets: pairing is enabled only
// after the multi-socket runtime and per-tenant command/guard stores are integrated.
const crypto = require('crypto');

const ID_RE = /^[a-f0-9]{32}$/;
const PHONE_RE = /^\d{8,15}$/;

function publicTenant(doc) {
  if (!doc) return null;
  return {
    id: doc._id,
    phone: doc.phone,
    status: doc.status,
    botName: doc.botName || 'CASTRO-MD',
    prefix: doc.prefix || '.',
    createdAt: doc.createdAt,
    connectedAt: doc.connectedAt || null,
    lastSeenAt: doc.lastSeenAt || null,
  };
}

function createTenantRegistry({ uri, dbName = 'castro_md' }) {
  if (!uri) throw new Error('MONGODB_URI is required for multi-user accounts');
  let client;
  let collection;
  let connecting;

  async function getCollection() {
    if (collection) return collection;
    if (!connecting) {
      connecting = (async () => {
        const { MongoClient } = require('mongodb');
        client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
        await client.connect();
        collection = client.db(dbName).collection('tenants');
        await collection.createIndex({ phone: 1 }, { unique: true });
        await collection.createIndex({ status: 1, createdAt: 1 });
        return collection;
      })().catch((error) => {
        connecting = null;
        client = null;
        throw error;
      });
    }
    return connecting;
  }

  return {
    async create(phone) {
      const normalized = String(phone || '').replace(/\D/g, '');
      if (!PHONE_RE.test(normalized)) throw new Error('Enter a valid WhatsApp number with country code.');
      const c = await getCollection();
      const existing = await c.findOne({ phone: normalized });
      if (existing) {
        if (existing.status === 'disabled') throw new Error('This bot account is disabled. Contact the platform owner.');
        return publicTenant(existing);
      }
      const doc = {
        _id: crypto.randomBytes(16).toString('hex'),
        phone: normalized,
        status: 'provisioning',
        botName: 'CASTRO-MD',
        prefix: '.',
        createdAt: new Date(),
        connectedAt: null,
        lastSeenAt: null,
      };
      try {
        await c.insertOne(doc);
      } catch (error) {
        if (error.code !== 11000) throw error;
        const raced = await c.findOne({ phone: normalized });
        if (raced) return publicTenant(raced);
        throw error;
      }
      return publicTenant(doc);
    },

    async get(id) {
      if (!ID_RE.test(String(id || ''))) return null;
      return publicTenant(await (await getCollection()).findOne({ _id: id }));
    },

    async markConnected(id) {
      if (!ID_RE.test(String(id || ''))) throw new Error('Invalid tenant id');
      const now = new Date();
      await (await getCollection()).updateOne(
        { _id: id },
        { $set: { status: 'connected', connectedAt: now, lastSeenAt: now } }
      );
    },

    async markDisconnected(id) {
      if (!ID_RE.test(String(id || ''))) throw new Error('Invalid tenant id');
      await (await getCollection()).updateOne(
        { _id: id, status: { $ne: 'disabled' } },
        { $set: { status: 'disconnected', lastSeenAt: new Date() } }
      );
    },

    async disable(id) {
      if (!ID_RE.test(String(id || ''))) throw new Error('Invalid tenant id');
      await (await getCollection()).updateOne({ _id: id }, { $set: { status: 'disabled' } });
    },

    async list({ limit = 100 } = {}) {
      const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
      const docs = await (await getCollection())
        .find({}, { projection: { phone: 1, status: 1, botName: 1, prefix: 1, createdAt: 1, connectedAt: 1, lastSeenAt: 1 } })
        .sort({ createdAt: -1 })
        .limit(safeLimit)
        .toArray();
      return docs.map(publicTenant);
    },

    async close() {
      if (client) await client.close();
      client = null;
      collection = null;
      connecting = null;
    },
  };
}

module.exports = { createTenantRegistry };
