const INTEGRATION_ENVIRONMENT_KEYS = [
  'WASSA_PG_INTEGRATION_MODE',
  'WASSA_PG_INTEGRATION_SCHEMA',
  'WASSA_PG_INTEGRATION_HOST',
  'WASSA_PG_TEST_DATABASE_URL',
  'WASSA_PG_TEST_ALLOWED_ENDPOINT',
  'WASSA_PG_TEST_CONFIRM',
  'WASSA_PG_PRODUCTION_ENDPOINT',
  'WASSA_PG_PRODUCTION_ENDPOINT_UNAVAILABLE'
];

function isPostgresIntegrationRequested(environment = process.env) {
  return INTEGRATION_ENVIRONMENT_KEYS.some(key =>
    Object.prototype.hasOwnProperty.call(environment, key)
  );
}

module.exports = { isPostgresIntegrationRequested };
