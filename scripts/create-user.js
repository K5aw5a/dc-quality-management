'use strict';

// Usage: USER_PASSWORD='...' npm run create-user -- <username> [--admin]
// The password comes from the environment so it doesn't end up in shell history.

const { loadLocalEnv, defaultDbPath } = require('../src/config');

loadLocalEnv();
const { openDb } = require('../src/db');
const { createUser } = require('../src/auth');

const args = process.argv.slice(2);
const username = args.find((a) => !a.startsWith('--'));
const role = args.includes('--admin') ? 'admin' : 'member';
const password = process.env.USER_PASSWORD;

if (!username || !password) {
  console.error("Usage: USER_PASSWORD='...' npm run create-user -- <username> [--admin]");
  process.exit(1);
}

const db = openDb(process.env.DB_PATH || defaultDbPath());
try {
  createUser(db, username, password, role);
  console.log(`Created ${role} "${username}"`);
} catch (err) {
  console.error(`Could not create user: ${err.message}`);
  process.exit(1);
} finally {
  db.close();
}
