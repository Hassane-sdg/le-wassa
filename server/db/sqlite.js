const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { DATA_DIRECTORY, resolvePrivateDataPath } = require('./paths');

const DB_FILE = resolvePrivateDataPath(process.env.WASSA_DB_PATH || path.join(DATA_DIRECTORY, 'db.sqlite'));
let dbPromise = null;
let transactionTail = Promise.resolve();

function defaultMenu() {
  return [
    { id: 'poulet-braise', name: 'Poulet braisé', category: 'Grillades', price: 12000, badge: 'Signature', description: 'Poulet mariné aux épices africaines, servi avec alloco et sauce maison.', image: 'images/grillade.png' },
    { id: 'poisson-braise', name: 'Poisson braisé', category: 'Grillades', price: 15000, badge: 'Spécialité', description: 'Poisson gras grillé au feu de bois, accompagnements maison.', image: 'images/grillade.png' },
    { id: 'attieke-poisson', name: 'Attiéké poisson', category: 'Grillades', price: 11000, badge: 'Populaire', description: 'Attiéké léger, poisson de mer, tomate, oignon et piment.', image: 'images/grillade.png' },
    { id: 'kedjenou', name: 'Kedjenou de poulet', category: 'Grillades', price: 14000, badge: 'Chef', description: 'Poulet mijoté aux légumes et épices locales.', image: 'images/grillade.png' },
    { id: 'alloco', name: 'Alloco', category: 'Accompagnements', price: 5000, badge: 'Accompagnement', description: 'Plantain frit, sauce piquante et oignons frais.', image: 'images/grillade.png' },
    { id: 'riz-sauce', name: 'Riz sauce', category: 'Accompagnements', price: 6000, badge: 'Classique', description: 'Riz parfumé et sauce généreuse aux saveurs locales.', image: 'images/grillade.png' },
    { id: 'coca-cola', name: 'Coca-Cola', category: 'Boissons', price: 1500, badge: 'Boisson', description: 'Boisson rafraîchissante glacée.', image: 'images/bar.png' },
    { id: 'jus-mangue', name: 'Jus de mangue', category: 'Boissons', price: 3000, badge: 'Frais', description: 'Jus frais à base de mangue locale.', image: 'images/bar.png' },
    { id: 'tropical-sun', name: 'Tropical Sun', category: 'Boissons', price: 3500, badge: 'Nouveau', description: 'Mocktail exotique avec fruits tropicaux.', image: 'images/bar.png' },
    { id: 'dessert-exotique', name: 'Dessert exotique', category: 'Desserts', price: 8000, badge: 'Signature', description: 'Fruits frais, glace coco et coulis de mangue.', image: 'images/grillade.png' }
  ];
}

async function getDb() {
  if (!dbPromise) {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    dbPromise = open({ filename: DB_FILE, driver: sqlite3.Database })
      .then(async db => {
        await db.exec('PRAGMA busy_timeout = 5000');
        return db;
      })
      .catch(error => {
        dbPromise = null;
        throw error;
      });
  }
  return dbPromise;
}

async function closeDatabase() {
  await transactionTail;
  if (!dbPromise) return;
  const db = await dbPromise;
  dbPromise = null;
  await db.close();
}

async function withTransaction(callback) {
  const previousTransaction = transactionTail;
  let releaseTransaction;
  transactionTail = new Promise(resolve => {
    releaseTransaction = resolve;
  });
  await previousTransaction;

  try {
    await getDb();
    const transactionDb = await open({ filename: DB_FILE, driver: sqlite3.Database });
    try {
      await transactionDb.exec('PRAGMA busy_timeout = 5000');
      await transactionDb.exec('BEGIN IMMEDIATE');
      try {
        const result = await callback(transactionDb);
        await transactionDb.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          await transactionDb.exec('ROLLBACK');
        } catch (rollbackError) {
          console.error('SQLite transaction rollback failed', { code: rollbackError.code || rollbackError.name || 'UNKNOWN' });
        }
        throw error;
      }
    } finally {
      await transactionDb.close();
    }
  } finally {
    releaseTransaction();
  }
}

async function ensureDatabase() {
  const db = await getDb();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      price INTEGER NOT NULL,
      badge TEXT,
      description TEXT,
      image TEXT DEFAULT 'images/profil.png',
      available INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS reservations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      date TEXT NOT NULL,
      party INTEGER NOT NULL,
      note TEXT,
      phone TEXT,
      email TEXT,
      event TEXT
    );

    CREATE TABLE IF NOT EXISTS tables (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'available'
    );

    CREATE TABLE IF NOT EXISTS table_sessions (
      id TEXT PRIMARY KEY,
      tableId TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expiresAt TEXT
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      tableId TEXT NOT NULL,
      sessionId TEXT,
      customerName TEXT NOT NULL,
      customerPhone TEXT,
      note TEXT,
      total INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      paymentMethod TEXT NOT NULL DEFAULT 'pay_on_site',
      paymentStatus TEXT NOT NULL DEFAULT 'PAY_ON_SITE',
      pointsAwarded INTEGER NOT NULL DEFAULT 0,
      idempotencyKey TEXT,
      requestFingerprint TEXT,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      items TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS loyalty (
      customerName TEXT PRIMARY KEY,
      points INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS loyalty_accounts (
      customerKey TEXT PRIMARY KEY,
      points INTEGER NOT NULL DEFAULT 0
    );
  `);

  await ensureColumns(db, 'products', {
    available: 'INTEGER NOT NULL DEFAULT 1'
  });
  await ensureColumns(db, 'reservations', {
    phone: 'TEXT',
    email: 'TEXT',
    event: 'TEXT'
  });
  await ensureColumns(db, 'orders', {
    sessionId: 'TEXT',
    customerPhone: 'TEXT',
    paymentMethod: "TEXT NOT NULL DEFAULT 'pay_on_site'",
    paymentStatus: "TEXT NOT NULL DEFAULT 'PAY_ON_SITE'",
    pointsAwarded: 'INTEGER NOT NULL DEFAULT 0',
    idempotencyKey: 'TEXT',
    requestFingerprint: 'TEXT'
  });
  await ensureColumns(db, 'table_sessions', {
    expiresAt: 'TEXT'
  });
  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS orders_idempotency_key ON orders(idempotencyKey) WHERE idempotencyKey IS NOT NULL');
  await db.run(
    `UPDATE products
     SET image = CASE WHEN category = 'Boissons' THEN 'images/bar.png' ELSE 'images/grillade.png' END
     WHERE image = 'images/profil.png'`
  );

  const countRow = await db.get('SELECT COUNT(*) as count FROM products');
  if ((countRow?.count || 0) === 0) {
    for (const item of defaultMenu()) {
      await db.run(
        'INSERT INTO products (id, name, category, price, badge, description, image) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [item.id, item.name, item.category, item.price, item.badge, item.description, item.image || 'images/profil.png']
      );
    }
  }

  for (const tableId of ['01', '02', '03', '04', '05']) {
    const exists = await db.get('SELECT 1 FROM tables WHERE id = ?', tableId);
    if (!exists) {
      await db.run('INSERT INTO tables (id, label, status) VALUES (?, ?, ?)', [tableId, `Table ${tableId}`, 'available']);
    }
  }
}

async function ensureColumns(db, table, columns) {
  const existing = new Set((await db.all(`PRAGMA table_info(${table})`)).map(column => column.name));
  for (const [name, definition] of Object.entries(columns)) {
    if (!existing.has(name)) {
      await db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }
}

async function ensureTable() {
  await ensureDatabase();
}

async function getProductById(productId) {
  const db = await getDb();
  return db.get('SELECT id, name, category, price, badge, description, image, available FROM products WHERE id = ?', productId);
}

async function listProducts(includeUnavailable = false) {
  const db = await getDb();
  const filter = includeUnavailable ? '' : 'WHERE available = 1';
  return db.all(`SELECT id, name, category, price, badge, description, image, available FROM products ${filter} ORDER BY category, name`);
}

async function saveProduct(product) {
  const db = await getDb();
  await db.run(
    `INSERT INTO products (id, name, category, price, badge, description, image, available)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, category = excluded.category,
       price = excluded.price, badge = excluded.badge, description = excluded.description,
       image = excluded.image, available = excluded.available`,
    [product.id, product.name, product.category, product.price, product.badge, product.description, product.image, product.available ? 1 : 0]
  );
  return getProductById(product.id);
}

async function deleteProduct(productId) {
  const db = await getDb();
  const result = await db.run('DELETE FROM products WHERE id = ?', productId);
  return result.changes > 0;
}

async function upsertTable({ id, label, status }) {
  const db = await getDb();
  await db.run(
    `INSERT INTO tables (id, label, status) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET label = excluded.label, status = excluded.status`,
    [id, label, status]
  );
  return db.get('SELECT * FROM tables WHERE id = ?', id);
}

async function updateTable({ id, label, status }) {
  const db = await getDb();
  const result = await db.run('UPDATE tables SET label = ?, status = ? WHERE id = ?', [label, status, id]);
  if (!result.changes) return null;
  return db.get('SELECT * FROM tables WHERE id = ?', id);
}

async function deleteTable(id) {
  const db = await getDb();
  const result = await db.run('DELETE FROM tables WHERE id = ?', [id]);
  return result.changes > 0;
}

async function listTables() {
  const db = await getDb();
  return db.all('SELECT * FROM tables ORDER BY id');
}

async function createTableSession({ id, tableId, expiresAt }) {
  const db = await getDb();
  await db.run('INSERT INTO table_sessions (id, tableId, expiresAt) VALUES (?, ?, ?)', [id, tableId, expiresAt]);
  return db.get('SELECT id, tableId, createdAt, expiresAt FROM table_sessions WHERE id = ?', id);
}

async function getTableSession(id) {
  const db = await getDb();
  return db.get(
    `SELECT id, tableId, createdAt, expiresAt
     FROM table_sessions
     WHERE id = ?
       AND julianday(COALESCE(expiresAt, datetime(createdAt, '+12 hours'))) > julianday('now')`,
    id
  );
}

async function expireTableSession(id, expiresAt) {
  const db = await getDb();
  const result = await db.run('UPDATE table_sessions SET expiresAt = ? WHERE id = ?', [expiresAt, id]);
  return result.changes > 0;
}

async function listReservations() {
  const db = await getDb();
  return db.all('SELECT id, name, date, party, note, phone, email, event FROM reservations ORDER BY id DESC');
}

async function createReservation({ id, name, date, party, note, phone, email, event }) {
  const db = await getDb();
  await db.run(
    'INSERT INTO reservations (id, name, date, party, note, phone, email, event) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, name, date, party, note || '', phone || '', email || '', event || '']
  );
  return { id, name, date, party, note: note || '', phone: phone || '', email: email || '', event: event || '' };
}

async function deleteReservation(id) {
  const db = await getDb();
  const result = await db.run('DELETE FROM reservations WHERE id = ?', [id]);
  return result.changes > 0;
}

async function listOrders() {
  const db = await getDb();
  const rows = await db.all('SELECT * FROM orders ORDER BY createdAt DESC');
  return rows.map(row => ({ ...row, items: JSON.parse(row.items || '[]') }));
}

async function getOrderByIdempotencyKey(idempotencyKey) {
  const db = await getDb();
  const row = await db.get('SELECT * FROM orders WHERE idempotencyKey = ?', idempotencyKey);
  return row ? { ...row, items: JSON.parse(row.items || '[]') } : null;
}

async function updateOrderStatus(id, status) {
  return withTransaction(async db => {
    const row = await db.get('SELECT * FROM orders WHERE id = ?', [id]);
    if (!row) return null;

    let pointsAwarded = Number(row.pointsAwarded || 0);
    if (status === 'COMPLETED' && row.status !== 'COMPLETED' && row.customerPhone && pointsAwarded === 0) {
      pointsAwarded = Math.max(1, Math.floor(Number(row.total) / 1000));
      const customerKey = crypto.createHash('sha256').update(row.customerPhone).digest('hex');
      await db.run(
        `INSERT INTO loyalty_accounts (customerKey, points) VALUES (?, ?)
         ON CONFLICT(customerKey) DO UPDATE SET points = points + excluded.points`,
        [customerKey, pointsAwarded]
      );
    }

    await db.run('UPDATE orders SET status = ?, pointsAwarded = ? WHERE id = ?', [status, pointsAwarded, id]);
    const updated = await db.get('SELECT * FROM orders WHERE id = ?', [id]);
    return { ...updated, items: JSON.parse(updated.items || '[]') };
  });
}

async function createOrder({
  id,
  tableId,
  sessionId,
  customerName,
  customerPhone,
  note,
  total,
  status,
  paymentMethod,
  paymentStatus,
  items,
  idempotencyKey,
  requestFingerprint
}) {
  return withTransaction(async db => {
    if (idempotencyKey) {
      const existing = await db.get('SELECT * FROM orders WHERE idempotencyKey = ?', idempotencyKey);
      if (existing) {
        const existingItems = JSON.parse(existing.items || '[]');
        const sameOrder = existing.tableId === tableId &&
          existing.sessionId === sessionId &&
          existing.customerName === customerName &&
          existing.customerPhone === (customerPhone || '') &&
          existing.note === (note || '') &&
          existing.paymentMethod === (paymentMethod || 'pay_on_site') &&
          (existing.requestFingerprint
            ? existing.requestFingerprint === requestFingerprint
            : JSON.stringify(existingItems.map(item => [item.productId, item.quantity])) ===
              JSON.stringify(items.map(item => [item.productId, item.quantity])));
        if (!sameOrder) {
          const error = new Error('This order confirmation key was already used for different order details');
          error.statusCode = 409;
          throw error;
        }

        return { order: { ...existing, items: existingItems }, replayed: true };
      }
    }

    await db.run(
      `INSERT INTO orders (
        id, tableId, sessionId, customerName, customerPhone, note, total, status,
        paymentMethod, paymentStatus, items, idempotencyKey, requestFingerprint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        tableId,
        sessionId || null,
        customerName,
        customerPhone || '',
        note || '',
        total,
        status || 'PENDING',
        paymentMethod || 'pay_on_site',
        paymentStatus || 'PAY_ON_SITE',
        JSON.stringify(items),
        idempotencyKey || null,
        requestFingerprint || null
      ]
    );

    const row = await db.get('SELECT * FROM orders WHERE id = ?', id);
    return { order: { ...row, items: JSON.parse(row.items || '[]') }, replayed: false };
  });
}

async function getLoyalty(phone) {
  const db = await getDb();
  const customerKey = crypto.createHash('sha256').update(phone).digest('hex');
  const result = await db.get('SELECT points FROM loyalty_accounts WHERE customerKey = ?', customerKey);
  return { points: result ? Number(result.points) : 0 };
}

module.exports = {
  DB_FILE,
  ensureDatabase,
  ensureTable,
  getDb,
  closeDatabase,
  getProductById,
  listProducts,
  saveProduct,
  deleteProduct,
  upsertTable,
  updateTable,
  deleteTable,
  listTables,
  createTableSession,
  getTableSession,
  expireTableSession,
  listReservations,
  createReservation,
  deleteReservation,
  listOrders,
  getOrderByIdempotencyKey,
  updateOrderStatus,
  createOrder,
  getLoyalty
};
