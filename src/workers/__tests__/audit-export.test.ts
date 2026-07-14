// audit-export.test.ts · E2 (260707) — proves the audit-trail export serializers. The adversarial cases
// are the ones that corrupt naive CSV: a comma, an embedded double-quote, and a newline inside a `reason`.
// A regression in escaping or the FROZEN column order (a downstream SIEM loader pins positions) fails here.

import { describe, it, expect } from 'vitest';
import {
  auditToCsv,
  auditToJsonl,
  parseAuditExportFormat,
  AUDIT_EXPORT_COLUMNS,
} from '../lib/audit-export';

const SAMPLE = [
  {
    occurred_at: '2026-07-07T00:00:00.000Z',
    actor_user_id: 'user_1',
    action: 'approve',
    target_type: 'sign_off',
    target_id: 'so_1',
    workspace_id: 'ws_1',
    reason: 'looks good, approved',
    causation_id: 'evt_1',
  },
];

describe('E2 auditToCsv', () => {
  it('emits the frozen header even with zero rows', () => {
    expect(auditToCsv([])).toBe(AUDIT_EXPORT_COLUMNS.join(','));
  });

  it('serializes a row in frozen column order', () => {
    const csv = auditToCsv(SAMPLE);
    const [header, row] = csv.split('\r\n');
    expect(header).toBe('occurred_at,actor_user_id,action,target_type,target_id,workspace_id,reason,causation_id');
    expect(row).toBe('2026-07-07T00:00:00.000Z,user_1,approve,sign_off,so_1,ws_1,"looks good, approved",evt_1');
  });

  it('escapes embedded quotes and newlines (RFC 4180)', () => {
    const csv = auditToCsv([{ ...SAMPLE[0], reason: 'said "no"\nthen yes' }]);
    const row = csv.split('\r\n')[1];
    expect(row).toContain('"said ""no""\nthen yes"');
  });

  it('renders null/undefined cells as empty', () => {
    const csv = auditToCsv([{ occurred_at: 't', actor_user_id: 'u', action: 'a', target_type: 'event', target_id: 'e', workspace_id: null, reason: null, causation_id: null }]);
    expect(csv.split('\r\n')[1]).toBe('t,u,a,event,e,,,');
  });
});

describe('E2 auditToJsonl', () => {
  it('emits one compact JSON object per line with all frozen keys', () => {
    const line = auditToJsonl(SAMPLE).split('\n')[0];
    const parsed = JSON.parse(line);
    expect(Object.keys(parsed)).toEqual([...AUDIT_EXPORT_COLUMNS]);
    expect(parsed.reason).toBe('looks good, approved');
  });

  it('is empty for zero rows', () => {
    expect(auditToJsonl([])).toBe('');
  });
});

describe('E2 parseAuditExportFormat', () => {
  it('maps csv/jsonl and defaults everything else to json', () => {
    expect(parseAuditExportFormat('csv')).toBe('csv');
    expect(parseAuditExportFormat('JSONL')).toBe('jsonl');
    expect(parseAuditExportFormat('xml')).toBe('json');
    expect(parseAuditExportFormat(null)).toBe('json');
    expect(parseAuditExportFormat(undefined)).toBe('json');
  });
});
