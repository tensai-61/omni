const path = require('path');
const { driverSelection } = require('./config');

const root = path.join(__dirname, '..');

function openDatabase(env = process.env) {
  const selection = driverSelection(env);
  if (selection.driver === 'libsql') {
    const { openLibsqlSync } = require('./libsql-sync');
    return openLibsqlSync({
      url: String(env.TURSO_DATABASE_URL).trim(),
      authToken: String(env.TURSO_AUTH_TOKEN).trim()
    });
  }
  const { DatabaseSync } = require('node:sqlite');
  const file = String(env.DATABASE_FILE || '').trim() || path.join(root, 'tournament.db');
  const database = new DatabaseSync(file, { timeout: 5000 });
  database.exec('PRAGMA busy_timeout = 5000');
  return database;
}

module.exports = { openDatabase };
