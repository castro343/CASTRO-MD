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
    settings: {
      botName: doc.botName || 'CASTRO-MD',
      prefix: doc.prefix || '.',
      autoRead: doc.autoRead === true,
      autoViewStatus: doc.autoViewStatus !== false,
      statusReact: doc.statusReact === true,
    },
  };
}

function createTenantRegistry({ uri, dbName = 'castro_md', MongoClient: MongoClientOverride } = {}) {
  if (!uri) throw new Error('MONGODB_URI is required for multi-user accounts');
  let client;
  let collection;
  let connecting;

  async function getCollection() {
    if (collection) return collection;
    if (!connecting) {
      connecting = (async () => {
        const MongoClient = MongoClientOverride || require('mongodb').MongoClient;
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

    async updateSettings(id, settings) {
      if (!ID_RE.test(String(id || ''))) throw new Error('Invalid tenant id');
      const allowed = {
        botName: String(settings.botName || 'CASTRO-MD').trim().slice(0, 32),
        prefix: String(settings.prefix || '.').trim(),
        autoRead: settings.autoRead === true,
        autoViewStatus: settings.autoViewStatus === true,
        statusReact: settings.statusReact === true,
      };
      if (!/^[A-Za-z0-9 _-]{2,32}$/.test(allowed.botName)) throw new Error('Bot name must be 2–32 letters, numbers, spaces, underscores or hyphens.');
      if (!/^[^\s]{1,3}$/.test(allowed.prefix)) throw new Error('Prefix must be 1–3 non-space characters.');
      const result = await (await getCollection()).updateOne(
        { _id: id, status: { $in: ['connected', 'disconnected'] } },
        { $set: allowed }
      );
      if (result.matchedCount !== 1) throw new Error('Connected customer account not found.');
      return allowed;
    },

    async markConnected(id) {
      if (!ID_RE.test(String(id || ''))) throw new Error('Invalid tenant id');
      const now = new Date();
      const c = await getCollection();
      // Count only a genuine successful pairing transition. Preserve one historical
      // pairing for legacy accounts created before this counter existed.
      const previous = await c.findOne({ _id: id });
      const priorPairings = Number(previous?.pairings) || (previous?.connectedAt ? 1 : 0);
      // Worker restarts and reconnects from "disconnected" must not inflate the total.
      const firstOrFreshPair = await c.updateOne(
        { _id: id, status: { $in: ['provisioning', 'needs_pairing'] } },
        { $set: { status: 'connected', connectedAt: now, lastSeenAt: now, pairings: priorPairings + 1 } }
      );
      if (firstOrFreshPair.modifiedCount === 0) {
        await c.updateOne(
          { _id: id, status: { $in: ['connected', 'disconnected'] } },
          { $set: { status: 'connected', lastSeenAt: now } }
        );
      }
    },

    async getPairingCount() {
      const rows = await (await getCollection())
        .find({}, { projection: { pairings: 1, connectedAt: 1 } })
        .toArray();
      return rows.reduce((total, row) => {
        const count = row.pairings == null && row.connectedAt ? 1 : Number(row.pairings) || 0;
        return total + Math.max(0, count);
      }, 0);
    },

    async markDisconnected(id) {
      if (!ID_RE.test(String(id || ''))) throw new Error('Invalid tenant id');
      await (await getCollection()).updateOne(
        { _id: id, status: { $in: ['connected', 'disconnected'] } },
        { $set: { status: 'disconnected', lastSeenAt: new Date() } }
      );
    },

    async markNeedsPairing(id) {
      if (!ID_RE.test(String(id || ''))) throw new Error('Invalid tenant id');
      await (await getCollection()).updateOne(
        { _id: id, status: { $ne: 'disabled' } },
        { $set: { status: 'needs_pairing', lastSeenAt: new Date() } }
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

    async createDashboardClaim(id, tokenHash, expiresAt) {
      if (!ID_RE.test(String(id || ''))) throw new Error('Invalid tenant id');
      if (!/^[a-f0-9]{64}$/.test(String(tokenHash || ''))) throw new Error('Invalid claim token hash');
      const result = await (await getCollection()).updateOne(
        { _id: id, status: 'connected' },
        { $set: { dashboardClaimHash: tokenHash, dashboardClaimExpiresAt: expiresAt } }
      );
      return result.modifiedCount === 1;
    },

    async consumeDashboardClaim(tokenHash) {
      if (!/^[a-f0-9]{64}$/.test(String(tokenHash || ''))) return null;
      const now = new Date();
      const c = await getCollection();
      const doc = await c.findOneAndUpdate(
        { dashboardClaimHash: tokenHash, dashboardClaimExpiresAt: { $gt: now }, status: 'connected' },
        { $unset: { dashboardClaimHash: '', dashboardClaimExpiresAt: '' }, $set: { dashboardClaimedAt: now } },
        { returnDocument: 'after' }
      );
      const claimed = doc?.value || doc;
      return claimed ? { id: claimed._id, status: claimed.status } : null;
    },

    async createDashboardSession(id, sessionHash, expiresAt) {
      if (!ID_RE.test(String(id || ''))) throw new Error('Invalid tenant id');
      if (!/^[a-f0-9]{64}$/.test(String(sessionHash || ''))) throw new Error('Invalid session hash');
      await (await getCollection()).updateOne(
        { _id: id, status: 'connected' },
        { $set: { dashboardSessionHash: sessionHash, dashboardSessionExpiresAt: expiresAt } }
      );
    },

    async getDashboardSession(sessionHash) {
      if (!/^[a-f0-9]{64}$/.test(String(sessionHash || ''))) return null;
      const doc = await (await getCollection()).findOne({
        dashboardSessionHash: sessionHash,
        dashboardSessionExpiresAt: { $gt: new Date() },
        status: 'connected',
      });
      return doc ? { id: doc._id, status: doc.status } : null;
    },

    async clearDashboardSession(id, sessionHash) {
      if (!ID_RE.test(String(id || '')) || !/^[a-f0-9]{64}$/.test(String(sessionHash || ''))) return;
      await (await getCollection()).updateOne(
        { _id: id, dashboardSessionHash: sessionHash },
        { $unset: { dashboardSessionHash: '', dashboardSessionExpiresAt: '' } }
      );
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
