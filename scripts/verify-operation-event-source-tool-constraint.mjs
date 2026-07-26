#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const TYPE_FILE = resolve(REPO, 'src/workers/dal/types/event.ts');
const REPAIR_MIGRATION = resolve(
  REPO,
  'src/workers/db/migrations/090_operation_events_source_tool_constraint_repair.sql',
);
const CONSTRAINT_NAME = 'operation_events_source_tool_check';
const argv = process.argv.slice(2);
const SELF_TEST = argv.includes('--self-test');
const REQUIRE_LIVE = argv.includes('--live');
const JSON_OUT = argv.includes('--json');

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

export function parseSourceToolType(source) {
  const match = source.match(/export\s+type\s+SourceTool\s*=([\s\S]*?);/);
  if (!match) return [];
  return uniqueSorted([...match[1].matchAll(/\|\s*'([^']+)'/g)].map((item) => item[1]));
}

export function parseMigrationConstraint(source) {
  const matches = [...source.matchAll(
    /CHECK\s*\(\s*source_tool\s+IN\s*\(([\s\S]*?)\)\s*\)/gi,
  )];
  if (matches.length !== 1) return [];
  return uniqueSorted([...matches[0][1].matchAll(/'([^']+)'/g)].map((item) => item[1]));
}

export function parseLiveConstraint(definition) {
  return uniqueSorted(
    [...String(definition || '').matchAll(/'((?:''|[^'])*)'(?:\s*::[a-z_][\w]*)?/gi)]
      .map((item) => item[1].replaceAll("''", "'")),
  );
}

export function compareVocabulary(expected, actual) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  return {
    missing: expected.filter((value) => !actualSet.has(value)),
    extra: actual.filter((value) => !expectedSet.has(value)),
    duplicates: actual.length - actualSet.size,
    ok: expected.length > 0
      && expected.length === actual.length
      && expected.every((value) => actualSet.has(value)),
  };
}

function fail(message, code = 1) {
  if (JSON_OUT) {
    console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  } else {
    console.error(`verify-operation-event-source-tool-constraint · FAIL · ${message}`);
  }
  process.exit(code);
}

function selfTest() {
  const expected = ['alpha', 'beta', 'gamma'];
  const cases = [
    { label: 'exact', actual: ['alpha', 'beta', 'gamma'], ok: true },
    { label: 'missing', actual: ['alpha', 'beta'], ok: false, missing: ['gamma'] },
    { label: 'extra', actual: ['alpha', 'beta', 'gamma', 'delta'], ok: false, extra: ['delta'] },
  ];
  const failures = [];
  for (const testCase of cases) {
    const result = compareVocabulary(expected, testCase.actual);
    if (result.ok !== testCase.ok) failures.push(`${testCase.label}: expected ok=${testCase.ok}`);
    if (testCase.missing && result.missing.join(',') !== testCase.missing.join(',')) {
      failures.push(`${testCase.label}: missing control failed`);
    }
    if (testCase.extra && result.extra.join(',') !== testCase.extra.join(',')) {
      failures.push(`${testCase.label}: extra control failed`);
    }
  }

  const typeValues = parseSourceToolType(
    "export type SourceTool =\n  | 'alpha'\n  | 'beta'\n  | 'gamma';",
  );
  const migrationValues = parseMigrationConstraint(
    "ALTER TABLE t ADD CONSTRAINT c CHECK (source_tool IN ('alpha', 'beta', 'gamma'));",
  );
  const liveValues = parseLiveConstraint(
    "CHECK ((source_tool = ANY (ARRAY['alpha'::text, 'beta'::text, 'gamma'::text])))",
  );
  for (const [label, values] of [
    ['type parser', typeValues],
    ['migration parser', migrationValues],
    ['live parser', liveValues],
  ]) {
    if (!compareVocabulary(expected, values).ok) failures.push(`${label}: parser control failed`);
  }

  if (failures.length) fail(failures.join('; '), 4);
  console.log('verify-operation-event-source-tool-constraint self-test PASS · exact/missing/extra and parser controls');
  process.exit(0);
}

async function main() {
  if (SELF_TEST) selfTest();

  let expected;
  let migrationValues;
  try {
    expected = parseSourceToolType(readFileSync(TYPE_FILE, 'utf8'));
    migrationValues = parseMigrationConstraint(readFileSync(REPAIR_MIGRATION, 'utf8'));
  } catch (error) {
    fail(`cannot read contract source: ${error.message}`);
  }

  const migration = compareVocabulary(expected, migrationValues);
  if (!migration.ok) {
    fail(`migration 090 differs from SourceTool: missing=[${migration.missing.join(',')}] extra=[${migration.extra.join(',')}]`);
  }

  let live = null;
  if (process.env.DATABASE_URL) {
    try {
      const { neon } = await import('@neondatabase/serverless');
      const sql = neon(process.env.DATABASE_URL);
      const rows = await sql`
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'operation_events'::regclass
          AND conname = ${CONSTRAINT_NAME}
          AND contype = 'c'
      `;
      if (rows.length !== 1) {
        fail(`expected one live ${CONSTRAINT_NAME}, found ${rows.length}`, 3);
      }
      const liveValues = parseLiveConstraint(rows[0].definition);
      live = compareVocabulary(expected, liveValues);
      if (!live.ok) {
        fail(`live constraint differs from SourceTool: missing=[${live.missing.join(',')}] extra=[${live.extra.join(',')}]`, 2);
      }
    } catch (error) {
      fail(`live constraint query failed: ${error.message}`, 3);
    }
  } else if (REQUIRE_LIVE) {
    fail('--live requires DATABASE_URL', 3);
  }

  const result = {
    ok: true,
    expected_count: expected.length,
    migration_090: 'exact',
    live: live ? 'exact' : 'not_requested',
    constraint: CONSTRAINT_NAME,
  };
  if (JSON_OUT) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(
      `PASS operation_events source_tool constraint · ${expected.length} values · migration 090 exact · live=${result.live}`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
