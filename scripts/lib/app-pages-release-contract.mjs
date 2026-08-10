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

export function parseReactRuntimeManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('frontend runtime manifest must be a JSON object');
  }
  if (manifest.schema_id !== 'xlooop.frontend_runtime_manifest.v2') {
    throw new Error(`unsupported frontend runtime manifest: ${String(manifest.schema_id)}`);
  }
  return {
    artifact_contract: 'react_vite_v2',
    build_mode: manifest.runtime_class,
    production_cutover_approved: manifest.production_cutover_approved,
    require_contract_handshake: manifest.require_contract_handshake,
    api_base: manifest.api_base,
    frontend_sha: manifest.frontend_sha,
    backend_sha: manifest.expected_backend_sha,
    contract_hash: manifest.expected_contract_hash,
    schema_head: manifest.expected_schema_head,
    environment: manifest.expected_environment,
    authority: manifest.expected_authority,
    feature_posture: manifest.expected_feature_posture,
    files: manifest.files,
  };
}

function parseReactRuntimeManifestFile(artifactDir) {
  const manifestPath = path.join(artifactDir, 'runtime-manifest.json');
  if (!existsSync(manifestPath)) return null;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new Error(`frontend runtime manifest is not valid JSON: ${manifestPath}`);
  }
  return parseReactRuntimeManifest(manifest);
}

export function parseFrontendReleaseArtifact(artifactDir) {
  const react = parseReactRuntimeManifestFile(artifactDir);
  if (react) return react;
  const indexPath = path.join(artifactDir, 'index.html');
  if (!existsSync(indexPath)) throw new Error(`frontend artifact missing ${indexPath}`);
  const contractMetaPath = path.join(artifactDir, 'contract-meta.js');
  const contractMeta = existsSync(contractMetaPath) ? readFileSync(contractMetaPath, 'utf8') : '';
  const contractHash = contractMeta.match(/[0-9a-f]{64}/)?.[0] ?? null;
  return {
    artifact_contract: 'legacy_wired_v1',
    ...parseFrontendReleaseHtml(readFileSync(indexPath, 'utf8')),
    contract_hash: contractHash,
  };
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
  const expectedApiBase = expected?.api_base || 'https://api.xlooop.com';
  const expectedEnvironment = expected?.environment || 'production';
  const expectedAuthority = expected?.authority || 'production';
  if (config.build_mode !== 'production') problems.push('build_mode');
  if (config.artifact_contract === 'react_vite_v2'
    && config.production_cutover_approved !== true) {
    problems.push('production_cutover_approved');
  }
  if (config.require_contract_handshake !== true) problems.push('require_contract_handshake');
  if (config.api_base !== expectedApiBase) problems.push('api_base');
  if (!SHA_PATTERN.test(config.frontend_sha || '')) problems.push('frontend_sha');
  if (!SHA_PATTERN.test(config.backend_sha || '')) problems.push('backend_sha');
  if (!Number.isSafeInteger(config.schema_head) || config.schema_head < 1) problems.push('schema_head');
  if (expected?.contract_hash && config.contract_hash !== expected.contract_hash) {
    problems.push('contract_hash_mismatch');
  }
  if (expected?.schema_head && config.schema_head !== expected.schema_head) {
    problems.push('schema_head_mismatch');
  }
  if (expected?.feature_posture && !posturesEqual(config.feature_posture, expected.feature_posture)) {
    problems.push('feature_posture_mismatch');
  }
  if (config.environment !== expectedEnvironment) problems.push('environment');
  if (config.authority !== expectedAuthority) problems.push('authority');
  problems.push(...exactPostureProblems(config.feature_posture));
  if (expected?.frontend_sha && config.frontend_sha !== expected.frontend_sha) {
    problems.push('frontend_sha_mismatch');
  }
  if (expected?.backend_sha && config.backend_sha !== expected.backend_sha) {
    problems.push('backend_sha_mismatch');
  }
  return { ok: problems.length === 0, problems };
}

export function releaseManifestDigest(manifest) {
  const stable = {
    schema_id: manifest?.schema_id,
    artifact_contract: manifest?.artifact_contract,
    frontend_sha: manifest?.frontend_sha,
    backend_sha: manifest?.backend_sha,
    contract_hash: manifest?.contract_hash,
    schema_head: manifest?.schema_head,
    environment: manifest?.environment,
    authority: manifest?.authority,
    api_base: manifest?.api_base,
    deployment_worker: manifest?.deployment_worker,
    wrangler_config: manifest?.wrangler_config,
    feature_posture: manifest?.feature_posture,
    files: manifest?.files,
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

export function verifyStaticArtifactFiles(artifactDir, contractHash) {
  const problems = [];
  const reactManifest = path.join(artifactDir, 'runtime-manifest.json');
  const react = existsSync(reactManifest);
  const required = react
    // React owns application bytes. The backend release assembler owns and emits
    // production _headers from data/security-headers.manifest.json.
    ? ['index.html', 'runtime-manifest.json', 'assets']
    : ['index.html', '_headers', 'clerk-boot.js', 'contract-meta.js', 'live-data.js', 'support.js', 'vendor'];
  for (const entry of required) {
    if (!existsSync(path.join(artifactDir, entry))) problems.push(`missing:${entry}`);
  }
  if (react) {
    const assetsDir = path.join(artifactDir, 'assets');
    if (existsSync(assetsDir)) {
      const assetFiles = readdirSync(assetsDir, { recursive: true, withFileTypes: false })
        .map(String);
      if (!assetFiles.some((name) => name.endsWith('.js'))) problems.push('missing:assets/*.js');
    }
    for (const legacy of ['clerk-boot.js', 'live-data.js', 'support.js', 'vendor']) {
      if (existsSync(path.join(artifactDir, legacy))) problems.push(`legacy_runtime_leak:${legacy}`);
    }
  }
  for (const forbidden of ['scripts', 'src', 'node_modules']) {
    if (existsSync(path.join(artifactDir, forbidden))) problems.push(`source_leak:${forbidden}`);
  }
  if (react) {
    try {
      const manifest = JSON.parse(readFileSync(reactManifest, 'utf8'));
      if (manifest.expected_contract_hash !== contractHash) problems.push('contract_hash_mismatch');
      const declared = manifest.files;
      if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
        problems.push('runtime_manifest_files');
      } else {
        // The frontend manifest owns only the files emitted by the frontend build. During
        // backend assembly the same directory also gains Pages Functions, routes, and the
        // release manifest; those files are governed by the outer release manifest. Compare
        // every frontend-declared path without treating backend-owned additions as drift.
        const releaseFiles = hashReleaseFiles(artifactDir, new Set(['runtime-manifest.json']));
        const declaredFilesMatch = Object.entries(declared).every(
          ([file, digest]) => releaseFiles[file] === digest,
        );
        if (!declaredFilesMatch) problems.push('runtime_manifest_file_hashes');
      }
    } catch {
      problems.push('runtime_manifest_invalid');
    }
  } else {
    const contractMeta = path.join(artifactDir, 'contract-meta.js');
    if (existsSync(contractMeta) && !readFileSync(contractMeta, 'utf8').includes(contractHash)) {
      problems.push('contract_hash_mismatch');
    }
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

export function assessReleaseManifest(manifest, currentHashes = null, expected = {}) {
  const problems = [];
  const expectedEnvironment = expected.environment || 'production';
  const expectedAuthority = expected.authority || 'production';
  const expectedApiBase = expected.api_base || 'https://api.xlooop.com';
  if (manifest?.schema_id !== 'xlooop.app_pages_release_manifest.v1') problems.push('schema_id');
  if (!['legacy_wired_v1', 'react_vite_v2'].includes(manifest?.artifact_contract)) {
    problems.push('artifact_contract');
  }
  if (!SHA_PATTERN.test(manifest?.frontend_sha || '')) problems.push('frontend_sha');
  if (!SHA_PATTERN.test(manifest?.backend_sha || '')) problems.push('backend_sha');
  if (!HASH_PATTERN.test(manifest?.contract_hash || '')) problems.push('contract_hash');
  if (!Number.isSafeInteger(manifest?.schema_head) || manifest.schema_head < 1) problems.push('schema_head');
  if (manifest?.environment !== expectedEnvironment) problems.push('environment');
  if (manifest?.authority !== expectedAuthority) problems.push('authority');
  if (manifest?.api_base !== expectedApiBase) problems.push('api_base');
  if (expected.deployment_worker && manifest?.deployment_worker !== expected.deployment_worker) {
    problems.push('deployment_worker');
  }
  if (expected.wrangler_config && manifest?.wrangler_config !== expected.wrangler_config) {
    problems.push('wrangler_config');
  }
  problems.push(...exactPostureProblems(manifest?.feature_posture));
  if (!manifest?.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    problems.push('files');
  }
  if (!HASH_PATTERN.test(manifest?.artifact_digest || '')) problems.push('artifact_digest');
  else if (manifest.artifact_digest !== releaseManifestDigest(manifest)) {
    problems.push('artifact_digest_mismatch');
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

  // cutover_id pairing · 260729 — makes "atomic" REFUSABLE, not merely recordable.
  //
  // #111 gave both packets a shared cutover_id so a pair could be recognised after the fact. That
  // is proof-after. This is prevention-before: when the caller states which cutover this Pages
  // deploy belongs to, a packet that does not carry that id is REFUSED.
  //
  // The failure it exists to stop is the one that stranded the pilot on 260728: the API deployed,
  // the paired Pages deploy did not, and nothing in either artifact could tell that the two were
  // meant to be one operation. Two independent single-use authorisations with two independent TTLs
  // and no shared identity is a runbook instruction, not a property of the system.
  //
  // ADDITIVE BY CONSTRUCTION: enforcement engages ONLY when `expected.cutover_id` is supplied, so
  // every existing caller and every standalone Pages deploy is unaffected. Opt-in strictness, not a
  // new universal requirement — a gate that breaks unrelated flows on the day it lands is a gate
  // that gets reverted.
  if (expected?.cutover_id) {
    if (!packet?.cutover_id) problems.push('cutover_id_missing');
    else if (packet.cutover_id !== expected.cutover_id) problems.push('cutover_id_mismatch');
  }
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
  // 260805 · THE SAME CHECK LIVED IN TWO PLACES, AND I ONLY FIXED ONE.
  //
  // The minter was corrected to admit a BACKEND-ONLY cutover; this contract — read by
  // deploy-app-prod.mjs — was not. Consequence, measured in production: the API deployed to
  // fda3277a, then `deploy:app:prod` FAILED CLOSED on rollback_frontend_not_distinct, leaving the
  // live pair mismatched (backend fda3277a, frontend pinning ccbf6d29) until the declared rollback
  // was executed to restore it. Fixing a duplicated invariant in one copy is not fixing it.
  //
  // The requirement is "you can get back to something else". A Pages rollback resolves a DEPLOYMENT
  // UUID, never a git sha, so a distinct deployment id satisfies it even when the frontend source
  // sha is unchanged — which is exactly what a backend-only cutover looks like, because the built
  // artifact still differs (it pins the new backend sha).
  //
  // NOT a loosening: identical sha AND identical deployment id remains a no-op and is still
  // refused, below.
  // FIRST ATTEMPT WAS VACUOUS AND THE SELF-TEST CAUGHT IT. I compared the rollback deployment id
  // against `candidate.cloudflare_deployment_id` — but a CANDIDATE HAS NOT BEEN DEPLOYED YET, so it
  // carries no deployment id. The comparison was therefore always true and the guard stopped firing
  // entirely. `verify-app-pages-decision-packet self-test · FAIL · same rollback` said so
  // immediately. A guard I widen must still fail on the case it exists for.
  //
  // The genuine no-op is NOTHING CHANGING: same frontend sha AND same backend sha. A backend-only
  // cutover has an unchanged frontend sha and a DIFFERENT backend sha — the artifact really does
  // differ, because it pins that backend sha.
  const backendOnly = rollback.frontend_sha === candidate.frontend_sha
    && SHA_PATTERN.test(rollback.backend_sha || '')
    && rollback.backend_sha !== candidate.backend_sha;
  if (rollback.frontend_sha === candidate.frontend_sha && !backendOnly) {
    problems.push('rollback_frontend_not_distinct');
  }
  if (!UUID_PATTERN.test(rollback.cloudflare_deployment_id || '')) problems.push('rollback_deployment_id');
  if (!rollback.evidence_reference) problems.push('rollback_evidence_reference');
  if (deployment.api_base !== 'https://api.xlooop.com') problems.push('expected_api_base');
  if (!HASH_PATTERN.test(deployment.artifact_digest || '')) problems.push('expected_artifact_digest');
  if (!['legacy_wired_v1', 'react_vite_v2'].includes(deployment.artifact_contract)) {
    problems.push('expected_artifact_contract');
  }
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
  if (expected?.artifact_digest && deployment.artifact_digest !== expected.artifact_digest) {
    problems.push('expected_artifact_digest_mismatch');
  }
  if (expected?.artifact_contract && deployment.artifact_contract !== expected.artifact_contract) {
    problems.push('expected_artifact_contract_mismatch');
  }
  if (expected?.schema_head && deployment.schema_head !== expected.schema_head) {
    problems.push('expected_schema_head_mismatch');
  }
  if (expected?.feature_posture && !posturesEqual(deployment.feature_posture, expected.feature_posture)) {
    problems.push('expected_feature_posture_mismatch');
  }

  return { ok: problems.length === 0, problems };
}
