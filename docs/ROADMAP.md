# Roadmap

## Done: v0.1 skeleton
- [x] Node + SQLite backend, append-only migrations
- [x] Session auth, roles (admin/member), login limiter, CSP
- [x] Submittals, Documents, Trackers, Inspections, Findings modules
- [x] Optimistic concurrency (version + 409)
- [x] Activity log / per-record history
- [x] Vanilla JS UI generated from the schema: search, status filter, overdue highlighting
- [x] Test suite and CI; systemd, nginx and backup configs

## Next: v0.2 inspections that are useful in the field
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
