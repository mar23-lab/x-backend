#!/usr/bin/env node
// Produce pilot-shadow graph/projection evidence from an approved nonproduction database.
//
// This is the producer for the readiness blocker "fresh graph/projection evidence." It performs
// read-only aggregate queries, refuses production-looking DSNs, requires an explicit operator approval
// flag, writes the JSON evidence consumed by x-ai-docs readiness, and can optionally refresh the local
// GRAPH_SUBSTRATE_MANIFEST.yml census block so verify:projection-substrate-pilot can pass on the same
// measured source.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SELF_TEST = process.argv.includes('--self-test');
const WRITE_MANIFEST = process.argv.includes('--write-manifest') || process.env.XLOOOP_GRAPH_EVIDENCE_WRITE_MANIFEST === '1';
const DATABASE_URL = process.env.XLOOOP_PILOT_SHADOW_GRAPH_DATABASE_URL || process.env.DATABASE_URL || '';
const EVIDENCE_FILE = process.env.XLOOOP_PILOT_SHADOW_GRAPH_EVIDENCE_FILE || '';
const ENVIRONMENT = process.env.XLOOOP_GRAPH_EVIDENCE_ENVIRONMENT || 'pilot-shadow';
const APPROVED = process.env.XLOOOP_GRAPH_EVIDENCE_APPROVED_NONPROD === '1';
const DB_LABEL = process.env.XLOOOP_GRAPH_EVIDENCE_DB_LABEL || '';
const PROJECTION_P95_SECONDS = Number(process.env.XLOOOP_GRAPH_EVIDENCE_PROJECTION_P95_SECONDS ?? NaN);

const CENSUS_KEYS = [
  'persisted_graph_nodes',
  'persisted_graph_edges',
  'operation_events',
  'operations_unified',
  'task_packets',
  'projects',
  'workspaces',
  'synthetic_domains',
  'synthetic_domain_membership',
  'intents',
  'project_source_bindings',
  'audit_logs_with_causation_id',
  'cross_tenant_edge_refs',
  'latest_graph_node_at',
  'model_execution_receipts',
  'skill_invocation_receipts',
  'closing_attestations',
];

if (SELF_TEST) {
  runSelfTest();
  process.exit(0);
}

try {
  const evidence = await produceEvidence();
  fs.mkdirSync(path.dirname(path.resolve(EVIDENCE_FILE)), { recursive: true });
  fs.writeFileSync(path.resolve(EVIDENCE_FILE), `${JSON.stringify(evidence, null, 2)}\n`);
  if (WRITE_MANIFEST) {
    refreshManifest(evidence);
  }
  console.log(JSON.stringify({
    schema_id: 'xlooop.pilot_shadow_graph_evidence.producer.report.v1',
    status: 'PASS',
    evidence_file: path.resolve(EVIDENCE_FILE),
    manifest_updated: WRITE_MANIFEST,
    metrics: evidence.metrics,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    schema_id: 'xlooop.pilot_shadow_graph_evidence.producer.report.v1',
    status: 'FAIL',
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
}

async function produceEvidence() {
  if (!EVIDENCE_FILE) throw new Error('XLOOOP_PILOT_SHADOW_GRAPH_EVIDENCE_FILE is required');
  if (!DATABASE_URL) throw new Error('XLOOOP_PILOT_SHADOW_GRAPH_DATABASE_URL or DATABASE_URL is required');
  if (!APPROVED) throw new Error('XLOOOP_GRAPH_EVIDENCE_APPROVED_NONPROD=1 is required');
  if (!['pilot-shadow', 'staging', 'test'].includes(ENVIRONMENT)) throw new Error('environment must be pilot-shadow, staging, or test');
  assertNonProductionDatabaseUrl(DATABASE_URL);
  if (!DB_LABEL || /(prod|production)/i.test(DB_LABEL)) throw new Error('XLOOOP_GRAPH_EVIDENCE_DB_LABEL must name an approved nonproduction branch/DB');
  if (!Number.isFinite(PROJECTION_P95_SECONDS) || PROJECTION_P95_SECONDS < 0) {
    throw new Error('XLOOOP_GRAPH_EVIDENCE_PROJECTION_P95_SECONDS must be a measured nonnegative number');
  }

  const sql = neon(DATABASE_URL);
  const metrics = await readMetrics(sql);
  const generatedAt = new Date().toISOString();
  validateMetrics(metrics);
  return {
    schema_id: 'xlooop.pilot_shadow_graph_evidence.v1',
    evidence_class: 'pilot_shadow_live_graph_projection',
    environment: ENVIRONMENT,
    generated_at: generatedAt,
    source: {
      producer: 'x-backend.produce-pilot-shadow-graph-evidence',
      db_label: DB_LABEL,
      approved_nonproduction: true,
      read_only: true,
      production_data_allowed: false,
      manifest_write_requested: WRITE_MANIFEST,
    },
    metrics: {
      ...metrics,
      intent_count: metrics.intents,
      caused_by: metrics.audit_logs_with_causation_id,
      caused_by_count: metrics.audit_logs_with_causation_id,
      task_packet_count: metrics.task_packets,
      model_receipt_count: metrics.model_execution_receipts,
      tool_receipt_count: metrics.skill_invocation_receipts,
      closing_attestation_count: metrics.closing_attestations,
      cross_tenant_edges: metrics.cross_tenant_edge_refs,
      projection_p95_seconds: PROJECTION_P95_SECONDS,
    },
  };
}

async function readMetrics(sql) {
  const count = async (table, where = '') => {
    const rows = await sql(`SELECT count(*)::int AS count FROM ${table}${where}`);
    return Number(rows[0]?.count ?? 0);
  };
  const maxGraphNodeRows = await sql('SELECT max(created_at) AS latest_graph_node_at FROM graph_nodes');
  return {
    persisted_graph_nodes: await count('graph_nodes'),
    persisted_graph_edges: await count('graph_edges'),
    operation_events: await count('operation_events'),
    operations_unified: await count('operations_unified'),
    task_packets: await count('task_packets'),
    projects: await count('projects'),
    workspaces: await count('workspaces'),
    synthetic_domains: await count('synthetic_domains'),
    synthetic_domain_membership: await count('synthetic_domain_membership'),
    intents: await count('intents'),
    project_source_bindings: await count('project_source_bindings'),
    audit_logs_with_causation_id: await count('audit_logs', ' WHERE causation_id IS NOT NULL'),
    cross_tenant_edge_refs: await count('graph_edges', ' WHERE from_workspace_id <> to_workspace_id'),
    latest_graph_node_at: isoOrNull(maxGraphNodeRows[0]?.latest_graph_node_at),
    model_execution_receipts: await count('model_execution_receipts'),
    skill_invocation_receipts: await count('skill_invocation_receipts'),
    closing_attestations: await count('closing_attestations'),
  };
}

function validateMetrics(metrics) {
  for (const key of CENSUS_KEYS) {
    if (key === 'latest_graph_node_at') continue;
    if (!Number.isFinite(Number(metrics[key]))) throw new Error(`metric ${key} is not numeric`);
  }
  const requiredPositive = [
    'persisted_graph_nodes',
    'persisted_graph_edges',
    'intents',
    'audit_logs_with_causation_id',
    'task_packets',
    'model_execution_receipts',
    'skill_invocation_receipts',
    'closing_attestations',
  ];
  for (const key of requiredPositive) {
    if (Number(metrics[key]) <= 0) throw new Error(`metric ${key} must be > 0`);
  }
  if (Number(metrics.cross_tenant_edge_refs) !== 0) throw new Error('cross_tenant_edge_refs must be 0');
  if (!metrics.latest_graph_node_at || Number.isNaN(Date.parse(metrics.latest_graph_node_at))) {
    throw new Error('latest_graph_node_at must parse');
  }
}

function refreshManifest(evidence, manifestPath = path.join(ROOT, 'docs/graph/GRAPH_SUBSTRATE_MANIFEST.yml')) {
  const original = fs.readFileSync(manifestPath, 'utf8');
  const metrics = evidence.metrics;
  const source = `${evidence.environment} ${evidence.source.db_label} (read-only producer x-backend.produce-pilot-shadow-graph-evidence)`;
  let next = original
    .replace(/dated:\s*'[^']*'/, `dated: '${metrics.latest_graph_node_at}'`)
    .replace(/source:\s*.*$/m, `source: ${source}`);
  const replacements = {
    operation_events: metrics.operation_events,
    operations_unified: metrics.operations_unified,
    task_packets: metrics.task_packets,
    projects: metrics.projects,
    workspaces: metrics.workspaces,
    synthetic_domains: metrics.synthetic_domains,
    synthetic_domain_membership: metrics.synthetic_domain_membership,
    intents: metrics.intents,
    project_source_bindings: metrics.project_source_bindings,
    audit_logs_with_causation_id: metrics.audit_logs_with_causation_id,
    persisted_graph_nodes: metrics.persisted_graph_nodes,
    persisted_graph_edges: metrics.persisted_graph_edges,
    projected_capacity_nodes: metrics.persisted_graph_nodes,
  };
  for (const [key, value] of Object.entries(replacements)) {
    next = next.replace(new RegExp(`(${key}:\\s*)\\d+`), `$1${value}`);
  }
  next = next.replace(
    /persisted_lineage_spine:\s*'[^']*'/,
    `persisted_lineage_spine: 'intent:${metrics.intents}, caused_by:${metrics.audit_logs_with_causation_id}, task_packets:${metrics.task_packets}, cross_tenant_edge_refs:${metrics.cross_tenant_edge_refs}'`,
  );
  fs.writeFileSync(manifestPath, next);
}

function assertNonProductionDatabaseUrl(databaseUrl) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('database URL is malformed');
  }
  const haystack = `${parsed.hostname} ${parsed.pathname} ${parsed.search}`.toLowerCase();
  if (/(^|[^a-z])(prod|production)([^a-z]|$)/.test(haystack)) {
    throw new Error('production-looking database URL rejected');
  }
}

function isoOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function runSelfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xlooop-graph-evidence-'));
  const manifest = path.join(tmp, 'manifest.yml');
  fs.writeFileSync(manifest, `
census:
  dated: '2026-07-16T18:05:42Z'
  source: old
  row_counts:
    operation_events: 1
    operations_unified: 1
    task_packets: 1
    projects: 1
    workspaces: 1
    synthetic_domains: 1
    synthetic_domain_membership: 1
    intents: 1
    project_source_bindings: 1
    audit_logs_with_causation_id: 1
  persisted_graph_nodes: 1
  persisted_graph_edges: 1
  persisted_lineage_spine: 'intent:1, caused_by:1, task_packets:1, cross_tenant_edge_refs:0'
  projected_capacity_nodes: 1
`);
  const evidence = {
    environment: 'pilot-shadow',
    source: { db_label: 'pilot-shadow-self-test' },
    metrics: {
      operation_events: 10,
      operations_unified: 2,
      task_packets: 3,
      projects: 4,
      workspaces: 5,
      synthetic_domains: 6,
      synthetic_domain_membership: 7,
      intents: 8,
      project_source_bindings: 9,
      audit_logs_with_causation_id: 10,
      persisted_graph_nodes: 11,
      persisted_graph_edges: 12,
      cross_tenant_edge_refs: 0,
      latest_graph_node_at: '2026-07-22T00:00:00.000Z',
    },
  };
  validateMetrics({
    ...evidence.metrics,
    model_execution_receipts: 1,
    skill_invocation_receipts: 1,
    closing_attestations: 1,
  });
  refreshManifest(evidence, manifest);
  const updated = fs.readFileSync(manifest, 'utf8');
  const manifestOk = updated.includes("dated: '2026-07-22T00:00:00.000Z'") &&
    updated.includes('operation_events: 10') &&
    updated.includes('persisted_graph_nodes: 11') &&
    updated.includes("persisted_lineage_spine: 'intent:8, caused_by:10, task_packets:3, cross_tenant_edge_refs:0'");
  const prodRejected = (() => {
    try {
      assertNonProductionDatabaseUrl('postgres://u:p@prod-db.neon.tech/production');
      return false;
    } catch {
      return true;
    }
  })();
  const insufficientRejected = (() => {
    try {
      validateMetrics({
        ...evidence.metrics,
        model_execution_receipts: 0,
        skill_invocation_receipts: 1,
        closing_attestations: 1,
      });
      return false;
    } catch {
      return true;
    }
  })();
  if (!manifestOk || !prodRejected || !insufficientRejected) {
    console.error(JSON.stringify({ manifestOk, prodRejected, insufficientRejected, updated }, null, 2));
    throw new Error('self-test failed');
  }
  console.log('PASS pilot-shadow graph evidence producer self-test');
}
