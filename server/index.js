require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const QRCode = require('qrcode');
const db = require('./db');
const { manualPaymentProvider } = require('./payments');

const app = express();
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.WASSA_SMOKE_TEST === '1' ? '127.0.0.1' : '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || process.env.WONGO_ADMIN_TOKEN || '';
const GEMINI_API_URL = process.env.GEMINI_API_URL;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PUBLIC_SITE_URL = process.env.PUBLIC_SITE_URL || '';
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || process.env.CORS_ORIGINS || 'http://localhost:5000,http://127.0.0.1:5000,http://localhost:5500,http://127.0.0.1:5500')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
);

app.use(cors({
  origin(origin, callback) {
    callback(null, !origin || allowedOrigins.has(origin));
  },
  credentials: false,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Token', 'Idempotency-Key']
}));
app.use(express.json({ limit: '32kb' }));

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function sendApiError(res, error, fallback) {
  const statusCode = Number(error.statusCode) || 500;
  if (statusCode >= 500) {
    console.error(fallback, { code: error.code || error.name || 'UNKNOWN' });
    return res.status(statusCode).json({ ok: false, error: fallback });
  }
  return res.status(statusCode).json({ ok: false, error: error.message });
}

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || req.headers['x-admin-token'];
  let token = '';

  if (typeof header === 'string') {
    if (header.toLowerCase().startsWith('bearer ')) token = header.slice(7).trim();
    else token = header.trim();
  }

  const expected = Buffer.from(ADMIN_TOKEN);
  const supplied = Buffer.from(token);
  if (ADMIN_TOKEN && supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected)) {
    return next();
  }

  return res.status(401).json({ ok: false, error: 'Unauthorized' });
}

function validateProduct(payload, id) {
  const product = {
    id: String(id || payload.id || '').trim(),
    name: String(payload.name || '').trim(),
    category: String(payload.category || '').trim(),
    price: Number(payload.price),
    badge: String(payload.badge || '').trim(),
    description: String(payload.description || '').trim(),
    image: String(payload.image || 'images/profil.png').trim(),
    available: payload.available === undefined ? true : payload.available === true
  };
  if (!/^[a-zA-Z0-9_-]{1,60}$/.test(product.id)) throw badRequest('Product id must use 1-60 letters, numbers, dashes or underscores');
  if (!product.name || product.name.length > 100) throw badRequest('Product name must be between 1 and 100 characters');
  if (!product.category || product.category.length > 50) throw badRequest('Product category must be between 1 and 50 characters');
  if (!Number.isSafeInteger(product.price) || product.price <= 0 || product.price > 100000000) throw badRequest('Product price must be a positive amount in FCFA');
  if (product.badge.length > 40 || product.description.length > 400) throw badRequest('Product description or badge is too long');
  const localImagePath = /^images\/[A-Za-z0-9._/-]+$/.test(product.image) && !product.image.includes('..');
  if (product.image.length > 500 || (!localImagePath && !/^https:\/\//i.test(product.image))) {
    throw badRequest('Product image must be a local image path or an HTTPS URL');
  }
  return product;
}

app.get('/api/health', async (req, res) => {
  try {
    await db.ensureDatabase();
    const databaseName = db.getDatabaseType ? db.getDatabaseType() : 'sqlite';
    res.json({ ok: true, data: { status: 'healthy', database: databaseName, port: PORT } });
  } catch (error) {
    sendApiError(res, error, 'Health check is temporarily unavailable');
  }
});

app.get('/api/menu', async (req, res) => {
  try {
    const items = await db.listProducts();
    res.json({ ok: true, data: items });
  } catch (error) {
    sendApiError(res, error, 'Menu is temporarily unavailable');
  }
});

app.get('/api/admin/menu', requireAdmin, async (req, res) => {
  try {
    res.json({ ok: true, data: await db.listProducts(true) });
  } catch (error) {
    sendApiError(res, error, 'Admin menu is temporarily unavailable');
  }
});

app.post('/api/menu', requireAdmin, async (req, res) => {
  try {
    const product = validateProduct(req.body || {});
    if (await db.getProductById(product.id)) {
      return res.status(409).json({ ok: false, error: 'A product with this id already exists' });
    }
    res.status(201).json({ ok: true, data: await db.saveProduct(product) });
  } catch (error) {
    sendApiError(res, error, 'Failed to save product');
  }
});

app.put('/api/menu/:id', requireAdmin, async (req, res) => {
  try {
    if (!await db.getProductById(req.params.id)) return res.status(404).json({ ok: false, error: 'Product not found' });
    const product = validateProduct(req.body || {}, req.params.id);
    res.json({ ok: true, data: await db.saveProduct(product) });
  } catch (error) {
    sendApiError(res, error, 'Failed to update product');
  }
});

app.delete('/api/menu/:id', requireAdmin, async (req, res) => {
  try {
    const removed = await db.deleteProduct(req.params.id);
    if (!removed) return res.status(404).json({ ok: false, error: 'Product not found' });
    res.json({ ok: true, data: { deletedId: req.params.id } });
  } catch (error) {
    sendApiError(res, error, 'Failed to delete product');
  }
});

app.get('/api/tables', async (req, res) => {
  try {
    const tables = await db.listTables();
    res.json({ ok: true, data: tables });
  } catch (error) {
    sendApiError(res, error, 'Tables are temporarily unavailable');
  }
});

app.get('/api/tables/:id/qr', requireAdmin, async (req, res) => {
  try {
    const tableId = String(req.params.id || '').trim();
    if (!/^[a-zA-Z0-9_-]{1,20}$/.test(tableId)) throw badRequest('Invalid table id');
    const table = (await db.listTables()).find(item => item.id === tableId);
    if (!table) return res.status(404).json({ ok: false, error: 'Table not found' });
    const baseUrl = PUBLIC_SITE_URL || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:5000');
    if (!baseUrl) return res.status(503).json({ ok: false, error: 'Set PUBLIC_SITE_URL before generating table QR codes' });
    const parsedBase = new URL(baseUrl);
    if (parsedBase.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && parsedBase.hostname === 'localhost')) {
      throw badRequest('PUBLIC_SITE_URL must use HTTPS');
    }
    const target = new URL(`table.html?table=${encodeURIComponent(tableId)}`, `${parsedBase.origin}/`).toString();
    const image = await QRCode.toBuffer(target, { type: 'png', width: 480, margin: 2, errorCorrectionLevel: 'M' });
    res.set('Content-Type', 'image/png');
    res.set('Content-Disposition', `attachment; filename="table-${tableId}.png"`);
    res.send(image);
  } catch (error) {
    sendApiError(res, error, 'Failed to generate table QR code');
  }
});

app.post('/api/table-sessions', async (req, res) => {
  try {
    const rawTableId = (req.body || {}).tableId;
    if (typeof rawTableId !== 'string') throw badRequest('Invalid table id');
    const tableId = rawTableId.trim();
    if (!/^[a-zA-Z0-9_-]{1,20}$/.test(tableId)) throw badRequest('Invalid table id');
    const table = (await db.listTables()).find(item => item.id === tableId);
    if (!table) return res.status(404).json({ ok: false, error: 'Table not found' });
    if (table.status === 'maintenance') return res.status(409).json({ ok: false, error: 'This table is currently unavailable' });
    const session = await db.createTableSession({
      id: crypto.randomBytes(16).toString('hex'),
      tableId,
      expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()
    });
    res.status(201).json({ ok: true, data: session });
  } catch (error) {
    sendApiError(res, error, 'Failed to create table session');
  }
});

app.get('/api/payment-options', (req, res) => {
  res.json({ ok: true, data: manualPaymentProvider.getOptions() });
});

app.post('/api/tables', requireAdmin, async (req, res) => {
  try {
    const payload = req.body || {};
    const tableId = String(payload.id || payload.tableId || '').trim();
    const label = String(payload.label || `Table ${tableId}`).trim();
    const status = String(payload.status || 'available').trim().toLowerCase();
    if (!/^[a-zA-Z0-9_-]{1,20}$/.test(tableId)) throw badRequest('Table id must use 1-20 letters, numbers, dashes or underscores');
    if (!label || label.length > 60) throw badRequest('Table label must be between 1 and 60 characters');
    if (!['available', 'occupied', 'maintenance'].includes(status)) throw badRequest('Invalid table status');
    if ((await db.listTables()).some(table => table.id === tableId)) {
      return res.status(409).json({ ok: false, error: 'A table with this id already exists' });
    }

    const row = await db.upsertTable({
      id: tableId,
      label,
      status
    });

    res.status(201).json({ ok: true, data: row });
  } catch (error) {
    sendApiError(res, error, 'Failed to save table');
  }
});

app.put('/api/tables/:id', requireAdmin, async (req, res) => {
  try {
    const tableId = String(req.params.id || '').trim();
    const payload = req.body || {};
    const label = String(payload.label || `Table ${tableId}`).trim();
    const status = String(payload.status || '').trim().toLowerCase();
    if (!/^[a-zA-Z0-9_-]{1,20}$/.test(tableId)) throw badRequest('Invalid table id');
    if (!label || label.length > 60) throw badRequest('Table label must be between 1 and 60 characters');
    if (!['available', 'occupied', 'maintenance'].includes(status)) throw badRequest('Invalid table status');
    const row = await db.updateTable({ id: tableId, label, status });
    if (!row) return res.status(404).json({ ok: false, error: 'Table not found' });
    res.json({ ok: true, data: row });
  } catch (error) {
    sendApiError(res, error, 'Failed to update table');
  }
});

app.delete('/api/tables/:id', requireAdmin, async (req, res) => {
  try {
    const tableId = String(req.params.id || '').trim();
    const removed = await db.deleteTable(tableId);
    if (!removed) return res.status(404).json({ ok: false, error: 'Table not found' });
    res.json({ ok: true, data: { deletedId: tableId } });
  } catch (error) {
    sendApiError(res, error, 'Failed to delete table');
  }
});

app.get('/api/orders', requireAdmin, async (req, res) => {
  try {
    const orders = await db.listOrders();
    res.json({ ok: true, data: orders });
  } catch (error) {
    sendApiError(res, error, 'Orders are temporarily unavailable');
  }
});

app.put('/api/orders/:id/status', requireAdmin, async (req, res) => {
  try {
    const status = String((req.body || {}).status || '').trim().toUpperCase();
    const validStatuses = ['PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'SERVED', 'COMPLETED', 'CANCELLED'];
    if (!validStatuses.includes(status)) throw badRequest('Invalid order status');
    const order = await db.updateOrderStatus(String(req.params.id), status);
    if (!order) return res.status(404).json({ ok: false, error: 'Order not found' });
    res.json({ ok: true, data: order });
  } catch (error) {
    sendApiError(res, error, 'Failed to update order status');
  }
});

app.post('/api/orders', async (req, res) => {
  try {
    const payload = req.body;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw badRequest('Invalid order payload');
    const tableId = typeof payload.tableId === 'string' ? payload.tableId.trim() : '';
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
    const customerName = typeof payload.customerName === 'string' ? payload.customerName.trim() : '';
    const customerPhoneRaw = payload.customerPhone === undefined ? '' : payload.customerPhone;
    const note = payload.note === undefined ? '' : payload.note;
    const items = payload.items;
    const paymentMethod = payload.paymentMethod === undefined ? 'pay_on_site' : payload.paymentMethod;
    const idempotencyKey = req.get('Idempotency-Key') || '';

    if (!/^[a-zA-Z0-9_-]{1,20}$/.test(tableId)) throw badRequest('A valid table id is required');
    if (!/^[a-f0-9]{32}$/i.test(sessionId)) throw badRequest('A valid table session is required');
    if (!customerName || customerName.length > 100) throw badRequest('Customer name must be between 1 and 100 characters');
    if (typeof note !== 'string' || note.length > 500) throw badRequest('Order note must be 500 characters or fewer');
    if (typeof customerPhoneRaw !== 'string' || customerPhoneRaw.length > 30) throw badRequest('Enter a valid phone number');
    const customerPhone = customerPhoneRaw.replace(/[\s()-]/g, '');
    if (customerPhone && !/^\+?[0-9]{8,15}$/.test(customerPhone)) throw badRequest('Enter a valid phone number');
    if (paymentMethod !== 'pay_on_site') throw badRequest('Only payment on site is currently available');
    if (!/^[a-f0-9-]{16,80}$/i.test(idempotencyKey)) throw badRequest('A valid Idempotency-Key header is required');
    if (!Array.isArray(items) || !items.length || items.length > 40) throw badRequest('An order must contain between 1 and 40 different items');
    const normalizedItems = items.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw badRequest('Invalid order item');
      const productId = typeof item.productId === 'string' ? item.productId.trim() : '';
      const quantity = item.quantity;
      if (!/^[a-zA-Z0-9_-]{1,60}$/.test(productId)) throw badRequest('Invalid product id');
      if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 20) throw badRequest('Each item quantity must be between 1 and 20');
      return { productId, quantity };
    });
    if (new Set(normalizedItems.map(item => item.productId)).size !== normalizedItems.length) {
      throw badRequest('An order must contain each product only once');
    }

    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
      tableId,
      sessionId,
      customerName,
      customerPhone,
      note,
      paymentMethod,
      items: normalizedItems.map(item => [item.productId, item.quantity])
    })).digest('hex');
    const previousOrder = await db.getOrderByIdempotencyKey(idempotencyKey);
    if (previousOrder) {
      if (previousOrder.requestFingerprint !== fingerprint) {
        return res.status(409).json({ ok: false, error: 'This idempotency key was already used for a different order' });
      }
      return res.status(200).json({ ok: true, data: previousOrder, replayed: true });
    }

    const table = (await db.listTables()).find(item => item.id === tableId);
    if (!table) return res.status(404).json({ ok: false, error: 'Table not found' });
    if (table.status === 'maintenance') return res.status(409).json({ ok: false, error: 'This table is currently unavailable' });
    const session = await db.getTableSession(sessionId);
    if (!session || session.tableId !== tableId) throw badRequest('The table session is invalid or expired');

    const validItems = await Promise.all(normalizedItems.map(async item => {
      const { productId, quantity } = item;
      const product = await db.getProductById(productId);

      if (!product || !product.available) throw badRequest(`Product is unavailable: ${productId}`);

      return {
        productId: product.id,
        productName: product.name,
        quantity,
        unitPrice: product.price,
        totalPrice: product.price * quantity
      };
    }));

    const total = validItems.reduce((sum, item) => sum + item.totalPrice, 0);
    if (!Number.isSafeInteger(total) || total <= 0) throw badRequest('Invalid order total');
    const payment = manualPaymentProvider.createPaymentIntent();
    const order = await db.createOrder({
      id: `WASSA-${crypto.randomBytes(16).toString('hex')}`,
      tableId,
      sessionId,
      customerName,
      customerPhone,
      note,
      total,
      status: 'PENDING',
      paymentMethod: 'pay_on_site',
      paymentStatus: payment.status,
      items: validItems,
      idempotencyKey,
      requestFingerprint: fingerprint
    });

    res.status(order.replayed ? 200 : 201).json({ ok: true, data: order.order, replayed: order.replayed });
  } catch (error) {
    sendApiError(res, error, 'Failed to create order');
  }
});

app.get('/api/reservations', requireAdmin, async (req, res) => {
  try {
    const items = await db.listReservations();
    res.json({ ok: true, data: items });
  } catch (error) {
    sendApiError(res, error, 'Reservations are temporarily unavailable');
  }
});

app.post('/api/reservations', async (req, res) => {
  try {
    const payload = req.body || {};
    const name = String(payload.name || '').trim();
    const dateStr = String(payload.date || '').trim();
    const party = Number(payload.party || 1);
    const note = String(payload.note || '').trim();
    const phone = String(payload.phone || '').replace(/[\s()-]/g, '');
    const email = String(payload.email || '').trim();
    const event = String(payload.event || '').trim();

    if (!name || name.length > 100) throw badRequest('Customer name must be between 1 and 100 characters');
    if (!/^\+?[0-9]{8,15}$/.test(phone)) throw badRequest('Enter a valid phone number');
    if (email.length > 254 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw badRequest('Enter a valid email address');
    if (event.length > 100) throw badRequest('Event name is too long');

    const reservationDate = new Date(dateStr || Date.now());
    if (Number.isNaN(reservationDate.getTime()) || reservationDate.getTime() <= Date.now()) throw badRequest('Choose a future reservation date and time');
    if (!Number.isInteger(party) || party < 1 || party > 50) throw badRequest('Party size must be between 1 and 50');
    if (note.length > 500) throw badRequest('Note must be shorter than 500 characters');

    const item = await db.createReservation({
      id: Date.now() * 1000 + crypto.randomInt(0, 1000),
      name,
      date: reservationDate.toISOString(),
      party,
      note,
      phone,
      email,
      event
    });

    res.status(201).json({ ok: true, data: item });
  } catch (error) {
    sendApiError(res, error, 'Failed to create reservation');
  }
});

app.delete('/api/reservations/:id', requireAdmin, async (req, res) => {
  try {
    const removed = await db.deleteReservation(Number(req.params.id));
    if (!removed) return res.status(404).json({ ok: false, error: 'Reservation not found' });
    res.json({ ok: true, data: { deletedId: Number(req.params.id) } });
  } catch (error) {
    sendApiError(res, error, 'Failed to delete reservation');
  }
});

app.get('/api/loyalty', requireAdmin, async (req, res) => {
  try {
    const phone = String(req.query.phone || '').replace(/[\s()-]/g, '');
    if (!/^\+?[0-9]{8,15}$/.test(phone)) throw badRequest('A valid customer phone number is required');
    const points = await db.getLoyalty(phone);
    res.json({ ok: true, data: points });
  } catch (error) {
    sendApiError(res, error, 'Failed to load loyalty points');
  }
});

app.post('/api/gemini/generate', requireAdmin, async (req, res) => {
  try {
    if (!GEMINI_API_URL || !GEMINI_API_KEY) {
      return res.status(500).json({ ok: false, error: 'Server not configured: GEMINI_API_URL / GEMINI_API_KEY missing' });
    }

    const prompt = String((req.body || {}).prompt || '').trim();
    if (!prompt || prompt.length > 1000) throw badRequest('Prompt must be between 1 and 1000 characters');
    const response = await axios.post(
      GEMINI_API_URL,
      { prompt, max_tokens: 120 },
      {
        headers: {
          Authorization: `Bearer ${GEMINI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    res.json({ ok: true, data: response.data });
  } catch (error) {
    sendApiError(res, error, 'The announcement service is unavailable');
  }
});

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'Le WASSA API', version: '1.0.0' });
});

async function startServer() {
  if (process.env.NODE_ENV === 'production' && Buffer.byteLength(ADMIN_TOKEN) < 32) {
    throw new Error('Set ADMIN_TOKEN to at least 32 random characters before starting in production');
  }
  await db.ensureDatabase();
  let server;
  const onListening = () => {
    const address = server.address();
    console.log(`Le WASSA API listening on http://localhost:${address.port}`);
  };
  server = HOST
    ? app.listen(PORT, HOST, onListening)
    : app.listen(PORT, onListening);

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      server.close(async () => {
        try {
          await db.closeDatabase();
          process.exitCode = 0;
        } catch (error) {
          console.error('Database shutdown failed', { code: error.code || error.name || 'UNKNOWN' });
          process.exitCode = 1;
        }
      });
    });
  }
  return server;
}

if (require.main === module) {
  startServer().catch(error => {
    console.error('Failed to start Le WASSA API', { code: error.code || error.name || 'UNKNOWN' });
    process.exit(1);
  });
}

module.exports = { app, startServer };
