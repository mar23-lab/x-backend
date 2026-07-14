#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policyPath = path.join(repoRoot, 'docs/engineering/generated-artifact-policy.json');
const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
const verify = process.argv.includes('--verify');
const jsonOnly = process.argv.includes('--json');

function globToRegExp(glob) {
  const escaped = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`);
}

const rules = (policy.rules || []).flatMap((rule) =>
  (rule.patterns || []).map((pattern) => ({
    ...rule,
    pattern,
    re: globToRegExp(pattern),
  })),
);

function classify(rel) {
  const normalized = rel.replace(/\\/g, '/');
  const match = rules.find((rule) => rule.re.test(normalized));
  return match ? {
    class: match.class,
    pattern: match.pattern,
    commit_disposition: match.commit_disposition,
    read_only_behavior: match.read_only_behavior,
  } : {
    class: 'unclassified',
    pattern: null,
    commit_disposition: 'owner_disposition_required',
    read_only_behavior: 'must_not_change',
  };
}

function parsePorcelain(raw) {
  const entries = String(raw || '').split('\0').filter(Boolean);
  const files = [];
  for (let idx = 0; idx < entries.length; idx += 1) {
    const entry = entries[idx];
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    const target = file.includes(' -> ') ? file.split(' -> ').pop() : file;
    files.push({
      status: status.trim() || status,
      path: target,
      ...classify(target),
    });
    if (/^[RC]/.test(status)) idx += 1;
  }
  return files;
}

const branch = execFileSync('git', ['branch', '--show-current'], { cwd: repoRoot, encoding: 'utf8' }).trim();
const status = execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: repoRoot, encoding: 'utf8' });
const files = parsePorcelain(status);
const byClass = files.reduce((acc, file) => {
  acc[file.class] = (acc[file.class] || 0) + 1;
  return acc;
}, {});
const unclassified = files.filter((file) => file.class === 'unclassified');

const result = {
  schema_version: 'xlooop.dirty_worktree_classification.v1',
  status: unclassified.length ? 'fail' : 'pass',
  branch,
  repo_root: repoRoot,
  policy_path: path.relative(repoRoot, policyPath),
  dirty_files: files.length,
  by_class: byClass,
  files,
  unclassified,
  next_action: unclassified.length
    ? 'Classify these paths in docs/engineering/generated-artifact-policy.json or get owner disposition before commit/deploy.'
    : 'All dirty files are classified. Commit/dispose by class before closeout.',
};

if (jsonOnly) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`dirty-worktree-classification · ${result.status.toUpperCase()} · ${files.length} dirty files`);
  for (const [klass, count] of Object.entries(byClass).sort()) console.log(`  ${klass}: ${count}`);
  if (unclassified.length) {
    console.error('\nunclassified:');
    for (const file of unclassified) console.error(`  - ${file.path} (${file.status})`);
  }
}

if (verify && unclassified.length) process.exit(1);
