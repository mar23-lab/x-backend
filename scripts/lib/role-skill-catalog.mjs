// scripts/lib/role-skill-catalog.mjs · OAR-W3 (260713) · PURE catalog logic shared by the publisher CLI,
// the parity gate, and the vitest suite — one canonical serializer/hasher so "deterministic" is a single
// implementation, not three copies.
//
// Doctrine (approved plan, Track B):
//   * The catalog SSOT is docs/contracts/role-skill-catalog.json (customer-safe contracts, curated fresh —
//     NEVER extracted MB-P bodies). The publisher projects it into the mig-035 tables.
//   * classification whitelist: only 'public' | 'customer_visible' may ever be published.
//   * agent-key disjointness: keys in docs/contracts/agent-roles.yml (file-only SSOT) are FORBIDDEN here.
//   * Determinism: canonical key-ordered JSON, sha256 hex, deterministic ids from hashes, NO timestamps
//     in emitted SQL (timestamps live only in the publish receipt file).
//   * Immutability: same (key, version) with a different content hash is a HARD ERROR before any SQL.

import { createHash } from 'node:crypto';

export const CLASSIFICATION_WHITELIST = Object.freeze(['public', 'customer_visible']);
export const CATEGORIES = Object.freeze(['role', 'skill', 'pack', 'tool']);
export const SOURCE_PACKAGES = Object.freeze(['xcp-platform-templates', 'approved-mbp-projection', 'customer-safe-pack']);

/** Markers that must never appear in any published payload (mirrors FORBIDDEN_SURFACES + raw-path scan). */
export const FORBIDDEN_MARKERS = Object.freeze([
  '/Users/maratbasyrov/WIP/MB-P',
  '_sys/skills',
  'HARD_RULES',
  'governance_scoring',
  'agent_routing',
  'private_graph_schema',
  'raw_graph:',
  'search_all_memory:',
]);

/** Overlay keys published content must not RELY on (they are dropped by applyAllowedOverlay). */
export const FORBIDDEN_OVERRIDE_KEYS = Object.freeze([
  'security', 'retention', 'approval', 'redaction', 'forbidden_surfaces', 'tenant_isolation',
  'raw_graph', 'full_tenant_memory', 'governance_scoring', 'agent_routing', 'private_graph_schema',
  'secrets', 'search_all_memory',
]);

const REQUIRED_FIELDS = Object.freeze([
  'key', 'category', 'version', 'classification', 'name', 'description', 'capability', 'actions',
  'allowed_tools', 'denied_tools', 'requires_approval', 'evidence_contract', 'output_schema',
  'closing_requirement', 'source_ref',
]);

export function sha256Hex(payload) {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/** Stable key-ordered JSON — object keys sorted recursively; arrays keep author order (it is meaningful). */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The customer-safe projection persisted as template_versions.redacted_content. Field allow-list —
 *  anything not named here (including future authoring-side fields) NEVER reaches the DB. */
export function projectEntry(entry) {
  const p = {
    schema_id: 'xlooop.role_skill_contract.v1',
    key: entry.key,
    category: entry.category,
    version: entry.version,
    classification: entry.classification,
    name: entry.name,
    description: entry.description,
    capability: entry.capability,
    actions: entry.actions,
    allowed_tools: entry.allowed_tools,
    denied_tools: entry.denied_tools,
    requires_approval: entry.requires_approval,
    evidence_contract: entry.evidence_contract,
    output_schema: entry.output_schema,
    closing_requirement: entry.closing_requirement,
  };
  if (entry.skills) p.skills = entry.skills;
  if (entry.roles) p.roles = entry.roles;
  return p;
}

export function parseCatalog(jsonText) {
  const catalog = JSON.parse(jsonText);
  if (catalog.schema_id !== 'xlooop.role_skill_catalog.v1') {
    throw new Error(`unexpected schema_id: ${catalog.schema_id}`);
  }
  return catalog;
}

/** Validate the whole catalog. Returns string[] of failures (empty = valid). Pure. */
export function validateCatalog(catalog, opts = {}) {
  const errs = [];
  const agentKeys = new Set(opts.agentKeys ?? []);
  if (!SOURCE_PACKAGES.includes(catalog.source_package)) {
    errs.push(`source_package '${catalog.source_package}' not one of the 3 permitted mig-035 literals`);
  }
  const seen = new Set();
  const byKeyVersion = new Map();
  for (const e of catalog.entries ?? []) {
    for (const f of REQUIRED_FIELDS) {
      if (e[f] === undefined || e[f] === null) errs.push(`${e.key ?? '<missing key>'}: missing required field '${f}'`);
    }
    if (!CATEGORIES.includes(e.category)) errs.push(`${e.key}: category '${e.category}' not in ${CATEGORIES.join('|')}`);
    if (!CLASSIFICATION_WHITELIST.includes(e.classification)) {
      errs.push(`${e.key}: classification '${e.classification}' is not publishable (whitelist: ${CLASSIFICATION_WHITELIST.join('|')})`);
    }
    if (seen.has(e.key)) errs.push(`duplicate key: ${e.key}`);
    seen.add(e.key);
    byKeyVersion.set(`${e.key}@${e.version}`, e);
    if (agentKeys.has(e.key)) {
      errs.push(`${e.key}: collides with a docs/contracts/agent-roles.yml automation-agent identity (file-only SSOT; HR-NO-PARALLEL-MODEL-1)`);
    }
    const text = canonicalJson(projectEntry(e));
    for (const marker of FORBIDDEN_MARKERS) {
      if (text.includes(marker)) errs.push(`${e.key}: projected content contains forbidden marker '${marker}'`);
    }
    // published content must not RELY on protected overlay keys as its own top-level payload keys
    for (const k of FORBIDDEN_OVERRIDE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(projectEntry(e), k)) {
        errs.push(`${e.key}: projected content uses protected overlay key '${k}'`);
      }
    }
  }
  // referential integrity: role→skills and pack→roles/skills must name published key@version pairs
  for (const e of catalog.entries ?? []) {
    for (const ref of [...(e.skills ?? []), ...(e.roles ?? [])]) {
      if (!byKeyVersion.has(ref)) errs.push(`${e.key}: references '${ref}' which is not in this catalog`);
    }
  }
  return errs;
}

/** Deterministic ids: hash-derived so two dry-runs are byte-identical. */
export function definitionId(templateKey) {
  return `td_${sha256Hex(templateKey).slice(0, 16)}`;
}
export function versionId(templateKey, version) {
  return `tv_${sha256Hex(`${templateKey}@${version}`).slice(0, 16)}`;
}

/** Build publishable row models (with content hashes). Pure; sourceSha injected by the CLI. */
export function buildRows(catalog, { sourceSha, approvalRef }) {
  return (catalog.entries ?? []).map((e) => {
    const projected = projectEntry(e);
    const canonical = canonicalJson(projected);
    return {
      key: e.key,
      category: e.category,
      version: e.version,
      classification: e.classification,
      name: e.name,
      description: e.description,
      definition_id: definitionId(e.key),
      version_id: versionId(e.key, e.version),
      content_sha256: sha256Hex(canonical),
      redacted_content: canonical,
      source_package: catalog.source_package,
      source_ref: e.source_ref,
      source_sha: sourceSha,
      approval_ref: approvalRef,
    };
  });
}

export function sqlString(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** Emit the deterministic publish SQL. NO timestamps, NO random ids — byte-identical across runs.
 *  Immutability belt: ON CONFLICT DO NOTHING only guards races; the REAL same-version/different-hash
 *  hard-failure happens in the CLI pre-check BEFORE this SQL is ever produced. */
export function buildSql(rows, opts = {}) {
  const lines = ['BEGIN;', ''];
  for (const r of rows) {
    lines.push(
      `INSERT INTO template_definitions (id, template_key, name, description, category, classification, source_package, source_ref, authority_level)`,
      `VALUES (${sqlString(r.definition_id)}, ${sqlString(r.key)}, ${sqlString(r.name)}, ${sqlString(r.description)}, ${sqlString(r.category)}, ${sqlString(r.classification)}, ${sqlString(r.source_package)}, ${sqlString(r.source_ref)}, 'approved_projection')`,
      `ON CONFLICT (template_key) DO NOTHING;`,
      '',
      `INSERT INTO template_versions (id, template_id, version, content_sha256, redacted_content, source_ref, source_sha, approval_ref, lifecycle_state)`,
      `VALUES (${sqlString(r.version_id)}, ${sqlString(r.definition_id)}, ${sqlString(r.version)}, ${sqlString(r.content_sha256)}, ${sqlString(r.redacted_content)}::jsonb, ${sqlString(r.source_ref)}, ${sqlString(r.source_sha)}, ${sqlString(r.approval_ref)}, 'approved')`,
      `ON CONFLICT (template_id, version) DO NOTHING;`,
      '',
    );
  }
  if (opts.workspaceId) {
    for (const r of rows) {
      lines.push(
        `INSERT INTO tenant_template_bindings (id, workspace_id, template_id, version_id, binding_scope, lifecycle_state, approved_by, approval_ref)`,
        `VALUES (${sqlString(`tb_${sha256Hex(`${opts.workspaceId}:${r.key}@${r.version}`).slice(0, 16)}`)}, ${sqlString(opts.workspaceId)}, ${sqlString(r.definition_id)}, ${sqlString(r.version_id)}, 'workspace', 'active', ${sqlString(opts.approvedBy ?? 'operator')}, ${sqlString(r.approval_ref)})`,
        `ON CONFLICT (id) DO NOTHING;`,
        '',
      );
    }
  }
  lines.push('COMMIT;', '');
  lines.push('-- Verify (read-only, after apply):');
  lines.push(`--   SELECT count(*) FROM template_definitions WHERE category IN ('role','skill','pack','tool'); -- expect ${rows.length}`);
  lines.push(`--   SELECT count(*) FROM template_versions tv JOIN template_definitions td ON td.id = tv.template_id WHERE td.category IN ('role','skill','pack','tool') AND tv.lifecycle_state = 'approved'; -- expect ${rows.length}`);
  return lines.join('\n');
}

/** Compare desired rows to existing (template_key, version, content_sha256) triplets.
 *  Returns { conflicts, skips, publishable }. A conflict = same key+version, DIFFERENT hash = hard error. */
export function immutabilityCheck(rows, existingTriplets) {
  const existing = new Map(existingTriplets.map((t) => [`${t.template_key}@${t.version}`, t.content_sha256]));
  const conflicts = [];
  const skips = [];
  const publishable = [];
  for (const r of rows) {
    const prior = existing.get(`${r.key}@${r.version}`);
    if (prior === undefined) publishable.push(r);
    else if (prior === r.content_sha256) skips.push(r);
    else conflicts.push({ key: r.key, version: r.version, existing_hash: prior, new_hash: r.content_sha256 });
  }
  return { conflicts, skips, publishable };
}

/** Project a published catalog entry into the resolver kernel's RoleSkillBinding shape (parity seam).
 *  Roles bind their referenced skills; skills bind themselves. Packs/tools have no direct binding. */
export function toRoleSkillBindings(catalog) {
  const skills = new Map(
    (catalog.entries ?? []).filter((e) => e.category === 'skill').map((e) => [`${e.key}@${e.version}`, e]),
  );
  const bindings = [];
  for (const role of (catalog.entries ?? []).filter((e) => e.category === 'role')) {
    for (const ref of role.skills ?? []) {
      const skill = skills.get(ref);
      if (!skill) continue; // validateCatalog already fails on dangling refs
      bindings.push({
        role: role.key,
        skill_key: skill.key,
        skill_version: skill.version,
        lifecycle: 'active',
        actions: skill.actions,
        allowed_tools: skill.allowed_tools,
        denied_tools: skill.denied_tools,
        requires_approval: skill.requires_approval,
        source: 'catalog',
      });
    }
  }
  return bindings;
}
