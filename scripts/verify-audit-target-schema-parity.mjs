#!/usr/bin/env node
// Keep the TypeScript audit vocabulary and PostgreSQL CHECK constraint identical.
// This prevents an audited write from compiling while every live transaction rolls back at the DB.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function quotedValues(source) {
  return [...source.matchAll(/'([a-z][a-z0-9_]*)'/g)].map((match) => match[1]);
}

function typeValues(source) {
  const match = source.match(/export type AuditTargetType\s*=([\s\S]*?);/);
  if (!match) throw new Error('AuditTargetType union not found');
  return new Set(quotedValues(match[1]));
}

function constraintValues(source) {
  const match = source.match(/audit_logs_target_type_check\s+CHECK\s*\(target_type\s+IN\s*\(([\s\S]*?)\)\s*\)/);
  if (!match) throw new Error('audit_logs target_type CHECK not found');
  return new Set(quotedValues(match[1]));
}

function compare(typeSet, constraintSet) {
  return {
    missingFromSchema: [...typeSet].filter((value) => !constraintSet.has(value)).sort(),
    missingFromTypes: [...constraintSet].filter((value) => !typeSet.has(value)).sort(),
  };
}

function latestAuditMigration() {
  const dir = path.join(ROOT, 'src/workers/db/migrations');
  const candidates = fs.readdirSync(dir)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort((a, b) => Number.parseInt(b, 10) - Number.parseInt(a, 10));
  for (const name of candidates) {
    const source = fs.readFileSync(path.join(dir, name), 'utf8');
    if (/audit_logs_target_type_check\s+CHECK\s*\(target_type\s+IN/.test(source)) {
      return { name, source };
    }
  }
  throw new Error('no audit target constraint migration found');
}

if (process.argv.includes('--self-test')) {
  const types = typeValues("export type AuditTargetType = 'user' | 'chat_thread';");
  const schema = constraintValues(
    "ADD CONSTRAINT audit_logs_target_type_check CHECK (target_type IN ('user', 'chat_thread'))",
  );
  const pass = compare(types, schema);
  if (pass.missingFromSchema.length || pass.missingFromTypes.length) process.exit(1);
  const red = compare(types, constraintValues(
    "ADD CONSTRAINT audit_logs_target_type_check CHECK (target_type IN ('user'))",
  ));
  if (red.missingFromSchema.join(',') !== 'chat_thread') process.exit(1);
  console.log('SELF-TEST PASS · audit target parity comparator observes missing schema values');
  process.exit(0);
}

try {
  const typePath = path.join(ROOT, 'src/workers/dal/types/access.ts');
  const types = typeValues(fs.readFileSync(typePath, 'utf8'));
  const migration = latestAuditMigration();
  const schema = constraintValues(migration.source);
  const result = compare(types, schema);
  if (result.missingFromSchema.length || result.missingFromTypes.length) {
    console.error('FAIL audit target schema parity');
    console.error(`  missing_from_schema=${JSON.stringify(result.missingFromSchema)}`);
    console.error(`  missing_from_types=${JSON.stringify(result.missingFromTypes)}`);
    console.error(`  latest_constraint_migration=${migration.name}`);
    process.exit(1);
  }
  console.log(`PASS audit target schema parity · ${types.size}/${schema.size} values · ${migration.name}`);
} catch (error) {
  console.error(`FAIL audit target schema parity · ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
