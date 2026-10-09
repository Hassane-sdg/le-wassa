const databaseUrl = process.env.DATABASE_URL && process.env.DATABASE_URL.trim();
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction && !databaseUrl) {
  throw new Error('DATABASE_URL is required when NODE_ENV=production.');
}

if (databaseUrl || isProduction) {
  module.exports = require('./postgres');
} else {
  module.exports = require('./sqlite');
}
