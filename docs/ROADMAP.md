# Roadmap

## Done: v0.1 skeleton
- [x] Node + SQLite backend, append-only migrations
- [x] Session auth, roles (admin/member), login limiter, CSP
- [x] Submittals, Documents, Trackers, Inspections, Findings modules
- [x] Optimistic concurrency (version + 409)
- [x] Activity log / per-record history
- [x] Vanilla JS UI generated from the schema: search, status filter, overdue highlighting
- [x] Test suite and CI; systemd, nginx and backup configs

## Done: v0.2 document import & dashboard
- [x] Zero-dependency readers: .xlsx/.csv/.docx/.pdf (text PDFs)
- [x] Upload with document type / register choice (or auto-detect), preview, column remapping, row exclusion
- [x] Upsert by register key (re-import applies only differences); single-document form reading
- [x] Evidence files linked to audit checklist items
- [x] Registers: audit checklist, submittals, deliveries, materials, ITPs, benchmarks/FOK, issues/NCRs, calibration, installer tasks, where info lives
- [x] Dashboard: readiness by area, overdue / due soon / on hold, submittal ageing, upcoming deliveries
- [x] .xlsx export per register / all registers, blank templates

## Done: v0.3 scanned documents
- [x] Scanned-page detection; page images extracted (JPEG, CCITT G3/G4 → TIFF, Flate/LZW/RLE → PNG)
- [x] OCR via Windows built-in OCR (no install) or Tesseract; results cached per file
- [x] Photo/scan uploads (.jpg, .png, .tif, .bmp)
- [x] OCR-tolerant matching (joined headings, O/0 and l/1 in dates and numbers)

## Done: v0.4 editable registers
- [x] Registers stored in the database; editor for purpose, columns, types, status options (colour, done / on hold / N/A), rules
- [x] Create / archive registers; hidden columns and archived registers keep their data
- [x] Document types: register, reading mode, file-name words, default audit item, saved column mapping
- [x] Learning: headings mapped by hand at import are remembered by the register and the document type
- [x] Manual column mapping when a chosen register recognises none of a file's headings

## Next: v0.5 import quality
- [ ] Encrypted PDFs with an empty user password (common "protected" exports)
- [ ] Import several files at once
- [ ] Deskew / rotate crooked scans before OCR; JBIG2 scans
- [ ] Training/TBT and O&M/as-built registers

## Later: inspections that are useful in the field
- [ ] Checklist templates per area (UPS, generator, switchgear, CRAH/CRAC, chiller, fire suppression, access control)
- [ ] Starting an inspection from a template creates its findings automatically
- [ ] Inspection status derived from its findings (any open critical finding → cannot pass)
- [ ] Mobile-friendly inspection view for use on the data hall floor

## v0.3 documentation control
- [ ] File attachments (stored on disk, with hashes recorded) for documents and findings
- [ ] Submittal revision history: resubmitting creates rev N+1 linked to rev N
- [ ] Transmittal log (what was sent to whom, and when)
- [ ] Review comments per submittal

## v0.4 non-conformance and reporting
- [ ] NCR module linked to failed findings
- [ ] CAPA (corrective and preventive actions) with verification step
- [ ] Dashboard: submittal turnaround, open items by area or owner, first-time pass rate, overdue counts
- [ ] CSV import/export for existing spreadsheets

## Later
- [ ] Per-project / per-site separation
- [ ] Human-reviewed sync to external systems (contractor portal, DMS, CMMS), using the queue-and-approve pattern proven at Future Aero Lab
- [ ] Email digests of overdue items
