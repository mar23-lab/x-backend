#!/usr/bin/env node
// Strict pilot-shadow soak and rollback evidence verifier.
//
// This closes the remaining prose-only gate: a 48-72h pilot-shadow soak plus
// rollback rehearsal must be backed by a sanitized evidence artifact. The
// verifier never deploys, mutates production, or reads secrets.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const strict =
  process.argv.includes('--strict') ||
  process.env.XLOOOP_REQUIRE_PILOT_SHADOW_SOAK_ROLLBACK === '1';
const selfTest = process.argv.includes('--self-test');
const evidenceFile = process.env.XLOOOP_PILOT_SHADOW_SOAK_ROLLBACK_EVIDENCE_FILE || '';
const maxAgeDays = Number(process.env.XLOOOP_SOAK_ROLLBACK_MAX_AGE_DAYS || 7);
const minDurationHours = Number(process.env.XLOOOP_SOAK_MIN_DURATION_HOURS || 48);
const minHealthSamples = Number(process.env.XLOOOP_SOAK_MIN_HEALTH_SAMPLES || 12);
const maxProjectionP95Seconds = Number(process.env.XLOOOP_PROJECTION_MAX_P95_SECONDS || 60);
const checks = [];
const failures = [];
const warnings = [];
let authority = false;

function addCheck(id, ok, details = {}, options = {}) {
  const status = ok ? 'PASS' : (options.warnOnly ? 'WARN' : 'FAIL');
  const row = { id, status, ...details };
  checks.push(row);
  if (!ok && options.block) failures.push(row);
  if (!ok && options.warnOnly) warnings.push(row);
  return row;
}

if (selfTest) {
  runSelfTest();
  process.exit(0);
}

addCheck('evidence_file_configured', Boolean(evidenceFile), {
  env: 'XLOOOP_PILOT_SHADOW_SOAK_ROLLBACK_EVIDENCE_FILE',
  evidence_file: evidenceFile || null,
}, { block: strict, warnOnly: !strict });

if (evidenceFile) {
  const resolved = path.resolve(evidenceFile);
  addCheck('evidence_file_exists', fs.existsSync(resolved), { evidence_file: resolved }, { block: strict, warnOnly: !strict });
  addCheck('evidence_file_not_example', !/(^|[/\\])[^/\\]*(?:schema\.)?example\.json$/i.test(resolved), {
    evidence_file: resolved,
  }, { block: strict, warnOnly: !strict });
  if (fs.existsSync(resolved)) {
    try {
      const evidence = JSON.parse(fs.readFileSync(resolved, 'utf8'));
      addCheck('evidence_file_json', true, { evidence_file: resolved });
      verifyEvidence(evidence, resolved);
    } catch (error) {
      addCheck('evidence_file_json', false, { evidence_file: resolved, error: error.message }, { block: true });
    }
  }
}

const status = failures.length ? 'FAIL' : 'PASS';
const report = {
  schema_id: 'xlooop.pilot_shadow_soak_rollback_evidence.verifier.v1',
  status,
  strict,
  pilot_shadow_soak_rollback_authority: authority,
  evidence_file_configured: Boolean(evidenceFile),
  checks,
  failures,
  warnings,
  conclusion: authority
    ? 'Pilot-shadow soak and rollback evidence authority is present.'
    : '48-72h soak and rollback evidence remains absent or non-authoritative; pilot-shadow completion cannot claim this live gate yet.',
};

console.log(JSON.stringify(report, null, 2));
process.exit(status === 'PASS' ? 0 : 1);

function verifyEvidence(e, evidencePath) {
  const missing = [];
  for (const field of [
    'schema_id',
    'evidence_class',
    'environment',
    'authority',
    'api_base',
    'frontend_origin',
    'backend_build_sha',
    'schema_head',
    'generated_at',
    'soak',
    'health_samples',
    'metrics',
    'queue',
    'rollback_rehearsal',
  ]) {
    if (e[field] === undefined || e[field] === '') missing.push(field);
  }
  addCheck('required_fields_present', missing.length === 0, { missing }, { block: true });
  addCheck('schema_valid', e.schema_id === 'xlooop.pilot_shadow_soak_rollback_evidence.v1', {
    schema_id: e.schema_id || null,
  }, { block: true });
  addCheck('evidence_class_valid', e.evidence_class === 'pilot_shadow_soak_rollback', {
    evidence_class: e.evidence_class || null,
  }, { block: true });
  addCheck('environment_is_pilot_shadow', e.environment === 'pilot-shadow', {
    environment: e.environment || null,
  }, { block: true });
  addCheck('authority_is_shadow', e.authority === 'shadow', {
    authority: e.authority || null,
  }, { block: true });
  addCheck('api_base_is_pilot_shadow_not_production', isPilotShadowApi(e.api_base), {
    api_base: e.api_base || null,
  }, { block: true });
  addCheck('frontend_origin_is_nonproduction_pages', isNonProductionFrontend(e.frontend_origin), {
    frontend_origin: e.frontend_origin || null,
  }, { block: true });
  addCheck('backend_sha_valid', shaOk(e.backend_build_sha), {
    backend_build_sha: e.backend_build_sha || null,
  }, { block: true });
  addCheck('schema_head_numeric', Number.isInteger(Number(e.schema_head)) && Number(e.schema_head) > 0, {
    schema_head: e.schema_head ?? null,
  }, { block: true });

  const generatedMs = Date.parse(e.generated_at || '');
  const ageDays = Number.isNaN(generatedMs)
    ? null
    : Math.round(((Date.now() - generatedMs) / 864e5) * 100) / 100;
  addCheck('generated_at_parses', !Number.isNaN(generatedMs), {
    generated_at: e.generated_at || null,
  }, { block: true });
  addCheck('evidence_fresh_enough', ageDays !== null && ageDays >= 0 && ageDays <= maxAgeDays, {
    generated_age_days: ageDays,
    max_age_days: maxAgeDays,
  }, { block: true });
  addCheck('no_placeholder_markers', placeholderPaths(e).length === 0, {
    placeholder_paths: placeholderPaths(e),
  }, { block: true });
  addCheck('no_raw_secret_keys_or_values', secretPaths(e).length === 0, {
    secret_paths: secretPaths(e),
  }, { block: true });
  addCheck('no_production_runtime_urls', productionUrlPaths(e).length === 0, {
    production_url_paths: productionUrlPaths(e),
  }, { block: true });

  const soakProblems = problemsForSoak(e.soak);
  addCheck('soak_window_complete', soakProblems.length === 0, {
    soak_problems: soakProblems,
  }, { block: true });

  const metricProblems = problemsForMetrics(e.metrics);
  addCheck('soak_metrics_clean', metricProblems.length === 0, {
    metric_problems: metricProblems,
  }, { block: true });

  const queueProblems = problemsForQueue(e.queue);
  addCheck('projection_queue_clean', queueProblems.length === 0, {
    queue_problems: queueProblems,
  }, { block: true });

  const sampleProblems = problemsForHealthSamples(e);
  addCheck('health_samples_cover_soak_window', sampleProblems.length === 0, {
    sample_problems: sampleProblems,
  }, { block: true });

  const rollbackProblems = problemsForRollback(e.rollback_rehearsal, e.backend_build_sha);
  addCheck('rollback_rehearsal_complete', rollbackProblems.length === 0, {
    rollback_problems: rollbackProblems,
  }, { block: true });

  authority =
    failures.length === 0 &&
    e.evidence_class === 'pilot_shadow_soak_rollback' &&
    e.environment === 'pilot-shadow' &&
    e.authority === 'shadow' &&
    isPilotShadowApi(e.api_base) &&
    isNonProductionFrontend(e.frontend_origin) &&
    !/(^|[/\\])[^/\\]*(?:schema\.)?example\.json$/i.test(evidencePath);

  addCheck('pilot_shadow_soak_rollback_authority', authority, {
    evidence_file: evidencePath,
  }, { block: strict, warnOnly: !strict });
}

function problemsForSoak(soak) {
  const problems = [];
  if (!soak || typeof soak !== 'object') return ['soak'];
  const startedMs = Date.parse(soak.started_at || '');
  const endedMs = Date.parse(soak.ended_at || '');
  const duration = Number(soak.duration_hours);
  if (Number.isNaN(startedMs)) problems.push('soak.started_at');
  if (Number.isNaN(endedMs)) problems.push('soak.ended_at');
  if (!Number.isFinite(duration)) problems.push('soak.duration_hours');
  if (!Number.isNaN(startedMs) && !Number.isNaN(endedMs) && endedMs <= startedMs) problems.push('soak.ended_at_order');
  if (Number.isFinite(duration) && duration < minDurationHours) problems.push('soak.duration_hours_minimum');
  if (!Number.isNaN(startedMs) && !Number.isNaN(endedMs) && Number.isFinite(duration)) {
    const observedHours = (endedMs - startedMs) / 3.6e6;
    if (Math.abs(observedHours - duration) > 0.25) problems.push('soak.duration_hours_mismatch');
  }
  if (soak.production_untouched !== true) problems.push('soak.production_untouched');
  if (typeof soak.operator !== 'string' || soak.operator.trim() === '') problems.push('soak.operator');
  return [...new Set(problems)];
}

function problemsForMetrics(metrics) {
  const problems = [];
  if (!metrics || typeof metrics !== 'object') return ['metrics'];
  for (const field of ['http_5xx_count', 'cross_tenant_leakage_count', 'unapproved_write_count', 'dead_letter_count']) {
    if (Number(metrics[field]) !== 0) problems.push(`metrics.${field}`);
  }
  if (!Number.isFinite(Number(metrics.projection_p95_seconds))) problems.push('metrics.projection_p95_seconds');
  if (Number(metrics.projection_p95_seconds) > maxProjectionP95Seconds) problems.push('metrics.projection_p95_seconds_max');
  if (metrics.critical_error_count !== undefined && Number(metrics.critical_error_count) !== 0) problems.push('metrics.critical_error_count');
  if (metrics.error_budget_burn_pct !== undefined && Number(metrics.error_budget_burn_pct) > 1) problems.push('metrics.error_budget_burn_pct');
  return [...new Set(problems)];
}

function problemsForQueue(queue) {
  const problems = [];
  if (!queue || typeof queue !== 'object') return ['queue'];
  if (typeof queue.projection_queue !== 'string' || !/pilot-shadow/.test(queue.projection_queue)) problems.push('queue.projection_queue');
  if (queue.dlq !== undefined && typeof queue.dlq !== 'string') problems.push('queue.dlq');
  if (!Number.isInteger(Number(queue.processed_count)) || Number(queue.processed_count) < 1) problems.push('queue.processed_count');
  if (Number(queue.dead_letter_count) !== 0) problems.push('queue.dead_letter_count');
  if (!Number.isFinite(Number(queue.p95_seconds))) problems.push('queue.p95_seconds');
  if (Number(queue.p95_seconds) > maxProjectionP95Seconds) problems.push('queue.p95_seconds_max');
  return [...new Set(problems)];
}

function problemsForHealthSamples(e) {
  const problems = [];
  const samples = Array.isArray(e.health_samples) ? e.health_samples : [];
  if (samples.length < minHealthSamples) problems.push('health_samples.length');
  const startedMs = Date.parse(e.soak?.started_at || '');
  const endedMs = Date.parse(e.soak?.ended_at || '');
  const times = [];
  samples.forEach((sample, index) => {
    const prefix = `health_samples[${index}]`;
    if (!sample || typeof sample !== 'object') {
      problems.push(prefix);
      return;
    }
    const checkedMs = Date.parse(sample.checked_at || '');
    if (Number.isNaN(checkedMs)) problems.push(`${prefix}.checked_at`);
    else times.push(checkedMs);
    if (Number(sample.status ?? sample.http_status) !== 200) problems.push(`${prefix}.status`);
    if ((sample.build ?? sample.build_sha) !== e.backend_build_sha) problems.push(`${prefix}.build`);
    if (Number(sample.schema_head ?? sample.schema) !== Number(e.schema_head)) problems.push(`${prefix}.schema_head`);
    if (sample.environment !== 'pilot-shadow') problems.push(`${prefix}.environment`);
    if (sample.authority !== 'shadow') problems.push(`${prefix}.authority`);
    if (!/^[0-9a-f]{64}$/.test(sample.contract_hash || '')) problems.push(`${prefix}.contract_hash`);
  });
  if (times.length > 0 && !Number.isNaN(startedMs) && !Number.isNaN(endedMs)) {
    const first = Math.min(...times);
    const last = Math.max(...times);
    if (first > startedMs + 2 * 3600 * 1000) problems.push('health_samples.first_within_2h_of_start');
    if (last < endedMs - 2 * 3600 * 1000) problems.push('health_samples.last_within_2h_of_end');
  }
  return [...new Set(problems)];
}

function problemsForRollback(rollback, backendBuildSha) {
  const problems = [];
  if (!rollback || typeof rollback !== 'object') return ['rollback_rehearsal'];
  const startedMs = Date.parse(rollback.started_at || '');
  const endedMs = Date.parse(rollback.ended_at || '');
  if (rollback.performed !== true) problems.push('rollback_rehearsal.performed');
  if (![
    'pilot_shadow_redeploy_previous_version',
    'pilot_shadow_config_revert',
    'pilot_shadow_rollback_rehearsal',
  ].includes(rollback.mode)) problems.push('rollback_rehearsal.mode');
  if (Number.isNaN(startedMs)) problems.push('rollback_rehearsal.started_at');
  if (Number.isNaN(endedMs)) problems.push('rollback_rehearsal.ended_at');
  if (!Number.isNaN(startedMs) && !Number.isNaN(endedMs) && endedMs <= startedMs) problems.push('rollback_rehearsal.ended_at_order');
  if (typeof rollback.operator !== 'string' || rollback.operator.trim() === '') problems.push('rollback_rehearsal.operator');
  if (rollback.pre_health_build_sha !== backendBuildSha) problems.push('rollback_rehearsal.pre_health_build_sha');
  if (!shaOk(rollback.rollback_target_sha)) problems.push('rollback_rehearsal.rollback_target_sha');
  if (rollback.rollback_target_sha === backendBuildSha) problems.push('rollback_rehearsal.rollback_target_sha_distinct');
  if (rollback.post_health_build_sha !== rollback.rollback_target_sha) problems.push('rollback_rehearsal.post_health_build_sha');
  if (rollback.candidate_restored_sha !== undefined && rollback.candidate_restored_sha !== backendBuildSha) {
    problems.push('rollback_rehearsal.candidate_restored_sha');
  }
  if (rollback.health_restored !== true) problems.push('rollback_rehearsal.health_restored');
  if (rollback.data_loss !== false) problems.push('rollback_rehearsal.data_loss');
  if (rollback.production_untouched !== true) problems.push('rollback_rehearsal.production_untouched');
  if (typeof rollback.receipt_id !== 'string' || rollback.receipt_id.trim() === '') problems.push('rollback_rehearsal.receipt_id');
  if (!Array.isArray(rollback.audit_ids) || rollback.audit_ids.length < 1) problems.push('rollback_rehearsal.audit_ids');
  return [...new Set(problems)];
}

function shaOk(value) {
  return /^[0-9a-f]{40}$/.test(value || '');
}

function isPilotShadowApi(apiBase) {
  return typeof apiBase === 'string' &&
    /^https:\/\//.test(apiBase) &&
    apiBase !== 'https://api.xlooop.com' &&
    /xlooop-api-pilot-shadow/.test(apiBase);
}

function isNonProductionFrontend(origin) {
  if (typeof origin !== 'string' || !/^https:\/\//.test(origin) || origin === 'https://app.xlooop.com') {
    return false;
  }
  try {
    return /\.xlooop-app-next\.pages\.dev$/.test(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function placeholderPaths(value, prefix = '') {
  return stringValuePaths(value, prefix, /(placeholder|example|changeme|todo)/i);
}

function productionUrlPaths(value, prefix = '') {
  return stringValuePaths(value, prefix, /https:\/\/(?:api|app)\.xlooop\.com|xlooop-api-prod/i);
}

function secretPaths(value, prefix = '') {
  if (!value || typeof value !== 'object') return [];
  const problems = [];
  for (const [key, child] of Object.entries(value)) {
    const current = prefix ? `${prefix}.${key}` : key;
    if (/(^|_)(access_token|authorization|cookie|database_url|dsn|password|private_key|refresh_token|secret|session_secret|token)$/i.test(key)) {
      problems.push(current);
    }
    if (typeof child === 'string' && /(postgres(?:ql)?:\/\/|bearer\s+|password=|sk_live_|-----BEGIN [A-Z ]+PRIVATE KEY-----)/i.test(child)) {
      problems.push(current);
    }
    if (child && typeof child === 'object') problems.push(...secretPaths(child, current));
  }
  return [...new Set(problems)];
}

function stringValuePaths(value, prefix, pattern) {
  if (typeof value === 'string') return pattern.test(value) ? [prefix || '<root>'] : [];
  if (!value || typeof value !== 'object') return [];
  const problems = [];
  for (const [key, child] of Object.entries(value)) {
    const current = prefix ? `${prefix}.${key}` : key;
    problems.push(...stringValuePaths(child, current, pattern));
  }
  return [...new Set(problems)];
}

function runSelfTest() {
  const now = Date.now();
  const start = new Date(now - 49 * 3600 * 1000).toISOString();
  const end = new Date(now - 1 * 3600 * 1000).toISOString();
  const build = 'a'.repeat(40);
  const target = 'b'.repeat(40);
  const healthSamples = Array.from({ length: minHealthSamples }, (_, index) => ({
    checked_at: new Date(Date.parse(start) + index * ((Date.parse(end) - Date.parse(start)) / (minHealthSamples - 1))).toISOString(),
    status: 200,
    build,
    schema_head: 79,
    environment: 'pilot-shadow',
    authority: 'shadow',
    contract_hash: 'c'.repeat(64),
  }));
  const valid = {
    schema_id: 'xlooop.pilot_shadow_soak_rollback_evidence.v1',
    evidence_class: 'pilot_shadow_soak_rollback',
    environment: 'pilot-shadow',
    authority: 'shadow',
    api_base: 'https://xlooop-api-pilot-shadow.xlooop23.workers.dev',
    frontend_origin: 'https://0829da1f.xlooop-app-next.pages.dev',
    backend_build_sha: build,
    schema_head: 79,
    generated_at: new Date(now).toISOString(),
    soak: {
      started_at: start,
      ended_at: end,
      duration_hours: 48,
      operator: 'pilot-shadow-operator',
      production_untouched: true,
    },
    health_samples: healthSamples,
    metrics: {
      http_5xx_count: 0,
      cross_tenant_leakage_count: 0,
      unapproved_write_count: 0,
      dead_letter_count: 0,
      projection_p95_seconds: 42,
      critical_error_count: 0,
      error_budget_burn_pct: 0,
    },
    queue: {
      projection_queue: 'xlooop-tenant-projection-pilot-shadow',
      dlq: 'xlooop-tenant-projection-pilot-shadow-dlq',
      processed_count: 12,
      dead_letter_count: 0,
      p95_seconds: 42,
    },
    rollback_rehearsal: {
      performed: true,
      mode: 'pilot_shadow_rollback_rehearsal',
      started_at: new Date(now - 45 * 60 * 1000).toISOString(),
      ended_at: new Date(now - 30 * 60 * 1000).toISOString(),
      operator: 'pilot-shadow-operator',
      pre_health_build_sha: build,
      rollback_target_sha: target,
      post_health_build_sha: target,
      candidate_restored_sha: build,
      health_restored: true,
      data_loss: false,
      production_untouched: true,
      receipt_id: 'rollback_receipt_1',
      audit_ids: ['audit_rollback_1'],
    },
  };

  const previousFailures = failures.length;
  verifyEvidence(valid, '/tmp/pilot-shadow-soak-rollback-live.json');
  const validOk = failures.length === previousFailures && authority === true;
  const prodRejected = !isPilotShadowApi('https://api.xlooop.com') &&
    !isNonProductionFrontend('https://app.xlooop.com') &&
    productionUrlPaths({ api_base: 'https://api.xlooop.com' }).length === 1;
  const secretRejected = secretPaths({ database_url: 'redacted' }).length > 0;
  const placeholderRejected = placeholderPaths({ note: 'todo' }).length === 1;
  if (!validOk || !prodRejected || !secretRejected || !placeholderRejected) {
    console.error(JSON.stringify({ validOk, prodRejected, secretRejected, placeholderRejected, checks, failures }, null, 2));
    throw new Error('self-test failed');
  }
  console.log('PASS pilot-shadow soak rollback evidence self-test');
}
