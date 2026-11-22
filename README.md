# DC Quality Management Workspace

**A shared, authenticated quality-management platform for data center construction and operations: submittals & documentation, trackers, and inspections/audits in one place.**

*Stack: Node.js (zero runtime dependencies), SQLite, vanilla JS frontend, GitHub Actions, self-hosted Linux.*

> **Status: skeleton (v0.1).** The core platform runs and is tested. The roadmap below lists what is planned next. See [`docs/`](docs/) for the architecture, decision log and roadmap.

---

## Context

Quality management on a data center project is spread across spreadsheets, email threads, shared drives and contractor portals. There are submittal registers, document transmittals, punch lists, RFIs, commissioning trackers, and inspection or audit checklists for power, cooling, fire and security systems. Nobody has one current picture, edits overwrite each other, and there's no record of who changed a status or when.

This project gives the QA/QC team one authenticated, shared system of record for that work. It's kept deliberately small enough for one engineer to run and reason about: no framework, no build step, and one SQLite file.

## What's in the skeleton

**Three modules, one schema.** All modules are defined in [`src/schema.js`](src/schema.js). The database tables, API validation and the frontend's forms and tables are all generated from that one definition, so adding a field or a whole tracker type is a one-file change.

| Module | Records | Highlights |
| --- | --- | --- |
| **Submittals & documentation** | Submittals, Documents | Ref/revision tracking, a review status workflow (draft → submitted → under review → approved / approved as noted / revise & resubmit / rejected), documents linked to a submittal, overdue review dates highlighted |
| **Trackers** | Tracker items | Punch list, RFI, snag, commissioning and action-item trackers with owner, location, priority, status and due date |
| **Inspections / audits** | Inspections, Findings | Inspections, audits and witness tests by area (power, cooling, rack & cabling, fire, security…), with pass/fail/observation findings and severity |

**Shared backend with safe concurrent editing.** A REST API over SQLite. Every record carries a version number. An update based on a stale version is refused with `409 Conflict` and the current record is returned, so two engineers editing the same item can't silently overwrite each other.

**Full audit trail.** Every create, update and delete is written to an activity log with the user, the time and a field-by-field before/after diff. The edit dialog shows it as each record's history, which is the traceability a QMS audit asks for.

**Authenticated by default.** Session login with scrypt password hashes, HttpOnly + SameSite=Strict cookies, case-insensitive usernames, a brute-force limiter, JSON-only writes as a CSRF guard, a strict Content Security Policy, and admin-only deletes. The instance can't be started open: the first admin comes from env vars or a CLI script.

**Production-shaped from day one.** A CI pipeline that runs the test suite on every push and only deploys when it passes. A hardened systemd unit, an nginx TLS reverse proxy config, and a nightly encrypted off-site SQLite backup script.

## Quick start

Requires Node.js 22.5+ (uses the built-in `node:sqlite`).

```bash
ADMIN_USER=admin ADMIN_PASSWORD='choose-a-long-password' npm start
# → http://127.0.0.1:3000
```

Add more users:

```bash
USER_PASSWORD='another-long-password' npm run create-user -- jane.doe
USER_PASSWORD='another-long-password' npm run create-user -- qa.lead --admin
```

Run the tests:

```bash
npm test
```

Configuration (env vars): `PORT` (3000), `HOST` (127.0.0.1), `DB_PATH` (`./data/qm.db`), `COOKIE_SECURE=1` when served over HTTPS, `TRUST_PROXY=1` behind nginx.

## API

All endpoints except `/api/health` and `/api/login` require a session.

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/login` / `/api/logout` | `{username, password}` |
| `GET` | `/api/me`, `/api/schema` | Current user, module definitions |
| `GET` | `/api/:module` | Filters: any enum/date/ref field (`?status=open&tracker=rfi`), `?q=` text search |
| `POST` | `/api/:module` | Create |
| `GET` | `/api/:module/:id` | Read |
| `PATCH` | `/api/:module/:id` | Partial update; **must** include `version` |
| `DELETE` | `/api/:module/:id` | Admin only |
| `GET` | `/api/activity?resource=&record_id=` | Audit trail |

Modules: `submittals`, `documents`, `trackers`, `inspections`, `findings`.

## Project layout

```
src/schema.js      module definitions (the one place to add fields/modules)
src/db.js          SQLite connection + append-only migrations
src/auth.js        users, password hashing, sessions, login limiter
src/resources.js   validation, CRUD, optimistic concurrency, activity log
src/app.js         HTTP routing, security headers, static files
public/            vanilla JS frontend (no build step)
test/              node:test suite (API + auth)
deploy/            systemd, nginx, env example, backup script
docs/              architecture, decision log, roadmap
```

## Roadmap (next)

- Inspection **checklist templates** (e.g. standard UPS, generator, CRAH, fire suppression checklists) that generate findings automatically
- **File attachments** (photos of findings, signed inspection sheets)
- **Non-conformance reports and CAPA** linked to failed findings
- **Dashboards / KPIs**: submittal turnaround time, open punch items by area, first-time inspection pass rate
- CSV import/export for existing registers
- Integrations, human-reviewed in the same way as the Future Aero Lab HubSpot sync (for example a contractor portal or a document management system)

See [`docs/ROADMAP.md`](docs/ROADMAP.md) for detail.

## Stack

Node.js · SQLite (`node:sqlite`) · vanilla JavaScript (no framework, no build step) · GitHub Actions · nginx · systemd
