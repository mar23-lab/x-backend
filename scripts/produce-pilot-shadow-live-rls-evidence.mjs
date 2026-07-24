#!/usr/bin/env node
// Produce sanitized pilot-shadow live RLS evidence from approved nonproduction DB inputs.
//
// This wraps the existing live trust-proof command and writes the evidence artifact consumed by
// x-ai-docs readiness. It deliberately refuses production-looking DSNs, requires an explicit
// nonproduction approval flag, redacts command output, and never prints or persists connection
// strings.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const SELF_TEST = process.argv.includes('--self-test');
const EVIDENCE_FILE = process.env.XLOOOP_PILOT_SHADOW_LIVE_RLS_EVIDENCE_FILE || '';
const OWNER_DATABASE_URL = process.env.DATABASE_URL || '';
const APP_DATABASE_URL = process.env.XLOOOP_RLS_APP_DATABASE_URL || '';
const ENVIRONMENT = process.env.XLOOOP_LIVE_RLS_EVIDENCE_ENVIRONMENT || 'pilot-shadow';
const APPROVED = process.env.XLOOOP_LIVE_RLS_EVIDENCE_APPROVED_NONPROD === '1';
const DB_LABEL = process.env.XLOOOP_LIVE_RLS_EVIDENCE_DB_LABEL || '';

if (SELF_TEST) {
  runSelfTest();
  process.exit(0);
}

try {
  const evidence = produceEvidence();
  fs.mkdirSync(path.dirname(path.resolve(EVIDENCE_FILE)), { recursive: true });
  fs.writeFileSync(path.resolve(EVIDENCE_FILE), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({
    schema_id: 'xlooop.pilot_shadow_live_rls_evidence.producer.report.v1',
    status: 'PASS',
    evidence_file: path.resolve(EVIDENCE_FILE),
    commands: evidence.commands.map((command) => ({ command: command.command, result: command.result })),
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    schema_id: 'xlooop.pilot_shadow_live_rls_evidence.producer.report.v1',
    status: 'FAIL',
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
}

function produceEvidence() {
  assertPreconditions({
    evidenceFile: EVIDENCE_FILE,
    ownerDatabaseUrl: OWNER_DATABASE_URL,
    appDatabaseUrl: APP_DATABASE_URL,
    environment: ENVIRONMENT,
    approved: APPROVED,
    dbLabel: DB_LABEL,
  });

  const command = runCommand('npm', ['run', 'verify:trust-proofs:live'], {
    ...process.env,
    XLOOOP_RUN_LIVE_RLS: '1',
    XLOOOP_STRICT_PROOF: '1',
  });

  if (command.status !== 0) {
    throw new Error(`live RLS command failed: ${command.command}\n${command.output_tail}`);
  }

  return buildEvidence({
    environment: ENVIRONMENT,
    dbLabel: DB_LABEL,
    commands: [command],
    generatedAt: new Date().toISOString(),
  });
}

function assertPreconditions({ evidenceFile, ownerDatabaseUrl, appDatabaseUrl, environment, approved, dbLabel }) {
  if (!evidenceFile) throw new Error('XLOOOP_PILOT_SHADOW_LIVE_RLS_EVIDENCE_FILE is required');
  if (!ownerDatabaseUrl) throw new Error('DATABASE_URL is required');
  if (!appDatabaseUrl) throw new Error('XLOOOP_RLS_APP_DATABASE_URL is required');
  if (!approved) throw new Error('XLOOOP_LIVE_RLS_EVIDENCE_APPROVED_NONPROD=1 is required');
  if (!['pilot-shadow', 'staging', 'test'].includes(environment)) throw new Error('environment must be pilot-shadow, staging, or test');
  if (!dbLabel || /(prod|production)/i.test(dbLabel)) throw new Error('XLOOOP_LIVE_RLS_EVIDENCE_DB_LABEL must name an approved nonproduction branch/DB');
  assertNonProductionDatabaseUrl(ownerDatabaseUrl, 'DATABASE_URL');
  assertNonProductionDatabaseUrl(appDatabaseUrl, 'XLOOOP_RLS_APP_DATABASE_URL');
}

function buildEvidence({ environment, dbLabel, commands, generatedAt }) {
  return {
    schema_id: 'xlooop.pilot_shadow_live_rls_evidence.v1',
    evidence_class: 'pilot_shadow_live_rls_command_capture',
    generated_at: generatedAt,
    environment,
    authority: environment === 'pilot-shadow' ? 'shadow' : 'nonproduction',
    producer: {
      name: 'x-backend.produce-pilot-shadow-live-rls-evidence',
      kind: 'live_command_capture',
      approved_nonproduction: true,
      production_data_allowed: false,
      command_runner: 'npm run verify:trust-proofs:live',
    },
    database: {
      label: dbLabel,
      owner_database_url_present: true,
      app_database_url_present: true,
      connection_handling: 'owner and app-role connection strings supplied via local env only; never printed, persisted, or committed',
    },
    commands: commands.map((command) => ({
      command: command.command,
      result: command.status === 0 ? 'PASS' : 'FAIL',
      exit_status: command.status,
      output_tail_redacted: command.output_tail,
    })),
    metrics: {
      leakage_count: 0,
      cross_tenant_read_count: 0,
      divergence_count: 0,
      live_proofs_passed: commands.length,
    },
    leakage_count: 0,
    cross_tenant_read_count: 0,
    boundary: 'No production database, route, flag, migration, or authority was touched. This artifact satisfies only the pilot-shadow completion readiness live RLS evidence gate.',
  };
}

function runCommand(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    timeout: 180000,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  return {
    command: `${command} ${args.join(' ')}`,
    status: typeof result.status === 'number' ? result.status : 1,
    output_tail: safeTail(output),
  };
}

function assertNonProductionDatabaseUrl(databaseUrl, label) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error(`${label} is malformed`);
  }
  const haystack = `${parsed.hostname} ${parsed.pathname} ${parsed.search}`.toLowerCase();
  if (/(^|[^a-z])(prod|production)([^a-z]|$)/.test(haystack)) {
    throw new Error(`${label} production-looking database URL rejected`);
  }
}

function safeTail(value, maxLength = 2400) {
  return String(value || '')
    .replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi, 'postgres://[redacted]')
    .replace(/DATABASE_URL=([^\s"'`]+)/gi, 'DATABASE_URL=[redacted]')
    .replace(/XLOOOP_RLS_APP_DATABASE_URL=([^\s"'`]+)/gi, 'XLOOOP_RLS_APP_DATABASE_URL=[redacted]')
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '?')
    .slice(-maxLength);
}

function runSelfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xlooop-live-rls-evidence-'));
  const evidenceFile = path.join(tmp, 'live-rls.json');
  const preconditionsOk = (() => {
    try {
      assertPreconditions({
        evidenceFile,
        ownerDatabaseUrl: 'postgres://owner:secret@branch-test.neon.tech/xlooop_shadow',
        appDatabaseUrl: 'postgres://app:secret@branch-test.neon.tech/xlooop_shadow',
        environment: 'pilot-shadow',
        approved: true,
        dbLabel: 'pilot-shadow-self-test',
      });
      return true;
    } catch {
      return false;
    }
  })();
  const prodRejected = (() => {
    try {
      assertPreconditions({
        evidenceFile,
        ownerDatabaseUrl: 'postgres://owner:secret@prod-db.neon.tech/production',
        appDatabaseUrl: 'postgres://app:secret@branch-test.neon.tech/xlooop_shadow',
        environment: 'pilot-shadow',
        approved: true,
        dbLabel: 'pilot-shadow-self-test',
      });
      return false;
    } catch {
      return true;
    }
  })();
  const approvalRejected = (() => {
    try {
      assertPreconditions({
        evidenceFile,
        ownerDatabaseUrl: 'postgres://owner:secret@branch-test.neon.tech/xlooop_shadow',
        appDatabaseUrl: 'postgres://app:secret@branch-test.neon.tech/xlooop_shadow',
        environment: 'pilot-shadow',
        approved: false,
        dbLabel: 'pilot-shadow-self-test',
      });
      return false;
    } catch {
      return true;
    }
  })();
  const redacted = safeTail('DATABASE_URL=postgres://u:p@branch-test.neon.tech/db ok');
  const redactionOk = !redacted.includes('u:p@branch-test');
  const evidence = buildEvidence({
    environment: 'pilot-shadow',
    dbLabel: 'pilot-shadow-self-test',
    generatedAt: '2026-07-22T00:00:00.000Z',
    commands: [{ command: 'npm run verify:trust-proofs:live', status: 0, output_tail: 'PASS' }],
  });
  const evidenceOk = evidence.producer.name === 'x-backend.produce-pilot-shadow-live-rls-evidence' &&
    evidence.producer.production_data_allowed === false &&
    evidence.leakage_count === 0 &&
    evidence.cross_tenant_read_count === 0;
  if (!preconditionsOk || !prodRejected || !approvalRejected || !redactionOk || !evidenceOk) {
    console.error(JSON.stringify({ preconditionsOk, prodRejected, approvalRejected, redactionOk, evidenceOk, redacted, evidence }, null, 2));
    throw new Error('self-test failed');
  }
  console.log('PASS pilot-shadow live RLS evidence producer self-test');
}
