const fs = require('fs');
const path = require('path');
const sqliteAdapter = require('../db/sqlite');
const { resolvePrivateDataPath } = require('../db/paths');

async function migrate() {
  const jsonPath = resolvePrivateDataPath(
    process.env.WASSA_LEGACY_DB_PATH || path.join(path.dirname(sqliteAdapter.DB_FILE), 'db.json')
  );
  if (!fs.existsSync(jsonPath)) {
    console.error('No legacy JSON database found at the configured private data path.');
    process.exit(1);
  }
  const raw = fs.readFileSync(jsonPath, 'utf8');
  const obj = JSON.parse(raw || '{}');
  const reservations = Array.isArray(obj.reservations) ? obj.reservations : [];

  console.log('Found', reservations.length, 'reservations in JSON DB');

  await sqliteAdapter.ensureTable();

  for (const [index, r] of reservations.entries()) {
    try {
      const item = {
        id: Number(r.id) || Date.now() + index,
        name: String(r.name || '').slice(0, 100),
        date: r.date && !Number.isNaN(new Date(r.date).getTime())
          ? new Date(r.date).toISOString()
          : new Date().toISOString(),
        party: Math.min(50, Math.max(1, Number(r.party) || 1)),
        note: String(r.note || '').slice(0, 500),
        phone: String(r.phone || '').slice(0, 30),
        email: String(r.email || '').slice(0, 254),
        event: String(r.event || '').slice(0, 100)
      };
      if (item.name) await sqliteAdapter.createReservation(item);
    } catch (err) {
      console.error(`Failed to migrate reservation at index ${index}:`, err.message);
    }
  }

  console.log('Migration completed. SQLite database stored outside the project directory.');
}

migrate().catch(err => { console.error(err); process.exit(1); });
