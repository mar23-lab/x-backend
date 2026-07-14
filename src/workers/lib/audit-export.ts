// audit-export.ts · E2 (260707) · auditor self-serve export of the governance audit trail.
//
// Enterprise security teams + external auditors ask for the audit trail as a file they can diff, archive,
// and load into their SIEM — not a paginated JSON API. This turns the existing operator audit read
// (GET /api/v1/audit-log) into CSV (RFC 4180) or JSONL with a FROZEN column order, so an export is stable
// across releases (a reordered/added column would break a downstream loader). Pure (no I/O) → unit-testable.

/** Frozen export column order. Append-only — never reorder or remove (downstream loaders pin positions). */
export const AUDIT_EXPORT_COLUMNS = [
  'occurred_at',
  'actor_user_id',
  'action',
  'target_type',
  'target_id',
  'workspace_id',
  'reason',
  'causation_id',
] as const;

type AuditEntry = Record<string, unknown>;

/** RFC 4180 field: wrap in quotes iff it contains a comma, quote, CR or LF; double embedded quotes. */
function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialize entries to RFC-4180 CSV with the frozen header. Always emits the header row (even if empty). */
export function auditToCsv(entries: AuditEntry[]): string {
  const header = AUDIT_EXPORT_COLUMNS.join(',');
  const rows = (entries || []).map((e) => AUDIT_EXPORT_COLUMNS.map((c) => csvCell(e[c])).join(','));
  return [header, ...rows].join('\r\n');
}

/** Serialize entries to JSONL (one compact JSON object per line, frozen key order). */
export function auditToJsonl(entries: AuditEntry[]): string {
  return (entries || [])
    .map((e) => {
      const ordered: Record<string, unknown> = {};
      for (const c of AUDIT_EXPORT_COLUMNS) ordered[c] = e[c] ?? null;
      return JSON.stringify(ordered);
    })
    .join('\n');
}

export type AuditExportFormat = 'json' | 'csv' | 'jsonl';

/** Parse + validate the ?format param. Unknown/absent → 'json' (the existing default; back-compatible). */
export function parseAuditExportFormat(raw: string | null | undefined): AuditExportFormat {
  const v = String(raw || '').trim().toLowerCase();
  return v === 'csv' || v === 'jsonl' ? v : 'json';
}

// ── W2 (260708) · customer-facing export column sets (CONSERVATIVE redaction — operator decision) ──────
// Receipts expose grounding events + freshness + instrument_kind (agent-vs-human) but NO model/vendor names
// (the "via Xlooop" doctrine); the customer audit export renders operator identities as 'xlooop:operator'
// and OMITS free-text `reason`. Frozen orders — append-only, like AUDIT_EXPORT_COLUMNS.

export const RECEIPT_EXPORT_COLUMNS = [
  'event_id',
  'occurred_at',
  'status',
  'summary',
  'source_tool',
  'instrument_kind',   // agent-vs-human attribution (050) — shown; the principal id is NOT
  'lineage_recorded',  // G7 honesty: false = pre-050 row (actor lineage was not captured then)
] as const;

export const CUSTOMER_AUDIT_EXPORT_COLUMNS = [
  'occurred_at',
  'actor',             // redacted: operator/platform identities render as 'xlooop:operator'
  'action',
  'target_type',
  'target_id',
  'causation_id',      // lineage pointer (an id, not free text) — kept for auditability
] as const;

/** Generic frozen-column serializers (reuse the RFC-4180 cell + JSONL discipline above). */
export function rowsToCsv(columns: readonly string[], entries: AuditEntry[]): string {
  const rows = (entries || []).map((e) => columns.map((c) => csvCell(e[c])).join(','));
  return [columns.join(','), ...rows].join('\r\n');
}
export function rowsToJsonl(columns: readonly string[], entries: AuditEntry[]): string {
  return (entries || []).map((e) => {
    const ordered: Record<string, unknown> = {};
    for (const c of columns) ordered[c] = e[c] ?? null;
    return JSON.stringify(ordered);
  }).join('\n');
}

/** CONSERVATIVE actor redaction for customer-facing audit rows: any internal/operator principal renders as
 *  'xlooop:operator'; a customer's OWN workspace member ids pass through (they already see their teammates). */
export function redactAuditActorForCustomer(actorUserId: unknown, workspaceMemberIds: ReadonlySet<string>): string {
  const id = actorUserId == null ? '' : String(actorUserId);
  if (!id) return 'xlooop:system';
  return workspaceMemberIds.has(id) ? id : 'xlooop:operator';
}
