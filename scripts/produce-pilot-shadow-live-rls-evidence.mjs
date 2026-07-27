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
const CANDIDATE_SHA = process.env.XLOOOP_LIVE_RLS_EVIDENCE_CANDIDATE_SHA || '';

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
    candidateSha: CANDIDATE_SHA,
  });

  // The soak writes its measured counts here and we read them back. Before this, leakage_count and
  // cross_tenant_read_count were HARDCODED to 0 in buildEvidence while readiness scored them as
  // measurements, so those two checks could never fail regardless of what the proof observed.
  const summaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlooop-rls-soak-summary-'));
  const summaryFile = path.join(summaryDir, 'rls-shadow-soak.summary.json');

  const command = runCommand('npm', ['run', 'verify:trust-proofs:live'], {
    ...process.env,
    XLOOOP_RUN_LIVE_RLS: '1',
    XLOOOP_STRICT_PROOF: '1',
    XLOOOP_RLS_SOAK_SUMMARY_JSON: summaryFile,
  });

  if (command.status !== 0) {
    throw new Error(`live RLS command failed: ${command.command}\n${command.output_tail}`);
  }

  const soak = readSoakSummary(summaryFile);

  return buildEvidence({
    environment: ENVIRONMENT,
    dbLabel: DB_LABEL,
    candidateSha: CANDIDATE_SHA,
    commands: [command],
    soak,
    generatedAt: new Date().toISOString(),
  });
}

// Fail closed on every path: a missing, unparseable, insufficiently-sampled or failing summary must
// REFUSE rather than fall back to zero. A default of 0 here would recreate the exact defect this
// function exists to remove, because 0 is also the value that satisfies the readiness check.
function readSoakSummary(summaryFile) {
  let raw;
  try {
    raw = fs.readFileSync(summaryFile, 'utf8');
  } catch {
    throw new Error('rls-shadow-soak wrote no summary; leakage counts cannot be asserted without a measurement');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('rls-shadow-soak summary is not valid JSON; refusing to infer leakage counts');
  }
  if (parsed?.schema_id !== 'xlooop.rls_shadow_soak.summary.v1') {
    throw new Error(`unexpected soak summary schema_id: ${String(parsed?.schema_id)}`);
  }
  for (const key of ['leakage_count', 'cross_tenant_read_count', 'divergence_count', 'tables_with_rows', 'workspaces_sampled', 'leak_probes']) {
    if (!Number.isFinite(Number(parsed[key]))) {
      throw new Error(`soak summary field ${key} is not numeric; refusing to emit an unmeasured count`);
    }
  }
  if (parsed.sufficient_sample !== true) {
    throw new Error(`rls-shadow-soak sample was insufficient (${(parsed.insufficient_reasons || []).join('; ') || 'no reason given'}); an unexercised database cannot evidence tenant isolation`);
  }
  if (parsed.status !== 'PASS') {
    throw new Error(`rls-shadow-soak status is ${String(parsed.status)}, not PASS`);
  }
  return parsed;
}

function assertPreconditions({
  evidenceFile,
  ownerDatabaseUrl,
  appDatabaseUrl,
  environment,
  approved,
  dbLabel,
  candidateSha,
  gitState = readGitState(),
}) {
  if (!evidenceFile) throw new Error('XLOOOP_PILOT_SHADOW_LIVE_RLS_EVIDENCE_FILE is required');
  if (!ownerDatabaseUrl) throw new Error('DATABASE_URL is required');
  if (!appDatabaseUrl) throw new Error('XLOOOP_RLS_APP_DATABASE_URL is required');
  if (!approved) throw new Error('XLOOOP_LIVE_RLS_EVIDENCE_APPROVED_NONPROD=1 is required');
  if (!['pilot-shadow', 'staging', 'test'].includes(environment)) throw new Error('environment must be pilot-shadow, staging, or test');
  if (!dbLabel || /(prod|production)/i.test(dbLabel)) throw new Error('XLOOOP_LIVE_RLS_EVIDENCE_DB_LABEL must name an approved nonproduction branch/DB');
  if (!/^[0-9a-f]{40}$/.test(candidateSha)) {
    throw new Error('XLOOOP_LIVE_RLS_EVIDENCE_CANDIDATE_SHA must be a full 40-character lowercase Git SHA');
  }
  if (gitState.sha !== candidateSha) throw new Error('candidate SHA does not match current git HEAD');
  if (!gitState.clean) throw new Error('live evidence requires a clean git worktree');
  assertNonProductionDatabaseUrl(ownerDatabaseUrl, 'DATABASE_URL');
  assertNonProductionDatabaseUrl(appDatabaseUrl, 'XLOOOP_RLS_APP_DATABASE_URL');
}

function buildEvidence({ environment, dbLabel, candidateSha, commands, soak, generatedAt }) {
  if (!soak) throw new Error('buildEvidence requires a measured soak summary');
  return {
    schema_id: 'xlooop.pilot_shadow_live_rls_evidence.v1',
    evidence_class: 'pilot_shadow_live_rls_command_capture',
    generated_at: generatedAt,
    environment,
    authority: environment === 'pilot-shadow' ? 'shadow' : 'nonproduction',
    candidate: {
      git_sha: candidateSha,
      git_worktree_clean: true,
    },
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
    // Every count below is READ FROM the soak's own summary. None is a literal.
    metrics: {
      leakage_count: Number(soak.leakage_count),
      cross_tenant_read_count: Number(soak.cross_tenant_read_count),
      divergence_count: Number(soak.divergence_count),
      live_proofs_passed: commands.length,
      tables_with_rows: Number(soak.tables_with_rows),
      workspaces_sampled: Number(soak.workspaces_sampled),
      cross_tenant_leak_probes: Number(soak.leak_probes),
    },
    leakage_count: Number(soak.leakage_count),
    cross_tenant_read_count: Number(soak.cross_tenant_read_count),
    sample: {
      tables_with_rows: Number(soak.tables_with_rows),
      workspaces_sampled: Number(soak.workspaces_sampled),
      cross_tenant_leak_probes: Number(soak.leak_probes),
      sufficient_sample: soak.sufficient_sample === true,
    },
    boundary: 'No production database, route, flag, migration, or authority was touched. This artifact satisfies only the pilot-shadow completion readiness live RLS evidence gate.',
  };
}

function readGitState() {
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  const status = spawnSync('git', ['status', '--porcelain'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (sha.status !== 0 || status.status !== 0) {
    throw new Error('cannot determine Git candidate state');
  }
  return {
    sha: String(sha.stdout || '').trim(),
    clean: String(status.stdout || '').trim().length === 0,
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
        candidateSha: 'a'.repeat(40),
        gitState: { sha: 'a'.repeat(40), clean: true },
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
        candidateSha: 'a'.repeat(40),
        gitState: { sha: 'a'.repeat(40), clean: true },
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
        candidateSha: 'a'.repeat(40),
        gitState: { sha: 'a'.repeat(40), clean: true },
      });
      return false;
    } catch {
      return true;
    }
  })();
  const redacted = safeTail('DATABASE_URL=postgres://u:p@branch-test.neon.tech/db ok');
  const redactionOk = !redacted.includes('u:p@branch-test');
  const dirtyRejected = (() => {
    try {
      assertPreconditions({
        evidenceFile,
        ownerDatabaseUrl: 'postgres://owner:secret@branch-test.neon.tech/xlooop_shadow',
        appDatabaseUrl: 'postgres://app:secret@branch-test.neon.tech/xlooop_shadow',
        environment: 'pilot-shadow',
        approved: true,
        dbLabel: 'pilot-shadow-self-test',
        candidateSha: 'a'.repeat(40),
        gitState: { sha: 'a'.repeat(40), clean: false },
      });
      return false;
    } catch {
      return true;
    }
  })();
  const goodSummary = {
    schema_id: 'xlooop.rls_shadow_soak.summary.v1',
    leakage_count: 0,
    cross_tenant_read_count: 0,
    divergence_count: 0,
    tables_with_rows: 6,
    workspaces_sampled: 12,
    leak_probes: 12,
    sufficient_sample: true,
    status: 'PASS',
  };
  const writeSummary = (name, value) => {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
  };
  const refuses = (file) => {
    try {
      readSoakSummary(file);
      return false;
    } catch {
      return true;
    }
  };
  // A missing summary must NOT degrade to zero — zero is the value that satisfies readiness.
  const missingSummaryRefused = refuses(path.join(tmp, 'does-not-exist.json'));
  const malformedRefused = refuses(writeSummary('malformed.json', '{not json'));
  const wrongSchemaRefused = refuses(writeSummary('wrong-schema.json', { ...goodSummary, schema_id: 'other.v1' }));
  const nonNumericRefused = refuses(writeSummary('non-numeric.json', { ...goodSummary, leakage_count: 'none' }));
  // The defect that made this fix necessary: an EMPTY database sampled nothing and still read as GREEN.
  const insufficientRefused = refuses(writeSummary('insufficient.json', {
    ...goodSummary,
    tables_with_rows: 0,
    workspaces_sampled: 0,
    leak_probes: 0,
    sufficient_sample: false,
    insufficient_reasons: ['no spine table contained any rows, so nothing was compared'],
    status: 'INSUFFICIENT_SAMPLE',
  }));
  const failStatusRefused = refuses(writeSummary('failed.json', { ...goodSummary, status: 'FAIL' }));
  const goodSummaryAccepted = (() => {
    try {
      return readSoakSummary(writeSummary('good.json', goodSummary)).workspaces_sampled === 12;
    } catch {
      return false;
    }
  })();

  const evidence = buildEvidence({
    environment: 'pilot-shadow',
    dbLabel: 'pilot-shadow-self-test',
    candidateSha: 'a'.repeat(40),
    generatedAt: '2026-07-22T00:00:00.000Z',
    commands: [{ command: 'npm run verify:trust-proofs:live', status: 0, output_tail: 'PASS' }],
    soak: goodSummary,
  });
  const evidenceOk = evidence.producer.name === 'x-backend.produce-pilot-shadow-live-rls-evidence' &&
    evidence.producer.production_data_allowed === false &&
    evidence.candidate.git_sha === 'a'.repeat(40) &&
    evidence.candidate.git_worktree_clean === true &&
    evidence.leakage_count === 0 &&
    evidence.cross_tenant_read_count === 0 &&
    // The sample must be carried through, so a reader can tell a measured zero from an empty run.
    evidence.sample.workspaces_sampled === 12 &&
    evidence.sample.cross_tenant_leak_probes === 12 &&
    evidence.sample.sufficient_sample === true;
  // Proof the counts are WIRED and not coincidentally zero: a leaking summary must surface as a
  // nonzero leakage_count in the artifact rather than being flattened to 0.
  const leakingEvidence = buildEvidence({
    environment: 'pilot-shadow',
    dbLabel: 'pilot-shadow-self-test',
    candidateSha: 'a'.repeat(40),
    generatedAt: '2026-07-22T00:00:00.000Z',
    commands: [{ command: 'npm run verify:trust-proofs:live', status: 0, output_tail: 'PASS' }],
    soak: { ...goodSummary, leakage_count: 3, cross_tenant_read_count: 3, divergence_count: 2 },
  });
  const leakagePropagates = leakingEvidence.leakage_count === 3 &&
    leakingEvidence.cross_tenant_read_count === 3 &&
    leakingEvidence.metrics.divergence_count === 2;
  const soakRequired = (() => {
    try {
      buildEvidence({
        environment: 'pilot-shadow',
        dbLabel: 'pilot-shadow-self-test',
        candidateSha: 'a'.repeat(40),
        generatedAt: '2026-07-22T00:00:00.000Z',
        commands: [],
      });
      return false;
    } catch {
      return true;
    }
  })();

  const checks = {
    preconditionsOk,
    prodRejected,
    approvalRejected,
    dirtyRejected,
    redactionOk,
    evidenceOk,
    missingSummaryRefused,
    malformedRefused,
    wrongSchemaRefused,
    nonNumericRefused,
    insufficientRefused,
    failStatusRefused,
    goodSummaryAccepted,
    leakagePropagates,
    soakRequired,
  };
  if (Object.values(checks).some((value) => value !== true)) {
    console.error(JSON.stringify({ ...checks, redacted, evidence }, null, 2));
    throw new Error('self-test failed');
  }
  console.log(`PASS pilot-shadow live RLS evidence producer self-test (${Object.keys(checks).length} checks)`);
}
