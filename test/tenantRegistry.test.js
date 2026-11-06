'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTenantRegistry } = require('../lib/tenantRegistry');

function fakeMongo() {
  const docs = new Map();
  class MongoClient {
    constructor() {}
    async connect() {}
    db() {
      return { collection() {
        return {
          async createIndex() {},
          async findOne(query) { return docs.get(query._id) || [...docs.values()].find(d => d.phone === query.phone) || null; },
          async insertOne(doc) {
            if ([...docs.values()].some(d => d.phone === doc.phone)) {
              const error = new Error('duplicate key'); error.code = 11000; throw error;
            }
            docs.set(doc._id, structuredClone(doc));
          },
          async updateOne(filter, update) {
            const doc = docs.get(filter._id);
            if (!doc) return { matchedCount: 0 };
            if (filter.status?.$in && !filter.status.$in.includes(doc.status)) return { matchedCount: 0 };
            if (filter.status?.$ne && doc.status === filter.status.$ne) return { matchedCount: 0 };
            Object.assign(doc, update.$set || {});
            for (const [key, value] of Object.entries(update.$inc || {})) doc[key] = (doc[key] || 0) + value;
            return { matchedCount: 1, modifiedCount: 1 };
          },
          find() {
            let rows = [...docs.values()];
            return {
              sort() { return this; },
              limit(n) { rows = rows.slice(0, n); return this; },
              async toArray() { return structuredClone(rows); }
            };
          }
        };
      }};
    }
    async close() {}
  }
  return { MongoClient, docs };
}

test('rejects invalid phone numbers before provisioning', async () => {
  const { MongoClient } = fakeMongo();
  const registry = createTenantRegistry({ uri: 'mongodb://test', MongoClient });
  await assert.rejects(registry.create('abc'), /valid WhatsApp number/);
});

test('creates isolated tenants and returns existing account for duplicate phone', async () => {
  const { MongoClient, docs } = fakeMongo();
  const registry = createTenantRegistry({ uri: 'mongodb://test', MongoClient });
  const first = await registry.create('254700000001');
  const same = await registry.create('+254 700 000 001');
  const second = await registry.create('254700000002');

  assert.equal(first.id, same.id);
  assert.notEqual(first.id, second.id);
  assert.equal(docs.size, 2);
  assert.equal(first.status, 'provisioning');
  assert.equal(second.status, 'provisioning');
});

test('logged-out state is not overwritten by a later disconnected event', async () => {
  const { MongoClient, docs } = fakeMongo();
  const registry = createTenantRegistry({ uri: 'mongodb://test', MongoClient });
  const tenant = await registry.create('254700000003');

  await registry.markConnected(tenant.id);
  await registry.markNeedsPairing(tenant.id);
  await registry.markDisconnected(tenant.id);

  assert.equal(docs.get(tenant.id).status, 'needs_pairing');
});

test('disabled tenants remain disabled when logout recovery runs', async () => {
  const { MongoClient, docs } = fakeMongo();
  const registry = createTenantRegistry({ uri: 'mongodb://test', MongoClient });
  const tenant = await registry.create('254700000004');

  await registry.disable(tenant.id);
  await registry.markNeedsPairing(tenant.id);

  assert.equal(docs.get(tenant.id).status, 'disabled');
});

test('connection updates affect only the addressed tenant', async () => {
  const { MongoClient, docs } = fakeMongo();
  const registry = createTenantRegistry({ uri: 'mongodb://test', MongoClient });
  const a = await registry.create('254700000005');
  const b = await registry.create('254700000006');

  await registry.markConnected(a.id);

  assert.equal(docs.get(a.id).status, 'connected');
  assert.equal(docs.get(b.id).status, 'provisioning');
});

const { namespaceId } = require('../lib/mongoAuth');

test('Mongo auth namespaces preserve owner compatibility and isolate tenant keys', () => {
  const tenantA = 'a'.repeat(32);
  const tenantB = 'b'.repeat(32);

  assert.equal(namespaceId('default', 'creds'), 'creds');
  assert.equal(namespaceId(tenantA, 'creds'), `${tenantA}:creds`);
  assert.notEqual(namespaceId(tenantA, 'pre-key-1'), namespaceId(tenantB, 'pre-key-1'));
  assert.throws(() => namespaceId('../other', 'creds'), /Invalid session namespace/);
});

test('counts successful pairings once and counts a fresh re-pair after logout', async () => {
  const { MongoClient, docs } = fakeMongo();
  const registry = createTenantRegistry({ uri: 'mongodb://test', MongoClient });
  const tenant = await registry.create('254700000007');

  assert.equal(await registry.getPairingCount(), 0);
  await registry.markConnected(tenant.id);
  assert.equal(await registry.getPairingCount(), 1);

  // Repeated connection events and worker restarts do not add another pairing.
  await registry.markConnected(tenant.id);
  await registry.markDisconnected(tenant.id);
  await registry.markConnected(tenant.id);
  assert.equal(await registry.getPairingCount(), 1);

  // A logged-out account that successfully pairs again is a new pairing.
  await registry.markNeedsPairing(tenant.id);
  await registry.markConnected(tenant.id);
  assert.equal(await registry.getPairingCount(), 2);
  assert.equal(docs.get(tenant.id).pairings, 2);
});
