#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assessFrontendReleaseArtifact,
  hashReleaseFiles,
  parseFrontendReleaseArtifact,
  verifyStaticArtifactFiles,
} from './lib/app-pages-release-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactDir = path.resolve(process.env.XLOOOP_FRONTEND_ARTIFACT_DIR || '');
const outputDir = path.resolve(process.env.XLOOOP_APP_PAGES_RELEASE_DIR || path.join(root, 'dist-app-pages-release'));
const allowedOutput = path.join(root, 'dist-app-pages-release');

function fail(message) {
  console.error(`prepare-app-pages-release · FAIL-CLOSED · ${message}`);
  process.exit(1);
}

if (!process.env.XLOOOP_FRONTEND_ARTIFACT_DIR) fail('XLOOOP_FRONTEND_ARTIFACT_DIR is required');
if (outputDir !== allowedOutput) fail(`release output must be ${allowedOutput}`);
if (artifactDir === outputDir || artifactDir.startsWith(`${outputDir}${path.sep}`)) {
  fail('frontend artifact cannot be inside the release output directory');
}

const backendSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const backendDirty = execFileSync('git', ['status', '--porcelain=v1'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
if (backendDirty) fail('release assembly requires a clean backend worktree');
const generatedAt = execFileSync('git', ['show', '-s', '--format=%cI', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const contract = JSON.parse(readFileSync(path.join(root, 'docs/contracts/api-contract.v1.json'), 'utf8'));
const config = parseFrontendReleaseArtifact(artifactDir);
const assessment = assessFrontendReleaseArtifact(config, { backend_sha: backendSha });
const fileProblems = verifyStaticArtifactFiles(artifactDir, contract.contract_hash);
if (!assessment.ok || fileProblems.length) {
  fail([...assessment.problems, ...fileProblems].join(','));
}

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });
cpSync(artifactDir, outputDir, { recursive: true });

const wrangler = path.join(root, 'node_modules', '.bin', 'wrangler');
const build = spawnSync(
  wrangler,
  [
    'pages',
    'functions',
    'build',
    'functions',
    '--outdir',
    path.join(outputDir, '_worker.js'),
    '--project-directory',
    root,
    '--build-output-directory',
    outputDir,
    '--output-routes-path',
    path.join(outputDir, '_routes.json'),
  ],
  { cwd: root, encoding: 'utf8' },
);
if (build.status !== 0) fail(`Pages Functions build failed\n${build.stderr || build.stdout}`);

const manifest = {
  schema_id: 'xlooop.app_pages_release_manifest.v1',
  generated_at: generatedAt,
  frontend_sha: config.frontend_sha,
  backend_sha: backendSha,
  contract_hash: contract.contract_hash,
  schema_head: config.schema_head,
  environment: config.environment,
  authority: config.authority,
  api_base: config.api_base,
  feature_posture: config.feature_posture,
  files: hashReleaseFiles(outputDir),
};
writeFileSync(path.join(outputDir, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `prepare-app-pages-release · PASS · frontend=${manifest.frontend_sha} backend=${manifest.backend_sha}`
  + ` files=${Object.keys(manifest.files).length}`,
);
