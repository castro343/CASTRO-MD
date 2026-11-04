const fs = require('fs');
const { BufferJSON, initAuthCreds, proto } = require('@whiskeysockets/baileys');

// All bot accounts share one MongoDB collection, but every account has an isolated
// namespace. The default namespace intentionally keeps the original document IDs so
// the existing CASTRO-MD owner session remains compatible during the migration.
let client = null;
let col = null;
let connecting = null;

async function getCollection(uri, dbName) {
  if (col) return col;
  if (!connecting) {
    connecting = (async () => {
      const { MongoClient } = require('mongodb');
      client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
      await client.connect();
      col = client.db(dbName).collection('auth');
      return col;
    })().catch((error) => {
      connecting = null;
      client = null;
      throw error;
    });
  }
  return connecting;
}

const enc = (v) => JSON.stringify(v, BufferJSON.replacer);
const dec = (s) => JSON.parse(s, BufferJSON.reviver);

function namespaceId(tenantId, id) {
  const tenant = String(tenantId || 'default');
  if (tenant === 'default') return id; // backward compatibility with the original owner session
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(tenant)) {
    throw new Error('Invalid session namespace');
  }
  return `${tenant}:${id}`;
}

// Baileys-compatible auth state. tenantId gives each linked WhatsApp account
// independent credentials and Signal keys inside the shared MongoDB collection.
async function useMongoAuthState(uri, { dbName = 'castro_md', seedFile, tenantId = 'default' } = {}) {
  const c = await getCollection(uri, dbName);
  const docId = (id) => namespaceId(tenantId, id);

  const read = async (id) => {
    const doc = await c.findOne({ _id: docId(id) });
    return doc ? dec(doc.v) : null;
  };

  let creds = await read('creds');
  if (!creds) {
    creds = tenantId === 'default' && seedFile && fs.existsSync(seedFile)
      ? dec(fs.readFileSync(seedFile, 'utf8'))
      : initAuthCreds();
    await c.updateOne(
      { _id: docId('creds') },
      { $setOnInsert: { _id: docId('creds'), v: enc(creds) } },
      { upsert: true }
    );
    // If another worker initialized this namespace at the same time, use its stored creds.
    creds = await read('creds') || creds;
  }

  const keys = {
    get: async (type, ids) => {
      const out = {};
      await Promise.all(ids.map(async (id) => {
        let value = await read(`${type}-${id}`);
        if (type === 'app-state-sync-key' && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value);
        }
        out[id] = value;
      }));
      return out;
    },
    set: async (data) => {
      const ops = [];
      for (const type of Object.keys(data)) {
        for (const id of Object.keys(data[type])) {
          const value = data[type][id];
          const _id = docId(`${type}-${id}`);
          ops.push(value
            ? { replaceOne: { filter: { _id }, replacement: { _id, v: enc(value) }, upsert: true } }
            : { deleteOne: { filter: { _id } } });
        }
      }
      if (ops.length) await c.bulkWrite(ops, { ordered: false });
    },
  };

  return {
    state: { creds, keys },
    saveCreds: () => c.replaceOne(
      { _id: docId('creds') },
      { _id: docId('creds'), v: enc(creds) },
      { upsert: true }
    ),
    clear: () => tenantId === 'default'
      ? c.deleteMany({ _id: { $in: [docId('creds')] } }).then(async () => {
          // Remove only legacy default-session Signal keys, never other tenants' records.
          await c.deleteMany({ _id: { $not: /:/ } });
        })
      : c.deleteMany({ _id: { $regex: `^${String(tenantId).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}:` } }),
  };
}

module.exports = { useMongoAuthState };
