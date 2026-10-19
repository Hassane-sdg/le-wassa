const net = require('node:net');
const { createInterface } = require('node:readline/promises');
const { Client } = require('pg');

const DATABASE_NAME = 'lewassa';
const SCHEMA_NAME = 'public';
const PRODUCTION_ENDPOINT_UNAVAILABLE_CONFIRMATION =
  'site-not-deployed-no-production-postgres';
const CANDIDATE_TABLE_LABEL_PATTERNS = [
  'Test %',
  'Alternate test table %',
  'Maintenance test table %'
];

const REQUIRED_COLUMNS = [
  ['tables', 'id'],
  ['tables', 'label'],
  ['tables', 'status'],
  ['products', 'id'],
  ['products', 'category'],
  ['products', 'description'],
  ['table_sessions', 'id'],
  ['table_sessions', 'table_id'],
  ['table_sessions', 'created_at'],
  ['table_sessions', 'expires_at'],
  ['orders', 'id'],
  ['orders', 'table_id'],
  ['orders', 'session_id'],
  ['orders', 'customer_name'],
  ['orders', 'customer_phone'],
  ['orders', 'items'],
  ['reservations', 'id'],
  ['reservations', 'name'],
  ['reservations', 'phone']
];

const RENDER_HOST_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+render\.com$/i;

function parseAllowedEndpoint(value) {
  if (typeof value !== 'string' || !value.trim() || /[/?#@\\\s]/.test(value)) {
    throw new Error('WASSA_PG_TEST_ALLOWED_ENDPOINT must be a Render hostname and explicit port.');
  }

  let parsed;
  try {
    parsed = new URL(`postgres://${value.trim()}/`);
  } catch {
    throw new Error('The authorized Render endpoint is malformed.');
  }

  const port = Number(parsed.port);
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    !parsed.port ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    net.isIP(parsed.hostname) ||
    !RENDER_HOST_PATTERN.test(parsed.hostname)
  ) {
    throw new Error('The authorized endpoint must be a Render DNS hostname with an explicit port.');
  }

  return `${parsed.hostname.toLowerCase()}:${port}`;
}

function readDiagnosticTarget(environment = process.env) {
  if (environment.DATABASE_URL || environment.TEST_DATABASE_URL) {
    throw new Error('Unset DATABASE_URL and TEST_DATABASE_URL before running this diagnostic.');
  }

  if (environment.WASSA_PG_TEST_CONFIRM !== 'lewassa-is-not-production') {
    throw new Error('Explicit non-production target confirmation is required.');
  }

  const allowedEndpoint = parseAllowedEndpoint(
    environment.WASSA_PG_TEST_ALLOWED_ENDPOINT
  );
  const productionValue = environment.WASSA_PG_PRODUCTION_ENDPOINT;
  const productionUnavailable = environment.WASSA_PG_PRODUCTION_ENDPOINT_UNAVAILABLE;
  let productionEndpoint = null;

  if (typeof productionValue === 'string' && productionValue.trim()) {
    if (productionUnavailable) {
      throw new Error('Production endpoint and its absence confirmation cannot both be configured.');
    }
    productionEndpoint = parseAllowedEndpoint(productionValue);
  } else if (productionUnavailable !== PRODUCTION_ENDPOINT_UNAVAILABLE_CONFIRMATION) {
    throw new Error('Configure the production endpoint or explicitly confirm it is unavailable.');
  }

  const connectionString = environment.WASSA_PG_TEST_DATABASE_URL;
  if (typeof connectionString !== 'string' || !connectionString) {
    throw new Error('WASSA_PG_TEST_DATABASE_URL is required.');
  }

  let target;
  try {
    target = new URL(connectionString);
  } catch {
    throw new Error('The dedicated PostgreSQL test connection is malformed.');
  }

  const effectivePort = target.port || '5432';
  const effectiveEndpoint = `${target.hostname.toLowerCase()}:${effectivePort}`;
  const sslModes = target.searchParams.getAll('sslmode');
  const queryIsAllowed =
    [...target.searchParams.keys()].every(key => key === 'sslmode') &&
    sslModes.length === 1 &&
    sslModes[0] === 'require';

  if (
    !['postgres:', 'postgresql:'].includes(target.protocol) ||
    effectiveEndpoint !== allowedEndpoint ||
    effectiveEndpoint === productionEndpoint ||
    !target.username ||
    !target.password ||
    target.pathname !== `/${DATABASE_NAME}` ||
    target.hash ||
    !queryIsAllowed ||
    net.isIP(target.hostname) ||
    !RENDER_HOST_PATTERN.test(target.hostname)
  ) {
    throw new Error('Refusing to connect: target is not the explicitly authorized lewassa test endpoint.');
  }

  target.searchParams.delete('sslmode');
  return {
    connectionString: target.toString(),
    endpoint: effectiveEndpoint,
    hostname: target.hostname
  };
}

async function confirmTarget(endpoint) {
  if (!process.stdin.isTTY) {
    throw new Error('Run this diagnostic from an interactive terminal for target confirmation.');
  }

  const terminal = createInterface({
    input: process.stdin,
    output: process.stderr
  });
  try {
    const answer = await terminal.question(
      `Confirm in Render that ${endpoint} is the test database lewassa, not production. Type "I VERIFIED lewassa IS NOT PRODUCTION": `
    );
    if (answer.trim() !== 'I VERIFIED lewassa IS NOT PRODUCTION') {
      throw new Error('The test database was not explicitly confirmed.');
    }
  } finally {
    terminal.close();
  }
}

function requireColumn(columns, table, column, acceptedTypes) {
  const actual = columns.get(`${table}.${column}`);
  if (!actual || !acceptedTypes.includes(actual.data_type)) {
    throw new Error(
      `Required column ${table}.${column} is missing or has an unsupported type.`
    );
  }
}

function createPgClientOptions(target) {
  return {
    connectionString: target.connectionString,
    ssl: {
      rejectUnauthorized: true,
      servername: target.hostname
    },
    connectionTimeoutMillis: 10000,
    application_name: 'wassa-readonly-residual-diagnostic'
  };
}

async function withReadOnlyTransaction(client, action) {
  let connected = false;
  let rollbackRequired = false;
  let result;
  let diagnosticError = null;

  try {
    await client.connect();
    connected = true;

    rollbackRequired = true;
    await client.query('BEGIN READ ONLY');
    result = await action(client);
  } catch (error) {
    diagnosticError = error;
  } finally {
    if (connected && rollbackRequired) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error(
          'Read-only transaction rollback failed; PostgreSQL SQLSTATE:',
          safeSqlState(rollbackError)
        );
        diagnosticError = diagnosticError || rollbackError;
      }
    }

    if (connected) {
      try {
        await client.end();
      } catch (closeError) {
        console.error(
          'PostgreSQL diagnostic connection close failed; PostgreSQL SQLSTATE:',
          safeSqlState(closeError)
        );
        diagnosticError = diagnosticError || closeError;
      }
    }
  }

  if (diagnosticError) throw diagnosticError;
  return result;
}

async function readCandidateTables(client) {
  return client.query(
    `SELECT id AS table_id, status
     FROM public.tables
     WHERE label LIKE ANY($1::text[])
     ORDER BY id`,
    [CANDIDATE_TABLE_LABEL_PATTERNS]
  );
}

async function readCandidateSessions(client) {
  return client.query(
    `SELECT s.id AS session_id, s.table_id, s.created_at, s.expires_at
     FROM public.table_sessions AS s
     JOIN public.tables AS t ON t.id = s.table_id
     WHERE t.label LIKE ANY($1::text[])
     ORDER BY s.created_at`,
    [CANDIDATE_TABLE_LABEL_PATTERNS]
  );
}

async function runDiagnostic() {
  const target = readDiagnosticTarget();
  await confirmTarget(target.endpoint);

  const client = new Client(createPgClientOptions(target));
  let diagnosticError = null;

  try {
    await withReadOnlyTransaction(client, async () => {
      const identity = await client.query(
      'SELECT current_database() AS database_name, current_schema() AS schema_name'
      );
      if (
        identity.rows[0].database_name !== DATABASE_NAME ||
        identity.rows[0].schema_name !== SCHEMA_NAME
      ) {
        throw new Error('Connected database or schema is not the authorized lewassa/public target.');
      }

      const columnResult = await client.query(
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = $1
         AND table_name = ANY($2::text[])
       ORDER BY table_name, ordinal_position`,
      [
        SCHEMA_NAME,
        ['tables', 'products', 'table_sessions', 'orders', 'reservations']
      ]
      );
      const columns = new Map(
      columnResult.rows.map(row => [
        `${row.table_name}.${row.column_name}`,
        row
      ])
      );

    requireColumn(columns, 'tables', 'id', ['text', 'character varying']);
    requireColumn(columns, 'tables', 'label', ['text', 'character varying']);
    requireColumn(columns, 'tables', 'status', ['text', 'character varying']);
    requireColumn(columns, 'products', 'id', ['text', 'character varying']);
    requireColumn(columns, 'products', 'category', ['text', 'character varying']);
    requireColumn(columns, 'products', 'description', ['text', 'character varying']);
    requireColumn(columns, 'table_sessions', 'id', ['text', 'character varying']);
    requireColumn(columns, 'table_sessions', 'table_id', ['text', 'character varying']);
    requireColumn(columns, 'table_sessions', 'created_at', [
      'timestamp with time zone',
      'timestamp without time zone'
    ]);
    requireColumn(columns, 'table_sessions', 'expires_at', [
      'timestamp with time zone',
      'timestamp without time zone'
    ]);
    requireColumn(columns, 'orders', 'id', ['text', 'character varying']);
    requireColumn(columns, 'orders', 'table_id', ['text', 'character varying']);
    requireColumn(columns, 'orders', 'session_id', ['text', 'character varying']);
    requireColumn(columns, 'orders', 'customer_name', ['text', 'character varying']);
    requireColumn(columns, 'orders', 'customer_phone', ['text', 'character varying']);
    requireColumn(columns, 'orders', 'items', ['jsonb']);
    requireColumn(columns, 'reservations', 'id', ['bigint', 'integer']);
    requireColumn(columns, 'reservations', 'name', ['text', 'character varying']);
    requireColumn(columns, 'reservations', 'phone', ['text', 'character varying']);

      console.log('Verified target: database lewassa, schema public.');
      console.log('Verified required column types (including orders.items = jsonb).');

    const tables = await readCandidateTables(client);
      console.log('Candidate tables (technical identifiers only):');
      console.table(tables.rows);

    const products = await client.query(
      `SELECT id AS product_id
       FROM public.products
       WHERE id LIKE 'it-%'
         AND category = 'Integration test'
         AND description LIKE 'Temporary integration-test product %'
       ORDER BY id`
    );
      console.log('Candidate products (technical identifiers only):');
      console.table(products.rows);

    const sessions = await readCandidateSessions(client);
      console.log('Sessions linked to candidate tables:');
      console.table(sessions.rows);

    const orders = await client.query(
      `SELECT
         o.id AS order_id,
         o.table_id,
         o.session_id,
         COALESCE(
           array_agg(DISTINCT item.value ->> 'productId')
             FILTER (WHERE item.value ->> 'productId' IS NOT NULL),
           ARRAY[]::text[]
         ) AS product_ids
       FROM public.orders AS o
       LEFT JOIN LATERAL jsonb_array_elements(
         CASE
           WHEN jsonb_typeof(o.items) = 'array' THEN o.items
           ELSE '[]'::jsonb
         END
       ) AS item(value) ON true
       WHERE o.customer_name LIKE 'PostgreSQL integration %'
       GROUP BY o.id, o.table_id, o.session_id
       ORDER BY o.id`
    );
      console.log('Candidate orders and technical links (no customer data):');
      console.table(orders.rows);

    const reservations = await client.query(
      `SELECT
         r.id AS reservation_id,
         COALESCE(array_agg(DISTINCT o.id) FILTER (WHERE o.id IS NOT NULL), ARRAY[]::text[]) AS matching_order_ids,
         COALESCE(array_agg(DISTINCT o.table_id) FILTER (WHERE o.table_id IS NOT NULL), ARRAY[]::text[]) AS matching_table_ids,
         COALESCE(array_agg(DISTINCT o.session_id) FILTER (WHERE o.session_id IS NOT NULL), ARRAY[]::text[]) AS matching_session_ids
       FROM public.reservations AS r
       LEFT JOIN public.orders AS o
         ON o.customer_name = r.name
        AND COALESCE(o.customer_phone, '') = COALESCE(r.phone, '')
        AND o.customer_name LIKE 'PostgreSQL integration %'
       WHERE r.name LIKE 'PostgreSQL integration %'
       GROUP BY r.id
       ORDER BY r.id`
    );
      console.log('Candidate reservations and matching technical links only:');
      console.table(reservations.rows);
    });
  } catch (error) {
    diagnosticError = error;
  }

  if (diagnosticError) {
    const sqlState = safeSqlState(diagnosticError);
    console.error(
      `Read-only PostgreSQL diagnostic stopped without printing error details.${sqlState ? ` SQLSTATE: ${sqlState}.` : ''}`
    );
    process.exitCode = 1;
  }
}

function safeSqlState(error) {
  return error && typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)
    ? error.code
    : '';
}

if (require.main === module) {
  runDiagnostic().catch(error => {
    console.error('PostgreSQL residual diagnostic refused or failed without printing sensitive details.');
    const sqlState = safeSqlState(error);
    if (sqlState) console.error(`PostgreSQL SQLSTATE: ${sqlState}.`);
    process.exitCode = 1;
  });
}

module.exports = {
  readDiagnosticTarget,
  parseAllowedEndpoint,
  createPgClientOptions,
  withReadOnlyTransaction,
  readCandidateTables,
  readCandidateSessions
};
