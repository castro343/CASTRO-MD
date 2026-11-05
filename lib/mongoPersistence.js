'use strict';

// Tenant-scoped MongoDB document storage shared by settings and group protection.
// Each worker receives its own TENANT_ID and therefore cannot read another tenant's records.
const TENANT_RE = /^[a-f0-9]{32}$/;

let client;
let connecting;

function tenantKey() {
  const id = process.env.TENANT_ID || 'default';
  if (id !== 'default' && !TENANT_RE.test(id)) {
    throw new Error('Invalid TENANT_ID; refusing to access tenant persistence.');
  }
  return id;
}

async function getDatabase(uri, dbName) {
  if (!uri) throw new Error('MONGODB_URI is required for persistent tenant data.');
  if (!connecting) {
    connecting = (async () => {
      const { MongoClient } = require('mongodb');
      client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
      await client.connect();
      return client.db(dbName || 'castro_md');
    })().catch((error) => {
      connecting = null;
      client = null;
      throw error;
    });
  }
  return connecting;
}

async function readDocument(collectionName, uri, dbName) {
  const db = await getDatabase(uri, dbName);
  return db.collection(collectionName).findOne({ _id: tenantKey() });
}

async function createDocument(collectionName, data, uri, dbName) {
  const db = await getDatabase(uri, dbName);
  const now = new Date();
  try {
    await db.collection(collectionName).insertOne({
      _id: tenantKey(),
      ...data,
      createdAt: now,
      updatedAt: now,
    });
    return true;
  } catch (error) {
    if (error?.code === 11000) return false;
    throw error;
  }
}

async function writeDocument(collectionName, data, uri, dbName) {
  const db = await getDatabase(uri, dbName);
  const now = new Date();

  // _id is supplied by the tenant filter, and createdAt is insert-only.
  // Strip both before $set so documents read from MongoDB can be written
  // back without attempting to update immutable _id or conflicting with
  // $setOnInsert.createdAt.
  const { _id, createdAt, ...fields } = data || {};

  await db.collection(collectionName).updateOne(
    { _id: tenantKey() },
    { $set: { ...fields, updatedAt: now }, $setOnInsert: { createdAt: now } },
    { upsert: true }
  );
}

// Atomically claim a one-time state transition before performing an external side effect.
async function claimDocument(collectionName, filter, update, uri, dbName) {
  const db = await getDatabase(uri, dbName);
  const result = await db.collection(collectionName).updateOne(filter, update);
  return result.modifiedCount === 1;
}

async function close() {
  if (client) await client.close();
  client = null;
  connecting = null;
}

module.exports = { tenantKey, readDocument, createDocument, writeDocument, claimDocument, close };
