const assert = require('node:assert/strict');
const test = require('node:test');
const { Client } = require('pg');
const {
  readDiagnosticTarget,
  createPgClientOptions,
  withReadOnlyTransaction,
  readCandidateTables,
  readCandidateSessions
} = require('./postgres-residual-diagnostic');

const connectionString =
  'postgres://synthetic-user:synthetic-password@db.example.render.com:5432/lewassa?sslmode=require';

function validEnvironment(overrides = {}) {
  return {
    WASSA_PG_TEST_DATABASE_URL: connectionString,
    WASSA_PG_TEST_ALLOWED_ENDPOINT: 'db.example.render.com:5432',
    WASSA_PG_PRODUCTION_ENDPOINT: 'production.example.render.com:5432',
    WASSA_PG_TEST_CONFIRM: 'lewassa-is-not-production',
    ...overrides
  };
}

test('TLS verification and server hostname survive pg option parsing', () => {
  const target = readDiagnosticTarget(validEnvironment());
  const options = createPgClientOptions(target);

  assert.equal(new URL(target.connectionString).search, '');
  assert.deepEqual(options.ssl, {
    rejectUnauthorized: true,
    servername: 'db.example.render.com'
  });

  const client = new Client(options);
  assert.equal(client.connectionParameters.ssl.rejectUnauthorized, true);
  assert.equal(client.connectionParameters.ssl.servername, 'db.example.render.com');
});

test('read-only candidate queries include Alternate and Maintenance fixtures and linked sessions', async () => {
  const events = [];
  const selectQueries = [];
  const client = {
    async connect() {
      events.push('connect');
    },
    async query(sql, params) {
      events.push(sql);
      if (sql.startsWith('SELECT')) {
        selectQueries.push({ sql, params });
        return { rows: [] };
      }
      return { rows: [] };
    },
    async end() {
      events.push('end');
    }
  };

  await withReadOnlyTransaction(client, async connectedClient => {
    await readCandidateTables(connectedClient);
    await readCandidateSessions(connectedClient);
  });

  const expectedPatterns = [
    'Test %',
    'Alternate test table %',
    'Maintenance test table %'
  ];
  assert.equal(selectQueries.length, 2);
  for (const { sql, params } of selectQueries) {
    assert.match(sql, /^\s*SELECT\b/);
    assert.match(sql, /LIKE ANY\(\$1::text\[\]\)/);
    assert.deepEqual(params, [expectedPatterns]);
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/i);
  }
  assert.match(selectQueries[1].sql, /JOIN public\.tables AS t ON t\.id = s\.table_id/);
  assert.deepEqual(events, [
    'connect',
    'BEGIN READ ONLY',
    selectQueries[0].sql,
    selectQueries[1].sql,
    'ROLLBACK',
    'end'
  ]);
});

test('read-only client rolls back and closes after a query failure without masking it', async () => {
  const events = [];
  const queryError = Object.assign(new Error('synthetic query failure'), { code: 'XX000' });
  const client = {
    async connect() {
      events.push('connect');
    },
    async query(sql) {
      events.push(sql);
      if (sql === 'SELECT synthetic failure') throw queryError;
    },
    async end() {
      events.push('end');
    }
  };

  await assert.rejects(
    withReadOnlyTransaction(client, async connectedClient => {
      await connectedClient.query('SELECT synthetic failure');
    }),
    error => error === queryError
  );

  assert.deepEqual(events, ['connect', 'BEGIN READ ONLY', 'SELECT synthetic failure', 'ROLLBACK', 'end']);
});

test('read-only client closes even when rollback fails and preserves the first error', async () => {
  const events = [];
  const queryError = new Error('synthetic query failure');
  const rollbackError = Object.assign(new Error('synthetic rollback failure'), { code: '08006' });
  const client = {
    async connect() {
      events.push('connect');
    },
    async query(sql) {
      events.push(sql);
      if (sql === 'SELECT synthetic failure') throw queryError;
      if (sql === 'ROLLBACK') throw rollbackError;
    },
    async end() {
      events.push('end');
    }
  };
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    await assert.rejects(
      withReadOnlyTransaction(client, async connectedClient => {
        await connectedClient.query('SELECT synthetic failure');
      }),
      error => error === queryError
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(events, ['connect', 'BEGIN READ ONLY', 'SELECT synthetic failure', 'ROLLBACK', 'end']);
});

test('connection failure preserves its error and does not close an unconnected client', async () => {
  const events = [];
  const connectError = Object.assign(new Error('synthetic connection failure'), { code: '08001' });
  const client = {
    async connect() {
      events.push('connect');
      throw connectError;
    },
    async query(sql) {
      events.push(sql);
    },
    async end() {
      events.push('end');
    }
  };

  await assert.rejects(
    withReadOnlyTransaction(client, async () => assert.fail('No work should run after connect failure')),
    error => error === connectError
  );

  assert.deepEqual(events, ['connect']);
});

test('failed BEGIN still attempts rollback and closes an established client', async () => {
  const events = [];
  const beginError = new Error('synthetic begin failure');
  const client = {
    async connect() {
      events.push('connect');
    },
    async query(sql) {
      events.push(sql);
      if (sql === 'BEGIN READ ONLY') throw beginError;
    },
    async end() {
      events.push('end');
    }
  };

  await assert.rejects(
    withReadOnlyTransaction(client, async () => assert.fail('No work should run after BEGIN failure')),
    error => error === beginError
  );

  assert.deepEqual(events, ['connect', 'BEGIN READ ONLY', 'ROLLBACK', 'end']);
});
