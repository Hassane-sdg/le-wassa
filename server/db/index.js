const { isPostgresIntegrationRequested } = require('./postgres-integration-mode');

const databaseUrl = process.env.DATABASE_URL && process.env.DATABASE_URL.trim();
const isProduction = process.env.NODE_ENV === 'production';
const isPostgresIntegration = isPostgresIntegrationRequested(process.env);

if ((isProduction || isPostgresIntegration) && !databaseUrl) {
  if (isPostgresIntegration) {
    throw new Error('DATABASE_URL is required when PostgreSQL integration mode is requested.');
  }
  throw new Error('DATABASE_URL is required when NODE_ENV=production.');
}

if (databaseUrl || isProduction || isPostgresIntegration) {
  module.exports = require('./postgres');
} else {
  module.exports = require('./sqlite');
}
