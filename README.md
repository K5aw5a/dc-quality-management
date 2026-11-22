# DC Quality Management Workspace

**A quality dashboard for data center projects. Upload the registers, logs and certificates you already have (Excel, CSV, Word, PDF). The app reads them into structured registers and shows audit readiness and what's overdue, due soon or on hold on one page.**

*Stack: Node.js (zero runtime dependencies, no build step), SQLite, vanilla JS. Runs on a laptop with nothing to install except Node.*

---

## What it does

**1. Upload a document → preview → import.**
Pick a file and say what it is (or let the app detect it). The app:
- finds the table, even when the header row sits under a summary block (e.g. row 8);
- matches columns to fields by name ("Submittal No", "Ref", "Doc no" → *Ref*; "Next due", "Valid until" → *Due date*);
- reads dates (`17/09/2026`, `17-Sep-26`, `17 de septiembre de 2026`, Excel dates), numbers (`1.234,5` or `1,234.5`), yes/no (`Y`, `✓`) and statuses (`Code B` → *Approved as noted*);
- shows every row as **new / update / unchanged / skipped**, with changed values highlighted. You can change any column's field, untick rows, then import.

Nothing changes until you click Import. Re-importing an updated register only applies the differences, and empty cells never wipe existing data.

**Scanned PDFs and photos** (`.jpg`, `.png`, `.tif`) are read with OCR. On Windows 10/11 the app uses the **OCR engine built into Windows**, so there is nothing to install. On Linux/servers it uses **Tesseract** if installed (`apt install tesseract-ocr`). Scanned pages are found automatically: a page with no text and a page-sized image. The page image is passed to OCR (JPEG, CCITT fax/TIFF and Flate scans are supported), and the words are laid out into rows and columns like any other table. The preview flags OCR results so you check them before importing.

For single documents (a calibration certificate, an NCR form, an ITP cover sheet), it reads `Label: value` pairs and pre-fills a form for you to check and save. Any file can also be stored as **evidence** against an audit checklist item.

**2. Registers you shape yourself** (Settings → *Edit registers*, admin only). Each register has:
- a **purpose** ("what it stands for"), shown on its page and when uploading;
- **columns** you can add, rename, reorder, hide or make required, with a type (text, long text, status/choice, date, number, yes/no, link);
- **headings in files that mean this column**, which drive the automatic matching (e.g. *NCR No, Issue ID, Ref → ID*);
- **status options** with a colour and flags: *done* (never overdue, counts as ready), *on hold* (on the dashboard's on-hold list), *N/A* (left out of readiness %), plus other words that mean that status (e.g. *Code B → Approved as noted*);
- **rules**: which columns identify a record (so re-imports update instead of duplicating), the title, the status column, the due-date column and "due soon" window, the on-hold reason column, and an optional age counter (e.g. *Days in review* since *Date submitted* while *Submitted / Under review*).

You can also **create new registers** (e.g. Procedures, Training/TBT, RFIs) or **archive** ones you don't use. Removing a column only hides it, and archiving keeps the records, so nothing is ever deleted.

**Learning:** when you correct a column in an import preview, the register remembers that heading for next time.

**Document types** (Settings → *Document types*) are named kinds of files you pick at upload, e.g. *ACC issues export*, *Calibration certificate*, *Procedure*. Each says which register it goes into, whether it's read as a **table**, a **single document** or stored as **evidence only**, which words in the file name identify it, a default audit item, and a **saved column mapping**. "Save as document type…" in an import preview creates one from the current file, and later column choices are added to it automatically. Files whose names contain a type's words are recognised automatically.

The starting registers (all editable):

| Register | Key columns | Computed |
| --- | --- | --- |
| Audit checklist | ref, area, item, status (Ready/Partial/Missing/Not checked/N/A), where in ACC/TIDP, owner, gap/action, QP ref, what to have ready | evidence files |
| Submittal register | ref, title, system, rev, date submitted, GC status, blocker, owner | days in review |
| Delivery tracker | PO, item, supplier, qty, expected, actual, status, submittal approved?, MIR done? | |
| Material tracker | item, delivered qty, location, installed qty, expiry, installer/area | remaining |
| ITP register | ITP no., activity, system, rev, approval status, linked checklists | |
| Benchmark / FOK register | item, system, location, responsible, status, approval date, comments | |
| Issues / NCR log | ID, type, description, location, owner, raised, target, status | age |
| Calibration register | ID, equipment, make/model, cal date, due date, certificate | |
| Installer task list | area, task, installer, start/end, materials needed, status | |
| Where info lives | register, status, where it lives today, audit areas | |

**3. Dashboard** (the main page):
- audit readiness % and counts by status, a breakdown per area, and the missing/partial items with their gap/action;
- a card per register (green = OK, amber = due soon / on hold, red = overdue);
- overdue items, items due soon (14 days; 30 for calibration and material expiry), on hold and why;
- ageing of submittals at the GC (0–7 / 8–14 / 15–28 / 29+ days), upcoming deliveries with submittal/MIR flags;
- the "where info lives" map.

Every change (manual or imported) is recorded in each record's history: who, when, and which field went from what to what. Imported records link back to the source file.

## Run it (Windows / PowerShell)

Needs Node.js 22.13+ (`node -v`).

```powershell
$env:DB_PATH = "$env:LOCALAPPDATA\dc-quality\qm.db"
$env:PROJECT_NAME = "My project"
npm.cmd start
```

The first time, also set `$env:ADMIN_USER` and `$env:ADMIN_PASSWORD` (10+ characters) to create the admin. Then open http://127.0.0.1:3000.

Keep `DB_PATH` **outside OneDrive** (a synced database file can be corrupted). Uploaded files are stored in an `uploads` folder next to the database, never in Git.

Add a user (in a second window):

```powershell
$env:DB_PATH = "$env:LOCALAPPDATA\dc-quality\qm.db"; $env:USER_PASSWORD = "a-long-password"; npm.cmd run create-user -- jane.doe
```

On macOS/Linux use `DB_PATH=... npm start`. Other settings: `PORT` (3000), `HOST` (127.0.0.1), `UPLOAD_DIR`, `COOKIE_SECURE=1` behind HTTPS, `TRUST_PROXY=1` behind nginx.

### OCR settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `OCR_ENGINE` | `windows` on Windows, else `tesseract` if found | `windows`, `tesseract` or `off` |
| `OCR_LANG` | Windows: your profile languages · Tesseract: `eng` | e.g. `es-ES` / `en-GB` (Windows), `spa` / `eng+spa` (Tesseract) |
| `OCR_MAX_PAGES` | 50 | max scanned pages read per file |

The startup log shows which engine was found. Windows OCR needs the language's OCR component (installed with the display language; *Settings → Time & language → Language* to add more). If IT has locked PowerShell down (Constrained Language Mode), Windows OCR can't run; the app says so, and stores the file as evidence.

## What it can't read (yet)

- **Poor scans**: OCR misreads blurry, skewed or very small text. Scan at 200–300 dpi, straight. Always check OCR previews.
- **Scans saved as JBIG2 or JPEG 2000** (some copiers' "high compression" mode): re-scan as standard PDF/JPEG/TIFF.
- Handwriting is not reliably read.
- **Password-protected / encrypted PDFs**: save or print an unprotected copy.
- **Old `.xls` / `.doc`**: open and "Save As" `.xlsx` / `.docx`.
- Very complex PDF layouts (rotated text, tables drawn as images) may need the column mapping adjusted in the preview.

## Tests

```bash
npm test
```

The suite covers the readers (xlsx/csv/docx/pdf, scanned PDFs with JPEG/CCITT/Flate pages), OCR (real Tesseract tests are skipped when it isn't installed), value parsing, upload → preview → import, re-import, evidence linking, exports, dashboard figures, auth/security, and upgrading a v0.1 database. Fixtures in `test/fixtures` are synthetic (`make_fixtures.py` regenerates them).

## Project layout

```
src/schema.js        the STARTING registers (copied into the database on first run)
src/registry.js      register definitions stored in the DB: validate, compile, cache
src/settings.js      editing registers and document types; learning headings from imports
src/parsers/         zip, xml, xlsx (read+write), csv, docx, pdf readers, png/tiff encoders — no dependencies
src/ocr.js           OCR via Windows built-in OCR (PowerShell) or Tesseract
src/values.js        dates / numbers / yes-no / status parsing
src/importer.js      header detection, column mapping, row planning, commit
src/dashboard.js     dashboard figures
src/uploads.js       file storage (content-addressed, outside git)
src/resources.js     validation, CRUD, optimistic concurrency, activity log
src/db.js            SQLite, migrations, additive schema sync
src/app.js           HTTP routes, security headers
public/              vanilla JS frontend (no build step); settings.js = register/document-type editors
test/                node:test suite + synthetic fixtures
deploy/              systemd, nginx, env example, backup script
docs/                architecture, decision log, roadmap
```

**The repository is public.** Never commit project documents, exports or the database. They live in `DB_PATH` / `UPLOAD_DIR`, which `.gitignore` already excludes when kept inside the repo folder.
