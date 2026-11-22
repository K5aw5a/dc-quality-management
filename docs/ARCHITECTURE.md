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

## Document import

```
upload (raw bytes) ─► uploads/<sha256>  (content-addressed, outside git)
        │
        ▼
parsers/  xlsx · csv · docx · pdf  ─►  { tables: [[cells]], lines, text }
        │
        ▼
importer.analyse ─ header row detection (scans 60 rows) ─ column → field matching (synonyms in schema.js)
                 ─ cell conversion (values.js) ─ plan: create / update / unchanged / skip by register key
        │  preview to the user (they can remap columns, change header row/sheet, untick rows)
        ▼
importer.commit ─ one transaction; each change logged as 'import' with the source upload id
```

PDFs: text is extracted from content streams (Flate/LZW/ASCII filters, object streams, ToUnicode CMaps, font widths), grouped into lines by y position and into cells by gaps. Once the header row is known, each line is re-split against the header's column positions, and wrapped lines (no value in the key column) are folded into the row above.

Single documents (certificates, forms) use `Label: value` pairs and two-column table rows, plus per-register patterns (e.g. NCR/ITP numbers), and are saved through an editable form.

## Schema-driven modules

`src/schema.js` describes each register: its fields, types (`string`, `text`, `enum`, `date`, `number`, `bool`), column synonyms, required flags, defaults and list columns. From that one definition:

- `db.js` creates missing tables and adds missing columns at start-up (additive only),
- `resources.js` validates input and decides which fields can be filtered on,
- the frontend renders the tabs, tables, filters and edit forms by fetching `/api/schema`.

Every module table also gets `id`, `version`, `created_by`, `created_at` and `updated_at`.

**Changing the schema:** adding a field or register in `schema.js` is enough; it is created on next start. Renames, type changes and removals need an explicit migration in `MIGRATIONS` (append-only, tracked with `PRAGMA user_version`). v0.1's generic tables are kept as `legacy_*`.

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
