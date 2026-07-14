// scripts/lib/data-projection-meta.mjs · Round 13 R13.4 (2026-05-20).
//
// Shared helper for stamping the _meta envelope onto producer outputs so the
// runtime reader (R13.3) + smoke validator (R13.2) can detect drift.
//
// Envelope shape (matches data/schemas/*.v1.schema.json _meta property):
//   {
//     schema:        "<schema-name>.v1",
//     generated_at:  <ISO-8601 timestamp; defaults to now>,
//     producer:      <producer script path relative to repo root>,
//     git_sha:       <commit sha, or "" for dev/commit-feedback-safe snapshots>,
//   }
//
// Usage in a producer:
//   import { stampProducerMeta } from './lib/data-projection-meta.mjs';
//   const contract = stampProducerMeta(buildContract(), {
//     schema: 'operations-live-stream.v1',
//     producer: 'scripts/generate-operations-live-stream.mjs',
//   });
//   fs.writeFileSync(outPath, JSON.stringify(contract, null, 2) + '\n');
//
// The helper preserves the original key order by spreading the original
// object after _meta, so _meta lands at the top of the JSON file (the
// natural reading position).

import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

let cachedGitSha = null;

export function resolveGitSha(explicitGitSha = undefined) {
  if (explicitGitSha !== undefined) {
    return String(explicitGitSha || '');
  }
  if (cachedGitSha !== null) return cachedGitSha;
  if (process.env.GIT_SHA) {
    cachedGitSha = process.env.GIT_SHA;
    return cachedGitSha;
  }
  try {
    const sha = execSync('git rev-parse HEAD', { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    cachedGitSha = sha;
    return sha;
  } catch (_) {
    cachedGitSha = '';
    return '';
  }
}

export function stampProducerMeta(contract, { schema, producer, generatedAt, gitSha }) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    throw new TypeError('stampProducerMeta · contract must be a plain object');
  }
  if (!schema || typeof schema !== 'string') {
    throw new TypeError('stampProducerMeta · schema (string) is required');
  }
  if (!producer || typeof producer !== 'string') {
    throw new TypeError('stampProducerMeta · producer (string) is required');
  }
  const meta = {
    schema,
    generated_at: generatedAt || contract.generated_at || new Date().toISOString(),
    producer,
    git_sha: resolveGitSha(gitSha),
  };
  return { _meta: meta, ...contract };
}
