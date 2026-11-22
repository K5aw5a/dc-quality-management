# Decision log

Short records of the decisions that shape the system: what was decided, why, and what was given up.

---

### D1: Zero runtime dependencies, no build step
**Decision:** Node.js standard library only (`node:http`, `node:sqlite`, `node:crypto`, `node:test`), with plain JS in the browser.
**Why:** It's small enough for one person to own end to end, has no supply-chain or upgrade churn, and deploying is just `git pull` plus a restart.
**Trade-off:** Routing, validation and UI rendering are hand-written. That's acceptable at this size. Revisit if the frontend grows past a few thousand lines.

### D2: SQLite as the system of record
**Decision:** A single SQLite file in WAL mode.
**Why:** The team is tens of users, not thousands. SQLite gives transactions, foreign keys and trivial backups (`.backup`) with no database server to run.
**Trade-off:** Single host. If multi-site writes are ever needed, the data layer is isolated in `db.js` / `resources.js`.
**Note:** `node:sqlite` is still marked experimental in Node 22. The warning is suppressed in the npm scripts. Pin the Node major version in production.

### D3: Schema-driven modules
**Decision:** One declarative definition (`schema.js`) drives tables, validation and UI.
**Why:** QA/QC registers are numerous and similar (a list of items with status, owner, due date and location). New trackers should be cheap to add.
**Trade-off:** Module-specific behaviour (for example checklist templates) needs explicit code on top of the generic layer.

### D4: Optimistic concurrency instead of locking
**Decision:** A version column per record, `409` on a stale write.
**Why:** Edits are mostly to different records. Conflicts are rare, and when they happen it's better to refuse than to overwrite.
**Trade-off:** The user must reopen and re-apply their change on conflict.

### D5: Activity log written in the same transaction as the change
**Decision:** Every write records the user, the action and a field-level diff, atomically.
**Why:** Traceability ("who approved this submittal, and when?") is a core requirement of a quality management system, not an add-on.

### D6: Login required from the first boot
**Decision:** The server never runs without users. The first admin is created from env vars or the CLI.
**Why:** Avoids an "open until someone sets up auth" window. Lesson carried over from Future Aero Lab, where adding login later meant a staged rollout to the whole team.

### D7: Case-insensitive usernames
**Decision:** `COLLATE NOCASE` on `users.username`.
**Why:** Lesson carried over from Future Aero Lab, where a case-sensitivity bug broke login during rollout.

### D8: Write our own file readers instead of using libraries
**Decision:** .xlsx/.docx (zip + XML) and PDF text extraction are implemented in `src/parsers/` with no dependencies.
**Why:** The tool runs on an admin-managed laptop where installing packages is hard, and keeping zero dependencies keeps setup to just `git pull`. Office files are zipped XML, which is small to read. PDF text extraction is the hard part: ours covers text PDFs exported from Word, Excel and reporting tools.
**Trade-off:** No OCR, no encrypted PDFs, and unusual PDF layouts may need the column mapping fixed in the preview. Revisit (e.g. vendor pdf.js) if real documents keep failing.

### D9: Every import is previewed and approved by a person
**Decision:** Uploading only reads a file. Writing happens on an explicit Import, after the user has seen new/updated/unchanged rows and can remap columns or untick rows.
**Why:** Registers are audit evidence; a wrong automatic mapping must never silently overwrite good data. Same principle as the human-reviewed HubSpot sync at Future Aero Lab. Empty cells never clear values, and re-imports only apply differences.

### D10: Uploaded files and data stay out of Git
**Decision:** Files are stored by SHA-256 in `UPLOAD_DIR` (default: next to the database). Fixtures are synthetic.
**Why:** The repository is public and the documents belong to client projects.
