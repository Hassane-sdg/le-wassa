const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.sqlite');
let dbPromise = null;

function defaultMenu() {
  return [
    { id: 'poulet-braise', name: 'Poulet braisé', category: 'Grillades', price: 12000, badge: 'Signature', description: 'Poulet mariné aux épices africaines, servi avec alloco et sauce maison.' },
    { id: 'poisson-braise', name: 'Poisson braisé', category: 'Grillades', price: 15000, badge: 'Spécialité', description: 'Poisson gras grillé au feu de bois, Accompagnements maison.' },
    { id: 'attieke-poisson', name: 'Attiéké poisson', category: 'Grillades', price: 11000, badge: 'Populaire', description: 'Attiéké léger, poisson de mer, tomate, oignon et piment.' },
    { id: 'kedjenou', name: 'Kedjenou de poulet', category: 'Grillades', price: 14000, badge: 'Chef', description: 'Poulet mijoté aux légumes et épices locales.' },
    { id: 'alloco', name: 'Alloco', category: 'Accompagnements', price: 5000, badge: 'Accompagnement', description: 'Plantain frit, sauce piquante et oignons frais.' },
    { id: 'riz-sauce', name: 'Riz sauce', category: 'Accompagnements', price: 6000, badge: 'Classique', description: 'Riz parfumé et sauce généreuse aux saveurs locales.' },
    { id: 'coca-cola', name: 'Coca-Cola', category: 'Boissons', price: 1500, badge: 'Boisson', description: 'Boisson rafraîchissante glacée.' },
    { id: 'jus-mangue', name: 'Jus de mangue', category: 'Boissons', price: 3000, badge: 'Frais', description: 'Jus frais à base de mangue locale.' },
    { id: 'tropical-sun', name: 'Tropical Sun', category: 'Boissons', price: 3500, badge: 'Nouveau', description: 'Mocktail exotique avec fruits tropicaux.' },
    { id: 'dessert-exotique', name: 'Dessert exotique', category: 'Desserts', price: 8000, badge: 'Signature', description: 'Fruits frais, glace coco et coulis de mangue.' }
  ];
}

async function getDb() {
  if (!dbPromise) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    dbPromise = open({ filename: DB_PATH, driver: sqlite3.Database });
  }
  return dbPromise;
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
      image TEXT DEFAULT 'images/profil.png'
    );

    CREATE TABLE IF NOT EXISTS reservations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      date TEXT NOT NULL,
      party INTEGER NOT NULL,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS tables (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'available'
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      tableId TEXT NOT NULL,
      customerName TEXT NOT NULL,
      note TEXT,
      total INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      items TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS loyalty (
      customerName TEXT PRIMARY KEY,
      points INTEGER NOT NULL DEFAULT 0
    );
  `);

  const currentProducts = await db.get('SELECT COUNT(*) as count FROM products');
  if ((currentProducts?.count || 0) === 0) {
    const items = defaultMenu();
    for (const item of items) {
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

function getProductByIdSync(productId) {
  return defaultMenu().find(item => item.id === productId) || null;
}

async function listProducts() {
  const db = await getDb();
  return db.all('SELECT id, name, category, price, badge, description, image FROM products ORDER BY category, name');
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

async function listTables() {
  const db = await getDb();
  return db.all('SELECT * FROM tables ORDER BY id');
}

async function listReservations() {
  const db = await getDb();
  return db.all('SELECT id, name, date, party, note FROM reservations ORDER BY id DESC');
}

async function createReservation({ id, name, date, party, note }) {
  const db = await getDb();
  await db.run('INSERT INTO reservations (id, name, date, party, note) VALUES (?, ?, ?, ?, ?)', [id, name, date, party, note || '']);
  return { id, name, date, party, note: note || '' };
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

async function createOrder({ id, tableId, customerName, note, total, status, items }) {
  const db = await getDb();
  await db.run(
    'INSERT INTO orders (id, tableId, customerName, note, total, status, items) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, tableId, customerName, note || '', total, status || 'PENDING', JSON.stringify(items)]
  );

  const customer = await db.get('SELECT * FROM loyalty WHERE customerName = ?', customerName);
  const pointsEarned = Math.max(10, Math.floor(total / 1000));
  if (customer) {
    await db.run('UPDATE loyalty SET points = points + ? WHERE customerName = ?', [pointsEarned, customerName]);
  } else {
    await db.run('INSERT INTO loyalty (customerName, points) VALUES (?, ?)', [customerName, pointsEarned]);
  }

  return { id, tableId, customerName, note: note || '', total, status: status || 'PENDING', items };
}

async function getLoyalty(customerName) {
  const db = await getDb();
  const result = await db.get('SELECT points FROM loyalty WHERE customerName = ?', customerName);
  return { customerName, points: result ? Number(result.points) : 0 };
}

module.exports = {
  DB_PATH,
  ensureDatabase,
  getProductByIdSync,
  listProducts,
  upsertTable,
  listTables,
  listReservations,
  createReservation,
  deleteReservation,
  listOrders,
  createOrder,
  getLoyalty,
  getDb
};
