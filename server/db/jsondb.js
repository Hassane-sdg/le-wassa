const fs = require('fs');
const path = require('path');
const { DATA_DIRECTORY, resolvePrivateDataPath } = require('./paths');

const DB_PATH = resolvePrivateDataPath(
  process.env.WASSA_JSON_DB_PATH || path.join(DATA_DIRECTORY, 'db.json')
);

function readDb() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(raw || '{}');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

function writeDb(obj) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(obj, null, 2), 'utf8');
}

function ensureArray(key) {
  const db = readDb();
  if (!Array.isArray(db[key])) db[key] = [];
  writeDb(db);
}

function list(key) {
  const db = readDb();
  return db[key] || [];
}

function insert(key, item) {
  const db = readDb();
  if (!Array.isArray(db[key])) db[key] = [];
  db[key].push(item);
  writeDb(db);
  return item;
}

function findById(key, id) {
  const arr = list(key);
  return arr.find(x => String(x.id) === String(id));
}

function removeById(key, id) {
  const db = readDb();
  if (!Array.isArray(db[key])) return false;
  const before = db[key].length;
  db[key] = db[key].filter(x => String(x.id) !== String(id));
  writeDb(db);
  return db[key].length !== before;
}

module.exports = { list, insert, findById, removeById, ensureArray };
