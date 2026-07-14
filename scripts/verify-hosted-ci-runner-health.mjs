#!/usr/bin/env node
// Verifies that hosted CI/account/runner failures are classified as infrastructure
// or disabled-runner policy, not hidden as product-code failures.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const report = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data/hosted-ci-runner-health.json'), 'utf8'));
const strictHostedFreshness = process.argv.includes('--strict-fresh') || process.env.XLOOOP_REQUIRE_HOSTED_CI_FRESH === '1';
const failures = [];
const warnings = [];
const checks = [];

function check(id, ok, details = {}) {
  checks.push({ id, status: ok ? 'PASS' : 'FAIL', ...details });
  if (!ok) failures.push({ id, ...details });
}
function warn(id, message, details = {}, options = {}) {
  const row = { id, status: options.block ? 'FAIL' : 'WARN', message, ...details };
  if (options.block) failures.push({ id, message, ...details });
  else warnings.push({ id, message, ...details });
  checks.push(row);
}

function currentHeadFor(repoName) {
  if (repoName === 'mar23-lab/Xlooop-XCP-demo') {
    const proc = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
    return proc.status === 0 ? proc.stdout.trim() : '';
  }
  if (repoName === 'mar23-lab/MB-P') {
    const proc = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: '/Users/maratbasyrov/WIP/MB-P', encoding: 'utf8' });
    return proc.status === 0 ? proc.stdout.trim() : '';
  }
  return '';
}

check('schema_version', report.schema_version === 'xlooop.hosted_ci_runner_health.v1');
check('hosted_not_release_authority', report.policy?.hosted_ci_is_release_authority === false);
check('local_replacement_policy_present', report.policy?.local_replacement_required_when_hosted_pre_step_failure === true);
check('repositories_present', Array.isArray(report.repositories) && report.repositories.length >= 2, { repo_count: (report.repositories || []).length });

for (const repo of report.repositories || []) {
  const currentHead = currentHeadFor(repo.repo);
  const evidenceHeadCurrent = Boolean(repo.head_sha) && Boolean(currentHead) && repo.head_sha === currentHead;
  if (repo.classification === 'hosted_ci_pre_step_infra_failure') {
    check(`fresh_evidence_matches_current_head:${repo.repo}`, evidenceHeadCurrent, {
      evidence_head_sha: repo.head_sha || null,
      current_head_sha: currentHead || null,
    });
  } else if (repo.classification === 'hosted_actions_disabled_non_authoritative') {
    if (!evidenceHeadCurrent) {
      warn(
        `hosted_evidence_head_not_current:${repo.repo}`,
        'Hosted run evidence is not on current HEAD because this repo disables workflow YAML; local gates remain release authority.',
        { evidence_head_sha: repo.head_sha || null, current_head_sha: currentHead || null },
        { block: strictHostedFreshness },
      );
    }
  }
  check(`repo_present:${repo.repo}`, Boolean(repo.repo));
  check(`repo_not_release_gate:${repo.repo}`, repo.active_as_release_gate === false, { classification: repo.classification });
  check(`repo_local_replacement_required:${repo.repo}`, repo.local_replacement_required === true);
  check(`repo_runs_present:${repo.repo}`, Array.isArray(repo.runs) && repo.runs.length > 0, { run_count: (repo.runs || []).length });

  if (repo.classification === 'hosted_ci_pre_step_infra_failure') {
    const jobs = (repo.runs || []).flatMap((run) => run.jobs || []);
    const badJobs = jobs.filter((job) => !Array.isArray(job.steps) || job.steps.length !== 0 || Number(job.duration_seconds) > 7);
    check(`pre_step_jobs_have_no_steps:${repo.repo}`, badJobs.length === 0, { bad_jobs: badJobs });
    check(`fresh_observed_at:${repo.repo}`, !Number.isNaN(Date.parse(repo.observed_at || '')));
  } else if (repo.classification === 'hosted_actions_disabled_non_authoritative') {
    check(`workflow_yaml_disabled:${repo.repo}`, repo.current_workflow_yaml_count === 0, { current_workflow_yaml_count: repo.current_workflow_yaml_count });
    warn(`hosted_run_evidence_stale:${repo.repo}`, 'Hosted run evidence is historical because the repo currently disables workflow YAML; local gates are the active release authority.', { latest_run_created_at: repo.runs?.[0]?.created_at || null });
  } else {
    check(`known_classification:${repo.repo}`, false, { classification: repo.classification });
  }
}

const output = { schema_id: 'xlooop.hosted_ci_runner_health.verifier.v1', status: failures.length ? 'FAIL' : 'PASS', strict_hosted_freshness: strictHostedFreshness, checks, failures, warnings };
console.log(JSON.stringify(output, null, 2));
process.exit(failures.length ? 1 : 0);
