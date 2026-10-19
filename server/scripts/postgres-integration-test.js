const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { once } = require('node:events');
const net = require('node:net');
const { createInterface } = require('node:readline/promises');

const APPLICATION_TABLES = [
  'products',
  'reservations',
  'tables',
  'table_sessions',
  'orders',
  'loyalty',
  'loyalty_accounts'
];
const PRODUCTION_ENDPOINT_UNAVAILABLE_CONFIRMATION = 'site-not-deployed-no-production-postgres';
const INTEGRATION_SCHEMA_PREFIX = 'wassa_integration_test_';
const INTEGRATION_SCHEMA_PATTERN = /^wassa_integration_test_[a-f0-9]{32}$/;
const RUN_ENVIRONMENT_KEYS = [
  'DATABASE_URL',
  'PGSSLMODE',
  'NODE_ENV',
  'WASSA_PG_INTEGRATION_MODE',
  'WASSA_PG_INTEGRATION_SCHEMA',
  'WASSA_PG_INTEGRATION_HOST',
  'PORT',
  'WASSA_SMOKE_TEST',
  'ADMIN_TOKEN',
  'WONGO_ADMIN_TOKEN',
  'WASSA_PG_TEST_DATABASE_URL',
  'WASSA_PG_TEST_ALLOWED_ENDPOINT',
  'WASSA_PG_PRODUCTION_ENDPOINT',
  'WASSA_PG_PRODUCTION_ENDPOINT_UNAVAILABLE',
  'WASSA_PG_TEST_CONFIRM'
];
const SENSITIVE_ENVIRONMENT_KEYS = [
  'WASSA_PG_TEST_DATABASE_URL',
  'WASSA_PG_TEST_ALLOWED_ENDPOINT',
  'WASSA_PG_PRODUCTION_ENDPOINT',
  'DATABASE_URL',
  'TEST_DATABASE_URL',
  'ADMIN_TOKEN',
  'WONGO_ADMIN_TOKEN',
  'GEMINI_API_KEY'
];
let activeStage = 'validation de la cible';

function getSensitiveValues(extraValues = []) {
  const values = [...extraValues];
  for (const key of SENSITIVE_ENVIRONMENT_KEYS) {
    if (process.env[key]) values.push(process.env[key]);
  }

  for (const value of [...values]) {
    if (typeof value !== 'string') continue;
    try {
      const parsed = new URL(value);
      for (const component of [parsed.username, parsed.password]) {
        if (!component) continue;
        values.push(component);
        try {
          values.push(decodeURIComponent(component));
        } catch {
          // The encoded credential is still redacted below.
        }
      }
    } catch {
      // Non-URL values are redacted verbatim below.
    }
  }

  return [...new Set(values.filter(value => typeof value === 'string' && value.length > 0))]
    .sort((left, right) => right.length - left.length);
}

function sanitizeDiagnosticMessage(error, extraSensitiveValues = []) {
  let message = error && typeof error.message === 'string'
    ? error.message
    : 'Unknown error';

  message = message
    .replace(/(?:postgres(?:ql)?|https?):\/\/[^\s"'<>]+/gi, '[URL redacted]')
    .replace(/\b(password|passwd|pwd|token|secret|api[_-]?key|authorization|database_url|connectionstring)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[redacted]')
    .replace(/\b(?:WASSA-[a-f0-9]+|it-[a-f0-9]+|it_[a-f0-9]+)\b/gi, '[identifier redacted]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[identifier redacted]');

  for (const value of getSensitiveValues(extraSensitiveValues)) {
    message = message.split(value).join('[redacted]');
    try {
      const encoded = encodeURIComponent(value);
      if (encoded !== value) message = message.split(encoded).join('[redacted]');
    } catch {
      // Keep the diagnostic usable even if an environment value is malformed Unicode.
    }
  }

  return message.replace(/[\r\n\t]+/g, ' ').slice(0, 500);
}

function formatSafeDiagnostic(error, stage = activeStage, extraSensitiveValues = []) {
  const code = error && typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)
    ? ` Code PostgreSQL : ${error.code}.`
    : '';
  return `Étape : ${stage}. Erreur : ${sanitizeDiagnosticMessage(error, extraSensitiveValues)}.${code}`;
}

function reportSafeDiagnostic(label, error, stage = activeStage, extraSensitiveValues = []) {
  console.error(`${label} ${formatSafeDiagnostic(error, stage, extraSensitiveValues)}`);
}

function parseRenderEndpoint(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('A Render PostgreSQL endpoint in host:port form is required.');
  }

  const endpoint = value.trim();
  if (/[/?#@\\\s]/.test(endpoint)) {
    throw new Error('The authorized endpoint must contain only a Render hostname and explicit port.');
  }

  let parsed;
  try {
    parsed = new URL(`postgres://${endpoint}/`);
  } catch {
    throw new Error('The authorized Render endpoint is malformed.');
  }

  if (parsed.username || parsed.password || parsed.pathname !== '/' ||
      parsed.search || parsed.hash || !parsed.port ||
      net.isIP(parsed.hostname) ||
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+render\.com$/i.test(parsed.hostname)) {
    throw new Error('The authorized endpoint must be a Render DNS hostname with an explicit port.');
  }

  return parsed.host.toLowerCase();
}

function readTestTarget(environment = process.env) {
  if (environment.NODE_ENV === 'production') {
    throw new Error('Refusing to run PostgreSQL integration tests in a production environment.');
  }
  const connectionString = environment.WASSA_PG_TEST_DATABASE_URL;
  const allowedEndpoint = parseRenderEndpoint(environment.WASSA_PG_TEST_ALLOWED_ENDPOINT);
  const configuredProductionEndpoint = environment.WASSA_PG_PRODUCTION_ENDPOINT;
  const productionUnavailableConfirmation = environment.WASSA_PG_PRODUCTION_ENDPOINT_UNAVAILABLE;
  let productionEndpoint = null;

  if (typeof configuredProductionEndpoint === 'string' && configuredProductionEndpoint.trim()) {
    if (productionUnavailableConfirmation) {
      throw new Error('Production endpoint and its unavailability confirmation cannot both be configured.');
    }
    productionEndpoint = parseRenderEndpoint(configuredProductionEndpoint);
  } else if (productionUnavailableConfirmation !== PRODUCTION_ENDPOINT_UNAVAILABLE_CONFIRMATION) {
    throw new Error('Set the production endpoint or explicitly confirm that no production PostgreSQL endpoint exists.');
  }

  if (environment.WASSA_PG_TEST_CONFIRM !== 'lewassa-is-not-production') {
    throw new Error('Explicit confirmation for the non-production lewassa test database is required.');
  }
  const ambiguousConnectionKeys = [
    'DATABASE_URL',
    'TEST_DATABASE_URL',
    'PGHOST',
    'PGPORT',
    'PGDATABASE',
    'PGSERVICE',
    'PGSERVICEFILE',
    'PGOPTIONS'
  ];
  if (ambiguousConnectionKeys.some(key => environment[key])) {
    throw new Error('Unset ambiguous database connection configuration before running PostgreSQL integration tests.');
  }
  if (!connectionString) {
    throw new Error('WASSA_PG_TEST_DATABASE_URL is required.');
  }

  let target;
  try {
    target = new URL(connectionString);
  } catch {
    throw new Error('The dedicated PostgreSQL test connection is malformed.');
  }

  const sslModes = target.searchParams.getAll('sslmode');
  const queryIsAllowed = [...target.searchParams.keys()].every(key => key === 'sslmode') &&
    sslModes.length === 1 && sslModes[0] === 'require';
  const host = `${target.hostname.toLowerCase()}:${target.port || '5432'}`;

  if (!['postgres:', 'postgresql:'].includes(target.protocol) ||
      host !== allowedEndpoint ||
      host === productionEndpoint ||
      !target.username ||
      !target.password ||
      target.pathname !== '/lewassa' ||
      target.hash ||
      !queryIsAllowed ||
      net.isIP(target.hostname) ||
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+render\.com$/i.test(target.hostname)) {
    throw new Error('Refusing to connect: target is not the explicitly authorized Render lewassa test endpoint.');
  }

  target.searchParams.delete('sslmode');
  return {
    connectionString: target.toString(),
    endpoint: host,
    hostname: target.hostname.toLowerCase()
  };
}

async function confirmTestTarget(target, ask) {
  if (typeof ask !== 'function') {
    throw new Error('An explicit interactive confirmation is required before connecting.');
  }
  const confirmation = await ask(target.endpoint);
  if (confirmation !== 'I VERIFIED lewassa IS NOT PRODUCTION') {
    throw new Error('PostgreSQL test target was not explicitly confirmed.');
  }
}

function validateIntegrationSchemaName(schemaName) {
  if (typeof schemaName !== 'string' || !INTEGRATION_SCHEMA_PATTERN.test(schemaName) ||
      schemaName === 'public') {
    throw new Error('Refusing an invalid or public PostgreSQL integration schema.');
  }
}

function createIntegrationClientOptions(target, schemaName, bootstrap = false) {
  validateIntegrationSchemaName(schemaName);
  return {
    connectionString: target.connectionString,
    ssl: { rejectUnauthorized: true, servername: target.hostname },
    options: `-c search_path=${bootstrap ? 'pg_catalog' : schemaName}`,
    connectionTimeoutMillis: 10000,
    application_name: 'wassa-postgres-integration-test'
  };
}

async function verifyAndCreateIntegrationSchema(target, schemaName, ClientClass) {
  validateIntegrationSchemaName(schemaName);
  const client = new ClientClass(createIntegrationClientOptions(target, schemaName, true));
  let connected = false;
  let transactionStarted = false;
  let firstError = null;

  try {
    await client.connect();
    connected = true;
    await client.query('BEGIN READ ONLY');
    transactionStarted = true;
    const result = await client.query(
      `SELECT current_database() AS database_name,
              to_regnamespace($1) IS NOT NULL AS schema_exists`,
      [schemaName]
    );
    assert.equal(result.rows[0].database_name, 'lewassa', 'Connected database must be lewassa');
    assert.equal(result.rows[0].schema_exists, false, 'Integration schema must not already exist');
  } catch (error) {
    firstError = error;
  } finally {
    if (connected && transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (error) {
        firstError = firstError || error;
      }
    }
    if (connected) {
      try {
        await client.end();
      } catch (error) {
        firstError = firstError || error;
      }
    }
  }
  if (firstError) throw firstError;

  const createClient = new ClientClass(createIntegrationClientOptions(target, schemaName, true));
  let createConnected = false;
  try {
    await createClient.connect();
    createConnected = true;
    await createClient.query(`CREATE SCHEMA "${schemaName}"`);
  } finally {
    if (createConnected) await createClient.end();
  }
}

async function verifyCurrentIntegrationSchema(client, schemaName) {
  validateIntegrationSchemaName(schemaName);
  const result = await client.query(
    'SELECT current_database() AS database_name, current_schema() AS schema_name'
  );
  assert.equal(result.rows[0].database_name, 'lewassa', 'Connected database must be lewassa');
  assert.equal(result.rows[0].schema_name, schemaName, 'Connection must use the dedicated integration schema');
}

async function verifyEmptyApplicationTables(client, schemaName) {
  validateIntegrationSchemaName(schemaName);
  const database = await client.query(
    'SELECT current_database() AS name, current_schema() AS schema'
  );
  assert.equal(database.rows[0].name, 'lewassa', 'Connected database must be lewassa');
  assert.equal(database.rows[0].schema, schemaName, 'Integration tests require the dedicated schema');

  const existingTables = await client.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = $1
       AND table_name = ANY($2::text[])`,
    [schemaName, APPLICATION_TABLES]
  );

  for (const { table_name: tableName } of existingTables.rows) {
    const exists = await client.query(`SELECT EXISTS (SELECT 1 FROM "${tableName}" LIMIT 1) AS has_rows`);
    if (exists.rows[0].has_rows) {
      throw new Error(`Refusing to test: existing application table "${tableName}" is not empty.`);
    }
  }
}

function expectOwnedRow(row, expected, entityName) {
  if (!row) {
    throw new Error(`Refusing cleanup: ownership of the ${entityName} row could not be confirmed (row not found).`);
  }

  const mismatchedField = Object.entries(expected).find(([key, value]) => {
    if (key === 'date' || key === 'createdAt' || key === 'expiresAt') {
      const rowTime = row[key] instanceof Date
        ? row[key].getTime()
        : typeof row[key] === 'string' ? Date.parse(row[key]) : Number.NaN;
      const expectedTime = value instanceof Date
        ? value.getTime()
        : typeof value === 'string' ? Date.parse(value) : Number.NaN;
      return !Number.isFinite(rowTime) || !Number.isFinite(expectedTime) || rowTime !== expectedTime;
    }
    if (key === 'items') {
      return JSON.stringify(stableValue(row[key])) !== JSON.stringify(stableValue(value));
    }
    return row[key] !== value;
  });
  if (mismatchedField) {
    throw new Error(
      `Refusing cleanup: ownership of the ${entityName} row could not be confirmed (field "${mismatchedField[0]}" differs).`
    );
  }
}

function stableValue(value) {
  if (value === undefined) return { type: 'undefined' };
  if (value instanceof Date) {
    return { type: 'date', value: Number.isFinite(value.getTime()) ? value.toISOString() : 'invalid' };
  }
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, stableValue(value[key])])
    );
  }
  return value;
}

function snapshotOrders(orders) {
  const normalized = orders.map(stableValue);
  normalized.sort((left, right) =>
    String(left.id).localeCompare(String(right.id)) ||
    JSON.stringify(left).localeCompare(JSON.stringify(right))
  );
  return JSON.stringify(normalized);
}

async function selectOwnedRow(client, sql, params, expected, entityName) {
  const result = await client.query(sql, params);
  if (!result.rows[0]) {
    throw new Error(
      `Refusing cleanup: ownership of the ${entityName} row could not be confirmed (row not found).`
    );
  }
  expectOwnedRow(result.rows[0], expected, entityName);
  return result.rows[0];
}

async function deleteOwnedRows(client, ownedRows) {
  await client.query('BEGIN');
  try {
    const additionalTables = [];
    for (const expectedTable of ownedRows.additionalTables || []) {
      const table = await selectOwnedRow(
        client,
        'SELECT id, label, status FROM tables WHERE id = $1 FOR UPDATE',
        [expectedTable.id],
        expectedTable,
        'additional test table'
      );
      if (table) additionalTables.push({ row: table, expected: expectedTable });
    }

    const table = ownedRows.table && await selectOwnedRow(
      client,
      'SELECT id, label, status FROM tables WHERE id = $1 FOR UPDATE',
      [ownedRows.table.id],
      ownedRows.table,
      'test table'
    );
    const product = ownedRows.product && await selectOwnedRow(
      client,
      'SELECT id, name, category, price, badge, description, image, available FROM products WHERE id = $1 FOR UPDATE',
      [ownedRows.product.id],
      ownedRows.product,
      'test product'
    );
    const session = ownedRows.session && await selectOwnedRow(
      client,
      `SELECT id, table_id AS "tableId", created_at AS "createdAt", expires_at AS "expiresAt"
       FROM table_sessions WHERE id = $1 FOR UPDATE`,
      [ownedRows.session.id],
      ownedRows.session,
      'test session'
    );
    const additionalSessions = [];
    for (const expectedSession of ownedRows.additionalSessions || []) {
      const session = await selectOwnedRow(
        client,
        `SELECT id, table_id AS "tableId", created_at AS "createdAt", expires_at AS "expiresAt"
         FROM table_sessions WHERE id = $1 FOR UPDATE`,
        [expectedSession.id],
        expectedSession,
        'additional test session'
      );
      if (session) additionalSessions.push({ row: session, expected: expectedSession });
    }

    const order = ownedRows.order && await selectOwnedRow(
      client,
      `SELECT id, table_id AS "tableId", session_id AS "sessionId",
              customer_name AS "customerName", customer_phone AS "customerPhone",
              note, idempotency_key AS "idempotencyKey",
              request_fingerprint AS "requestFingerprint", status,
              points_awarded AS "pointsAwarded",
              payment_method AS "paymentMethod",
              payment_status AS "paymentStatus",
              total, items
       FROM orders WHERE idempotency_key = $1 FOR UPDATE`,
      [ownedRows.order.idempotencyKey],
      ownedRows.order,
      'test order'
    );
    const reservation = ownedRows.reservation && await selectOwnedRow(
      client,
      `SELECT id::text AS id, name, date, party, note, phone, email, event
       FROM reservations WHERE id = $1 FOR UPDATE`,
      [String(ownedRows.reservation.id)],
      { ...ownedRows.reservation, id: String(ownedRows.reservation.id) },
      'test reservation'
    );

    let loyalty = null;
    if (ownedRows.loyalty) {
      loyalty = await selectOwnedRow(
        client,
        'SELECT customer_key AS "customerKey", points FROM loyalty_accounts WHERE customer_key = $1 FOR UPDATE',
        [ownedRows.loyalty.customerKey],
        ownedRows.loyalty,
        'test loyalty account'
      );
      if (loyalty && ownedRows.loyalty.points > 0 &&
          (!order || order.pointsAwarded !== ownedRows.loyalty.points ||
           order.customerPhone !== ownedRows.order.customerPhone ||
           order.status !== 'COMPLETED')) {
        throw new Error('Refusing cleanup: the test loyalty account is not exclusively supported by its completed test order.');
      }
    }

    const removals = [
      [loyalty, 'DELETE FROM loyalty_accounts WHERE customer_key = $1 AND points = $2', ownedRows.loyalty && [ownedRows.loyalty.customerKey, ownedRows.loyalty.points]],
      [order, `DELETE FROM orders
               WHERE id = $1 AND idempotency_key = $2 AND request_fingerprint = $3
                 AND payment_method = $4 AND payment_status = $5`,
        ownedRows.order && [
          ownedRows.order.id,
          ownedRows.order.idempotencyKey,
          ownedRows.order.requestFingerprint,
          ownedRows.order.paymentMethod,
          ownedRows.order.paymentStatus
        ]],
      [reservation, 'DELETE FROM reservations WHERE id = $1 AND name = $2 AND phone = $3', ownedRows.reservation && [ownedRows.reservation.id, ownedRows.reservation.name, ownedRows.reservation.phone]],
      [session, 'DELETE FROM table_sessions WHERE id = $1 AND table_id = $2', ownedRows.session && [ownedRows.session.id, ownedRows.session.tableId]],
      [product, 'DELETE FROM products WHERE id = $1 AND name = $2 AND category = $3 AND price = $4', ownedRows.product && [ownedRows.product.id, ownedRows.product.name, ownedRows.product.category, ownedRows.product.price]],
      ...additionalSessions.map(({ row, expected }) => [
        row,
        'DELETE FROM table_sessions WHERE id = $1 AND table_id = $2',
        [expected.id, expected.tableId]
      ]),
      ...additionalTables.map(({ row, expected }) => [
        row,
        'DELETE FROM tables WHERE id = $1 AND label = $2 AND status = $3',
        [expected.id, expected.label, expected.status]
      ]),
      [table, 'DELETE FROM tables WHERE id = $1 AND label = $2 AND status = $3', ownedRows.table && [ownedRows.table.id, ownedRows.table.label, ownedRows.table.status]]
    ];
    for (const [row, sql, params] of removals) {
      if (!row) continue;
      const result = await client.query(sql, params);
      if (result.rowCount !== 1) {
        throw new Error('Refusing cleanup: a confirmed test row changed before deletion.');
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      reportSafeDiagnostic(
        'Integration-data cleanup rollback failed.',
        rollbackError,
        'nettoyage des données de test',
        Object.values(ownedRows).flatMap(row =>
          Array.isArray(row)
            ? row.flatMap(item => Object.values(item))
            : Object.values(row)
        )
      );
    }
    throw error;
  }
}

function trackPendingWrite(pendingWrites, unresolvedWrites, label, recover) {
  const pending = { label, recover, settle: null };
  const settle = () => {
    const pendingIndex = pendingWrites.indexOf(pending);
    if (pendingIndex !== -1) pendingWrites.splice(pendingIndex, 1);
    const unresolvedIndex = unresolvedWrites.indexOf(label);
    if (unresolvedIndex !== -1) unresolvedWrites.splice(unresolvedIndex, 1);
  };
  pending.settle = settle;
  pendingWrites.push(pending);
  unresolvedWrites.push(label);
  return settle;
}

async function recoverPendingWrites(client, pendingWrites) {
  for (const pending of [...pendingWrites]) {
    await pending.recover(client);
    pending.settle();
  }
}

async function insertOwnedAdditionalRow(
  client,
  unresolvedWrites,
  label,
  collection,
  sql,
  params,
  expected,
  entityName,
  pendingWrites = []
) {
  const recoverySql = entityName === 'table session'
    ? `SELECT id, table_id AS "tableId", created_at AS "createdAt", expires_at AS "expiresAt"
       FROM table_sessions WHERE id = $1`
    : 'SELECT id, label, status FROM tables WHERE id = $1';
  const clearPending = trackPendingWrite(
    pendingWrites,
    unresolvedWrites,
    label,
    async recoveryClient => {
      const result = await recoveryClient.query(recoverySql, [expected.id]);
      if (!result.rows[0]) return;
      expectOwnedRow(result.rows[0], expected, `recovered ${entityName}`);
      collection.push(expected);
    }
  );
  const result = await client.query(sql, params);
  if (!result.rows[0]) {
    clearPending();
    throw new Error(`Refusing test setup: the generated ${entityName} identifier already exists.`);
  }
  expectOwnedRow(result.rows[0], expected, `new ${entityName}`);
  collection.push(expected);
  clearPending();
}

async function closeServer(server) {
  if (!server || !server.listening) return;
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

async function promptForTarget(endpoint) {
  if (!process.stdin.isTTY) {
    throw new Error('Run the integration test from an interactive terminal to confirm its database target.');
  }
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await terminal.question(
      `Verify independently in Render that ${endpoint} is the empty test database lewassa, not production. Type "I VERIFIED lewassa IS NOT PRODUCTION" to continue: `
    )).trim();
  } finally {
    terminal.close();
  }
}

async function seedOwnedReferenceRows(client, testData, ownedRows, unresolvedWrites, pendingWrites = []) {
  const table = {
    id: testData.tableId,
    label: `Test ${testData.runId}`,
    status: 'available'
  };
  const clearTablePending = trackPendingWrite(
    pendingWrites,
    unresolvedWrites,
    'table',
    async recoveryClient => {
      const result = await recoveryClient.query(
        'SELECT id, label, status FROM tables WHERE id = $1',
        [table.id]
      );
      if (!result.rows[0]) return;
      expectOwnedRow(result.rows[0], table, 'recovered test table');
      ownedRows.table = table;
    }
  );
  const insertedTable = await client.query(
    `INSERT INTO tables (id, label, status)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING
     RETURNING id, label, status`,
    [table.id, table.label, table.status]
  );
  if (!insertedTable.rows[0]) {
    clearTablePending();
    throw new Error('Refusing test setup: the generated test table identifier already exists.');
  }
  expectOwnedRow(insertedTable.rows[0], table, 'new test table');
  ownedRows.table = table;
  clearTablePending();

  const product = {
    id: testData.productId,
    name: `Test product ${testData.runId}`,
    category: 'Integration test',
    price: 1234,
    badge: 'Test',
    description: `Temporary integration-test product ${testData.runId}`,
    image: 'images/grillade.png',
    available: true
  };
  const clearProductPending = trackPendingWrite(
    pendingWrites,
    unresolvedWrites,
    'product',
    async recoveryClient => {
      const result = await recoveryClient.query(
        `SELECT id, name, category, price, badge, description, image, available
         FROM products WHERE id = $1`,
        [product.id]
      );
      if (!result.rows[0]) return;
      expectOwnedRow(result.rows[0], product, 'recovered test product');
      ownedRows.product = product;
    }
  );
  const insertedProduct = await client.query(
    `INSERT INTO products (id, name, category, price, badge, description, image, available)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO NOTHING
     RETURNING id, name, category, price, badge, description, image, available`,
    [
      product.id,
      product.name,
      product.category,
      product.price,
      product.badge,
      product.description,
      product.image,
      product.available
    ]
  );
  if (!insertedProduct.rows[0]) {
    clearProductPending();
    throw new Error('Refusing test setup: the generated test product identifier already exists.');
  }
  expectOwnedRow(insertedProduct.rows[0], product, 'new test product');
  ownedRows.product = product;
  clearProductPending();

  const loyalty = { customerKey: testData.customerKey, points: 0 };
  const clearLoyaltyPending = trackPendingWrite(
    pendingWrites,
    unresolvedWrites,
    'loyalty account',
    async recoveryClient => {
      const result = await recoveryClient.query(
        'SELECT customer_key AS "customerKey", points FROM loyalty_accounts WHERE customer_key = $1',
        [loyalty.customerKey]
      );
      if (!result.rows[0]) return;
      expectOwnedRow(result.rows[0], loyalty, 'recovered test loyalty account');
      ownedRows.loyalty = loyalty;
    }
  );
  const insertedLoyalty = await client.query(
    `INSERT INTO loyalty_accounts (customer_key, points)
     VALUES ($1, 0)
     ON CONFLICT (customer_key) DO NOTHING
     RETURNING customer_key AS "customerKey", points`,
    [testData.customerKey]
  );
  if (!insertedLoyalty.rows[0]) {
    clearLoyaltyPending();
    throw new Error('Refusing test setup: the generated test loyalty account already exists.');
  }
  expectOwnedRow(insertedLoyalty.rows[0], loyalty, 'new test loyalty account');
  ownedRows.loyalty = loyalty;
  clearLoyaltyPending();
}

async function createThroughApi(unresolvedWrites, label, request, recordOwnership, options = {}) {
  const clearPending = options.pendingWrites && options.recoverOwnership
    ? trackPendingWrite(options.pendingWrites, unresolvedWrites, label, options.recoverOwnership)
    : null;
  if (!clearPending) unresolvedWrites.push(label);
  try {
    const response = await request();
    if (response.status !== 201) {
      throw new Error(`The ${label} creation was not confirmed.`);
    }
    recordOwnership(response);
    if (clearPending) clearPending();
    else unresolvedWrites.splice(unresolvedWrites.indexOf(label), 1);
    return response;
  } catch (error) {
    if (error.response && error.response.status >= 400 && error.response.status < 500) {
      if (clearPending) clearPending();
      else unresolvedWrites.splice(unresolvedWrites.indexOf(label), 1);
    }
    throw error;
  }
}

async function withEnvironmentRestored(operation, environment = process.env) {
  const initialEnvironment = new Map(
    RUN_ENVIRONMENT_KEYS.map(key => [key, environment[key]])
  );
  let result;
  let operationError;
  let operationFailed = false;

  try {
    result = await operation();
  } catch (error) {
    operationError = error;
    operationFailed = true;
  }

  const restorationErrors = [];
  for (const [key, value] of initialEnvironment) {
    try {
      if (value === undefined) delete environment[key];
      else environment[key] = value;
    } catch {
      restorationErrors.push(key);
    }
  }

  if (restorationErrors.length) {
    try {
      console.error(
        `PostgreSQL integration environment restoration failed for: ${restorationErrors.join(', ')}.`
      );
    } catch {
      // Do not mask the run failure if reporting the restoration issue also fails.
    }
  }
  if (operationFailed) throw operationError;
  if (restorationErrors.length) {
    throw new Error('PostgreSQL integration environment restoration failed.');
  }
  return result;
}

async function runIntegrationTest() {
  activeStage = 'validation de la cible';
  const target = readTestTarget();
  activeStage = 'confirmation interactive';
  await confirmTestTarget(target, promptForTarget);
  const runId = crypto.randomBytes(16).toString('hex');
  const schemaName = `${INTEGRATION_SCHEMA_PREFIX}${runId}`;
  validateIntegrationSchemaName(schemaName);

  const { Client } = require('pg');
  let schemaCreated = false;
  let db;
  let server;
  let verificationClient;
  let testError;
  const cleanupErrors = [];
  const ownedRows = {};
  const unresolvedWrites = [];
  const pendingWrites = [];

  const testData = {
    runId,
    productId: `it-${runId}`,
    tableId: `it_${runId.slice(0, 17)}`,
    customerName: `PostgreSQL integration ${runId}`,
    phone: `+226${String(crypto.randomInt(0, 100000000)).padStart(8, '0')}`,
    sessionId: crypto.randomBytes(16).toString('hex'),
    reservationId: Date.now() * 1000 + crypto.randomInt(0, 1000),
    customerKey: ''
  };
  testData.customerKey = crypto.createHash('sha256').update(testData.phone).digest('hex');
  let alternateTable;
  let maintenanceTable;
  let expiredSession;
  let otherTableSession;
  const generatedSensitiveValues = () => [
    ...Object.values(testData),
    ...Object.values(ownedRows).flatMap(row =>
      Array.isArray(row)
        ? row.flatMap(item => Object.values(item))
        : Object.values(row)
    )
  ];

  try {
    activeStage = 'précontrôle de création du schéma isolé';
    await verifyAndCreateIntegrationSchema(target, schemaName, Client);
    schemaCreated = true;

    process.env.DATABASE_URL = target.connectionString;
    process.env.PGSSLMODE = 'require';
    process.env.NODE_ENV = 'test';
    process.env.WASSA_PG_INTEGRATION_MODE = '1';
    process.env.WASSA_PG_INTEGRATION_SCHEMA = schemaName;
    process.env.WASSA_PG_INTEGRATION_HOST = target.hostname;
    process.env.PORT = '0';
    process.env.WASSA_SMOKE_TEST = '1';
    process.env.ADMIN_TOKEN = crypto.randomBytes(32).toString('hex');
    process.env.WONGO_ADMIN_TOKEN = '';

    let preflightConnected = false;
    let preflightTransactionStarted = false;
    const preflight = new Client(createIntegrationClientOptions(target, schemaName));
    try {
      activeStage = 'précontrôle des tables isolées';
      await preflight.connect();
      preflightConnected = true;
      await verifyCurrentIntegrationSchema(preflight, schemaName);
      await preflight.query('BEGIN READ ONLY');
      preflightTransactionStarted = true;
      await verifyEmptyApplicationTables(preflight, schemaName);
      await preflight.query('ROLLBACK');
      preflightTransactionStarted = false;
    } finally {
      if (preflightConnected) {
        try {
          if (preflightTransactionStarted) await preflight.query('ROLLBACK');
        } finally {
          await preflight.end();
        }
      }
    }

    activeStage = 'initialisation du schéma isolé';
    db = require('../db/postgres');
    await db.ensureDatabase();

    const setup = new Client(createIntegrationClientOptions(target, schemaName));
    try {
      activeStage = 'connexion PostgreSQL pour les données de test';
      await setup.connect();
      await verifyCurrentIntegrationSchema(setup, schemaName);
      activeStage = 'tests d’intégration';
      await seedOwnedReferenceRows(setup, testData, ownedRows, unresolvedWrites, pendingWrites);

      alternateTable = {
        id: `it_${runId.slice(0, 12)}_a`,
        label: `Alternate test table ${runId}`,
        status: 'available'
      };
      maintenanceTable = {
        id: `it_${runId.slice(0, 12)}_m`,
        label: `Maintenance test table ${runId}`,
        status: 'maintenance'
      };
      ownedRows.additionalTables = [];
      ownedRows.additionalSessions = [];
      for (const [label, table] of [
        ['alternate test table', alternateTable],
        ['maintenance test table', maintenanceTable]
      ]) {
        await insertOwnedAdditionalRow(
          setup,
          unresolvedWrites,
          label,
          ownedRows.additionalTables,
          `INSERT INTO tables (id, label, status)
           VALUES ($1, $2, $3)
           ON CONFLICT (id) DO NOTHING
           RETURNING id, label, status`,
          [table.id, table.label, table.status],
          table,
          'test table',
          pendingWrites
        );
      }

      const now = Date.now();
      expiredSession = {
        id: crypto.randomBytes(16).toString('hex'),
        tableId: testData.tableId,
        createdAt: new Date(now - 13 * 60 * 60 * 1000).toISOString(),
        expiresAt: new Date(now - 60 * 60 * 1000).toISOString()
      };
      otherTableSession = {
        id: crypto.randomBytes(16).toString('hex'),
        tableId: alternateTable.id,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60 * 60 * 1000).toISOString()
      };
      for (const [label, session] of [
        ['expired test session', expiredSession],
        ['alternate-table test session', otherTableSession]
      ]) {
        await insertOwnedAdditionalRow(
          setup,
          unresolvedWrites,
          label,
          ownedRows.additionalSessions,
          `INSERT INTO table_sessions (id, table_id, created_at, expires_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (id) DO NOTHING
           RETURNING id, table_id AS "tableId", created_at AS "createdAt", expires_at AS "expiresAt"`,
          [session.id, session.tableId, session.createdAt, session.expiresAt],
          session,
          'table session',
          pendingWrites
        );
      }
    } finally {
      await setup.end();
    }

    const { app } = require('../index');
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    verificationClient = new Client(createIntegrationClientOptions(target, schemaName));
    await verificationClient.connect();
    await verifyCurrentIntegrationSchema(verificationClient, schemaName);
    const baseURL = `http://127.0.0.1:${server.address().port}`;
    const axios = require('axios');
    const api = axios.create({ baseURL, proxy: false, maxRedirects: 0, timeout: 10000 });
    const admin = axios.create({
      baseURL,
      proxy: false,
      maxRedirects: 0,
      timeout: 10000,
      headers: { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` }
    });

    const health = await api.get('/api/health');
    assert.equal(health.data.data.database, 'postgresql');

    const menu = await api.get('/api/menu');
    assert.ok(menu.data.data.some(product => product.id === testData.productId));

    const sessionExpectedExpiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    const sessionRequestStartedAt = Date.now();
    const sessionResponse = await createThroughApi(
      unresolvedWrites,
      'session',
      () => api.post('/api/table-sessions', {
        tableId: testData.tableId,
        id: testData.sessionId,
        expiresAt: sessionExpectedExpiresAt
      }),
      response => {
        const createdSession = response.data.data;
        ownedRows.session = {
          id: createdSession.id,
          tableId: createdSession.tableId,
          createdAt: createdSession.createdAt,
          expiresAt: createdSession.expiresAt
        };
      },
      {
        pendingWrites,
        recoverOwnership: async recoveryClient => {
          const result = await recoveryClient.query(
            `SELECT id, table_id AS "tableId", created_at AS "createdAt",
                    expires_at AS "expiresAt"
             FROM table_sessions WHERE id = $1`,
            [testData.sessionId]
          );
          if (!result.rows[0]) return;
          const row = result.rows[0];
          expectOwnedRow(row, {
            id: testData.sessionId,
            tableId: testData.tableId,
            expiresAt: sessionExpectedExpiresAt
          }, 'recovered test session');
          const createdAt = row.createdAt instanceof Date
            ? row.createdAt.getTime()
            : Date.parse(row.createdAt);
          if (!Number.isFinite(createdAt) || createdAt < sessionRequestStartedAt - 1000 ||
              createdAt > Date.now() + 1000) {
            throw new Error('Refusing cleanup: the recovered test session creation time is outside the request window.');
          }
          ownedRows.session = {
            id: row.id,
            tableId: row.tableId,
            createdAt: row.createdAt,
            expiresAt: row.expiresAt
          };
        }
      }
    );
    const session = sessionResponse.data.data;
    assert.equal(session.tableId, testData.tableId);
    assert.ok(Number.isFinite(Date.parse(session.createdAt)));
    assert.ok(Number.isFinite(Date.parse(session.expiresAt)));

    const orderPayload = {
      tableId: testData.tableId,
      sessionId: session.id,
      customerName: testData.customerName,
      customerPhone: testData.phone,
      note: 'Integration test',
      paymentMethod: 'pay_on_site',
      items: [{ productId: testData.productId, quantity: 2, unitPrice: 1, totalPrice: 2 }]
    };
    const orderIdempotencyKey = crypto.randomUUID();
    const expectedOrderFingerprint = crypto.createHash('sha256').update(JSON.stringify({
      tableId: orderPayload.tableId,
      sessionId: orderPayload.sessionId,
      customerName: orderPayload.customerName,
      customerPhone: orderPayload.customerPhone,
      note: orderPayload.note,
      paymentMethod: orderPayload.paymentMethod,
      items: [[testData.productId, 2]]
    })).digest('hex');
    const expectedOrderItems = [{
      productId: testData.productId,
      productName: `Test product ${runId}`,
      quantity: 2,
      unitPrice: 1234,
      totalPrice: 2468
    }];
    const assertRejectedOrderWasNotPersisted = async (label, payload, expectedStatus) => {
      const idempotencyKey = crypto.randomUUID();
      const previousOrders = snapshotOrders(await db.listOrders());
      await assert.rejects(
        createThroughApi(
          unresolvedWrites,
          label,
          () => api.post('/api/orders', payload, { headers: { 'Idempotency-Key': idempotencyKey } }),
          () => assert.fail('A rejected order cannot establish ownership')
        ),
        error => error.response && error.response.status === expectedStatus
      );
      const rejectedOrder = await verificationClient.query(
        'SELECT id FROM orders WHERE idempotency_key = $1',
        [idempotencyKey]
      );
      assert.equal(rejectedOrder.rowCount, 0);
      if (snapshotOrders(await db.listOrders()) !== previousOrders) {
        throw new Error('A rejected order request mutated stored orders.');
      }
    };

    const missingTableId = `it_${runId.slice(0, 12)}_x`;
    const missingTableCheck = await verificationClient.query(
      'SELECT EXISTS (SELECT 1 FROM tables WHERE id = $1) AS exists',
      [missingTableId]
    );
    assert.equal(missingTableCheck.rows[0].exists, false);
    await assert.rejects(
      createThroughApi(
        unresolvedWrites,
        'missing-table test session',
        () => api.post('/api/table-sessions', { tableId: missingTableId }),
        () => assert.fail('A rejected session cannot establish ownership')
      ),
      error => error.response && error.response.status === 404
    );
    const missingTableSessionCheck = await verificationClient.query(
      'SELECT COUNT(*)::int AS count FROM table_sessions WHERE table_id = $1',
      [missingTableId]
    );
    assert.equal(missingTableSessionCheck.rows[0].count, 0);

    await assertRejectedOrderWasNotPersisted(
      'missing-table test order',
      { ...orderPayload, tableId: missingTableId },
      404
    );
    await assertRejectedOrderWasNotPersisted(
      'expired-session test order',
      { ...orderPayload, sessionId: expiredSession.id },
      400
    );
    await assertRejectedOrderWasNotPersisted(
      'cross-table-session test order',
      { ...orderPayload, sessionId: otherTableSession.id },
      400
    );

    const maintenanceSessionCountBefore = await verificationClient.query(
      'SELECT COUNT(*)::int AS count FROM table_sessions WHERE table_id = $1',
      [maintenanceTable.id]
    );
    assert.equal(maintenanceSessionCountBefore.rows[0].count, 0);
    await assert.rejects(
      createThroughApi(
        unresolvedWrites,
        'maintenance-table test session',
        () => api.post('/api/table-sessions', { tableId: maintenanceTable.id }),
        () => assert.fail('A rejected session cannot establish ownership')
      ),
      error => error.response && error.response.status === 409
    );
    const maintenanceSessionCountAfter = await verificationClient.query(
      'SELECT COUNT(*)::int AS count FROM table_sessions WHERE table_id = $1',
      [maintenanceTable.id]
    );
    assert.equal(maintenanceSessionCountAfter.rows[0].count, 0);
    await assertRejectedOrderWasNotPersisted(
      'maintenance-table test order',
      { ...orderPayload, tableId: maintenanceTable.id },
      409
    );

    const concurrentIdempotencyKey = orderIdempotencyKey;
    unresolvedWrites.push('order');
    const confirmations = await Promise.allSettled([
      api.post('/api/orders', orderPayload, {
        headers: { 'Idempotency-Key': concurrentIdempotencyKey }
      }),
      api.post('/api/orders', orderPayload, {
        headers: { 'Idempotency-Key': concurrentIdempotencyKey }
      })
    ]);
    const successfulConfirmations = confirmations
      .filter(result => result.status === 'fulfilled')
      .map(result => result.value);
    const created = successfulConfirmations.find(response => response.status === 201);
    if (created) {
      const createdOrder = created.data.data;
      ownedRows.order = {
        id: createdOrder.id,
        tableId: createdOrder.tableId,
        sessionId: createdOrder.sessionId,
        customerName: createdOrder.customerName,
        customerPhone: createdOrder.customerPhone,
        note: createdOrder.note,
        idempotencyKey: createdOrder.idempotencyKey,
        requestFingerprint: createdOrder.requestFingerprint,
        status: createdOrder.status,
        pointsAwarded: createdOrder.pointsAwarded,
        paymentMethod: createdOrder.paymentMethod,
        paymentStatus: createdOrder.paymentStatus,
        total: createdOrder.total,
        items: createdOrder.items
      };
    }
    const uncertainConfirmation = confirmations.some(result =>
      result.status === 'rejected' &&
      (!result.reason.response || result.reason.response.status >= 500)
    );
    if (!uncertainConfirmation) {
      unresolvedWrites.splice(unresolvedWrites.indexOf('order'), 1);
    }
    const replay = successfulConfirmations.find(response => response.status === 200);
    if (confirmations.some(result => result.status === 'rejected')) {
      throw new Error('At least one concurrent order confirmation did not return a response.');
    }
    assert.ok(created, 'Exactly one simultaneous confirmation must create the order');
    assert.ok(replay, 'The other simultaneous confirmation must replay the order');
    const order = created.data.data;
    assert.equal(order.total, 2468, 'Order total must use the server-side product price');
    assert.equal(order.items[0].unitPrice, 1234);
    assert.equal(order.items[0].totalPrice, 2468);
    assert.equal(order.paymentMethod, 'pay_on_site');
    assert.equal(order.paymentStatus, 'PAY_ON_SITE');
    assert.equal(replay.data.data.id, order.id);

    const idempotencyKey = ownedRows.order.idempotencyKey;
    const orderBeforeUnauthorizedUpdates = await db.getOrderByIdempotencyKey(idempotencyKey);
    assert.ok(orderBeforeUnauthorizedUpdates);
    for (const headers of [undefined, { Authorization: 'Bearer invalid-test-token' }]) {
      await assert.rejects(
        api.put(
          `/api/orders/${encodeURIComponent(order.id)}/status`,
          { status: 'CANCELLED' },
          headers ? { headers } : undefined
        ),
        error => error.response && error.response.status === 401
      );
      const orderAfterUnauthorizedUpdate = await db.getOrderByIdempotencyKey(idempotencyKey);
      assert.equal(orderAfterUnauthorizedUpdate.status, orderBeforeUnauthorizedUpdates.status);
      assert.equal(orderAfterUnauthorizedUpdate.pointsAwarded, orderBeforeUnauthorizedUpdates.pointsAwarded);
    }

    const replayResponse = await api.post('/api/orders', orderPayload, {
      headers: { 'Idempotency-Key': idempotencyKey }
    });
    assert.equal(replayResponse.status, 200);
    assert.equal(replayResponse.data.replayed, true);
    await assert.rejects(
      api.post('/api/orders', { ...orderPayload, note: 'Different payload' }, {
        headers: { 'Idempotency-Key': idempotencyKey }
      }),
      error => error.response && error.response.status === 409
    );
    await assert.rejects(
      api.post('/api/orders', {
        ...orderPayload,
        items: [{ productId: testData.productId, quantity: '2' }]
      }, { headers: { 'Idempotency-Key': crypto.randomUUID() } }),
      error => error.response && error.response.status === 400
    );
    await assert.rejects(
      api.post('/api/orders', {
        ...orderPayload,
        items: [{ productId: 'missing-test-product', quantity: 1 }]
      }, { headers: { 'Idempotency-Key': crypto.randomUUID() } }),
      error => error.response && error.response.status === 400
    );

    for (const status of ['CONFIRMED', 'PREPARING', 'READY', 'SERVED']) {
      const updated = await admin.put(`/api/orders/${encodeURIComponent(order.id)}/status`, { status });
      assert.equal(updated.data.data.status, status);
      ownedRows.order.status = status;
    }

    const completions = await Promise.all([
      admin.put(`/api/orders/${encodeURIComponent(order.id)}/status`, { status: 'COMPLETED' }),
      admin.put(`/api/orders/${encodeURIComponent(order.id)}/status`, { status: 'COMPLETED' })
    ]);
    assert.ok(completions.every(response => response.data.data.status === 'COMPLETED'));
    assert.ok(completions.every(response => response.data.data.pointsAwarded === 2));
    ownedRows.order.status = 'COMPLETED';
    ownedRows.order.pointsAwarded = 2;
    ownedRows.loyalty.points = 2;
    const loyalty = await admin.get('/api/loyalty', { params: { phone: testData.phone } });
    assert.equal(loyalty.data.data.points, 2, 'Concurrent completion must award loyalty points once');

    const reservation = await createThroughApi(
      unresolvedWrites,
      'reservation',
      () => api.post('/api/reservations', {
        name: testData.customerName,
        phone: testData.phone,
        date: new Date(Date.now() + 86400000).toISOString(),
        party: 2,
        note: 'PostgreSQL integration test'
      }),
      response => {
        ownedRows.reservation = { ...response.data.data };
      }
    );
    assert.ok((await admin.get('/api/reservations')).data.data.some(
      item => item.id === reservation.data.data.id
    ));

    const paymentOptions = await api.get('/api/payment-options');
    assert.ok(paymentOptions.data.data.some(
      option => option.id === 'pay_on_site' && option.available
    ));
    assert.ok(paymentOptions.data.data.some(
      option => option.id === 'online' && !option.available
    ));

    const rollbackProbeKey = crypto.randomUUID();
    await assert.rejects(
      db.createOrder({
        id: order.id,
        tableId: testData.tableId,
        sessionId: session.id,
        customerName: testData.customerName,
        customerPhone: testData.phone,
        note: 'Rollback probe',
        total: 2468,
        status: 'PENDING',
        paymentMethod: 'pay_on_site',
        paymentStatus: 'PAY_ON_SITE',
        items: order.items,
        idempotencyKey: rollbackProbeKey,
        requestFingerprint: crypto.randomBytes(32).toString('hex')
      }),
      error => error.code === '23505'
    );
    assert.equal(await db.getOrderByIdempotencyKey(rollbackProbeKey), null);
    assert.ok((await db.listOrders()).some(item => item.id === order.id));

    console.log('PostgreSQL integration checks passed for the verified lewassa test database.');
  } catch (error) {
    testError = error;
    reportSafeDiagnostic(
      'PostgreSQL integration test failed.',
      error,
      activeStage,
      [target.connectionString, ...generatedSensitiveValues()]
    );
  }

  activeStage = 'arrêt du serveur de test';
  try {
    await closeServer(server);
  } catch (error) {
    cleanupErrors.push(error);
    reportSafeDiagnostic('PostgreSQL test server shutdown failed.', error, activeStage);
  }

  if (verificationClient) {
    activeStage = 'fermeture de la connexion de vérification';
    try {
      await verificationClient.end();
    } catch (error) {
      cleanupErrors.push(error);
      reportSafeDiagnostic('PostgreSQL verification connection shutdown failed.', error, activeStage);
    }
  }

  if (db) {
    activeStage = 'fermeture du pool PostgreSQL';
    try {
      await db.closeDatabase();
    } catch (error) {
      cleanupErrors.push(error);
      reportSafeDiagnostic('PostgreSQL pool shutdown failed.', error, activeStage);
    }
  }

  if (schemaCreated) {
    activeStage = 'nettoyage des données de test';
    const cleanup = new Client(createIntegrationClientOptions(target, schemaName));
    try {
      await cleanup.connect();
      await verifyCurrentIntegrationSchema(cleanup, schemaName);
      await deleteOwnedRows(cleanup, ownedRows);
    } catch (error) {
      cleanupErrors.push(error);
      reportSafeDiagnostic(
        'PostgreSQL integration cleanup failed.',
        error,
        activeStage,
        generatedSensitiveValues()
      );
    } finally {
      try {
        await cleanup.end();
      } catch (error) {
        cleanupErrors.push(error);
        reportSafeDiagnostic('PostgreSQL cleanup connection close failed.', error, activeStage);
      }
    }
  }

  if (unresolvedWrites.length) {
    console.error('At least one test write had an uncertain outcome; unconfirmed rows were intentionally left untouched.');
    cleanupErrors.push(new Error('A test write had an uncertain outcome; unconfirmed rows were intentionally left untouched.'));
  }
  if (testError || cleanupErrors.length) process.exitCode = 1;
}

async function run() {
  return withEnvironmentRestored(runIntegrationTest);
}

if (require.main === module) {
  run().catch(error => {
    const diagnostic = formatSafeDiagnostic(error, activeStage);
    console.error(`PostgreSQL integration test refused or failed. ${diagnostic}`);
    process.exitCode = 1;
  });
}

module.exports = {
  readTestTarget,
  confirmTestTarget,
  validateIntegrationSchemaName,
  createIntegrationClientOptions,
  verifyAndCreateIntegrationSchema,
  verifyCurrentIntegrationSchema,
  verifyEmptyApplicationTables,
  snapshotOrders,
  deleteOwnedRows,
  seedOwnedReferenceRows,
  insertOwnedAdditionalRow,
  createThroughApi,
  withEnvironmentRestored,
  sanitizeDiagnosticMessage,
  formatSafeDiagnostic
};
