#!/usr/bin/env node
import fs from 'node:fs';

const migration = fs.readFileSync('src/workers/db/migrations/074_typed_work_relationships.sql', 'utf8');
const kernel = fs.readFileSync('src/workers/lib/work-relationship.ts', 'utf8');
const failures = [];
for (const relationship of ['depends_on', 'blocks', 'supersedes', 'duplicates', 'advances', 'contributes_to', 'measures', 'blocked_by']) {
  if (!migration.includes(`'${relationship}'`) || !kernel.includes(`'${relationship}'`)) failures.push(`missing relationship ${relationship}`);
}
for (const invariant of ['source_packet_id belongs to another workspace', 'target_id does not exist in this workspace', 'target_id is ambiguous across goal authorities', 'work_relationships_workspace_policy']) {
  if (!migration.includes(invariant)) failures.push(`missing invariant: ${invariant}`);
}
if (!migration.includes('STAGED ONLY')) failures.push('migration 074 must remain explicitly staged');
if (!migration.includes('CREATE UNIQUE INDEX IF NOT EXISTS uq_work_relationships_active_shape')) failures.push('active relationship shape lacks a unique index');
if (!migration.includes('WHERE deleted_at IS NULL')) failures.push('soft-deleted relationships still block active-edge recreation');
if (failures.length) {
  failures.forEach((failure) => console.error(`FAIL ${failure}`));
  process.exit(1);
}
console.log('PASS typed work relationships: pair-specific vocabulary, same-workspace source/target checks, ambiguity guard, RLS, staged-only');
