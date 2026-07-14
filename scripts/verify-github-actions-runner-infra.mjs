#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = args.get('repo') || 'mar23-lab/Xlooop-XCP-demo';
const workflow = args.get('workflow') || 'Cloudflare Pages Deploy - Xlooop';
const runId = args.get('run-id') || '';

if (!runId && actionsAreIntentionallyDisabled()) {
  console.log(JSON.stringify({
    status: 'PASS',
    schema_version: 'xlooop.github_actions_runner_infra_v1',
    repo,
    workflow,
    runner_status: 'disabled_by_owner_policy',
    active_workflow_count: 0,
    preserved_template_dir: 'deployment/github-actions-disabled',
    recommendation: 'Use local Cloudflare deploy scripts until owner re-enables paid GitHub Actions runners.',
  }, null, 2));
  process.exit(0);
}

const run = runId ? viewRun(runId) : latestRunForWorkflow(workflow);
const findings = [];
const emptyStepFailures = [];

if (!run) fail(`No GitHub Actions run found for workflow '${workflow}' in ${repo}`);

for (const job of run.jobs || []) {
  if (job.conclusion === 'failure' && Array.isArray(job.steps) && job.steps.length === 0) {
    emptyStepFailures.push(job);
  }
}

if (emptyStepFailures.length) {
  for (const job of emptyStepFailures) {
    findings.push({
      id: 'github_actions_job_failed_before_steps',
      severity: 'blocker',
      job_id: job.databaseId,
      job_name: job.name,
      evidence: 'GitHub returned a failed job with steps: []',
      likely_causes: [
        'private repository Actions minutes or billing policy blocked',
        'account-level Actions runner policy blocked hosted runners',
        'organization/repository Actions infrastructure policy blocked execution before runner assignment',
      ],
      recommended_actions: [
        'Keep .github/workflows empty while GitHub Actions is unpaid/unavailable.',
        'Use deployment/github-actions-disabled only as preserved future templates.',
        'Use npm run deploy:cloudflare:test:local:feedback or npm run deploy:cloudflare:test:local:safe-preview until hosted Actions runner health passes.',
        'Only restore active GitHub Actions after owner approval and a passing runner-health proof.',
      ],
    });
  }
}

const report = {
  status: findings.length ? 'FAIL' : 'PASS',
  schema_version: 'xlooop.github_actions_runner_infra_v1',
  repo,
  workflow,
  run_id: run.databaseId,
  run_url: run.url,
  conclusion: run.conclusion,
  status_label: run.status,
  job_count: (run.jobs || []).length,
  empty_step_failure_count: emptyStepFailures.length,
  findings,
};

console.log(JSON.stringify(report, null, 2));
if (findings.length) process.exit(1);

function latestRunForWorkflow(workflowName) {
  const rows = ghJson([
    'run',
    'list',
    '--repo',
    repo,
    '--workflow',
    workflowName,
    '--limit',
    '1',
    '--json',
    'databaseId,workflowName,status,conclusion,event,headBranch,headSha,createdAt,updatedAt,url',
  ]);
  if (!rows?.[0]?.databaseId) return null;
  return viewRun(rows[0].databaseId);
}

function viewRun(id) {
  return ghJson([
    'run',
    'view',
    String(id),
    '--repo',
    repo,
    '--json',
    'databaseId,name,workflowName,status,conclusion,event,headBranch,headSha,createdAt,updatedAt,url,jobs',
  ]);
}

function ghJson(commandArgs) {
  try {
    const stdout = execFileSync('gh', commandArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(stdout);
  } catch (error) {
    const stderr = error.stderr?.toString()?.trim();
    fail(`gh ${commandArgs.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
}

function fail(message) {
  console.error(`github-actions-runner-infra: FAIL - ${message}`);
  process.exit(1);
}

function actionsAreIntentionallyDisabled() {
  const activeDir = path.join(repoRoot, '.github', 'workflows');
  const disabledDir = path.join(repoRoot, 'deployment', 'github-actions-disabled');
  const active = fs.existsSync(activeDir)
    ? fs.readdirSync(activeDir).filter((name) => /\.ya?ml$/i.test(name))
    : [];
  const disabled = fs.existsSync(disabledDir)
    ? fs.readdirSync(disabledDir).filter((name) => /\.ya?ml$/i.test(name))
    : [];
  return active.length === 0
    && ['cloudflare-pages.yml', 'cloudflare-feedback-d1.yml', 'smoke.yml'].every((name) => disabled.includes(name));
}
