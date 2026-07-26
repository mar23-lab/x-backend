import { createHash } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

export const SHA_PATTERN = /^[0-9a-f]{40}$/;
export const HASH_PATTERN = /^[0-9a-f]{64}$/;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const FEATURE_POSTURE_KEYS = [
  'single_intake',
  'role_skill_catalog',
  'context_packet_persistence',
  'chat_history_persistence_required',
  'tenant_projection_queue',
  'current_work_projection',
];
export const PAGES_FUNCTIONS_ROUTE_SOURCE_MARKER =
  '// xlooop: normalized Wrangler Pages Functions route module';
const PAGES_FUNCTIONS_ROUTE_SOURCE_PATTERN =
  /^\/\/ (?:\.\.\/)+\.wrangler\/tmp\/pages-[A-Za-z0-9_-]+\/functionsRoutes-[0-9.]+\.mjs$/gm;
const PAGES_FUNCTIONS_TMP_COMMENT_PATTERN =
  /^\/\/ .*\.wrangler\/tmp\/pages-[^\r\n]+$/gm;

function assignment(source, name) {
  const match = source.match(new RegExp(`window\\.${name}=([^;]+);`));
  if (!match) throw new Error(`artifact marker missing: window.${name}`);
  try {
    return JSON.parse(match[1]);
  } catch {
    throw new Error(`artifact marker is not JSON-safe: window.${name}`);
  }
}

export function parseFrontendReleaseHtml(html) {
  return {
    build_mode: assignment(html, '__XLOOP_BUILD_MODE'),
    require_contract_handshake: assignment(html, '__XLOOP_REQUIRE_CONTRACT_HANDSHAKE'),
    api_base: assignment(html, '__XLOOP_API_BASE'),
    frontend_sha: assignment(html, '__XLOOP_FRONTEND_SHA'),
    backend_sha: assignment(html, '__XLOOP_EXPECTED_BACKEND_SHA'),
    schema_head: assignment(html, '__XLOOP_EXPECTED_SCHEMA_HEAD'),
    environment: assignment(html, '__XLOOP_EXPECTED_ENVIRONMENT'),
    authority: assignment(html, '__XLOOP_EXPECTED_AUTHORITY'),
    feature_posture: assignment(html, '__XLOOP_EXPECTED_FEATURE_POSTURE'),
  };
}

export function parseFrontendReleaseArtifact(artifactDir) {
  const indexPath = path.join(artifactDir, 'index.html');
  if (!existsSync(indexPath)) throw new Error(`frontend artifact missing ${indexPath}`);
  return parseFrontendReleaseHtml(readFileSync(indexPath, 'utf8'));
}

export function exactPostureProblems(posture, prefix = 'feature_posture') {
  if (!posture || typeof posture !== 'object' || Array.isArray(posture)) return [prefix];
  const problems = [];
  const unknown = Object.keys(posture).filter((key) => !FEATURE_POSTURE_KEYS.includes(key));
  for (const key of FEATURE_POSTURE_KEYS) {
    if (typeof posture[key] !== 'boolean') problems.push(`${prefix}.${key}`);
  }
  if (unknown.length) problems.push(`${prefix}.unknown:${unknown.join(',')}`);
  return problems;
}

export function posturesEqual(left, right) {
  return (
    exactPostureProblems(left, 'left').length === 0
    && exactPostureProblems(right, 'right').length === 0
    && FEATURE_POSTURE_KEYS.every((key) => left[key] === right[key])
  );
}

export function assessFrontendReleaseArtifact(config, expected) {
  const problems = [];
  if (config.build_mode !== 'production') problems.push('build_mode');
  if (config.require_contract_handshake !== true) problems.push('require_contract_handshake');
  if (config.api_base !== 'https://api.xlooop.com') problems.push('api_base');
  if (!SHA_PATTERN.test(config.frontend_sha || '')) problems.push('frontend_sha');
  if (!SHA_PATTERN.test(config.backend_sha || '')) problems.push('backend_sha');
  if (!Number.isSafeInteger(config.schema_head) || config.schema_head < 1) problems.push('schema_head');
  if (config.environment !== 'production') problems.push('environment');
  if (config.authority !== 'production') problems.push('authority');
  problems.push(...exactPostureProblems(config.feature_posture));
  if (expected?.frontend_sha && config.frontend_sha !== expected.frontend_sha) {
    problems.push('frontend_sha_mismatch');
  }
  if (expected?.backend_sha && config.backend_sha !== expected.backend_sha) {
    problems.push('backend_sha_mismatch');
  }
  return { ok: problems.length === 0, problems };
}

export function verifyStaticArtifactFiles(artifactDir, contractHash) {
  const problems = [];
  for (const entry of [
    'index.html',
    '_headers',
    'clerk-boot.js',
    'contract-meta.js',
    'live-data.js',
    'support.js',
    'vendor',
  ]) {
    if (!existsSync(path.join(artifactDir, entry))) problems.push(`missing:${entry}`);
  }
  for (const forbidden of ['scripts', 'src', 'node_modules']) {
    if (existsSync(path.join(artifactDir, forbidden))) problems.push(`source_leak:${forbidden}`);
  }
  const contractMeta = path.join(artifactDir, 'contract-meta.js');
  if (existsSync(contractMeta) && !readFileSync(contractMeta, 'utf8').includes(contractHash)) {
    problems.push('contract_hash_mismatch');
  }
  return problems;
}

function walkFiles(root, current = root) {
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join('/'));
    else throw new Error(`release tree contains unsupported filesystem entry: ${absolute}`);
  }
  return files.sort();
}

export function hashReleaseFiles(root, excluded = new Set(['release-manifest.json'])) {
  const result = {};
  for (const relative of walkFiles(root)) {
    if (excluded.has(relative)) continue;
    const absolute = path.join(root, relative);
    if (!statSync(absolute).isFile()) continue;
    result[relative] = createHash('sha256').update(readFileSync(absolute)).digest('hex');
  }
  return result;
}

export function normalizePagesFunctionsBundle(source) {
  const generatedMatches = [...source.matchAll(PAGES_FUNCTIONS_ROUTE_SOURCE_PATTERN)];
  const stableMatches = source.split(PAGES_FUNCTIONS_ROUTE_SOURCE_MARKER).length - 1;
  const tmpComments = [...source.matchAll(PAGES_FUNCTIONS_TMP_COMMENT_PATTERN)];

  if (generatedMatches.length === 0 && stableMatches === 1 && tmpComments.length === 0) {
    return source;
  }
  if (
    generatedMatches.length !== 1
    || stableMatches !== 0
    || tmpComments.length !== generatedMatches.length
  ) {
    throw new Error(
      'Pages Functions bundle must contain exactly one recognized Wrangler route-source comment',
    );
  }
  return source.replace(PAGES_FUNCTIONS_ROUTE_SOURCE_PATTERN, PAGES_FUNCTIONS_ROUTE_SOURCE_MARKER);
}

export function assessReleaseManifest(manifest, currentHashes = null) {
  const problems = [];
  if (manifest?.schema_id !== 'xlooop.app_pages_release_manifest.v1') problems.push('schema_id');
  if (!SHA_PATTERN.test(manifest?.frontend_sha || '')) problems.push('frontend_sha');
  if (!SHA_PATTERN.test(manifest?.backend_sha || '')) problems.push('backend_sha');
  if (!HASH_PATTERN.test(manifest?.contract_hash || '')) problems.push('contract_hash');
  if (!Number.isSafeInteger(manifest?.schema_head) || manifest.schema_head < 1) problems.push('schema_head');
  if (manifest?.environment !== 'production') problems.push('environment');
  if (manifest?.authority !== 'production') problems.push('authority');
  problems.push(...exactPostureProblems(manifest?.feature_posture));
  if (!manifest?.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    problems.push('files');
  }
  if (currentHashes) {
    const expected = JSON.stringify(manifest?.files || {});
    const actual = JSON.stringify(currentHashes);
    if (expected !== actual) problems.push('file_hashes');
  }
  return { ok: problems.length === 0, problems };
}

export function assessPagesDecisionPacket(packet, expected) {
  const problems = [];
  const maxAuthorizationTtlMs = 30 * 60 * 1000;
  const decision = packet?.decision || {};
  const target = packet?.target || {};
  const candidate = packet?.candidate || {};
  const rollback = packet?.rollback || {};
  const deployment = packet?.expected_deployment || {};

  if (packet?.schema_id !== 'xlooop.app_pages_deployment_decision.v1') problems.push('schema_id');
  if (packet?.status !== 'approved_to_deploy') problems.push('status');
  if (packet?.deployment_allowed !== true) problems.push('deployment_allowed');
  if (packet?.commercial_release_allowed !== false) problems.push('commercial_release_allowed');
  if (!decision.approver) problems.push('approver');
  if (!decision.approval_reference) problems.push('approval_reference');
  if (!UUID_PATTERN.test(decision.authorization_id || '')) problems.push('authorization_id');
  const approvedAt = Date.parse(decision.approved_at || '');
  const expiresAt = Date.parse(decision.expires_at || '');
  if (Number.isNaN(approvedAt)) problems.push('approved_at');
  if (Number.isNaN(expiresAt)) problems.push('expires_at');
  if (
    Number.isFinite(approvedAt)
    && Number.isFinite(expiresAt)
    && (expiresAt <= approvedAt || expiresAt - approvedAt > maxAuthorizationTtlMs)
  ) {
    problems.push('authorization_window');
  }
  if (
    expected?.now
    && Number.isFinite(approvedAt)
    && approvedAt > Date.parse(expected.now)
  ) {
    problems.push('authorization_not_yet_valid');
  }
  if (
    expected?.now
    && Number.isFinite(expiresAt)
    && expiresAt <= Date.parse(expected.now)
  ) {
    problems.push('authorization_expired');
  }
  if (target.operation !== 'deploy_pages') problems.push('target_operation');
  if (target.project_name !== 'xlooop-app') problems.push('target_project_name');
  if (target.branch !== 'main') problems.push('target_branch');
  if (target.environment !== 'production') problems.push('target_environment');
  if (!SHA_PATTERN.test(candidate.frontend_sha || '')) problems.push('candidate_frontend_sha');
  if (!SHA_PATTERN.test(candidate.backend_sha || '')) problems.push('candidate_backend_sha');
  if (!SHA_PATTERN.test(rollback.frontend_sha || '')) problems.push('rollback_frontend_sha');
  if (rollback.frontend_sha === candidate.frontend_sha) problems.push('rollback_frontend_not_distinct');
  if (!UUID_PATTERN.test(rollback.cloudflare_deployment_id || '')) problems.push('rollback_deployment_id');
  if (!rollback.evidence_reference) problems.push('rollback_evidence_reference');
  if (deployment.api_base !== 'https://api.xlooop.com') problems.push('expected_api_base');
  if (!Number.isSafeInteger(deployment.schema_head) || deployment.schema_head < 1) {
    problems.push('expected_schema_head');
  }
  if (!HASH_PATTERN.test(deployment.contract_hash || '')) problems.push('expected_contract_hash');
  if (deployment.environment !== 'production') problems.push('expected_environment');
  if (deployment.authority !== 'production') problems.push('expected_authority');
  problems.push(...exactPostureProblems(deployment.feature_posture, 'expected_feature_posture'));

  if (expected?.frontend_sha && candidate.frontend_sha !== expected.frontend_sha) {
    problems.push('candidate_frontend_sha_mismatch');
  }
  if (expected?.backend_sha && candidate.backend_sha !== expected.backend_sha) {
    problems.push('candidate_backend_sha_mismatch');
  }
  if (expected?.contract_hash && deployment.contract_hash !== expected.contract_hash) {
    problems.push('expected_contract_hash_mismatch');
  }
  if (expected?.schema_head && deployment.schema_head !== expected.schema_head) {
    problems.push('expected_schema_head_mismatch');
  }
  if (expected?.feature_posture && !posturesEqual(deployment.feature_posture, expected.feature_posture)) {
    problems.push('expected_feature_posture_mismatch');
  }

  return { ok: problems.length === 0, problems };
}
