'use strict';

// Single source of truth for every module. The database tables, API validation
// and the frontend's forms/tables are all generated from these definitions,
// so adding a field or a module is a change in one place.

const SUBMITTAL_STATUSES = [
  'draft', 'submitted', 'under_review', 'approved',
  'approved_as_noted', 'revise_resubmit', 'rejected',
];
const DISCIPLINES = [
  'electrical', 'mechanical', 'cooling', 'fire_protection',
  'security', 'structural', 'it_network', 'general',
];

const RESOURCES = {
  submittals: {
    label: 'Submittals',
    singular: 'Submittal',
    fields: {
      ref: { label: 'Ref #', type: 'string', required: true, max: 64 },
      title: { label: 'Title', type: 'string', required: true },
      discipline: { label: 'Discipline', type: 'enum', values: DISCIPLINES, default: 'general' },
      revision: { label: 'Rev', type: 'string', max: 16, default: '0' },
      contractor: { label: 'Contractor', type: 'string' },
      status: { label: 'Status', type: 'enum', values: SUBMITTAL_STATUSES, default: 'draft' },
      due_date: { label: 'Review due', type: 'date' },
      notes: { label: 'Notes', type: 'text' },
    },
    list: ['ref', 'title', 'discipline', 'revision', 'status', 'due_date'],
  },

  documents: {
    label: 'Documents',
    singular: 'Document',
    fields: {
      title: { label: 'Title', type: 'string', required: true },
      doc_type: {
        label: 'Type', type: 'enum', default: 'other',
        values: ['drawing', 'specification', 'datasheet', 'method_statement',
          'test_report', 'om_manual', 'certificate', 'procedure', 'other'],
      },
      revision: { label: 'Rev', type: 'string', max: 16, default: '0' },
      url: { label: 'Link', type: 'url' },
      submittal_id: { label: 'Submittal', type: 'ref', ref: 'submittals', display: 'ref' },
      status: { label: 'Status', type: 'enum', values: ['current', 'superseded', 'withdrawn'], default: 'current' },
    },
    list: ['title', 'doc_type', 'revision', 'submittal_id', 'status', 'url'],
  },

  trackers: {
    label: 'Trackers',
    singular: 'Tracker item',
    fields: {
      tracker: {
        label: 'Tracker', type: 'enum', required: true,
        values: ['punch_list', 'rfi', 'snag', 'commissioning', 'action_item'],
      },
      title: { label: 'Title', type: 'string', required: true },
      location: { label: 'Location', type: 'string' },
      owner: { label: 'Owner', type: 'string' },
      priority: { label: 'Priority', type: 'enum', values: ['low', 'medium', 'high', 'critical'], default: 'medium' },
      status: { label: 'Status', type: 'enum', values: ['open', 'in_progress', 'blocked', 'closed'], default: 'open' },
      due_date: { label: 'Due', type: 'date' },
      notes: { label: 'Notes', type: 'text' },
    },
    list: ['tracker', 'title', 'location', 'owner', 'priority', 'status', 'due_date'],
  },

  inspections: {
    label: 'Inspections',
    singular: 'Inspection',
    fields: {
      title: { label: 'Title', type: 'string', required: true },
      kind: { label: 'Kind', type: 'enum', values: ['inspection', 'audit', 'witness_test'], default: 'inspection' },
      area: {
        label: 'Area', type: 'enum', default: 'general',
        values: ['power', 'cooling', 'rack_cabling', 'fire', 'security', 'civil', 'general'],
      },
      location: { label: 'Location', type: 'string' },
      inspector: { label: 'Inspector', type: 'string' },
      scheduled_date: { label: 'Date', type: 'date' },
      status: {
        label: 'Status', type: 'enum', default: 'scheduled',
        values: ['scheduled', 'in_progress', 'passed', 'passed_with_findings', 'failed', 'cancelled'],
      },
      notes: { label: 'Notes', type: 'text' },
    },
    list: ['title', 'kind', 'area', 'location', 'inspector', 'scheduled_date', 'status'],
  },

  findings: {
    label: 'Findings',
    singular: 'Finding',
    fields: {
      inspection_id: { label: 'Inspection', type: 'ref', ref: 'inspections', display: 'title', required: true },
      item: { label: 'Checklist item', type: 'string', required: true },
      result: { label: 'Result', type: 'enum', values: ['pass', 'fail', 'observation', 'n_a'], default: 'pass' },
      severity: { label: 'Severity', type: 'enum', values: ['minor', 'major', 'critical'], default: 'minor' },
      status: { label: 'Status', type: 'enum', values: ['open', 'closed'], default: 'open' },
      note: { label: 'Note', type: 'text' },
    },
    list: ['inspection_id', 'item', 'result', 'severity', 'status'],
  },
};

// Tables must be created parents-first so foreign keys resolve.
const ORDER = ['submittals', 'documents', 'trackers', 'inspections', 'findings'];

module.exports = { RESOURCES, ORDER };
