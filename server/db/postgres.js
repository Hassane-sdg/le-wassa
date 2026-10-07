const crypto = require('crypto');
const { Pool } = require('pg');

let pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
}) : null;

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

function safeJsonParse(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function normalizeOrderRow(row) {
  if (!row) return row;
  const normalized = { ...row };
  if (normalized.items !== undefined) {
    normalized.items = safeJsonParse(normalized.items);
  }
  return normalized;
}

function normalizeRows(rows) {
  return rows.map(normalizeOrderRow);
}

function convertQuestionMarks(sql, params = []) {
  let index = 0;
  const normalizedSql = sql.replace(/\?/g, () => `$${++index}`);
  return { text: normalizedSql, values: params };
}

async function ensurePool() {
  if (!pool) {
    throw new Error('DATABASE_URL is not configured. Set it to a PostgreSQL connection string before using the production database adapter.');
  }
  return pool;
}

async function query(text, params = []) {
  const client = await ensurePool();
  return client.query(text, params);
}

function getDatabaseType() {
  return 'postgresql';
}

async function getDb() {
  await ensurePool();
  return {
    query: async (text, params = []) => query(text, params),
    run: async (text, params = []) => {
      const prepared = convertQuestionMarks(text, params);
      const result = await query(prepared.text, prepared.values);
      return { changes: result.rowCount || 0, lastID: result.rows[0] && Number.isInteger(result.rows[0].id) ? result.rows[0].id : null };
    },
    get: async (text, params = []) => {
      const prepared = convertQuestionMarks(text, params);
      const result = await query(prepared.text, prepared.values);
      return result.rows[0] || null;
    },
    all: async (text, params = []) => {
      const prepared = convertQuestionMarks(text, params);
      const result = await query(prepared.text, prepared.values);
      return result.rows;
    },
    close: async () => {
      if (pool) {
        await pool.end();
        pool = null;
      }
    }
  };
}

async function ensureDatabase() {
  await ensurePool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      price INTEGER NOT NULL,
      badge TEXT,
      description TEXT,
      image TEXT DEFAULT 'images/profil.png',
      available BOOLEAN NOT NULL DEFAULT TRUE
    );

    CREATE TABLE IF NOT EXISTS reservations (
      id BIGINT PRIMARY KEY,
      name TEXT NOT NULL,
      date TIMESTAMPTZ NOT NULL,
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
      table_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      table_id TEXT NOT NULL,
      session_id TEXT,
      customer_name TEXT NOT NULL,
      customer_phone TEXT,
      note TEXT,
      total INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      payment_method TEXT NOT NULL DEFAULT 'pay_on_site',
      payment_status TEXT NOT NULL DEFAULT 'PAY_ON_SITE',
      points_awarded INTEGER NOT NULL DEFAULT 0,
      idempotency_key TEXT,
      request_fingerprint TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      items JSONB NOT NULL DEFAULT '[]'::jsonb
    );

    CREATE TABLE IF NOT EXISTS loyalty_accounts (
      customer_key TEXT PRIMARY KEY,
      points INTEGER NOT NULL DEFAULT 0
    );
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS orders_idempotency_key_idx
    ON orders (idempotency_key)
    WHERE idempotency_key IS NOT NULL;

    CREATE INDEX IF NOT EXISTS table_sessions_expiry_idx
    ON table_sessions (expires_at);
  `);

  const countResult = await pool.query('SELECT COUNT(*) AS count FROM products');
  if ((Number(countResult.rows[0].count) || 0) === 0) {
    for (const item of defaultMenu()) {
      await pool.query(
        `INSERT INTO products (id, name, category, price, badge, description, image, available)
         VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)`,
        [item.id, item.name, item.category, item.price, item.badge, item.description, item.image || 'images/profil.png']
      );
    }
  }

  for (const tableId of ['01', '02', '03', '04', '05']) {
    const exists = await pool.query('SELECT 1 FROM tables WHERE id = $1', [tableId]);
    if (!exists.rowCount) {
      await pool.query('INSERT INTO tables (id, label, status) VALUES ($1, $2, $3)', [tableId, `Table ${tableId}`, 'available']);
    }
  }
}

async function getProductById(productId) {
  const result = await query(
    'SELECT id, name, category, price, badge, description, image, available FROM products WHERE id = $1',
    [productId]
  );
  return result.rows[0] || null;
}

async function listProducts(includeUnavailable = false) {
  const sql = includeUnavailable
    ? 'SELECT id, name, category, price, badge, description, image, available FROM products ORDER BY category, name'
    : 'SELECT id, name, category, price, badge, description, image, available FROM products WHERE available = TRUE ORDER BY category, name';
  const result = await query(sql);
  return result.rows;
}

async function saveProduct(product) {
  const result = await query(
    `INSERT INTO products (id, name, category, price, badge, description, image, available)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       category = EXCLUDED.category,
       price = EXCLUDED.price,
       badge = EXCLUDED.badge,
       description = EXCLUDED.description,
       image = EXCLUDED.image,
       available = EXCLUDED.available
     RETURNING id, name, category, price, badge, description, image, available`,
    [product.id, product.name, product.category, product.price, product.badge, product.description, product.image, Boolean(product.available)]
  );
  return result.rows[0];
}

async function deleteProduct(productId) {
  const result = await query('DELETE FROM products WHERE id = $1 RETURNING id', [productId]);
  return result.rowCount > 0;
}

async function upsertTable({ id, label, status }) {
  const result = await query(
    `INSERT INTO tables (id, label, status)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, status = EXCLUDED.status
     RETURNING id, label, status`,
    [id, label, status]
  );
  return result.rows[0];
}

async function updateTable({ id, label, status }) {
  const result = await query(
    'UPDATE tables SET label = $1, status = $2 WHERE id = $3 RETURNING id, label, status',
    [label, status, id]
  );
  return result.rows[0] || null;
}

async function deleteTable(id) {
  const result = await query('DELETE FROM tables WHERE id = $1 RETURNING id', [id]);
  return result.rowCount > 0;
}

async function listTables() {
  const result = await query('SELECT id, label, status FROM tables ORDER BY id');
  return result.rows;
}

async function createTableSession({ id, tableId, expiresAt }) {
  const result = await query(
    'INSERT INTO table_sessions (id, table_id, expires_at) VALUES ($1, $2, $3) RETURNING id, table_id AS "tableId", created_at AS "createdAt", expires_at AS "expiresAt"',
    [id, tableId, expiresAt]
  );
  return result.rows[0];
}

async function getTableSession(id) {
  const result = await query(
    `SELECT id, table_id AS "tableId", created_at AS "createdAt", expires_at AS "expiresAt"
     FROM table_sessions
     WHERE id = $1 AND COALESCE(expires_at, created_at + INTERVAL '12 hours') > NOW()`,
    [id]
  );
  return result.rows[0] || null;
}

async function listReservations() {
  const result = await query(
    'SELECT id, name, date, party, note, phone, email, event FROM reservations ORDER BY id DESC'
  );
  return result.rows;
}

async function createReservation({ id, name, date, party, note, phone, email, event }) {
  const result = await query(
    'INSERT INTO reservations (id, name, date, party, note, phone, email, event) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, name, date, party, note, phone, email, event',
    [id, name, date, party, note || '', phone || '', email || '', event || '']
  );
  return result.rows[0];
}

async function deleteReservation(id) {
  const result = await query('DELETE FROM reservations WHERE id = $1 RETURNING id', [id]);
  return result.rowCount > 0;
}

async function listOrders() {
  const result = await query(
    `SELECT
       id,
       table_id AS "tableId",
       session_id AS "sessionId",
       customer_name AS "customerName",
       customer_phone AS "customerPhone",
       note,
       total,
       status,
       payment_method AS "paymentMethod",
       payment_status AS "paymentStatus",
       points_awarded AS "pointsAwarded",
       idempotency_key AS "idempotencyKey",
       request_fingerprint AS "requestFingerprint",
       created_at AS "createdAt",
       items
     FROM orders ORDER BY created_at DESC`
  );
  return normalizeRows(result.rows);
}

async function getOrderByIdempotencyKey(idempotencyKey) {
  const result = await query(
    `SELECT
       id,
       table_id AS "tableId",
       session_id AS "sessionId",
       customer_name AS "customerName",
       customer_phone AS "customerPhone",
       note,
       total,
       status,
       payment_method AS "paymentMethod",
       payment_status AS "paymentStatus",
       points_awarded AS "pointsAwarded",
       idempotency_key AS "idempotencyKey",
       request_fingerprint AS "requestFingerprint",
       created_at AS "createdAt",
       items
     FROM orders WHERE idempotency_key = $1`,
    [idempotencyKey]
  );
  return result.rows[0] ? normalizeOrderRow(result.rows[0]) : null;
}

async function updateOrderStatus(id, status) {
  const client = await ensurePool();
  const transaction = await client.connect();
  try {
    await transaction.query('BEGIN');
    const rowResult = await transaction.query(
      `SELECT
         id,
         table_id AS "tableId",
         session_id AS "sessionId",
         customer_name AS "customerName",
         customer_phone AS "customerPhone",
         note,
         total,
         status,
         payment_method AS "paymentMethod",
         payment_status AS "paymentStatus",
         points_awarded AS "pointsAwarded",
         idempotency_key AS "idempotencyKey",
         request_fingerprint AS "requestFingerprint",
         created_at AS "createdAt",
         items
       FROM orders WHERE id = $1`,
      [id]
    );
    const row = rowResult.rows[0];
    if (!row) {
      await transaction.query('COMMIT');
      return null;
    }

    let pointsAwarded = Number(row.pointsAwarded || 0);
    if (status === 'COMPLETED' && row.status !== 'COMPLETED' && row.customerPhone && pointsAwarded === 0) {
      pointsAwarded = Math.max(1, Math.floor(Number(row.total) / 1000));
      const customerKey = crypto.createHash('sha256').update(String(row.customerPhone)).digest('hex');
      await transaction.query(
        `INSERT INTO loyalty_accounts (customer_key, points)
         VALUES ($1, $2)
         ON CONFLICT (customer_key) DO UPDATE SET points = loyalty_accounts.points + EXCLUDED.points`,
        [customerKey, pointsAwarded]
      );
    }

    const updated = await transaction.query(
      `UPDATE orders
       SET status = $1, points_awarded = $2
       WHERE id = $3
       RETURNING
         id,
         table_id AS "tableId",
         session_id AS "sessionId",
         customer_name AS "customerName",
         customer_phone AS "customerPhone",
         note,
         total,
         status,
         payment_method AS "paymentMethod",
         payment_status AS "paymentStatus",
         points_awarded AS "pointsAwarded",
         idempotency_key AS "idempotencyKey",
         request_fingerprint AS "requestFingerprint",
         created_at AS "createdAt",
         items`,
      [status, pointsAwarded, id]
    );
    await transaction.query('COMMIT');
    return normalizeOrderRow(updated.rows[0]);
  } catch (error) {
    await transaction.query('ROLLBACK');
    throw error;
  } finally {
    transaction.release();
  }
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
  const existingResult = idempotencyKey
    ? await query(
        `SELECT
           id,
           table_id AS "tableId",
           session_id AS "sessionId",
           customer_name AS "customerName",
           customer_phone AS "customerPhone",
           note,
           total,
           status,
           payment_method AS "paymentMethod",
           payment_status AS "paymentStatus",
           points_awarded AS "pointsAwarded",
           idempotency_key AS "idempotencyKey",
           request_fingerprint AS "requestFingerprint",
           created_at AS "createdAt",
           items
         FROM orders WHERE idempotency_key = $1`,
        [idempotencyKey]
      )
    : { rows: [] };

  if (existingResult.rows[0]) {
    const existing = normalizeOrderRow(existingResult.rows[0]);
    const sameOrder = existing.tableId === tableId &&
      existing.sessionId === sessionId &&
      existing.customerName === customerName &&
      existing.customerPhone === (customerPhone || '') &&
      existing.note === (note || '') &&
      existing.paymentMethod === (paymentMethod || 'pay_on_site') &&
      (
        existing.requestFingerprint
          ? existing.requestFingerprint === requestFingerprint
          : JSON.stringify((existing.items || []).map(item => [item.productId, item.quantity])) === JSON.stringify((items || []).map(item => [item.productId, item.quantity]))
      );
    if (!sameOrder) {
      const error = new Error('This order confirmation key was already used for different order details');
      error.statusCode = 409;
      throw error;
    }
    return { order: existing, replayed: true };
  }

  const result = await query(
    `INSERT INTO orders (
      id,
      table_id,
      session_id,
      customer_name,
      customer_phone,
      note,
      total,
      status,
      payment_method,
      payment_status,
      items,
      idempotency_key,
      request_fingerprint
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
     RETURNING
       id,
       table_id AS "tableId",
       session_id AS "sessionId",
       customer_name AS "customerName",
       customer_phone AS "customerPhone",
       note,
       total,
       status,
       payment_method AS "paymentMethod",
       payment_status AS "paymentStatus",
       points_awarded AS "pointsAwarded",
       idempotency_key AS "idempotencyKey",
       request_fingerprint AS "requestFingerprint",
       created_at AS "createdAt",
       items`,
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
  return { order: normalizeOrderRow(result.rows[0]), replayed: false };
}

async function getLoyalty(phone) {
  const customerKey = crypto.createHash('sha256').update(String(phone || '')).digest('hex');
  const result = await query('SELECT points FROM loyalty_accounts WHERE customer_key = $1', [customerKey]);
  return { points: Number(result.rows[0]?.points || 0) };
}

async function closeDatabase() {
  if (!pool) return;
  await pool.end();
  pool = null;
}

module.exports = {
  DB_FILE: process.env.DATABASE_URL || 'postgresql://configured-through-DATABASE_URL',
  ensureDatabase,
  ensureTable: ensureDatabase,
  getDb,
  closeDatabase,
  getDatabaseType,
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
  listReservations,
  createReservation,
  deleteReservation,
  listOrders,
  getOrderByIdempotencyKey,
  updateOrderStatus,
  createOrder,
  getLoyalty
};
