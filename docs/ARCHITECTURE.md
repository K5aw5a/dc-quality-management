# Architecture

## Overview

```
Browser (vanilla JS, public/)
   │  fetch /api/*  (JSON, session cookie)
   ▼
nginx (TLS, HSTS)  ──►  Node http server (src/app.js)
                          ├─ auth.js        sessions, login, limiter
                          ├─ resources.js   validation, CRUD, versioning, activity log
                          └─ schema.js      module definitions
                                   │
                                   ▼
                          SQLite file (WAL mode)  ──►  nightly encrypted off-site backup
```

One process and one database file, with no runtime dependencies. Node's built-in `node:sqlite` provides the database driver.

## Schema-driven modules

`src/schema.js` describes each module: its fields, types (`string`, `text`, `enum`, `date`, `url`, `ref`), required flags, defaults and list columns. From that one definition:

- `db.js` creates the tables in the initial migration,
- `resources.js` validates input and decides which fields can be filtered on,
- the frontend renders the tabs, tables, filters and edit forms by fetching `/api/schema`.

Every module table also gets `id`, `version`, `created_by`, `created_at` and `updated_at`.

**Changing the schema after deployment:** add a new migration function to `MIGRATIONS` in `db.js` (for example `ALTER TABLE trackers ADD COLUMN discipline TEXT`) as well as updating `schema.js`. Migrations are append-only and tracked with `PRAGMA user_version`.

## Concurrency

Writes use optimistic concurrency. The client sends the `version` it loaded. The server checks it and updates with `WHERE id = ? AND version = ?`, incrementing the version. If the record moved on in the meantime, the client gets `409` with the current record, and the UI asks the user to reopen it. Nothing is overwritten silently.

## Audit trail

Each write runs in a transaction together with an `activity` row holding the username, action and a JSON before/after diff of the changed fields. A deleted record's last state is stored in its delete entry.

## Security

| Concern | Control |
| --- | --- |
| Passwords | scrypt with a per-user salt, constant-time compare, dummy hash for unknown users |
| Sessions | 256-bit random token in the cookie, stored only as a SHA-256 hash, 7-day expiry |
| Cookies | `HttpOnly`, `SameSite=Strict`, `Secure` when `COOKIE_SECURE=1` |
| CSRF | SameSite=Strict plus JSON-only bodies on writes (cross-site forms can't send `application/json`) |
| Brute force | 10 failed logins per IP per 15 minutes |
| XSS | Strict CSP (`default-src 'self'`, no inline script); UI renders data with `textContent` only; URL fields limited to http(s) |
| Authorization | All data endpoints require login; deletes are admin-only |
| SQL injection | Parameterized queries; table and column names come only from `schema.js`, never from the request |

## Deployment

See `deploy/`: a systemd unit (hardened, with write access only to `/var/lib/dc-quality`), an nginx reverse proxy with TLS, an env file template, and `backup.sh`. `backup.sh` takes a consistent `.backup` snapshot, checks its integrity, encrypts it with GPG and ships it off-site with rclone. CI deploys only after `npm test` passes, only from `main`, and only once deploy is enabled for the repo.
