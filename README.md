# DC Quality Management

**One place to run quality on a data center construction project.** Drop in the registers, logs, certificates and scans you already have. The app reads them into structured registers and shows on one page how ready you are for the next quality audit, and what is overdue, due soon or on hold.

Built for the QA/QC lead of a contractor package (for example BMS and EPMS: engineering, supply, installation, integration, testing, commissioning and handover). It runs on an ordinary work laptop with nothing to install except Node.js.

---

## Why it exists

On a data center project the quality information is everywhere: submittal logs in the common data environment (e.g. Autodesk Construction Cloud), issues and NCRs in another export, ITPs and check sheets in folders, calibration certificates as PDFs or scans, deliveries in emails, and an audit readiness checklist in Excel. Preparing for a client or main-contractor quality audit means chasing all of it by hand, and nobody has one current picture.

This app gives you that picture without retyping anything:

- **It reads what you already have.** Excel, CSV, Word, PDF, scanned PDFs and photos go in as they are.
- **It keeps one register per topic:** audit checklist, submittals, deliveries, materials, ITPs, benchmarks/FOK, issues/NCRs, calibration, installer tasks, plus any registers you add.
- **It shows what needs attention:** audit readiness by area, missing and partial evidence, overdue and blocked items, submittals waiting at the GC, upcoming deliveries.
- **It keeps a trail:** every change records who, when and what, and every imported record links back to its source file.

## How you use it

1. **Upload a document.** Choose what it is (a register, or a saved *document type* such as "ACC issues export" or "Calibration certificate"), or let the app detect it.
2. **Check the preview.** Each row is marked **new, update, unchanged** or **skipped**, and changed values are highlighted. Fix any column the app matched wrongly, untick rows you don't want, then **Import**. Nothing changes before you click Import.
3. **Next time it maps itself.** Headings you corrected are remembered, so the weekly export from the same source imports in one click.
4. **Work from the dashboard.** Readiness %, items needing action with their gap and owner, overdue / due soon / on hold, submittal ageing at the GC, and upcoming deliveries with submittal-approved and MIR flags.
5. **Keep evidence with the audit.** Any file (a procedure, a presentation, a signed sheet) can be stored as evidence against an audit checklist item.

## What's inside

### Reading documents
- **Spreadsheets and tables:** finds the header row even under a summary block, and matches columns by name ("Submittal No", "Doc no" → *Ref*; "Next due", "Valid until" → *Due date*).
- **Single documents** such as a calibration certificate, an NCR form or an ITP cover sheet: reads `Label: value` pairs into a pre-filled form to check and save.
- **Scanned PDFs and photos** with OCR. On Windows 10/11 it uses the OCR engine built into Windows (nothing to install); on servers it uses Tesseract.
- **Messy values:** day-first dates (`17/09/2026`, `17-Sep-26`, Spanish month names, Excel dates), EU/UK numbers, yes/no (`Y`, `✓`), review codes (`Code B` → *Approved as noted*), and common OCR slips (O/0, l/1).
- **Safe updates:** re-importing only applies differences, and empty cells never wipe existing data.

### Registers you shape yourself (Settings → *Edit registers*)
- A **purpose** for each register: what it is for, shown on its page and when uploading.
- **Columns:** add, rename, reorder, hide, make required. Types are text, long text, status/choice, date, number, yes/no and link.
- **Headings in files that mean each column**, which drive the automatic matching.
- **Status options** with a colour (green / amber / red / grey) and flags: *done* (never overdue, counts as ready), *on hold* (listed with its reason on the dashboard), *N/A* (left out of readiness %).
- **Rules:** what identifies a record, the title, the due-date column and "due soon" window, the hold-reason column, and an age counter (e.g. *Days in review*).
- **Create** your own registers (Procedures, Training/TBT, RFIs…) or **archive** ones you don't use. Hidden columns and archived registers keep their data; nothing is deleted.

### Document types (Settings → *Document types*)
Named kinds of files you upload regularly. Each says which register it goes into, whether it's read as a **table**, a **single document** or kept as **evidence only**, which words in the file name identify it, a default audit item, and its saved column mapping. "Save as document type…" in an import preview creates one from the file in front of you.

### Audits (read-only record)
The **Audits** page keeps the record of each quality audit: preparation checklist, the 13 audit areas (what to say, what to show, gaps and questions to ask), findings, and the resulting action list with owners, dates and status. The page has no editing controls. The record is written outside the app as an `audit-record.json` file (for example prepared in chat) and loaded by uploading it on the Upload page. Every upload is kept as a version, and the latest one is shown.

### The starting registers
All of them can be edited, renamed or archived.

| Register | Main columns |
| --- | --- |
| Audit checklist | ref, area, item, status (Ready / Partial / Missing / Not checked / N/A), where in the CDE, owner, gap / action, quality plan ref, what to have ready, evidence files |
| Submittal register | ref, title, system, rev, date submitted, GC status, days in review, blocker, owner |
| Delivery tracker | PO, item, supplier, qty, expected / actual date, status, submittal approved?, MIR done? |
| Material tracker | item, delivered qty, location, installed qty, remaining, expiry, installer / area |
| ITP register | ITP no., activity, system, rev, approval status, linked checklists |
| Benchmark / FOK register | item, system, location, responsible party, status, approval date, comments |
| Issues / NCR log | ID, type, description, location, owner, raised, target, status, age |
| Calibration register | ID, equipment, make / model, cal date, due date, certificate |
| Installer task list | area, task, installer, start / end, materials needed, status |
| Where info lives | each register, where its information lives today, audit areas it supports |

### Everyday features
- Search and filter every register, edit records in place, and see each record's history.
- Export any register, or all of them, to Excel; download a blank template.
- Company look: navy top bar, optional company logo, and Light / Dark / Auto per person.
- Sign-in for every user, admin and member roles, and protection against two people overwriting each other's edits.

## Getting started (Windows)

You need Node.js 22.13 or newer (`node -v`).

1. **First time only:** create your admin account. In PowerShell, in the app folder:
   ```powershell
   $env:ADMIN_USER = "admin"; $env:ADMIN_PASSWORD = "at-least-10-characters"; npm.cmd start
   ```
   Then stop it with `Ctrl+C`.
2. **Every day:** double-click **`start.cmd`** in the app folder. It starts the app and opens http://127.0.0.1:3000 in your browser. Keep its window open while you work; close it to stop the app. Tip: right-click `start.cmd` → *Send to* → *Desktop (create shortcut)*.
3. **Your settings** (project name, logo, OCR language…) go in **`local.env`** in the app folder. `start.cmd` creates it from `local.env.example` the first time; open it in Notepad and edit, e.g.:
   ```
   PROJECT_NAME=My project
   LOGO_FILE=%USERPROFILE%\Pictures\logo.png
   ```
   `local.env` stays on your computer and is never uploaded to GitHub.

The database is stored in `%LOCALAPPDATA%\dc-quality\qm.db` by default (outside OneDrive, which can corrupt a live database file), and uploaded files in an `uploads` folder next to it.

**Updating the app:** only when there is a new version, run `git pull` in the app folder, then start it again.

**Adding a teammate** (in PowerShell, in the app folder):
```powershell
$env:USER_PASSWORD = "a-long-password"; npm.cmd run create-user -- jane.doe
```
Add `--admin` to make them an admin. To let the whole team use one copy, run it on a server (see `deploy/`).

If PowerShell refuses `npm` ("running scripts is disabled"), use `npm.cmd` as shown. `start.cmd` doesn't need PowerShell at all.

### Settings

Put these in `local.env` (one `NAME=value` per line) or set them as environment variables; environment variables win.


| Variable | Default | What it does |
| --- | --- | --- |
| `DB_PATH` | `%LOCALAPPDATA%\dc-quality\qm.db` on Windows, `./data/qm.db` elsewhere | where the database lives |
| `PROJECT_NAME` | Quality Management | name shown in the top bar |
| `LOGO_FILE` | none | path to a local logo image (.png / .jpg / .svg) for the top bar and sign-in page |
| `PORT` / `HOST` | 3000 / 127.0.0.1 | where the app listens |
| `UPLOAD_DIR` | next to the database | where uploaded files are kept |
| `OCR_ENGINE` | `windows` on Windows, else `tesseract` if found | `windows`, `tesseract` or `off` |
| `OCR_LANG` | your Windows languages / `eng` | e.g. `en-GB`, `es-ES` (Windows); `eng+spa` (Tesseract) |
| `OCR_MAX_PAGES` | 50 | scanned pages read per file |
| `COOKIE_SECURE`, `TRUST_PROXY` | off | set to `1` when served over HTTPS behind nginx |

The startup log shows which OCR engine was found. Windows OCR uses the OCR language packs installed with your display languages (*Settings → Time & language → Language* to add more).

## Limits

- OCR misreads blurry, skewed or tiny text, and handwriting isn't read reliably. Scan at 200–300 dpi, and always check OCR previews.
- Not supported: password-protected PDFs, scans saved as JBIG2 or JPEG 2000 (some copiers' "high compression" mode), and old `.xls` / `.doc` files (use "Save As" `.xlsx` / `.docx`).
- If IT has locked PowerShell down, Windows OCR can't run. The app says so and keeps the file as evidence.
- It runs on one machine at a time unless you deploy it to a server.

## Your data

Everything stays on the machine running the app: the database at `DB_PATH` and uploaded files in `UPLOAD_DIR`. Nothing is sent to outside services. **This repository is public, so never commit project documents, exports, the database or a client logo.** `.gitignore` already excludes the data folders when they sit inside the repo.

---

## For developers

- **Stack:** Node.js standard library only (`node:http`, `node:sqlite`, `node:crypto`, `node:test`); no runtime dependencies, no build step. Vanilla JS frontend. File readers (zip/xlsx/docx/pdf, PNG/TIFF encoders) are written in-house.
- **Tests:** `npm test` covers readers, OCR (real Tesseract tests are skipped when it isn't installed), value parsing, upload → preview → import, learning, register and document-type editing, dashboard figures, security, and database upgrades. Fixtures in `test/fixtures` are synthetic (`make_fixtures.py` regenerates them).
- **Docs:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/DECISIONS.md`](docs/DECISIONS.md), [`docs/ROADMAP.md`](docs/ROADMAP.md).
- **Deploy:** `deploy/` has a systemd unit, an nginx config, an env example and an encrypted backup script. CI runs the tests on every push.

```
src/schema.js        starting registers (copied into the database on first run)
src/registry.js      register definitions stored in the database: validate, compile, cache
src/settings.js      editing registers and document types; learning headings from imports
src/parsers/         xlsx (read + write), csv, docx, pdf readers; zip/xml; png/tiff encoders
src/ocr.js           OCR via Windows built-in OCR (PowerShell) or Tesseract
src/values.js        dates / numbers / yes-no / status parsing
src/importer.js      header detection, column mapping, preview planning, import
src/dashboard.js     dashboard figures
src/audits.js        audit records (validated JSON, versions, read-only view data)
src/uploads.js       file storage (by content hash, outside git)
src/resources.js     validation, records, optimistic concurrency, activity log
src/db.js            SQLite, migrations, additive table sync
src/app.js           HTTP routes, security headers
src/config.js        local.env loading and default paths
public/              frontend (app.js, settings.js, audits.js, theme.js, styles.css)
test/                node:test suite and synthetic fixtures
deploy/              systemd, nginx, env example, backup script
```
