'use strict';

const { openDb } = require('./db');
const { createApp } = require('./app');
const { createUser } = require('./auth');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const DB_PATH = process.env.DB_PATH || './data/qm.db';

const db = openDb(DB_PATH);

// First run: create an admin from env vars so the instance is never left open.
const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
if (userCount === 0) {
  if (process.env.ADMIN_USER && process.env.ADMIN_PASSWORD) {
    try {
      createUser(db, process.env.ADMIN_USER, process.env.ADMIN_PASSWORD, 'admin');
      console.log(`Created admin user "${process.env.ADMIN_USER}"`);
    } catch (err) {
      console.error(`Could not create admin user from ADMIN_USER/ADMIN_PASSWORD: ${err.message}`);
      console.error('Usernames: 2-64 letters, digits, . _ @ -   Passwords: at least 10 characters.');
      process.exit(1);
    }
  } else {
    console.warn('No users exist. Set ADMIN_USER and ADMIN_PASSWORD, or run: npm run create-user -- <name> --admin');
  }
}

const server = createApp({
  db,
  cookieSecure: process.env.COOKIE_SECURE === '1',
  trustProxy: process.env.TRUST_PROXY === '1',
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use: the app (or something else) is probably already running.`);
    console.error(`Open http://${HOST}:${PORT}, stop the other process, or start on another port with PORT=<number>.`);
  } else {
    console.error(`Server error: ${err.message}`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`DC Quality Management listening on http://${HOST}:${PORT} (db: ${DB_PATH})`);
});

function shutdown() {
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
