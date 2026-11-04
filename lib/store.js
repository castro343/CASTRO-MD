'use strict';

const fs = require('fs');
const path = require('path');
const settings = require('../settings');
const persistence = require('./mongoPersistence');

const FILE = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'settings.json');
const RULES = {
  prefix: v => typeof v === 'string' && v.length >= 1 && v.length <= 3,
  botName: v => typeof v === 'string' && v.length >= 1 && v.length <= 30,
  mode: v => v === 'public' || v === 'private',
  menuImage: v => typeof v === 'string' && (v === '' || /^https?:\/\//i.test(v)),
  repo: v => typeof v === 'string' && v.length <= 200,
  channelLink: v => typeof v === 'string' && /whatsapp\.com\/channel\/[A-Za-z0-9_-]+/.test(v),
  forwarded: v => typeof v === 'boolean',
  autoViewStatus: v => typeof v === 'boolean',
  autoRead: v => typeof v === 'boolean',
  antiCall: v => typeof v === 'boolean',
  antiDelete: v => typeof v === 'boolean',
  alwaysOnline: v => typeof v === 'boolean',
  owners: v => Array.isArray(v) && v.every(n => /^\d{7,}$/.test(String(n))),
};

function snapshot(source) {
  const out = {};
  for (const key of Object.keys(RULES)) {
    const value = source?.[key];
    if (value !== undefined && RULES[key](value)) out[key] = value;
  }
  return out;
}

function apply(target, saved) {
  Object.assign(target, snapshot(saved));
  if (target.developer) target.owners = [...new Set([target.developer.number, ...(target.owners || [])])];
}

function readLegacy() {
  try { return snapshot(JSON.parse(fs.readFileSync(FILE, 'utf8'))); }
  catch { return {}; }
}

function writeLegacy(data) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const temp = FILE + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(data, null, 2));
    fs.renameSync(temp, FILE);
  } catch {}
}

async function load(target) {
  let saved = null;
  if (settings.mongoUri) {
    try { saved = await persistence.readDocument('tenant_settings', settings.mongoUri, settings.mongoDb); }
    catch (error) { console.error('[STORE] MongoDB load failed:', error.message); }
  }
  if (saved) {
    apply(target, saved);
    return true;
  }

  apply(target, readLegacy());
  const migrated = snapshot(target);
  if (settings.mongoUri) {
    try { await persistence.writeDocument('tenant_settings', migrated, settings.mongoUri, settings.mongoDb); }
    catch (error) { console.error('[STORE] MongoDB migration failed; local fallback retained:', error.message); }
  }
  writeLegacy(migrated);
  return true;
}

async function save(target) {
  const data = snapshot(target);
  let persisted = false;
  if (settings.mongoUri) {
    try {
      await persistence.writeDocument('tenant_settings', data, settings.mongoUri, settings.mongoDb);
      persisted = true;
    } catch (error) {
      console.error('[STORE] MongoDB save failed:', error.message);
    }
  }
  writeLegacy(data);
  return persisted || !settings.mongoUri;
}

module.exports = { load, save, FILE };
