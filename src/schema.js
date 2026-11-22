'use strict';

// The STARTING set of registers. On first start these are copied into the
// database (table `registers`), where they are edited in the app (Settings →
// Registers); see src/registry.js. Changing this file does not change an
// existing installation's registers.
//
// Field options:
//   type      string | text | enum | date | number | bool | url
//   aliases   column headings / form labels that mean this field (import)
//   required  must have a value
//   values    (enum) allowed values; `map` normalises imported text to a value;
//             `tones` picks the status colour: ok (green) / warn (amber) / bad (red) / muted
// Tab options:
//   key       field(s) that identify a record, used to update instead of duplicate on import
//   display   field(s) used as the record's title in lists and on the dashboard
//   keywords  words in a filename/document that suggest this tab (auto-detect)
//   done      status values that count as finished (never overdue)
//   hold      status values that count as on hold / blocked
//   due       date field that makes an open record overdue / due soon
//   reason    field shown as the "why" for on-hold records

const DAY = 86400000;
const daysBetween = (fromIso, toIso) => Math.round((Date.parse(toIso) - Date.parse(fromIso)) / DAY);

// Shared review/approval status (submittals, ITPs).
const REVIEW = {
  type: 'enum',
  values: ['not_submitted', 'submitted', 'under_review', 'approved', 'approved_as_noted', 'revise_resubmit', 'rejected', 'on_hold', 'superseded'],
  labels: { approved_as_noted: 'Approved as noted', revise_resubmit: 'Revise & resubmit' },
  tones: {
    approved: 'ok', approved_as_noted: 'ok', submitted: 'warn', under_review: 'warn',
    revise_resubmit: 'bad', rejected: 'bad', on_hold: 'bad', not_submitted: 'muted', superseded: 'muted',
  },
  map: {
    approved: ['code a', 'a', 'approved', 'accepted', 'status a', 'no comments'],
    approved_as_noted: ['code b', 'b', 'approved as noted', 'approved with comments', 'reviewed with comments', 'accepted with comments', 'status b', 'aan'],
    revise_resubmit: ['code c', 'c', 'revise and resubmit', 'revise resubmit', 'r r', 'resubmit', 'status c', 'returned'],
    rejected: ['code d', 'd', 'rejected', 'not approved', 'status d'],
    under_review: ['under review', 'in review', 'pending', 'with gc', 'for review', 'awaiting review', 'review', 'open', 'awaiting approval', 'pending approval'],
    submitted: ['submitted', 'issued', 'sent', 'issued for review'],
    on_hold: ['on hold', 'hold', 'blocked'],
    not_submitted: ['not submitted', 'draft', 'not started', 'to submit', 'planned', 'wip', 'in preparation'],
    superseded: ['superseded', 'void', 'withdrawn', 'cancelled'],
  },
};

const TABS = {
  checklist: {
    label: 'Audit checklist',
    singular: 'Checklist item',
    keywords: ['audit', 'checklist', 'readiness'],
    key: ['ref'],
    display: ['ref', 'item'],
    fields: {
      ref: { label: 'Ref', type: 'string', required: true, max: 32, aliases: ['ref', 'ref no', 'item no', 'no', 'reference', 'id'] },
      area: { label: 'Area', type: 'string', aliases: ['area', 'audit area', 'section', 'category'] },
      item: { label: 'Item', type: 'string', required: true, aliases: ['item', 'requirement', 'audit item', 'check', 'question', 'description'] },
      status: {
        label: 'Status', type: 'enum', default: 'not_checked',
        values: ['ready', 'partial', 'missing', 'not_checked', 'n_a'],
        labels: { n_a: 'N/A' },
        tones: { ready: 'ok', partial: 'warn', missing: 'bad', not_checked: 'muted', n_a: 'muted' },
        map: {
          ready: ['ready', 'yes', 'ok', 'complete', 'done', 'in place', 'green'],
          partial: ['partial', 'partially', 'in progress', 'amber', 'some'],
          missing: ['missing', 'no', 'gap', 'not available', 'red', 'none'],
          not_checked: ['not checked', 'tbc', 'to check', 'unknown', 'not yet checked'],
          n_a: ['n a', 'na', 'not applicable'],
        },
        aliases: ['status', 'readiness', 'rag', 'state'],
      },
      location: { label: 'Where in ACC / TIDP', type: 'string', aliases: ['where in acc tidp', 'where in acc', 'where', 'location', 'acc location', 'evidence location', 'link'] },
      owner: { label: 'Owner', type: 'string', aliases: ['owner', 'responsible', 'action by', 'assigned to'] },
      gap: { label: 'Gap / action needed', type: 'text', aliases: ['gap action needed', 'gap', 'action needed', 'action', 'actions', 'gap action'] },
      qp_ref: { label: 'Quality Plan ref', type: 'string', aliases: ['quality plan ref', 'qp ref', 'qp section', 'plan ref', 'qp'] },
      evidence: { label: 'What to have ready', type: 'text', aliases: ['what to have ready', 'evidence', 'evidence required', 'to have ready', 'what to show'] },
    },
    computed: {
      evidence_files: { label: 'Files', type: 'number' },
    },
    list: ['ref', 'area', 'item', 'status', 'owner', 'gap', 'evidence_files'],
    hold: [],
    done: ['ready', 'n_a'],
  },

  submittals: {
    label: 'Submittal register',
    singular: 'Submittal',
    keywords: ['submittal', 'transmittal', 'submission'],
    key: ['ref'],
    display: ['ref', 'title'],
    fields: {
      ref: { label: 'Ref', type: 'string', required: true, max: 64, aliases: ['ref', 'submittal no', 'submittal number', 'submittal ref', 'submittal id', 'submittal', 'doc no', 'document no', 'document number', 'transmittal no', 'number', 'no', 'id'] },
      title: { label: 'Title', type: 'string', required: true, aliases: ['title', 'description', 'document title', 'submittal title', 'subject', 'name'] },
      system: { label: 'System', type: 'string', aliases: ['system', 'discipline', 'package', 'scope'] },
      revision: { label: 'Rev', type: 'string', max: 16, aliases: ['rev', 'revision', 'rev no', 'version'] },
      date_submitted: { label: 'Date submitted', type: 'date', aliases: ['date submitted', 'submitted', 'submission date', 'date sent', 'sent date', 'submitted date', 'submitted on', 'date'] },
      gc_status: { ...REVIEW, label: 'GC status', default: 'not_submitted', aliases: ['gc status', 'status', 'review status', 'approval status', 'acc status', 'review code', 'code', 'gc review'] },
      blocker: { label: 'Blocker', type: 'text', aliases: ['blocker', 'blocked by', 'blockers', 'hold reason', 'reason', 'issue', 'comments', 'remarks', 'notes'] },
      owner: { label: 'Owner', type: 'string', aliases: ['owner', 'responsible', 'assigned to', 'author', 'prepared by', 'action by', 'originator'] },
    },
    computed: {
      days_in_review: { label: 'Days in review', type: 'number' },
    },
    list: ['ref', 'title', 'system', 'revision', 'date_submitted', 'gc_status', 'days_in_review', 'blocker', 'owner'],
    done: ['approved', 'approved_as_noted', 'superseded'],
    hold: ['on_hold'],
    reason: 'blocker',
  },

  deliveries: {
    label: 'Delivery tracker',
    singular: 'Delivery',
    keywords: ['delivery', 'deliveries', 'purchase order', 'po register', 'logistics'],
    key: ['po', 'item'],
    display: ['po', 'item'],
    fields: {
      po: { label: 'PO', type: 'string', max: 64, aliases: ['po', 'po no', 'po number', 'purchase order', 'order no', 'order number', 'po ref'] },
      item: { label: 'Item', type: 'string', required: true, aliases: ['item', 'description', 'material', 'equipment', 'product', 'item description'] },
      supplier: { label: 'Supplier', type: 'string', aliases: ['supplier', 'vendor', 'manufacturer', 'supplied by'] },
      qty: { label: 'Qty', type: 'number', aliases: ['qty', 'quantity', 'qty ordered', 'ordered qty', 'ordered'] },
      expected_date: { label: 'Expected', type: 'date', aliases: ['expected date', 'expected', 'eta', 'expected delivery', 'planned delivery', 'delivery date', 'required date', 'due date', 'due'] },
      actual_date: { label: 'Actual', type: 'date', aliases: ['actual date', 'actual', 'actual delivery', 'delivered', 'date delivered', 'received date', 'date received', 'delivered on'] },
      status: {
        label: 'Status', type: 'enum', default: 'ordered',
        values: ['ordered', 'in_transit', 'partially_delivered', 'delivered', 'delayed', 'on_hold', 'cancelled'],
        tones: { ordered: 'muted', in_transit: 'warn', partially_delivered: 'warn', delivered: 'ok', delayed: 'bad', on_hold: 'bad', cancelled: 'muted' },
        map: {
          delivered: ['delivered', 'received', 'complete', 'on site', 'arrived'],
          partially_delivered: ['partial', 'partially delivered', 'part delivered', 'partially received'],
          in_transit: ['in transit', 'shipped', 'dispatched', 'on the way'],
          delayed: ['delayed', 'late', 'overdue'],
          on_hold: ['on hold', 'hold', 'blocked'],
          cancelled: ['cancelled', 'canceled', 'void'],
          ordered: ['ordered', 'placed', 'open', 'pending', 'po issued', 'not delivered'],
        },
        aliases: ['status', 'delivery status', 'state'],
      },
      submittal_approved: { label: 'Submittal approved?', type: 'bool', aliases: ['submittal approved', 'approved submittal', 'submittal ok', 'submittal'] },
      mir_done: { label: 'MIR done?', type: 'bool', aliases: ['mir done', 'mir', 'mir complete', 'material inspection', 'material inspection report', 'mir raised'] },
      notes: { label: 'Notes', type: 'text', aliases: ['notes', 'comments', 'remarks', 'hold reason'] },
    },
    list: ['po', 'item', 'supplier', 'qty', 'expected_date', 'actual_date', 'status', 'submittal_approved', 'mir_done'],
    done: ['delivered', 'cancelled'],
    hold: ['on_hold', 'delayed'],
    due: 'expected_date',
    reason: 'notes',
  },

  materials: {
    label: 'Material tracker',
    singular: 'Material',
    keywords: ['material', 'materials', 'stock', 'storage'],
    key: ['item', 'location'],
    display: ['item', 'location'],
    fields: {
      item: { label: 'Item', type: 'string', required: true, aliases: ['item', 'material', 'description', 'product', 'equipment'] },
      delivered_qty: { label: 'Delivered qty', type: 'number', aliases: ['delivered qty', 'delivered', 'qty delivered', 'received qty', 'qty received', 'received'] },
      location: { label: 'Location / storage', type: 'string', aliases: ['location storage', 'location', 'storage', 'storage location', 'store', 'stored at'] },
      installed_qty: { label: 'Installed qty', type: 'number', aliases: ['installed qty', 'installed', 'qty installed'] },
      expiry: { label: 'Expiry', type: 'date', aliases: ['expiry', 'expiry date', 'expires', 'use by', 'shelf life', 'expiration'] },
      installer_area: { label: 'Installer / area', type: 'string', aliases: ['installer area', 'installer', 'area', 'install area', 'zone'] },
      notes: { label: 'Notes', type: 'text', aliases: ['notes', 'comments', 'remarks'] },
    },
    computed: {
      remaining: { label: 'Remaining', type: 'number' },
    },
    list: ['item', 'delivered_qty', 'location', 'installed_qty', 'remaining', 'expiry', 'installer_area'],
    done: [],
    hold: [],
    due: 'expiry',
    dueLabel: 'expires',
    soonDays: 30,
  },

  itps: {
    label: 'ITP register',
    singular: 'ITP',
    keywords: ['itp', 'inspection and test plan', 'inspection & test plan', 'inspection test plan'],
    key: ['itp_no'],
    display: ['itp_no', 'activity'],
    keyPattern: /\b(?:[A-Z0-9]+-)*ITP[-_ ]?[A-Z0-9]*\d[A-Z0-9-]*\b/i,
    fields: {
      itp_no: { label: 'ITP no.', type: 'string', required: true, max: 64, aliases: ['itp no', 'itp number', 'itp ref', 'itp', 'document no', 'doc no', 'document number', 'ref', 'number', 'no'] },
      activity: { label: 'Activity', type: 'string', required: true, aliases: ['activity', 'title', 'description', 'scope', 'itp title', 'work activity', 'document title'] },
      system: { label: 'System', type: 'string', aliases: ['system', 'discipline', 'package'] },
      revision: { label: 'Rev', type: 'string', max: 16, aliases: ['rev', 'revision', 'rev no', 'version'] },
      approval_status: { ...REVIEW, label: 'Approval status', default: 'not_submitted', aliases: ['approval status', 'status', 'gc status', 'review status', 'review code', 'code'] },
      linked_checklists: { label: 'Linked checklists', type: 'text', aliases: ['linked checklists', 'checklists', 'check sheets', 'checksheets', 'itcs', 'itc', 'forms', 'linked forms'] },
      notes: { label: 'Notes', type: 'text', aliases: ['notes', 'comments', 'remarks', 'hold reason'] },
    },
    list: ['itp_no', 'activity', 'system', 'revision', 'approval_status', 'linked_checklists'],
    done: ['approved', 'approved_as_noted', 'superseded'],
    hold: ['on_hold'],
    reason: 'notes',
  },

  benchmarks: {
    label: 'Benchmark / FOK register',
    singular: 'Benchmark',
    keywords: ['benchmark', 'fok', 'first of kind', 'first off', 'smbf'],
    key: ['item', 'location'],
    display: ['item', 'location'],
    fields: {
      item: { label: 'Item', type: 'string', required: true, aliases: ['item', 'benchmark', 'description', 'activity', 'element'] },
      system: { label: 'System', type: 'string', aliases: ['system', 'discipline', 'package'] },
      location: { label: 'Location', type: 'string', aliases: ['location', 'area', 'room', 'zone', 'level'] },
      responsible: { label: 'Responsible party', type: 'string', aliases: ['responsible party', 'responsible', 'owner', 'by', 'contractor'] },
      status: {
        label: 'Status', type: 'enum', default: 'planned',
        values: ['planned', 'ready_for_inspection', 'inspected', 'approved', 'rejected', 'on_hold'],
        tones: { planned: 'muted', ready_for_inspection: 'warn', inspected: 'warn', approved: 'ok', rejected: 'bad', on_hold: 'bad' },
        map: {
          approved: ['approved', 'accepted', 'signed off', 'closed', 'complete'],
          inspected: ['inspected', 'awaiting approval', 'pending approval'],
          ready_for_inspection: ['ready for inspection', 'ready', 'rfi', 'requested'],
          rejected: ['rejected', 'failed', 'not accepted'],
          on_hold: ['on hold', 'hold', 'blocked'],
          planned: ['planned', 'open', 'not started', 'pending', 'tbc'],
        },
        aliases: ['status', 'state'],
      },
      approval_date: { label: 'Approval date', type: 'date', aliases: ['approval date', 'approved date', 'date approved', 'sign off date', 'signed off', 'date'] },
      comments: { label: 'Comments', type: 'text', aliases: ['comments', 'notes', 'remarks', 'hold reason'] },
    },
    list: ['item', 'system', 'location', 'responsible', 'status', 'approval_date', 'comments'],
    done: ['approved'],
    hold: ['on_hold'],
    reason: 'comments',
  },

  issues: {
    label: 'Issues / NCR log',
    singular: 'Issue',
    keywords: ['ncr', 'non conformance', 'non-conformance', 'snag', 'issue', 'issues', 'defect', 'punch'],
    key: ['issue_id'],
    display: ['issue_id', 'description'],
    keyPattern: /\b(?:NCR|SNAG|ISS(?:UE)?)[-_ ]?\d+[A-Z0-9-]*\b/i,
    fields: {
      issue_id: { label: 'ID', type: 'string', required: true, max: 64, aliases: ['id', 'issue id', 'ncr no', 'ncr number', 'ncr ref', 'ncr', 'issue no', 'issue number', 'snag no', 'ref', 'number', 'no'] },
      type: {
        label: 'Type', type: 'enum', default: 'issue', values: ['issue', 'snag', 'ncr', 'observation'],
        labels: { ncr: 'NCR' },
        tones: { issue: 'muted', snag: 'muted', ncr: 'muted', observation: 'muted' },
        map: { ncr: ['ncr', 'non conformance', 'nonconformance'], snag: ['snag', 'punch', 'defect'], observation: ['observation', 'obs'], issue: ['issue'] },
        aliases: ['type', 'category', 'issue type'],
      },
      description: { label: 'Description', type: 'text', required: true, aliases: ['description', 'issue', 'title', 'details', 'non conformance', 'nonconformance', 'subject', 'issue description'] },
      location: { label: 'Location', type: 'string', aliases: ['location', 'area', 'room', 'zone', 'level'] },
      owner: { label: 'Owner', type: 'string', aliases: ['owner', 'assigned to', 'responsible', 'action by', 'assignee', 'responsible party'] },
      raised_date: { label: 'Raised', type: 'date', aliases: ['raised date', 'raised', 'date raised', 'date opened', 'opened', 'created', 'created on', 'open date', 'date'] },
      target_date: { label: 'Target', type: 'date', aliases: ['target date', 'target', 'due date', 'due', 'close by', 'target close', 'required by'] },
      status: {
        label: 'Status', type: 'enum', default: 'open',
        values: ['open', 'in_progress', 'ready_to_inspect', 'closed', 'on_hold', 'void'],
        tones: { open: 'warn', in_progress: 'warn', ready_to_inspect: 'warn', closed: 'ok', on_hold: 'bad', void: 'muted' },
        map: {
          closed: ['closed', 'complete', 'resolved', 'done', 'verified', 'signed off'],
          ready_to_inspect: ['ready to inspect', 'ready for inspection', 'work completed', 'ready for review', 'ready to close'],
          in_progress: ['in progress', 'work in progress', 'wip', 'ongoing', 'answered'],
          on_hold: ['on hold', 'hold', 'blocked'],
          void: ['void', 'cancelled', 'not valid', 'duplicate'],
          open: ['open', 'new', 'raised', 'draft', 'pending'],
        },
        aliases: ['status', 'state'],
      },
      notes: { label: 'Notes', type: 'text', aliases: ['notes', 'comments', 'remarks', 'hold reason', 'action', 'corrective action'] },
    },
    computed: {
      age_days: { label: 'Age (days)', type: 'number' },
    },
    list: ['issue_id', 'type', 'description', 'location', 'owner', 'raised_date', 'target_date', 'status', 'age_days'],
    done: ['closed', 'void'],
    hold: ['on_hold'],
    due: 'target_date',
    reason: 'notes',
  },

  calibration: {
    label: 'Calibration register',
    singular: 'Instrument',
    keywords: ['calibration', 'calibrated', 'cal cert', 'certificate of calibration'],
    key: ['cal_id'],
    display: ['cal_id', 'equipment'],
    fields: {
      cal_id: { label: 'ID', type: 'string', required: true, max: 64, aliases: ['id', 'equipment id', 'asset id', 'asset no', 'asset number', 'tag', 'tag no', 'instrument id', 'serial no', 'serial number', 'serial', 's n', 'id no'] },
      equipment: { label: 'Equipment', type: 'string', required: true, aliases: ['equipment', 'instrument', 'description', 'item', 'equipment description', 'tool', 'unit under test'] },
      make_model: { label: 'Make / model', type: 'string', aliases: ['make model', 'make', 'model', 'manufacturer', 'manufacturer model', 'model no', 'type'] },
      cal_date: { label: 'Cal date', type: 'date', aliases: ['cal date', 'calibration date', 'date calibrated', 'calibrated', 'calibrated on', 'last calibration', 'date of calibration', 'date of issue', 'issue date'] },
      due_date: { label: 'Due date', type: 'date', aliases: ['due date', 'next due', 'next due date', 'next calibration', 'next calibration date', 'recalibration date', 'cal due', 'calibration due', 'due', 'valid until', 'expiry', 'expiry date', 're calibration due'] },
      certificate: { label: 'Certificate', type: 'string', aliases: ['certificate', 'certificate no', 'certificate number', 'cert no', 'cert number', 'cert', 'cert ref', 'certificate ref'] },
      notes: { label: 'Notes', type: 'text', aliases: ['notes', 'comments', 'remarks'] },
    },
    list: ['cal_id', 'equipment', 'make_model', 'cal_date', 'due_date', 'certificate'],
    done: [],
    hold: [],
    due: 'due_date',
    dueLabel: 'calibration due',
    soonDays: 30,
  },

  tasks: {
    label: 'Installer task list',
    singular: 'Task',
    keywords: ['task', 'tasks', 'installer', 'installation plan', 'look ahead', 'lookahead'],
    key: ['area', 'task'],
    display: ['task', 'area'],
    fields: {
      area: { label: 'Area', type: 'string', aliases: ['area', 'location', 'zone', 'room', 'level'] },
      task: { label: 'Task', type: 'string', required: true, aliases: ['task', 'activity', 'description', 'work', 'work item'] },
      installer: { label: 'Installer', type: 'string', aliases: ['installer', 'assigned to', 'crew', 'team', 'subcontractor', 'responsible', 'owner'] },
      start_date: { label: 'Start', type: 'date', aliases: ['start', 'start date', 'planned start', 'from'] },
      end_date: { label: 'End', type: 'date', aliases: ['end', 'end date', 'finish', 'finish date', 'planned finish', 'to', 'due', 'due date'] },
      materials_needed: { label: 'Materials needed', type: 'text', aliases: ['materials needed', 'materials', 'material', 'materials required'] },
      status: {
        label: 'Status', type: 'enum', default: 'not_started',
        values: ['not_started', 'in_progress', 'complete', 'on_hold', 'blocked'],
        tones: { not_started: 'muted', in_progress: 'warn', complete: 'ok', on_hold: 'bad', blocked: 'bad' },
        map: {
          complete: ['complete', 'completed', 'done', 'finished', 'closed'],
          in_progress: ['in progress', 'started', 'ongoing', 'wip'],
          on_hold: ['on hold', 'hold', 'paused'],
          blocked: ['blocked', 'stopped', 'waiting'],
          not_started: ['not started', 'planned', 'open', 'to do', 'todo', 'pending'],
        },
        aliases: ['status', 'state', 'progress'],
      },
      notes: { label: 'Notes / hold reason', type: 'text', aliases: ['notes', 'comments', 'remarks', 'hold reason', 'blocker', 'reason'] },
    },
    list: ['area', 'task', 'installer', 'start_date', 'end_date', 'materials_needed', 'status'],
    done: ['complete'],
    hold: ['on_hold', 'blocked'],
    due: 'end_date',
    reason: 'notes',
  },

  sources: {
    label: 'Where info lives',
    singular: 'Register',
    keywords: ['where info lives', 'tracker map', 'information map'],
    key: ['register'],
    display: ['register'],
    fields: {
      register: { label: 'Register / tracker', type: 'string', required: true, aliases: ['register', 'tracker', 'name', 'register tracker'] },
      status: {
        label: 'Status', type: 'enum', default: 'unknown', values: ['have', 'partial', 'need', 'unknown'],
        labels: { need: 'Need to build', unknown: 'Not sure yet' },
        tones: { have: 'ok', partial: 'warn', need: 'bad', unknown: 'muted' },
        map: { have: ['have', 'yes', 'in place'], partial: ['partial', 'partly'], need: ['need', 'need to build', 'missing', 'no'], unknown: ['unknown', 'not sure', 'not sure yet', 'tbc'] },
        aliases: ['status'],
      },
      location: { label: 'Where the info lives today', type: 'string', aliases: ['where info lives', 'where', 'location', 'source', 'lives'] },
      audit_areas: { label: 'Audit areas', type: 'string', aliases: ['audit areas', 'areas', 'supports', 'audit area'] },
      needed_for_audit: { label: 'Needed for audit?', type: 'bool', aliases: ['needed for audit', 'audit', 'required for audit'] },
      owner: { label: 'Owner', type: 'string', aliases: ['owner', 'responsible'] },
      notes: { label: 'Notes', type: 'text', aliases: ['notes', 'comments'] },
    },
    list: ['register', 'status', 'location', 'audit_areas', 'needed_for_audit', 'owner'],
    done: ['have'],
    hold: [],
  },
};

// Starting content for "Where info lives" (generic; edit in the app).
const SOURCES_SEED = [
  ['Audit readiness checklist', 'have', 'Audit checklist workbook', 'All areas', 'yes'],
  ['Submittal register', 'partial', 'ACC + GC review', 'Technical submittals', 'yes'],
  ['Issues, snags and NCR log', 'partial', 'ACC Issues', 'Defects, snags & NCRs', 'yes'],
  ['ITP register', 'need', 'ITPs exist, register not updated', 'ITPs & checklists, workmanship', 'yes'],
  ['Inspection and test register', 'need', 'Scattered check sheets / WIRs', 'ITPs, testing & inspection', 'yes'],
  ['Benchmark / FOK register', 'need', 'Ask site team', 'Benchmarks / FOK, workmanship', 'yes'],
  ['Calibration register', 'unknown', 'Commissioning engineer?', 'Testing, materials & calibration', 'yes'],
  ['Training, TBT and competency', 'unknown', 'HR / site supervisor?', 'Quality resources, briefings / TBTs', 'yes'],
  ['O&M and as-built registers', 'unknown', 'Document control?', 'Approvals & handover', 'yes'],
  ['Delivery tracker', 'need', 'Emails / site team', 'Materials', 'no'],
  ['Material tracker', 'need', 'Nothing yet', 'Materials', 'yes'],
  ['Installer task list', 'need', 'Installation lead', 'Supports material tracking', 'no'],
  ['Programmer clarifications log', 'need', 'Emails and chats', 'RFIs / scope', 'no'],
];

const ORDER = Object.keys(TABS);

module.exports = { TABS, ORDER, SOURCES_SEED, daysBetween };
