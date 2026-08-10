#!/usr/bin/env node
// Prepare the two SHA-256 canary bindings consumed by pilot-shadow auth.
//
// This command never calls Cloudflare and never prints token or hash values. It
// parses the token value from the governed env file, hashes that value (not the
// containing file), and writes a mode-0600 Wrangler secret-bulk JSON artifact
// outside the repository for a separately approved operator action.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.argv.includes('--self-test')) {
  selfTest();
  process.exit(0);
}

const readEnvFile = arg('read-env-file')
  || process.env.XLOOOP_CANARY_API_TOKEN_ENV_FILE
  || path.join(os.homedir(), '.xlooop', 'pilot-telemetry', 'secrets', 'xlooop-canary-api-token.env');
const lifecycleTokenFile = arg('lifecycle-token-file')
  || process.env.XLOOOP_CANARY_LIFECYCLE_API_TOKEN_FILE
  || '/tmp/xlooop-canary-lifecycle-api-token.txt';
const outputPath = arg('output');

if (!outputPath) refuse('missing --output=/absolute/path.json');
prepareBundle({
  readEnvFile,
  lifecycleTokenFile,
  outputPath,
  overwrite: process.argv.includes('--overwrite'),
});

console.log(JSON.stringify({
  schema_id: 'xlooop.pilot_shadow_canary_secret_bundle_preparation.v1',
  status: 'PASS',
  target: 'xlooop-api-pilot-shadow',
  config: 'wrangler.pilot-shadow.toml',
  output_path: path.resolve(outputPath),
  output_mode: '0600',
  secret_names: [
    'XLOOOP_CANARY_API_TOKEN_SHA256',
    'XLOOOP_CANARY_LIFECYCLE_TOKEN_SHA256',
  ],
  raw_tokens_written: false,
  cloudflare_mutation_performed: false,
  next_action: 'After exact operator approval, run Wrangler secret bulk with this file and wrangler.pilot-shadow.toml, then delete the temporary bundle after live verification.',
}, null, 2));

function prepareBundle({ readEnvFile, lifecycleTokenFile, outputPath, overwrite }) {
  const resolvedOutput = path.resolve(outputPath);
  if (!path.isAbsolute(outputPath)) refuse('output path must be absolute');
  if (isWithin(repoRoot, resolvedOutput)) refuse('output path must be outside the repository');
  if (path.extname(resolvedOutput) !== '.json') refuse('output path must end in .json');
  if (!overwrite && fs.existsSync(resolvedOutput)) refuse('output already exists; use a new path or explicit --overwrite');

  const envValues = parseEnvFile(readEnvFile);
  const readToken = validateToken(envValues.XLOOOP_CANARY_API_TOKEN, 'read canary token');
  const lifecycleToken = validateToken(readSecretFile(lifecycleTokenFile), 'lifecycle canary token');
  if (readToken === lifecycleToken) refuse('read and lifecycle canary tokens must be distinct');

  const bundle = {
    XLOOOP_CANARY_API_TOKEN_SHA256: sha256(readToken),
    XLOOOP_CANARY_LIFECYCLE_TOKEN_SHA256: sha256(lifecycleToken),
  };
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true, mode: 0o700 });
  fs.writeFileSync(resolvedOutput, `${JSON.stringify(bundle, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: overwrite ? 'w' : 'wx',
  });
  fs.chmodSync(resolvedOutput, 0o600);
  return bundle;
}

function parseEnvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) refuse(`read canary env file not found: ${filePath}`);
  const values = {};
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    values[match[1]] = unquote(match[2].trim());
  }
  return values;
}

function readSecretFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) refuse(`lifecycle canary token file not found: ${filePath}`);
  return fs.readFileSync(filePath, 'utf8').trim();
}

function validateToken(value, label) {
  const token = String(value || '').trim();
  if (token.length < 32) refuse(`${label} must be at least 32 characters`);
  if (/\s/.test(token)) refuse(`${label} must not contain whitespace`);
  return token;
}

function unquote(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function arg(name) {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : '';
}

function refuse(message) {
  console.error(`prepare-pilot-shadow-canary-secret-bundle · REFUSED · ${message}`);
  process.exit(1);
}

function selfTest() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlooop-canary-bundle-self-test-'));
  const readToken = 'read-token-abcdefghijklmnopqrstuvwxyz-0123456789';
  const lifecycleToken = 'lifecycle-token-abcdefghijklmnopqrstuvwxyz-9876543210';
  const envFile = path.join(tempDir, 'canary.env');
  const lifecycleFile = path.join(tempDir, 'lifecycle.txt');
  const output = path.join(tempDir, 'bundle.json');
  fs.writeFileSync(envFile, `export XLOOOP_CANARY_API_TOKEN='${readToken}'\n`, { mode: 0o600 });
  fs.writeFileSync(lifecycleFile, `${lifecycleToken}\n`, { mode: 0o600 });

  const bundle = prepareBundle({ readEnvFile: envFile, lifecycleTokenFile: lifecycleFile, outputPath: output, overwrite: false });
  const saved = JSON.parse(fs.readFileSync(output, 'utf8'));
  const mode = fs.statSync(output).mode & 0o777;
  const checks = [
    ['read token value is hashed', bundle.XLOOOP_CANARY_API_TOKEN_SHA256 === sha256(readToken)],
    ['whole env file is not hashed', bundle.XLOOOP_CANARY_API_TOKEN_SHA256 !== sha256(fs.readFileSync(envFile, 'utf8'))],
    ['lifecycle token value is hashed', bundle.XLOOOP_CANARY_LIFECYCLE_TOKEN_SHA256 === sha256(lifecycleToken)],
    ['raw read token is absent', !JSON.stringify(saved).includes(readToken)],
    ['raw lifecycle token is absent', !JSON.stringify(saved).includes(lifecycleToken)],
    ['output mode is 0600', mode === 0o600],
  ];
  const failures = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failures.length) {
    console.error(JSON.stringify({ status: 'FAIL', failures }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ status: 'PASS', checks: checks.map(([name]) => name) }, null, 2));
}
