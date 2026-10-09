const assert = require('assert');
const axios = require('axios');
const crypto = require('crypto');
const { once } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('dotenv').config();
const { localSmokeBaseUrl } = require('./smoke-target');

if (process.env.NODE_ENV === 'production') {
  throw new Error('Smoke tests cannot run with NODE_ENV=production.');
}

if (process.env.DATABASE_URL || process.env.TEST_DATABASE_URL) {
  throw new Error('Smoke tests use a temporary SQLite database; unset DATABASE_URL and TEST_DATABASE_URL.');
}

if (process.env.BASE_URL) {
  throw new Error('BASE_URL overrides are disabled; the smoke test starts its own isolated local API.');
}

async function run() {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'le-wassa-smoke-'));
  const databasePath = path.join(temporaryDirectory, 'smoke.sqlite');
  const adminToken = crypto.randomBytes(32).toString('hex');
  let db;
  let server;
  let testError;
  const cleanupErrors = [];

  try {
    process.env.NODE_ENV = 'test';
    process.env.ADMIN_TOKEN = adminToken;
    process.env.PORT = '0';
    process.env.WASSA_SMOKE_TEST = '1';
    process.env.WONGO_ADMIN_TOKEN = '';
    process.env.NODE_OPTIONS = '';
    process.env.DATABASE_URL = '';
    process.env.TEST_DATABASE_URL = '';
    process.env.WASSA_DB_PATH = databasePath;
    process.env.WASSA_DATA_DIR = temporaryDirectory;
    db = require('../db');
    const { startServer } = require('../index');
    server = await startServer();
    if (!server.listening) await once(server, 'listening');
    const port = server.address().port;
    const base = localSmokeBaseUrl(`http://127.0.0.1:${port}`, port);
    const admin = axios.create({
      baseURL: base,
      proxy: false,
      maxRedirects: 0,
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const api = axios.create({ baseURL: base, proxy: false, maxRedirects: 0 });
    const timestamp = Date.now();
    const tableId = `smoke_${timestamp}`;
    const productId = `smoke-${timestamp}`;
    const customerPhone = `+226${String(timestamp).slice(-8)}`;

    const health = await api.get('/api/health');
    assert.strictEqual(health.data.data.status, 'healthy');
    assert.strictEqual(health.data.data.database, db.getDatabaseType ? db.getDatabaseType() : 'sqlite');

    const privateRequests = [
      api.get('/api/orders'),
      api.get('/api/admin/menu'),
      api.get('/api/reservations'),
      api.get('/api/loyalty', { params: { phone: customerPhone } }),
      api.get(`/api/tables/${tableId}/qr`),
      api.post('/api/tables', { id: tableId, label: 'Unauthorized table' }),
      api.put(`/api/tables/${tableId}`, { label: 'Unauthorized table', status: 'available' }),
      api.delete(`/api/tables/${tableId}`),
      api.post('/api/menu', { id: productId, name: 'Unauthorized', category: 'Test', price: 1 }),
      api.put(`/api/menu/${productId}`, { name: 'Unauthorized', category: 'Test', price: 1 }),
      api.delete(`/api/menu/${productId}`),
      api.put('/api/orders/not-an-order/status', { status: 'COMPLETED' }),
      api.delete('/api/reservations/1')
    ];
    const privateResponses = await Promise.allSettled(privateRequests);
    assert.ok(privateResponses.every(result =>
      result.status === 'rejected' && result.reason.response && result.reason.response.status === 401
    ), 'Every private API route must reject unauthenticated requests with 401');

    const publicMenu = await api.get('/api/menu');
    assert.ok(Array.isArray(publicMenu.data.data));
    const publicTables = await api.get('/api/tables');
    assert.ok(Array.isArray(publicTables.data.data));
    assert.ok(publicTables.data.data.every(table =>
      Object.keys(table).every(key => ['id', 'label', 'status'].includes(key))
    ), 'Public table listing must not expose customer or operational records');

    await admin.post('/api/tables', { id: tableId, label: `Table test ${timestamp}`, status: 'available' });
    const session = await api.post('/api/table-sessions', { tableId });
    assert.strictEqual(session.data.data.tableId, tableId);

    const qr = await admin.get(`/api/tables/${tableId}/qr`, { responseType: 'arraybuffer' });
    assert.strictEqual(qr.headers['content-type'], 'image/png');
    assert.ok(Buffer.from(qr.data).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));

    const product = {
      id: productId,
      name: 'Plat test du maquis',
      category: 'Test',
      price: 1234,
      badge: 'Test',
      description: 'Produit temporaire du test automatisé.',
      image: 'images/grillade.png',
      available: true
    };
    await admin.post('/api/menu', product);
    assert.ok((await api.get('/api/menu')).data.data.some(item => item.id === productId));

    await assert.rejects(admin.post('/api/menu', { ...product, price: -1 }), error => error.response.status === 400);

    const orderPayload = {
      tableId,
      sessionId: session.data.data.id,
      customerName: 'Client test',
      customerPhone,
      note: 'Peu de piment.',
      paymentMethod: 'pay_on_site',
      total: 1,
      items: [{ productId, quantity: 2, unitPrice: 1, totalPrice: 1 }]
    };
    const idempotencyKey = `${timestamp.toString(16)}${'a'.repeat(32)}`;
    const confirmationResponses = await Promise.all([
      api.post('/api/orders', orderPayload, { headers: { 'Idempotency-Key': idempotencyKey } }),
      api.post('/api/orders', orderPayload, { headers: { 'Idempotency-Key': idempotencyKey } })
    ]);
    const createdOrder = confirmationResponses.find(response => response.status === 201);
    const concurrentReplay = confirmationResponses.find(response => response.status === 200);
    assert.ok(createdOrder, 'One concurrent confirmation must create the order');
    assert.ok(concurrentReplay, 'The other concurrent confirmation must replay the order');
    const order = createdOrder.data.data;
    assert.strictEqual(order.total, 2468);
    assert.strictEqual(order.items[0].unitPrice, 1234);
    assert.strictEqual(order.paymentStatus, 'PAY_ON_SITE');
    assert.strictEqual(order.paymentMethod, 'pay_on_site');
    assert.strictEqual(concurrentReplay.data.data.id, order.id);

    const replayedOrder = await api.post('/api/orders', orderPayload, {
      headers: { 'Idempotency-Key': idempotencyKey }
    });
    assert.strictEqual(replayedOrder.status, 200);
    assert.strictEqual(replayedOrder.data.replayed, true);
    assert.strictEqual(replayedOrder.data.data.id, order.id);
    await assert.rejects(api.post('/api/orders', {
      ...orderPayload,
      note: 'Autre demande'
    }, { headers: { 'Idempotency-Key': idempotencyKey } }), error => error.response.status === 409);

    await assert.rejects(api.post('/api/orders', {
      ...orderPayload,
      items: [{ productId, quantity: '2' }]
    }, { headers: { 'Idempotency-Key': `${idempotencyKey}b` } }), error => error.response.status === 400);
    await assert.rejects(api.post('/api/orders', orderPayload), error => error.response.status === 400);
    const storedOrders = (await admin.get('/api/orders')).data.data;
    assert.ok(storedOrders.some(item => item.id === order.id), 'Created order must be persisted and available to the authenticated dashboard');

    const expiredSession = await api.post('/api/table-sessions', { tableId });
    await db.expireTableSession(expiredSession.data.data.id, new Date(Date.now() - 60000).toISOString());
    await assert.rejects(api.post('/api/orders', {
      ...orderPayload,
      sessionId: expiredSession.data.data.id
    }, { headers: { 'Idempotency-Key': `${timestamp.toString(16)}${'b'.repeat(32)}` } }), error => error.response.status === 400);

    const status = await admin.put(`/api/orders/${encodeURIComponent(order.id)}/status`, { status: 'COMPLETED' });
    assert.strictEqual(status.data.data.pointsAwarded, 2);
    const loyalty = await admin.get('/api/loyalty', { params: { phone: customerPhone } });
    assert.strictEqual(loyalty.data.data.points, 2);

    await assert.rejects(api.post('/api/orders', {
      tableId,
      sessionId: 'invalid-session',
      items: [{ productId, quantity: 1 }]
    }), error => error.response.status === 400);

    const reservation = await api.post('/api/reservations', {
      name: 'Client test',
      phone: customerPhone,
      date: new Date(Date.now() + 86400000).toISOString(),
      party: 2,
      note: 'Test de réservation'
    });
    assert.ok((await admin.get('/api/reservations')).data.data.some(item => item.id === reservation.data.data.id));

    const options = await api.get('/api/payment-options');
    assert.ok(options.data.data.some(option => option.id === 'pay_on_site' && option.available));
    assert.ok(options.data.data.some(option => option.id === 'online' && !option.available));

    console.log('Smoke tests passed: auth, tables, table sessions, QR image, menu CRUD, persisted orders, server-side prices, idempotency, order validation/status, loyalty, reservations, manual payment.');
  } catch (error) {
    testError = error;
  }

  try {
    if (server && server.listening) {
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    }
  } catch (error) {
    cleanupErrors.push(error);
  }

  try {
    if (db) await db.closeDatabase();
  } catch (error) {
    cleanupErrors.push(error);
  }

  try {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (testError && cleanupErrors.length) {
    throw new AggregateError(
      [testError, ...cleanupErrors],
      `Smoke test failed: ${testError.message}; cleanup failed: ${cleanupErrors.map(error => error.message).join('; ')}`
    );
  }
  if (testError) throw testError;
  if (cleanupErrors.length) {
    throw new AggregateError(cleanupErrors, `Smoke test cleanup failed: ${cleanupErrors.map(error => error.message).join('; ')}`);
  }
}

run().catch(error => {
  console.error('Smoke test failed:', error.response ? `${error.response.status} ${JSON.stringify(error.response.data)}` : error.message);
  process.exitCode = 1;
});
