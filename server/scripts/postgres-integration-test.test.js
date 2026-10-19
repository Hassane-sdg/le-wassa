const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const {
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
} = require('./postgres-integration-test');
const { createPoolConfig } = require('../db/postgres');
const { isPostgresIntegrationRequested } = require('../db/postgres-integration-mode');

const validConnection = 'postgresql://test-user:test-password@db.example.render.com:5432/lewassa?sslmode=require';
const NO_PRODUCTION_ENDPOINT_CONFIRMATION = 'site-not-deployed-no-production-postgres';
const integrationSchema = `wassa_integration_test_${'a'.repeat(32)}`;

function environmentSnapshot(environment, keys) {
  return Object.fromEntries(keys.map(key => [key, environment[key]]));
}

const runnerEnvironmentKeys = [
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

function validEnvironment(overrides = {}) {
  return {
    WASSA_PG_TEST_DATABASE_URL: validConnection,
    WASSA_PG_TEST_ALLOWED_ENDPOINT: 'db.example.render.com:5432',
    WASSA_PG_PRODUCTION_ENDPOINT: 'production.example.render.com:5432',
    WASSA_PG_TEST_CONFIRM: 'lewassa-is-not-production',
    ...overrides
  };
}

test('environment state is restored after a successful run, preserving empty and absent values', async () => {
  const environment = {
    DATABASE_URL: 'existing-db-url',
    WASSA_PG_INTEGRATION_MODE: '',
    ADMIN_TOKEN: 'existing-admin-token'
  };
  const before = environmentSnapshot(environment, runnerEnvironmentKeys);

  await withEnvironmentRestored(async () => {
    environment.DATABASE_URL = 'temporary-db-url';
    environment.WASSA_PG_INTEGRATION_MODE = '1';
    environment.WASSA_PG_INTEGRATION_SCHEMA = integrationSchema;
    environment.ADMIN_TOKEN = 'temporary-admin-token';
  }, environment);

  assert.deepEqual(environmentSnapshot(environment, runnerEnvironmentKeys), before);
  assert.equal(Object.hasOwn(environment, 'WASSA_PG_INTEGRATION_SCHEMA'), false);
  assert.equal(environment.WASSA_PG_INTEGRATION_MODE, '');
});

test('environment state is restored when validation fails before integration activation', async () => {
  const environment = {
    WASSA_PG_TEST_DATABASE_URL: '',
    WASSA_PG_TEST_CONFIRM: 'operator-value',
    DATABASE_URL: 'preexisting-db-url'
  };
  const before = environmentSnapshot(environment, runnerEnvironmentKeys);
  const validationError = new Error('synthetic validation failure');

  await assert.rejects(
    withEnvironmentRestored(async () => {
      throw validationError;
    }, environment),
    error => error === validationError
  );
  assert.deepEqual(environmentSnapshot(environment, runnerEnvironmentKeys), before);
});

test('environment remains active through cleanup and is restored after an initialization failure', async () => {
  const environment = {
    WASSA_PG_INTEGRATION_MODE: '',
    DATABASE_URL: 'original-db-url'
  };
  const before = environmentSnapshot(environment, runnerEnvironmentKeys);
  const initializationError = new Error('synthetic initialization failure');

  await assert.rejects(
    withEnvironmentRestored(async () => {
      environment.DATABASE_URL = 'temporary-db-url';
      environment.WASSA_PG_INTEGRATION_MODE = '1';
      environment.WASSA_PG_INTEGRATION_SCHEMA = integrationSchema;
      assert.equal(environment.WASSA_PG_INTEGRATION_MODE, '1');
      assert.equal(environment.WASSA_PG_INTEGRATION_SCHEMA, integrationSchema);
      throw initializationError;
    }, environment),
    error => error === initializationError
  );
  assert.deepEqual(environmentSnapshot(environment, runnerEnvironmentKeys), before);
});

test('original run error is preserved and restoration failures are reported as secondary', async () => {
  const originalValue = 'before';
  const backingEnvironment = { DATABASE_URL: originalValue };
  const environment = new Proxy(backingEnvironment, {
    set(target, key, value) {
      if (key === 'DATABASE_URL' && value === originalValue) {
        throw new Error('synthetic restoration failure');
      }
      target[key] = value;
      return true;
    }
  });
  const originalError = new Error('synthetic run failure');
  const messages = [];
  const previousConsoleError = console.error;
  console.error = message => messages.push(message);

  try {
    await assert.rejects(
      withEnvironmentRestored(async () => {
        environment.DATABASE_URL = 'during-run';
        throw originalError;
      }, environment),
      error => error === originalError
    );
  } finally {
    console.error = previousConsoleError;
  }

  assert.equal(backingEnvironment.DATABASE_URL, 'during-run');
  assert.equal(messages.length, 1);
  assert.match(messages[0], /environment restoration failed/);
  assert.match(messages[0], /DATABASE_URL/);
});

test('accepts only the explicitly allowlisted Render test endpoint', () => {
  const target = readTestTarget(validEnvironment());
  assert.equal(new URL(target.connectionString).search, '');
  assert.equal(target.endpoint, 'db.example.render.com:5432');
  assert.equal(target.hostname, 'db.example.render.com');
});

test('accepts an omitted URL port when its effective PostgreSQL port matches the allowlist', () => {
  const connectionString = validConnection.replace(':5432/lewassa', '/lewassa');
  const target = readTestTarget(validEnvironment({
    WASSA_PG_TEST_DATABASE_URL: connectionString
  }));
  assert.equal(new URL(target.connectionString).search, '');
  assert.equal(target.endpoint, 'db.example.render.com:5432');
});

test('accepts an explicit URL port when it matches the allowlist', () => {
  const target = readTestTarget(validEnvironment({
    WASSA_PG_TEST_DATABASE_URL: validConnection
  }));
  assert.equal(target.endpoint, 'db.example.render.com:5432');
});

test('refuses missing confirmation, target, endpoint, or production exclusion', () => {
  for (const overrides of [
    { WASSA_PG_TEST_CONFIRM: '' },
    { WASSA_PG_TEST_DATABASE_URL: '' },
    { WASSA_PG_TEST_ALLOWED_ENDPOINT: '' },
    { WASSA_PG_PRODUCTION_ENDPOINT: '' }
  ]) {
    assert.throws(() => readTestTarget(validEnvironment(overrides)));
  }
});

test('refuses production mode and ambiguous PostgreSQL connection settings', () => {
  assert.throws(
    () => readTestTarget(validEnvironment({ NODE_ENV: 'production' })),
    /production environment/
  );
  for (const key of [
    'DATABASE_URL',
    'TEST_DATABASE_URL',
    'PGHOST',
    'PGPORT',
    'PGDATABASE',
    'PGSERVICE',
    'PGSERVICEFILE',
    'PGOPTIONS'
  ]) {
    assert.throws(
      () => readTestTarget(validEnvironment({ [key]: 'configured' })),
      /ambiguous database connection configuration/
    );
  }
});

test('integration schema is restricted to a random dedicated name', () => {
  validateIntegrationSchemaName(integrationSchema);
  for (const schema of ['public', 'wassa_integration_test_short', 'wassa_integration_test_' + 'G'.repeat(32)]) {
    assert.throws(() => validateIntegrationSchemaName(schema), /invalid or public/);
  }
  assert.throws(
    () => createIntegrationClientOptions({ connectionString: '', hostname: '' }, 'public'),
    /invalid or public/
  );
});

test('integration clients are TLS-verified and pinned to only the dedicated search path', () => {
  const target = readTestTarget(validEnvironment());
  const options = createIntegrationClientOptions(target, integrationSchema);
  const bootstrap = createIntegrationClientOptions(target, integrationSchema, true);
  assert.deepEqual(options.ssl, { rejectUnauthorized: true, servername: target.hostname });
  assert.equal(options.options, `-c search_path=${integrationSchema}`);
  assert.equal(bootstrap.options, '-c search_path=pg_catalog');
  assert.equal(new URL(options.connectionString).search, '');
});

test('PostgreSQL pool uses the dedicated schema only in guarded integration mode', () => {
  const target = readTestTarget(validEnvironment());
  const connectionString = target.connectionString;
  const normal = createPoolConfig({
    DATABASE_URL: connectionString,
    PGSSLMODE: 'require'
  });
  assert.equal(normal.connectionString, connectionString);
  assert.deepEqual(normal.ssl, { rejectUnauthorized: true });
  assert.equal(normal.options, undefined);

  const integrationEnvironment = {
    ...validEnvironment(),
    DATABASE_URL: connectionString,
    NODE_ENV: 'test',
    WASSA_PG_INTEGRATION_MODE: '1',
    PGSSLMODE: 'require',
    WASSA_PG_INTEGRATION_SCHEMA: integrationSchema,
    WASSA_PG_INTEGRATION_HOST: target.hostname
  };
  const isolated = createPoolConfig(integrationEnvironment);
  assert.deepEqual(isolated.ssl, { rejectUnauthorized: true, servername: target.hostname });
  assert.equal(isolated.options, `-c search_path=${integrationSchema}`);

  for (const overrides of [
    { NODE_ENV: 'production' },
    { WASSA_PG_INTEGRATION_SCHEMA: 'public' },
    { PGSSLMODE: '' },
    { WASSA_PG_INTEGRATION_HOST: 'other.example.render.com' },
    { WASSA_PG_PRODUCTION_ENDPOINT: 'db.example.render.com:5432' },
    { WASSA_PG_TEST_ALLOWED_ENDPOINT: 'other.example.render.com:5432' },
    { WASSA_PG_TEST_CONFIRM: '' },
    { PGOPTIONS: '-c search_path=public' }
  ]) {
    assert.throws(() => createPoolConfig({
      ...integrationEnvironment,
      ...overrides
    }));
  }
});

test('partial integration markers require integration mode and never use the normal pool config', () => {
  const partialConfigurations = [
    {
      WASSA_PG_INTEGRATION_MODE: '1',
      DATABASE_URL: validConnection,
      NODE_ENV: 'test'
    },
    {
      WASSA_PG_INTEGRATION_MODE: '1',
      WASSA_PG_INTEGRATION_SCHEMA: integrationSchema,
      NODE_ENV: 'test'
    },
    {
      WASSA_PG_INTEGRATION_MODE: '1',
      DATABASE_URL: validConnection,
      WASSA_PG_INTEGRATION_SCHEMA: integrationSchema,
      NODE_ENV: 'test',
      PGSSLMODE: 'require'
    }
  ];
  for (const environment of partialConfigurations) {
    assert.equal(isPostgresIntegrationRequested(environment), true);
    assert.throws(() => createPoolConfig(environment));
  }
});

test('integration markers without DATABASE_URL cannot fall back to SQLite', () => {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (/^(?:DATABASE_URL|TEST_DATABASE_URL|PG[A-Z0-9_]*|WASSA_PG_)/.test(key)) {
      delete environment[key];
    }
  }
  environment.NODE_ENV = 'test';
  environment.WASSA_PG_INTEGRATION_MODE = '1';

  const result = spawnSync(
    process.execPath,
    ['-e', "require('./db')"],
    {
      cwd: path.resolve(__dirname, '..'),
      env: environment,
      encoding: 'utf8'
    }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DATABASE_URL is required when PostgreSQL integration mode is requested/);
  assert.doesNotMatch(result.stderr, /sqlite\.js/);
});

test('schema preflight is read-only and creates only the absent random schema', async () => {
  const statements = [];
  class FakeClient {
    constructor(options) {
      this.options = options;
    }
    async connect() {
      statements.push({ action: 'connect', options: this.options });
    }
    async query(sql, params) {
      statements.push({ action: 'query', sql, params });
      if (sql.startsWith('SELECT current_database()')) {
        return { rows: [{ database_name: 'lewassa', schema_exists: false }] };
      }
      return { rows: [] };
    }
    async end() {
      statements.push({ action: 'end' });
    }
  }

  await verifyAndCreateIntegrationSchema(readTestTarget(validEnvironment()), integrationSchema, FakeClient);
  const queries = statements.filter(item => item.action === 'query');
  assert.deepEqual(queries.map(item => item.sql), [
    'BEGIN READ ONLY',
    'SELECT current_database() AS database_name,\n              to_regnamespace($1) IS NOT NULL AS schema_exists',
    'ROLLBACK',
    `CREATE SCHEMA "${integrationSchema}"`
  ]);
  assert.deepEqual(queries[1].params, [integrationSchema]);
  assert.equal(statements.filter(item => item.action === 'end').length, 2);
});

test('schema preflight refuses existing schemas and always rolls back the read transaction', async () => {
  const statements = [];
  class ExistingSchemaClient {
    constructor() {}
    async connect() {}
    async query(sql) {
      statements.push(sql);
      if (sql.startsWith('SELECT current_database()')) {
        return { rows: [{ database_name: 'lewassa', schema_exists: true }] };
      }
      return { rows: [] };
    }
    async end() {}
  }
  await assert.rejects(
    verifyAndCreateIntegrationSchema(readTestTarget(validEnvironment()), integrationSchema, ExistingSchemaClient),
    /must not already exist/
  );
  assert.deepEqual(statements, ['BEGIN READ ONLY', 'SELECT current_database() AS database_name,\n              to_regnamespace($1) IS NOT NULL AS schema_exists', 'ROLLBACK']);
});

test('allows an absent production endpoint only with its dedicated explicit confirmation', () => {
  const target = readTestTarget(validEnvironment({
    WASSA_PG_PRODUCTION_ENDPOINT: '',
    WASSA_PG_PRODUCTION_ENDPOINT_UNAVAILABLE: NO_PRODUCTION_ENDPOINT_CONFIRMATION
  }));
  assert.equal(target.endpoint, 'db.example.render.com:5432');
});

test('refuses an absent production endpoint without the exact dedicated confirmation', () => {
  for (const confirmation of [undefined, '', 'not-deployed', 'true']) {
    assert.throws(() => readTestTarget(validEnvironment({
      WASSA_PG_PRODUCTION_ENDPOINT: '',
      WASSA_PG_PRODUCTION_ENDPOINT_UNAVAILABLE: confirmation
    })));
  }
});

test('refuses conflicting production endpoint and absence confirmation', () => {
  assert.throws(() => readTestTarget(validEnvironment({
    WASSA_PG_PRODUCTION_ENDPOINT_UNAVAILABLE: NO_PRODUCTION_ENDPOINT_CONFIRMATION
  })));
});

test('refuses general database URLs and any ambiguous or malformed target', () => {
  const cases = [
    { DATABASE_URL: validConnection },
    { TEST_DATABASE_URL: validConnection },
    { WASSA_PG_TEST_DATABASE_URL: 'postgres://test-user:test-password@db.example.render.com:5432/wassadb?sslmode=require' },
    { WASSA_PG_TEST_DATABASE_URL: 'postgresql://user:pass@db.example.render.com:5432/le-wassa-db?sslmode=require' },
    { WASSA_PG_TEST_DATABASE_URL: 'postgresql://user:pass@other.example.render.com:5432/lewassa?sslmode=require' },
    { WASSA_PG_TEST_DATABASE_URL: 'postgresql://user:pass@db.example.render.com:5433/lewassa?sslmode=require' },
    { WASSA_PG_TEST_DATABASE_URL: 'postgresql://user:pass@db.example.render.com:5432/lewassa?sslmode=disable' },
    { WASSA_PG_TEST_DATABASE_URL: 'postgresql://user:pass@db.example.render.com:5432/lewassa?sslmode=require&host=other.example.com' },
    { WASSA_PG_TEST_DATABASE_URL: 'postgresql://user:pass@db.example.render.com:5432/lewassa/?sslmode=require' },
    { WASSA_PG_TEST_DATABASE_URL: 'postgresql://user:pass@db.example.render.com.evil.test:5432/lewassa?sslmode=require' },
    { WASSA_PG_TEST_DATABASE_URL: 'postgresql://user:pass@8.8.8.8:5432/lewassa?sslmode=require' },
    { WASSA_PG_TEST_DATABASE_URL: 'not a connection URL' },
    { WASSA_PG_PRODUCTION_ENDPOINT: 'db.example.render.com:5432' },
    {
      WASSA_PG_PRODUCTION_ENDPOINT: '',
      WASSA_PG_PRODUCTION_ENDPOINT_UNAVAILABLE: NO_PRODUCTION_ENDPOINT_CONFIRMATION,
      DATABASE_URL: validConnection
    }
  ];
  for (const overrides of cases) {
    assert.throws(() => readTestTarget(validEnvironment(overrides)));
  }
});

test('requires an explicit interactive operator attestation', async () => {
  await assert.rejects(
    confirmTestTarget({ endpoint: 'db.example.render.com:5432' }, async () => ''),
    /not explicitly confirmed/
  );
  await assert.rejects(
    confirmTestTarget({ endpoint: 'db.example.render.com:5432' }),
    /interactive confirmation/
  );
  await confirmTestTarget(
    { endpoint: 'db.example.render.com:5432' },
    async endpoint => {
      assert.equal(endpoint, 'db.example.render.com:5432');
      return 'I VERIFIED lewassa IS NOT PRODUCTION';
    }
  );
});

test('preflight inspects every existing application table using reads only', async () => {
  const expectedTables = [
    'products',
    'reservations',
    'tables',
    'table_sessions',
    'orders',
    'loyalty',
    'loyalty_accounts'
  ];
  const statements = [];
  await verifyEmptyApplicationTables({
    async query(sql, params) {
      statements.push(sql);
      if (sql.includes('current_database()')) {
        return { rows: [{ name: 'lewassa', schema: integrationSchema }] };
      }
      if (sql.includes('information_schema.tables')) {
        assert.equal(params[0], integrationSchema);
        assert.deepEqual(params[1], expectedTables);
        return { rows: expectedTables.map(table_name => ({ table_name })) };
      }
      return { rows: [{ has_rows: false }] };
    }
  }, integrationSchema);
  assert.equal(statements.filter(sql => sql.includes('SELECT EXISTS')).length, expectedTables.length);
  assert.ok(statements.every(sql => /^\s*SELECT\b/i.test(sql)));
});

test('preflight stops when any application table contains a row', async () => {
  let checked = 0;
  await assert.rejects(
    verifyEmptyApplicationTables({
      async query(sql) {
        if (sql.includes('current_database()')) {
          return { rows: [{ name: 'lewassa', schema: integrationSchema }] };
        }
        if (sql.includes('information_schema.tables')) {
          return { rows: [{ table_name: 'orders' }] };
        }
        checked += 1;
        return { rows: [{ has_rows: true }] };
      }
    }, integrationSchema),
    /orders.*not empty/
  );
  assert.equal(checked, 1);
});

test('current-schema and empty-table guards refuse public or any other schema', async () => {
  await assert.rejects(
    verifyCurrentIntegrationSchema({
      async query() {
        return { rows: [{ database_name: 'lewassa', schema_name: 'public' }] };
      }
    }, integrationSchema),
    /dedicated integration schema/
  );
  await assert.rejects(
    verifyEmptyApplicationTables({
      async query() {
        return { rows: [{ name: 'lewassa', schema: 'public' }] };
      }
    }, integrationSchema),
    /dedicated schema/
  );
});

test('cleanup does nothing without confirmed ownership', async () => {
  const statements = [];
  await deleteOwnedRows({
    async query(sql) {
      statements.push(sql);
      return { rowCount: 0, rows: [] };
    }
  }, {});
  assert.deepEqual(statements, ['BEGIN', 'COMMIT']);
});

test('order snapshots are stable and include every order field', () => {
  const first = [{
    id: 'order-1',
    status: 'PENDING',
    pointsAwarded: 0,
    customerName: 'Test customer',
    items: [{ productId: 'product-1', quantity: 1 }],
    createdAt: new Date('2026-10-09T12:00:00.000Z')
  }, {
    id: 'order-2',
    status: 'COMPLETED',
    pointsAwarded: 10,
    paymentMethod: 'pay_on_site'
  }];
  const reordered = [
    {
      paymentMethod: 'pay_on_site',
      pointsAwarded: 10,
      status: 'COMPLETED',
      id: 'order-2'
    },
    {
      createdAt: new Date('2026-10-09T12:00:00.000Z'),
      items: [{ quantity: 1, productId: 'product-1' }],
      customerName: 'Test customer',
      pointsAwarded: 0,
      status: 'PENDING',
      id: 'order-1'
    }
  ];

  assert.equal(snapshotOrders(first), snapshotOrders(reordered));
  for (const changedField of [
    { status: 'CANCELLED' },
    { pointsAwarded: 1 },
    { customerName: 'Different customer' },
    { items: [{ productId: 'product-1', quantity: 2 }] },
    { paymentMethod: 'online' }
  ]) {
    const changedOrders = structuredClone(first);
    const targetOrder = Object.hasOwn(changedField, 'paymentMethod')
      ? changedOrders[1]
      : changedOrders[0];
    Object.assign(targetOrder, changedField);
    assert.notEqual(snapshotOrders(first), snapshotOrders(changedOrders));
  }
});

test('cleanup rolls back without deleting when any expected fixture is missing', async () => {
  const expectedSession = {
    id: 'session-id',
    tableId: 'table-id',
    createdAt: '2026-10-09T12:00:00.000Z',
    expiresAt: '2026-10-09T13:00:00.000Z'
  };
  const missingFixtures = [
    ['test table', { table: { id: 'table-id', label: 'Test table', status: 'available' } }],
    ['additional test table', { additionalTables: [{ id: 'alternate-id', label: 'Alternate test table', status: 'available' }] }],
    ['test product', { product: { id: 'product-id', name: 'Test product', category: 'Integration test', price: 100 } }],
    ['test session', { session: expectedSession }],
    ['additional test session', {
      additionalSessions: [{
        ...expectedSession,
        id: 'maintenance-session-id',
        tableId: 'maintenance-table-id'
      }]
    }],
    ['test order', { order: { id: 'order-id', idempotencyKey: 'key', requestFingerprint: 'fingerprint' } }],
    ['test reservation', { reservation: { id: 123, name: 'Test reservation', phone: '123' } }],
    ['test loyalty account', { loyalty: { customerKey: 'customer-key', points: 0 } }]
  ];

  for (const [entityName, ownedRows] of missingFixtures) {
    const statements = [];
    await assert.rejects(
      deleteOwnedRows({
        async query(sql) {
          statements.push(sql);
          if (sql.startsWith('SELECT')) return { rowCount: 0, rows: [] };
          return { rowCount: 1, rows: [] };
        }
      }, ownedRows),
      error => {
        assert.match(error.message, new RegExp(`ownership of the ${entityName} row could not be confirmed`));
        assert.match(error.message, /row not found/);
        return true;
      }
    );

    assert.equal(statements[0], 'BEGIN');
    assert.equal(statements.at(-1), 'ROLLBACK');
    assert.equal(statements.some(sql => sql.startsWith('DELETE')), false);
  }
});

test('cleanup identifies a divergent session field and rolls back without deleting', async () => {
  const expectedSession = {
    id: 'synthetic-session-id',
    tableId: 'synthetic-table-id',
    createdAt: '2026-10-09T12:00:00.000Z',
    expiresAt: '2026-10-09T13:00:00.000Z'
  };

  for (const field of Object.keys(expectedSession)) {
    const returnedSession = {
      ...expectedSession,
      createdAt: new Date(expectedSession.createdAt),
      expiresAt: new Date(expectedSession.expiresAt)
    };
    returnedSession[field] = field === 'createdAt' || field === 'expiresAt'
      ? new Date(Date.parse(expectedSession[field]) + 1000)
      : `different-${field}`;
    const statements = [];

    await assert.rejects(
      deleteOwnedRows({
        async query(sql) {
          statements.push(sql);
          if (sql.startsWith('SELECT id, table_id AS "tableId"')) {
            return { rows: [returnedSession] };
          }
          return { rowCount: 1, rows: [] };
        }
      }, { session: expectedSession }),
      error => {
        assert.match(error.message, new RegExp(`field "${field}" differs`));
        for (const value of Object.values(expectedSession)) {
          assert.equal(error.message.includes(String(value)), false);
        }
        return true;
      }
    );

    assert.equal(statements.at(-1), 'ROLLBACK');
    assert.equal(statements.some(sql => sql.startsWith('DELETE')), false);
  }
});

test('cleanup accepts session date values representing the same instant', async () => {
  const session = {
    id: 'synthetic-session-id',
    tableId: 'synthetic-table-id',
    createdAt: '2026-10-09T12:00:00.688Z',
    expiresAt: '2026-10-09T13:00:00.319Z'
  };
  const statements = [];

  await deleteOwnedRows({
    async query(sql) {
      statements.push(sql);
      if (sql.startsWith('SELECT id, table_id AS "tableId"')) {
        return {
          rows: [{
            ...session,
            createdAt: new Date(session.createdAt),
            expiresAt: new Date(session.expiresAt)
          }]
        };
      }
      if (sql.startsWith('DELETE FROM table_sessions')) return { rowCount: 1, rows: [] };
      return { rowCount: 0, rows: [] };
    }
  }, { session });

  assert.ok(statements.some(sql => sql.startsWith('DELETE FROM table_sessions')));
  assert.equal(statements.at(-1), 'COMMIT');
});

test('cleanup refuses a session createdAt that differs by one millisecond', async () => {
  const session = {
    id: 'synthetic-session-id',
    tableId: 'synthetic-table-id',
    createdAt: '2026-10-09T12:00:00.688Z',
    expiresAt: '2026-10-09T13:00:00.319Z'
  };
  const statements = [];

  await assert.rejects(
    deleteOwnedRows({
      async query(sql) {
        statements.push(sql);
        if (sql.startsWith('SELECT id, table_id AS "tableId"')) {
          return {
            rows: [{
              ...session,
              createdAt: new Date(Date.parse(session.createdAt) + 1),
              expiresAt: new Date(session.expiresAt)
            }]
          };
        }
        return { rowCount: 1, rows: [] };
      }
    }, { session }),
    /field "createdAt" differs/
  );

  assert.equal(statements.at(-1), 'ROLLBACK');
  assert.equal(statements.some(sql => sql.startsWith('DELETE')), false);
});

test('cleanup rolls back without deleting if owned row attributes differ', async () => {
  const statements = [];
  await assert.rejects(
    deleteOwnedRows({
      async query(sql) {
        statements.push(sql);
        if (sql.startsWith('SELECT id, label, status')) {
          return { rows: [{ id: 'it-test', label: 'someone else', status: 'available' }] };
        }
        return { rowCount: 0, rows: [] };
      }
    }, { table: { id: 'it-test', label: 'expected test table', status: 'available' } }),
    /ownership.*could not be confirmed/
  );
  assert.deepEqual(statements, [
    'BEGIN',
    'SELECT id, label, status FROM tables WHERE id = $1 FOR UPDATE',
    'ROLLBACK'
  ]);
});

test('cleanup deletes only a locked row whose full expected identity matches', async () => {
  const statements = [];
  const table = { id: 'it-test', label: 'expected test table', status: 'available' };
  await deleteOwnedRows({
    async query(sql, params) {
      statements.push({ sql, params });
      if (sql.startsWith('SELECT id, label, status')) {
        return { rows: [table] };
      }
      if (sql.startsWith('DELETE FROM tables')) return { rowCount: 1, rows: [] };
      return { rowCount: 0, rows: [] };
    }
  }, { table });
  assert.equal(statements.at(-2).sql, 'DELETE FROM tables WHERE id = $1 AND label = $2 AND status = $3');
  assert.deepEqual(statements.at(-2).params, [table.id, table.label, table.status]);
  assert.equal(statements.at(-1).sql, 'COMMIT');
});

test('cleanup locks and deletes only each individually confirmed test row', async () => {
  const additionalTable = { id: 'it-extra', label: 'Additional test table', status: 'maintenance' };
  const additionalSession = {
    id: 'additional-session-id',
    tableId: additionalTable.id,
    createdAt: '2026-10-09T14:00:00.000Z',
    expiresAt: '2026-10-09T15:00:00.000Z'
  };
  const owned = {
    additionalTables: [additionalTable],
    additionalSessions: [additionalSession],
    table: { id: 'it-test', label: 'Test table', status: 'available' },
    product: {
      id: 'it-product',
      name: 'Test product',
      category: 'Integration test',
      price: 1234,
      badge: 'Test',
      description: 'Temporary',
      image: 'images/grillade.png',
      available: true
    },
    session: {
      id: 'session-id',
      tableId: 'it-test',
      createdAt: '2026-10-09T12:00:00.000Z',
      expiresAt: '2026-10-09T13:00:00.000Z'
    },
    order: {
      id: 'test-order',
      tableId: 'it-test',
      sessionId: 'session-id',
      customerName: 'Integration test',
      customerPhone: '+22612345678',
      note: 'test',
      idempotencyKey: 'test-idempotency',
      requestFingerprint: 'a'.repeat(64),
      status: 'PENDING',
      pointsAwarded: 0
    },
    reservation: {
      id: 123456789,
      name: 'Integration test',
      date: '2026-10-10T12:00:00.000Z',
      party: 2,
      note: 'test',
      phone: '+22612345678',
      email: '',
      event: ''
    },
    loyalty: { customerKey: 'b'.repeat(64), points: 0 }
  };
  const statements = [];
  await deleteOwnedRows({
    async query(sql, params) {
      statements.push({ sql, params });
      if (sql.startsWith('DELETE')) return { rowCount: 1, rows: [] };
      if (sql.includes('FROM tables')) {
        const row = params[0] === additionalTable.id ? additionalTable : owned.table;
        return { rows: [row] };
      }
      if (sql.includes('FROM products')) return { rows: [owned.product] };
      if (sql.includes('FROM table_sessions')) {
        const row = params[0] === additionalSession.id
          ? { ...additionalSession, createdAt: new Date(additionalSession.createdAt), expiresAt: new Date(additionalSession.expiresAt) }
          : { ...owned.session, createdAt: new Date(owned.session.createdAt), expiresAt: new Date(owned.session.expiresAt) };
        return { rows: [row] };
      }
      if (sql.includes('FROM orders')) return { rows: [owned.order] };
      if (sql.includes('FROM reservations')) {
        return { rows: [{ ...owned.reservation, id: String(owned.reservation.id), date: new Date(owned.reservation.date) }] };
      }
      if (sql.includes('FROM loyalty_accounts')) return { rows: [owned.loyalty] };
      return { rowCount: 0, rows: [] };
    }
  }, owned);
  assert.equal(statements.filter(statement => statement.sql.startsWith('SELECT') &&
    statement.sql.includes('FOR UPDATE')).length, 8);
  assert.equal(statements.filter(statement => statement.sql.startsWith('DELETE')).length, 8);
  assert.ok(statements.filter(statement => statement.sql.startsWith('DELETE')).every(
    statement => statement.sql.includes('WHERE')
  ));
  assert.ok(statements.some(statement =>
    statement.sql === 'DELETE FROM tables WHERE id = $1 AND label = $2 AND status = $3' &&
    statement.params[0] === additionalTable.id
  ));
  assert.ok(statements.some(statement =>
    statement.sql === 'DELETE FROM table_sessions WHERE id = $1 AND table_id = $2' &&
    statement.params[0] === additionalSession.id
  ));
  assert.equal(statements.at(-1).sql, 'COMMIT');
});

test('cleanup rolls back before deleting if an additional owned session diverges', async () => {
  const expectedSession = {
    id: 'additional-session-id',
    tableId: 'additional-table-id',
    createdAt: '2026-10-09T14:00:00.000Z',
    expiresAt: '2026-10-09T15:00:00.000Z'
  };
  const statements = [];

  await assert.rejects(
    deleteOwnedRows({
      async query(sql) {
        statements.push(sql);
        if (sql.startsWith('SELECT id, table_id AS "tableId"')) {
          return {
            rows: [{
              ...expectedSession,
              createdAt: new Date(expectedSession.createdAt),
              expiresAt: new Date(Date.parse(expectedSession.expiresAt) + 1)
            }]
          };
        }
        return { rowCount: 1, rows: [] };
      }
    }, { additionalSessions: [expectedSession] }),
    /field "expiresAt" differs/
  );

  assert.equal(statements.at(-1), 'ROLLBACK');
  assert.equal(statements.some(sql => sql.startsWith('DELETE')), false);
});

test('cleanup rolls back before deleting if an additional owned table diverges', async () => {
  const expectedTable = {
    id: 'additional-table-id',
    label: 'Additional test table',
    status: 'maintenance'
  };
  const statements = [];

  await assert.rejects(
    deleteOwnedRows({
      async query(sql) {
        statements.push(sql);
        if (sql.startsWith('SELECT id, label, status')) {
          return { rows: [{ ...expectedTable, status: 'available' }] };
        }
        return { rowCount: 1, rows: [] };
      }
    }, { additionalTables: [expectedTable] }),
    /field "status" differs/
  );

  assert.equal(statements.at(-1), 'ROLLBACK');
  assert.equal(statements.some(sql => sql.startsWith('DELETE')), false);
});

test('cleanup rolls back if a confirmed row changes before its guarded delete', async () => {
  const statements = [];
  await assert.rejects(
    deleteOwnedRows({
      async query(sql) {
        statements.push(sql);
        if (sql.startsWith('SELECT id, label, status')) {
          return { rows: [{ id: 'it-test', label: 'Test table', status: 'available' }] };
        }
        if (sql.startsWith('DELETE FROM tables')) return { rowCount: 0, rows: [] };
        return { rowCount: 0, rows: [] };
      }
    }, { table: { id: 'it-test', label: 'Test table', status: 'available' } }),
    /changed before deletion/
  );
  assert.equal(statements.at(-1), 'ROLLBACK');
});

test('reference-row setup refuses conflicting identifiers and tracks uncertain writes', async () => {
  const ownedRows = {};
  const unresolvedWrites = [];
  await assert.rejects(
    seedOwnedReferenceRows({
      async query(sql) {
        if (sql.startsWith('INSERT INTO tables')) return { rows: [] };
        throw new Error('Unexpected follow-up insert');
      }
    }, { runId: 'test-run', tableId: 'it_test-run', productId: 'it-test-run' }, ownedRows, unresolvedWrites),
    /identifier already exists/
  );
  assert.deepEqual(ownedRows, {});
  assert.deepEqual(unresolvedWrites, []);
});

test('reference-row setup records only rows returned by its own inserts', async () => {
  const testData = {
    runId: 'test-run',
    tableId: 'it_test-run',
    productId: 'it-test-run',
    customerKey: 'c'.repeat(64)
  };
  const ownedRows = {};
  const unresolvedWrites = [];
  await seedOwnedReferenceRows({
    async query(sql) {
      if (sql.startsWith('INSERT INTO tables')) {
        return { rows: [{ id: testData.tableId, label: 'Test test-run', status: 'available' }] };
      }
      if (sql.startsWith('INSERT INTO products')) {
        return {
          rows: [{
            id: testData.productId,
            name: 'Test product test-run',
            category: 'Integration test',
            price: 1234,
            badge: 'Test',
            description: 'Temporary integration-test product test-run',
            image: 'images/grillade.png',
            available: true
          }]
        };
      }
      if (sql.startsWith('INSERT INTO loyalty_accounts')) {
        return { rows: [{ customerKey: testData.customerKey, points: 0 }] };
      }
      throw new Error('Unexpected query');
    }
  }, testData, ownedRows, unresolvedWrites);
  assert.deepEqual(Object.keys(ownedRows).sort(), ['loyalty', 'product', 'table']);
  assert.deepEqual(unresolvedWrites, []);
});

test('additional fixture ownership is recorded only after a returned row confirms it', async () => {
  const ownedTables = [];
  const unresolvedWrites = [];
  const expected = { id: 'it-extra', label: 'Additional test table', status: 'maintenance' };

  await insertOwnedAdditionalRow({
    async query(sql, params) {
      assert.match(sql, /^INSERT INTO tables/);
      assert.deepEqual(params, [expected.id, expected.label, expected.status]);
      return { rows: [expected] };
    }
  }, unresolvedWrites, 'maintenance table', ownedTables,
  'INSERT INTO tables (id, label, status) VALUES ($1, $2, $3) RETURNING id, label, status',
  [expected.id, expected.label, expected.status], expected, 'test table');

  assert.deepEqual(ownedTables, [expected]);
  assert.deepEqual(unresolvedWrites, []);
});

test('additional fixture setup retains uncertainty after an ambiguous insert failure', async () => {
  const ownedSessions = [];
  const unresolvedWrites = [];

  await assert.rejects(
    insertOwnedAdditionalRow({
      async query() {
        throw new Error('connection lost after insert');
      }
    }, unresolvedWrites, 'expired session', ownedSessions,
    'INSERT INTO table_sessions (...) VALUES (...) RETURNING id',
    [], { id: 'expired-session-id' }, 'table session'),
    /connection lost/
  );

  assert.deepEqual(ownedSessions, []);
  assert.deepEqual(unresolvedWrites, ['expired session']);
});

test('reference-row setup retains uncertainty after an ambiguous database failure', async () => {
  const ownedRows = {};
  const unresolvedWrites = [];
  await assert.rejects(
    seedOwnedReferenceRows({
      async query() {
        throw new Error('connection lost after write');
      }
    }, { runId: 'test-run', tableId: 'it_test-run', productId: 'it-test-run' }, ownedRows, unresolvedWrites),
    /connection lost/
  );
  assert.deepEqual(ownedRows, {});
  assert.deepEqual(unresolvedWrites, ['table']);
});

test('API creation is marked uncertain until a successful 201 response proves ownership', async () => {
  const unresolvedWrites = [];
  const ownedRows = {};
  await assert.rejects(
    createThroughApi(unresolvedWrites, 'session', async () => {
      throw new Error('network error after request');
    }, response => {
      ownedRows.session = response.data;
    }),
    /network error/
  );
  assert.deepEqual(unresolvedWrites, ['session']);
  assert.deepEqual(ownedRows, {});
});

test('API 4xx response clears uncertainty without claiming an owned row', async () => {
  const unresolvedWrites = [];
  await assert.rejects(
    createThroughApi(unresolvedWrites, 'session', async () => {
      const error = new Error('rejected');
      error.response = { status: 400 };
      throw error;
    }, () => assert.fail('Rejected requests cannot establish ownership')),
    /rejected/
  );
  assert.deepEqual(unresolvedWrites, []);
});

test('safe diagnostics retain useful error context but redact connection credentials and tokens', () => {
  const connectionString = 'postgres://test-user:p%40ss%3Aword@db.example.render.com:5432/lewassa?sslmode=require';
  const error = Object.assign(
    new Error(`connection failed for ${connectionString}; password=p@ss:word token=private-token`),
    { code: '28P01' }
  );

  const diagnostic = formatSafeDiagnostic(
    error,
    'connexion PostgreSQL',
    [connectionString, 'private-token']
  );

  assert.match(diagnostic, /connexion PostgreSQL/);
  assert.match(diagnostic, /connection failed/);
  assert.match(diagnostic, /Code PostgreSQL : 28P01/);
  for (const secret of [
    connectionString,
    'test-user',
    'p%40ss%3Aword',
    'p@ss:word',
    'private-token',
    'db.example.render.com'
  ]) {
    assert.equal(diagnostic.includes(secret), false, `Diagnostic unexpectedly contains ${secret}`);
  }
});

test('safe diagnostics redact generated identifiers and reject arbitrary error codes', () => {
  const diagnostic = formatSafeDiagnostic(
    Object.assign(
      new Error('failed for it_0123456789abcdef0 and 01234567-89ab-cdef-0123-456789abcdef'),
      { code: 'secret-token-value' }
    ),
    'tests d’intégration'
  );

  assert.match(diagnostic, /Étape : tests d’intégration/);
  assert.doesNotMatch(diagnostic, /it_0123456789abcdef0|01234567-89ab-cdef-0123-456789abcdef/);
  assert.doesNotMatch(diagnostic, /secret-token-value|Code PostgreSQL/);
});

test('message sanitizer does not return stack traces or multiline log injection', () => {
  const error = new Error('first line\nsecond line');
  error.stack = 'Error: first line\n  at private/file.js';
  const sanitized = sanitizeDiagnosticMessage(error);

  assert.equal(sanitized, 'first line second line');
  assert.doesNotMatch(sanitized, /private\/file\.js|at /);
});
