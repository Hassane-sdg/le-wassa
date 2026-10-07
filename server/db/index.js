const isPostgresEnabled = Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.trim());

module.exports = isPostgresEnabled ? require('./postgres') : require('./sqlite');
