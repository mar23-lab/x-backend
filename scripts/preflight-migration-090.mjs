#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareVocabulary,
  parseLiveConstraint,
  parseMigrationConstraint,
  parseSourceToolType,
} from './verify-operation-event-source-tool-constraint.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const TYPE_FILE = resolve(REPO, 'src/workers/dal/types/event.ts');
const MIGRATION_FILE = resolve(
  REPO,
  'src/workers/db/migrations/090_operation_events_source_tool_constraint_repair.sql',
);
const argv = process.argv.slice(2);
const SELF_TEST = argv.includes('--self-test');
const JSON_OUT = argv.includes('--json');
const REPAIR_ADDITIONS = new Set(['document_upload', 'tool_action']);

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function contractVocabulary() {
  const expected = parseSourceToolType(readFileSync(TYPE_FILE, 'utf8'));
  const migration = parseMigrationConstraint(readFileSync(MIGRATION_FILE, 'utf8'));
  const comparison = compareVocabulary(expected, migration);
  if (!comparison.ok) {
    throw new Error(
      `migration 090 differs from SourceTool: missing=[${comparison.missing.join(',')}] `
      + `extra=[${comparison.extra.join(',')}]`,
    );
  }
  return {
    target: expected,
    predecessor: expected.filter((value) => !REPAIR_ADDITIONS.has(value)),
  };
}

function addFailure(failures, id, actual, expected) {
  failures.push({ id, actual, expected });
}

export function classifyMigration090Preflight(snapshot, vocabulary) {
  const failures = [];
  const target = uniqueSorted(vocabulary.target);
  const predecessor = uniqueSorted(vocabulary.predecessor);
  const maxVersion = Number(snapshot.max_version);
  const version90Rows = Number(snapshot.version_90_rows);
  const constraintCount = Number(snapshot.constraint_count);
  const candidateConstraintCount = Number(snapshot.candidate_constraint_count);
  const nullSourceTools = Number(snapshot.null_source_tools);
  const blockingLockCount = Number(snapshot.blocking_lock_count);
  const observedTools = uniqueSorted(snapshot.observed_source_tools || []);
  const constraintValues = parseLiveConstraint(snapshot.constraint_definition || '');
  const predecessorComparison = compareVocabulary(predecessor, constraintValues);
  const targetComparison = compareVocabulary(target, constraintValues);
  const observedOutsideTarget = observedTools.filter((value) => !target.includes(value));
  const observedOutsidePredecessor = observedTools.filter((value) => !predecessor.includes(value));
  const alreadyApplied = version90Rows === 1 || maxVersion === 90;

  if (!snapshot.table_exists) addFailure(failures, 'operation_events_exists', false, true);
  if (!snapshot.migration_role_can_own) {
    addFailure(
      failures,
      'migration_role_owns_operation_events',
      false,
      true,
    );
  }
  if (constraintCount !== 1) addFailure(failures, 'canonical_constraint_count', constraintCount, 1);
  if (!snapshot.constraint_validated) {
    addFailure(failures, 'canonical_constraint_validated', Boolean(snapshot.constraint_validated), true);
  }
  if (candidateConstraintCount !== 0) {
    addFailure(failures, 'temporary_v90_constraint_absent', candidateConstraintCount, 0);
  }
  if (nullSourceTools !== 0) addFailure(failures, 'null_source_tools', nullSourceTools, 0);
  if (observedOutsideTarget.length) {
    addFailure(failures, 'observed_tools_within_target', observedOutsideTarget, []);
  }
  if (blockingLockCount !== 0) {
    addFailure(failures, 'concurrent_operation_events_locks', blockingLockCount, 0);
  }

  let disposition = 'blocked';
  if (alreadyApplied) {
    if (maxVersion !== 90) addFailure(failures, 'max_schema_version', maxVersion, 90);
    if (version90Rows !== 1) addFailure(failures, 'schema_90_ledger_rows', version90Rows, 1);
    if (!targetComparison.ok) {
      addFailure(failures, 'poststate_constraint_vocabulary', constraintValues, target);
    }
    if (!failures.length) disposition = 'already_applied_exact';
  } else {
    if (maxVersion !== 89) addFailure(failures, 'max_schema_version', maxVersion, 89);
    if (version90Rows !== 0) addFailure(failures, 'schema_90_ledger_rows', version90Rows, 0);
    if (!predecessorComparison.ok) {
      addFailure(failures, 'predecessor_constraint_vocabulary', constraintValues, predecessor);
    }
    if (observedOutsidePredecessor.length) {
      addFailure(failures, 'observed_tools_within_predecessor', observedOutsidePredecessor, []);
    }
    if (!failures.length) disposition = 'ready_to_apply';
  }

  return {
    schema_id: 'xlooop.migration_090_select_preflight.v1',
    status: failures.length ? 'blocked' : 'pass',
    disposition,
    ready_to_apply: disposition === 'ready_to_apply',
    database_name: snapshot.database_name || null,
    database_user: snapshot.database_user || null,
    max_version: maxVersion,
    version_90_rows: version90Rows,
    operation_events: {
      table_owner: snapshot.table_owner || null,
      migration_role_can_own: Boolean(snapshot.migration_role_can_own),
      row_count: Number(snapshot.row_count),
      total_bytes: Number(snapshot.total_bytes),
      observed_source_tools: observedTools,
      constraint_values: constraintValues,
      constraint_validated: Boolean(snapshot.constraint_validated),
      blocking_lock_count: blockingLockCount,
    },
    expected: {
      predecessor_source_tools: predecessor,
      target_source_tools: target,
    },
    failures,
  };
}

function selfTest() {
  const vocabulary = {
    target: ['alpha', 'beta', 'document_upload', 'tool_action'],
    predecessor: ['alpha', 'beta'],
  };
  const base = {
    database_name: 'fixture',
    database_user: 'fixture_owner',
    table_owner: 'fixture_owner',
    migration_role_can_own: true,
    max_version: 89,
    version_90_rows: 0,
    table_exists: true,
    constraint_count: 1,
    constraint_validated: true,
    constraint_definition: "CHECK ((source_tool = ANY (ARRAY['alpha'::text, 'beta'::text])))",
    candidate_constraint_count: 0,
    null_source_tools: 0,
    blocking_lock_count: 0,
    observed_source_tools: ['alpha', 'beta'],
    row_count: 2,
    total_bytes: 16384,
  };
  const cases = [
    {
      id: 'exact_predecessor_ready',
      snapshot: base,
      status: 'pass',
      disposition: 'ready_to_apply',
    },
    {
      id: 'unexpected_constraint_value_blocked',
      snapshot: {
        ...base,
        constraint_definition:
          "CHECK ((source_tool = ANY (ARRAY['alpha'::text, 'beta'::text, 'gamma'::text])))",
      },
      status: 'blocked',
      disposition: 'blocked',
    },
    {
      id: 'concurrent_lock_blocked',
      snapshot: { ...base, blocking_lock_count: 1 },
      status: 'blocked',
      disposition: 'blocked',
    },
    {
      id: 'non_owner_role_blocked',
      snapshot: { ...base, database_user: 'xlooop_app', migration_role_can_own: false },
      status: 'blocked',
      disposition: 'blocked',
    },
    {
      id: 'exact_poststate_no_reapply',
      snapshot: {
        ...base,
        max_version: 90,
        version_90_rows: 1,
        constraint_definition:
          "CHECK ((source_tool = ANY (ARRAY['alpha'::text, 'beta'::text, "
          + "'document_upload'::text, 'tool_action'::text])))",
        observed_source_tools: ['alpha', 'beta', 'document_upload'],
      },
      status: 'pass',
      disposition: 'already_applied_exact',
    },
    {
      id: 'ledger_without_semantics_blocked',
      snapshot: { ...base, max_version: 90, version_90_rows: 1 },
      status: 'blocked',
      disposition: 'blocked',
    },
  ];

  const failures = [];
  const scriptSource = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const sqlTemplates = [...scriptSource.matchAll(/await\s+sql`([\s\S]*?)`/g)]
    .map((match) => match[1].trim());
  if (sqlTemplates.length !== 5) {
    failures.push(`select-only SQL inventory: expected 5 templates, received ${sqlTemplates.length}`);
  }
  for (const [index, sqlText] of sqlTemplates.entries()) {
    if (!/^SELECT\b/i.test(sqlText)) {
      failures.push(`select-only SQL template ${index + 1}: statement does not begin with SELECT`);
    }
    if (/\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i.test(sqlText)) {
      failures.push(`select-only SQL template ${index + 1}: mutating keyword detected`);
    }
  }
  for (const testCase of cases) {
    const result = classifyMigration090Preflight(testCase.snapshot, vocabulary);
    if (result.status !== testCase.status || result.disposition !== testCase.disposition) {
      failures.push(
        `${testCase.id}: expected ${testCase.status}/${testCase.disposition}, `
        + `received ${result.status}/${result.disposition}`,
      );
    }
  }
  if (failures.length) {
    console.error(`preflight-migration-090 self-test FAIL: ${failures.join('; ')}`);
    process.exit(4);
  }
  console.log(
    'preflight-migration-090 self-test PASS '
    + '- SELECT-only SQL, exact predecessor, drift, lock, ownership, exact poststate, '
    + 'and false-ledger controls',
  );
}

async function readSnapshot() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required; no database query was attempted');
  }
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(process.env.DATABASE_URL);

  const metadataRows = await sql`
    SELECT
      current_database() AS database_name,
      current_user AS database_user,
      COALESCE(MAX(version), 0)::int AS max_version,
      COUNT(*) FILTER (WHERE version = 90)::int AS version_90_rows,
      to_regclass('public.operation_events') IS NOT NULL AS table_exists
    FROM workers_schema_version
  `;
  const metadata = metadataRows[0];
  if (!metadata?.table_exists) {
    return {
      ...metadata,
      constraint_count: 0,
      constraint_validated: false,
      constraint_definition: '',
      candidate_constraint_count: 0,
      null_source_tools: 0,
      blocking_lock_count: 0,
      observed_source_tools: [],
      row_count: 0,
      total_bytes: 0,
    };
  }

  const constraintRows = await sql`
    SELECT
      COUNT(*) FILTER (
        WHERE conname = 'operation_events_source_tool_check'
      )::int AS constraint_count,
      COALESCE(
        BOOL_AND(convalidated) FILTER (
          WHERE conname = 'operation_events_source_tool_check'
        ),
        false
      ) AS constraint_validated,
      COALESCE(
        STRING_AGG(pg_get_constraintdef(oid), E'\n') FILTER (
          WHERE conname = 'operation_events_source_tool_check'
        ),
        ''
      ) AS constraint_definition,
      COUNT(*) FILTER (
        WHERE conname = 'operation_events_source_tool_check_v90'
      )::int AS candidate_constraint_count
    FROM pg_constraint
    WHERE conrelid = 'operation_events'::regclass
      AND conname IN (
        'operation_events_source_tool_check',
        'operation_events_source_tool_check_v90'
      )
  `;
  const toolRows = await sql`
    SELECT source_tool, COUNT(*)::bigint AS row_count
    FROM operation_events
    GROUP BY source_tool
    ORDER BY source_tool
  `;
  const tableRows = await sql`
    SELECT
      COUNT(*)::bigint AS row_count,
      pg_total_relation_size('operation_events'::regclass)::bigint AS total_bytes,
      pg_get_userbyid(
        (SELECT relowner FROM pg_class WHERE oid = 'operation_events'::regclass)
      ) AS table_owner,
      pg_has_role(
        current_user,
        (SELECT relowner FROM pg_class WHERE oid = 'operation_events'::regclass),
        'USAGE'
      ) AS migration_role_can_own,
      COUNT(*) FILTER (WHERE source_tool IS NULL)::bigint AS null_source_tools
    FROM operation_events
  `;
  const lockRows = await sql`
    SELECT COUNT(*)::int AS blocking_lock_count
    FROM pg_locks AS locks
    JOIN pg_stat_activity AS activity ON activity.pid = locks.pid
    WHERE locks.relation = 'operation_events'::regclass
      AND locks.pid <> pg_backend_pid()
      AND activity.state <> 'idle'
  `;

  return {
    ...metadata,
    ...constraintRows[0],
    ...tableRows[0],
    ...lockRows[0],
    observed_source_tools: toolRows.map((row) => row.source_tool),
  };
}

async function main() {
  if (SELF_TEST) return selfTest();

  let result;
  try {
    const vocabulary = contractVocabulary();
    const snapshot = await readSnapshot();
    result = classifyMigration090Preflight(snapshot, vocabulary);
  } catch (error) {
    result = {
      schema_id: 'xlooop.migration_090_select_preflight.v1',
      status: 'blocked',
      disposition: 'query_failed',
      ready_to_apply: false,
      failures: [{ id: 'query', actual: error.message, expected: 'successful SELECT-only preflight' }],
    };
  }

  if (JSON_OUT) console.log(JSON.stringify(result, null, 2));
  else if (result.status === 'pass') {
    console.log(
      `PASS migration 090 SELECT-only preflight - ${result.disposition} `
      + `- schema ${result.max_version} - ${result.operation_events.row_count} operation events`,
    );
  } else {
    console.error(
      `FAIL migration 090 SELECT-only preflight - ${result.disposition} - `
      + result.failures.map((failure) => failure.id).join(', '),
    );
  }
  process.exit(result.status === 'pass' ? 0 : 2);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
