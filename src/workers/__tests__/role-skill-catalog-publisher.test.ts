// role-skill-catalog-publisher.test.ts · OAR-W3 (260713) · the mission's 18 publisher acceptance tests.
// Imports the SAME pure lib the CLI uses (scripts/lib/role-skill-catalog.mjs) so determinism/immutability
// are proven on the real implementation, not a re-model.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs lib, intentionally untyped (shared with the CLI + gates)
import {
  parseCatalog, validateCatalog, canonicalJson, sha256Hex, projectEntry, buildRows, buildSql,
  immutabilityCheck, sqlString, toRoleSkillBindings, CLASSIFICATION_WHITELIST, FORBIDDEN_MARKERS,
} from '../../../scripts/lib/role-skill-catalog.mjs';
import { resolveRoleAndSkills } from '../lib/role-skill-resolver';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CATALOG = parseCatalog(readFileSync(resolve(repoRoot, 'docs/contracts/role-skill-catalog.json'), 'utf8'));
const OPTS = { sourceSha: 'f'.repeat(40), approvalRef: 'test-approval' };
const NOW = new Date('2026-07-13T00:00:00.000Z');

function entryLike(over: Record<string, unknown> = {}) {
  return {
    key: 'skill.test.example',
    category: 'skill',
    version: '1.0.0',
    classification: 'customer_visible',
    name: 'Example',
    description: 'A test entry.',
    capability: 'test',
    actions: ['packet:create'],
    allowed_tools: [],
    denied_tools: [],
    requires_approval: false,
    evidence_contract: { resolution: 'role_skill_resolutions', denial: 'authority_denial_receipts' },
    output_schema: 'xlooop.skill_output.v1',
    closing_requirement: 'closing_attestations',
    source_ref: 'docs/contracts/role-skill-catalog.json#skill.test.example',
    ...over,
  };
}

describe('role-skill catalog publisher (OAR-W3)', () => {
  // 1. catalog parses + is schema-valid
  it('T1 · the shipped catalog parses and validates with zero errors', () => {
    expect(CATALOG.schema_id).toBe('xlooop.role_skill_catalog.v1');
    expect(validateCatalog(CATALOG, { agentKeys: [] })).toEqual([]);
    expect(CATALOG.entries.length).toBe(11); // 4 roles + 6 skills + 1 pack
  });

  // 2. classification whitelist rejects internal_sensitive
  it('T2 · internal_sensitive (or unknown) classification is rejected', () => {
    const bad = { ...CATALOG, entries: [entryLike({ classification: 'internal_sensitive' })] };
    expect(validateCatalog(bad).join('\n')).toContain('not publishable');
    expect(CLASSIFICATION_WHITELIST).toEqual(['public', 'customer_visible']);
  });

  // 3. agent-key disjointness (agent-roles.yml is a separate file-only SSOT)
  it('T3 · a key colliding with an automation-agent identity is rejected', () => {
    const bad = { ...CATALOG, entries: [entryLike({ key: 'xlooop:review-scheduler' })] };
    expect(validateCatalog(bad, { agentKeys: ['xlooop:review-scheduler'] }).join('\n')).toContain('HR-NO-PARALLEL-MODEL-1');
  });

  // 4. no MB-P path / forbidden markers in any projected content
  it('T4 · forbidden markers (MB-P paths, internal surfaces) are rejected and absent from the shipped catalog', () => {
    const bad = { ...CATALOG, entries: [entryLike({ description: 'see /Users/maratbasyrov/WIP/MB-P/_sys/skills/x' })] };
    expect(validateCatalog(bad).join('\n')).toContain('forbidden marker');
    const all = canonicalJson(CATALOG.entries.map(projectEntry));
    for (const marker of FORBIDDEN_MARKERS) expect(all).not.toContain(marker);
  });

  // 5. canonicalJson stable under key reorder
  it('T5 · canonicalJson is invariant to object key order', () => {
    const a = { b: 1, a: [{ y: 2, x: 3 }] };
    const b = { a: [{ x: 3, y: 2 }], b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  // 6. sha256 format matches the DB CHECK + stable across runs
  it('T6 · content hashes are 64-hex and identical across two buildRows runs', () => {
    const r1 = buildRows(CATALOG, OPTS);
    const r2 = buildRows(CATALOG, OPTS);
    for (const r of r1) expect(r.content_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(r1.map((r: { content_sha256: string }) => r.content_sha256)).toEqual(
      r2.map((r: { content_sha256: string }) => r.content_sha256),
    );
  });

  // 7. hash changes when any consumed field changes
  it('T7 · changing any projected field changes the content hash', () => {
    const base = entryLike();
    const h1 = sha256Hex(canonicalJson(projectEntry(base)));
    const h2 = sha256Hex(canonicalJson(projectEntry({ ...base, description: 'changed.' })));
    expect(h1).not.toBe(h2);
  });

  // 8. dry-run byte-determinism (SQL level; the CLI-level double-run is diffed by the parity gate)
  it('T8 · buildSql output is byte-identical across runs and contains no timestamps', () => {
    const s1 = buildSql(buildRows(CATALOG, OPTS));
    const s2 = buildSql(buildRows(CATALOG, OPTS));
    expect(s1).toBe(s2);
    expect(s1).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // no ISO timestamps in SQL
    expect(s1).not.toContain('now()');
  });

  // 9. SQL structure: BEGIN/COMMIT + all row families
  it('T9 · SQL wraps in BEGIN/COMMIT and inserts definitions + versions (+ bindings when workspace given)', () => {
    const noBind = buildSql(buildRows(CATALOG, OPTS));
    expect(noBind.startsWith('BEGIN;')).toBe(true);
    expect(noBind).toContain('COMMIT;');
    expect((noBind.match(/INSERT INTO template_definitions/g) ?? []).length).toBe(11);
    expect((noBind.match(/INSERT INTO template_versions/g) ?? []).length).toBe(11);
    expect(noBind).not.toContain('tenant_template_bindings');
    const withBind = buildSql(buildRows(CATALOG, OPTS), { workspaceId: 'ws_x' });
    expect((withBind.match(/INSERT INTO tenant_template_bindings/g) ?? []).length).toBe(11);
    expect(withBind).toContain(`'workspace', 'active'`);
  });

  // 10. same key+version+same hash → skip (idempotent republish)
  it('T10 · identical republish is a skip, not a write', () => {
    const rows = buildRows(CATALOG, OPTS);
    const existing = rows.map((r: { key: string; version: string; content_sha256: string }) => ({
      template_key: r.key, version: r.version, content_sha256: r.content_sha256,
    }));
    const { conflicts, skips, publishable } = immutabilityCheck(rows, existing);
    expect(conflicts).toEqual([]);
    expect(skips.length).toBe(11);
    expect(publishable).toEqual([]);
  });

  // 11. same key+version+DIFFERENT hash → hard conflict (the CLI exits 1 with zero SQL)
  it('T11 · hash drift on an existing version is a hard conflict', () => {
    const rows = buildRows(CATALOG, OPTS);
    const existing = [{ template_key: rows[0].key, version: rows[0].version, content_sha256: 'e'.repeat(64) }];
    const { conflicts } = immutabilityCheck(rows, existing);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]).toMatchObject({ key: rows[0].key, version: rows[0].version });
  });

  // 12. sqlString escaping
  it("T12 · sqlString escapes embedded quotes", () => {
    expect(sqlString("it's a 'test'")).toBe("'it''s a ''test'''");
  });

  // 13. version rows populate every reader-consumed NOT NULL, lifecycle 'approved'
  it('T13 · emitted version rows carry all reader-consumed NOT NULLs and approved lifecycle', () => {
    const sql = buildSql(buildRows(CATALOG, OPTS));
    expect(sql).toContain('content_sha256, redacted_content, source_ref, source_sha, approval_ref, lifecycle_state');
    expect((sql.match(/'approved'\)/g) ?? []).length).toBe(11);
  });

  // 14. binding rows valid (scope + lifecycle + approved_by)
  it('T14 · binding rows are workspace-scoped active with approver + approval_ref', () => {
    const sql = buildSql(buildRows(CATALOG, OPTS), { workspaceId: 'ws_x', approvedBy: 'op_1' });
    expect(sql).toContain(`'ws_x'`);
    expect(sql).toContain(`'op_1'`);
    expect(sql).toContain(`'test-approval'`);
  });

  // 15/16. reader compatibility: the customer reader filters to the safe tier BY CONSTRUCTION
  it('T15/T16 · resolveEffectiveTemplatesRow carries the schema-tolerant classification predicate', () => {
    const src = readFileSync(resolve(repoRoot, 'src/workers/dal/template-policy-store.ts'), 'utf8');
    expect(src).toContain(`COALESCE(to_jsonb(td)->>'classification', 'customer_visible') IN ('public', 'customer_visible')`);
    // and the publisher can never emit an unsafe row in the first place (T2) — belt and braces.
  });

  // 17. kernel parity: catalog projection resolves; the v0 floor stays honest no_catalog
  it('T17 · catalog bindings resolve a covered action; empty floor reports no_catalog', () => {
    const bindings = toRoleSkillBindings(CATALOG);
    expect(bindings.length).toBeGreaterThan(0);
    for (const b of bindings) {
      // exact RoleSkillBinding field parity (kernel consumes these)
      expect(b).toMatchObject({ lifecycle: 'active', source: 'catalog' });
      expect(Array.isArray(b.actions)).toBe(true);
      expect(typeof b.skill_key).toBe('string');
      expect(typeof b.skill_version).toBe('string');
    }
    const input = { tenant: 'ws_1', principal: 'u_1', role: 'role.operator-lead', mode: 'operator', action: 'packet:create' };
    const withCatalog = resolveRoleAndSkills(input, bindings, NOW);
    expect(withCatalog.verdict).toEqual({ allowed: true, reason: 'resolved' });
    expect(withCatalog.skill_coverage).toBe('resolved');
    expect(withCatalog.selected_skills.map((s) => s.key)).toContain('skill.software-delivery.governed-shipping');
    const withFloor = resolveRoleAndSkills(input, [], NOW);
    expect(withFloor.skill_coverage).toBe('no_catalog');
    expect(withFloor.verdict.reason).toBe('skill_not_installed');
  });

  // 18. dry-run exposure scan: emitted SQL carries no forbidden markers
  it('T18 · emitted SQL contains no forbidden markers or internal paths', () => {
    const sql = buildSql(buildRows(CATALOG, OPTS), { workspaceId: 'ws_x' });
    for (const marker of FORBIDDEN_MARKERS) expect(sql).not.toContain(marker);
    expect(sql).not.toContain('internal_sensitive');
  });
});
