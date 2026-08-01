// Portable, fail-closed consumer for MB-P capability projections.
//
// The producer contract lives in MB-P, but production must not read MB-P files,
// databases, or MCP services. Callers therefore pass a complete package and a
// locally configured trust policy. Nothing is activated merely by importing it.

export const CAPABILITY_PROJECTION_PACKAGE_SCHEMA = 'capability_projection_release_package_v1' as const;

type MutationMode = 'read_only' | 'proposal_approval_receipt' | 'forbidden';
type RedactionClass = 'customer_safe_metadata' | 'customer_safe_contract';
type ReleaseStatus = 'draft' | 'blocked' | 'active' | 'deprecated';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface CapabilityProjectionReleaseV1 {
  release_id: string;
  capability_id: string;
  capability_version: string;
  status: ReleaseStatus;
  source: { repo: string; path: string; sha: string };
  schemas: { inputs: string[]; outputs: string[] };
  authorization: {
    required_roles: string[];
    policy_refs: string[];
    mutation_mode: MutationMode;
  };
  verifiers: Array<{ id: string; source_sha256: string }>;
  compatibility: {
    consumer_repos: string[];
    minimum_schema_head: number;
    breaking_change_policy: 'semver_major';
  };
  tenant_boundary: {
    runtime_dependency_mode: 'versioned_projection_only';
    customer_runtime_import_allowed: boolean;
    mbp_filesystem_access: false;
    mbp_database_access: false;
    private_payload_allowed: false;
    tenant_binding_required: true;
    cross_tenant_data_allowed: false;
    redaction_class: RedactionClass;
  };
  integrity: {
    payload_sha256: string | null;
    signature_algorithm: 'none' | 'ed25519' | 'cosign-keyless';
    signature: string | null;
  };
  rollback: {
    previous_release_id: string | null;
    procedure: string;
    verified: boolean;
  };
  blockers: string[];
}

export interface CapabilityProjectionPackageV1 {
  schema_id: typeof CAPABILITY_PROJECTION_PACKAGE_SCHEMA;
  release: CapabilityProjectionReleaseV1;
  payload: JsonValue;
}

export interface TrustedCapabilityProjection {
  capabilityId: string;
  releaseId: string;
  capabilityVersion: string;
  sourceRepo: string;
  sourceSha: string;
  inputSchemas: readonly string[];
  outputSchemas: readonly string[];
  requiredRoles: readonly string[];
  policyRefs: readonly string[];
  mutationMode: MutationMode;
  verifierHashes: Readonly<Record<string, string>>;
  redactionClass: RedactionClass;
  ed25519PublicKeyBase64: string;
  maxPayloadBytes: number;
}

export interface CapabilityProjectionConsumerPolicy {
  consumerRepo: 'x-backend';
  schemaHead: number;
  trustedCapabilities: Readonly<Record<string, TrustedCapabilityProjection>>;
}

export type CapabilityProjectionRejectionCode =
  | 'invalid_package'
  | 'invalid_consumer_policy'
  | 'release_not_active'
  | 'release_blocked'
  | 'unknown_capability'
  | 'unknown_release'
  | 'stale_release'
  | 'untrusted_source'
  | 'untrusted_contract'
  | 'incompatible_release'
  | 'unsafe_tenant_boundary'
  | 'rollback_unverified'
  | 'payload_too_large'
  | 'payload_hash_mismatch'
  | 'unsigned_release'
  | 'unsupported_signature'
  | 'invalid_signature';

export type CapabilityProjectionImportResult =
  | {
      ok: true;
      release: CapabilityProjectionReleaseV1;
      payload: JsonValue;
      payloadSha256: string;
      packageSha256: string;
    }
  | { ok: false; code: CapabilityProjectionRejectionCode; reason: string };

const SHA40 = /^[0-9a-f]{40}$/;
const SHA64 = /^[0-9a-f]{64}$/;
const SEMVER = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/;
const RELEASE_ID = /^projection\.release\.[a-z0-9_.-]+\.v[0-9]+$/;
const CAPABILITY_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every((item) => typeof item === 'string' && item.length > 0)
    && new Set(value).size === value.length;
}

function validSourcePath(value: string): boolean {
  return value.length > 0
    && !value.startsWith('/')
    && !value.includes('\\')
    && !value.split('/').includes('..');
}

function shapeIsValid(value: unknown): value is CapabilityProjectionPackageV1 {
  if (!isRecord(value) || !exactKeys(value, ['schema_id', 'release', 'payload'])) return false;
  if (value.schema_id !== CAPABILITY_PROJECTION_PACKAGE_SCHEMA || !isJsonValue(value.payload)) return false;
  const release = value.release;
  if (!isRecord(release) || !exactKeys(release, [
    'release_id', 'capability_id', 'capability_version', 'status', 'source', 'schemas',
    'authorization', 'verifiers', 'compatibility', 'tenant_boundary', 'integrity',
    'rollback', 'blockers',
  ])) return false;
  if (typeof release.release_id !== 'string' || !RELEASE_ID.test(release.release_id)) return false;
  if (typeof release.capability_id !== 'string' || !CAPABILITY_ID.test(release.capability_id)) return false;
  if (typeof release.capability_version !== 'string' || !SEMVER.test(release.capability_version)) return false;
  if (!['draft', 'blocked', 'active', 'deprecated'].includes(String(release.status))) return false;

  const source = release.source;
  if (!isRecord(source) || !exactKeys(source, ['repo', 'path', 'sha'])) return false;
  if (typeof source.repo !== 'string' || source.repo.length === 0) return false;
  if (typeof source.path !== 'string' || !validSourcePath(source.path)) return false;
  if (typeof source.sha !== 'string' || !SHA40.test(source.sha)) return false;

  const schemas = release.schemas;
  if (!isRecord(schemas) || !exactKeys(schemas, ['inputs', 'outputs'])) return false;
  if (!stringArray(schemas.inputs) || !stringArray(schemas.outputs)) return false;

  const auth = release.authorization;
  if (!isRecord(auth) || !exactKeys(auth, ['required_roles', 'policy_refs', 'mutation_mode'])) return false;
  if (!stringArray(auth.required_roles) || !stringArray(auth.policy_refs)) return false;
  if (!['read_only', 'proposal_approval_receipt', 'forbidden'].includes(String(auth.mutation_mode))) return false;

  if (!Array.isArray(release.verifiers) || release.verifiers.some((verifier) => {
    if (!isRecord(verifier) || !exactKeys(verifier, ['id', 'source_sha256'])) return true;
    return typeof verifier.id !== 'string' || verifier.id.length === 0
      || typeof verifier.source_sha256 !== 'string' || !SHA64.test(verifier.source_sha256);
  })) return false;
  const verifierIds = release.verifiers.map((verifier) => (verifier as { id: string }).id);
  if (new Set(verifierIds).size !== verifierIds.length) return false;

  const compatibility = release.compatibility;
  if (!isRecord(compatibility)
    || !exactKeys(compatibility, ['consumer_repos', 'minimum_schema_head', 'breaking_change_policy'])
    || !stringArray(compatibility.consumer_repos)
    || !Number.isInteger(compatibility.minimum_schema_head)
    || Number(compatibility.minimum_schema_head) < 0
    || compatibility.breaking_change_policy !== 'semver_major') return false;

  const boundary = release.tenant_boundary;
  if (!isRecord(boundary) || !exactKeys(boundary, [
    'runtime_dependency_mode', 'customer_runtime_import_allowed', 'mbp_filesystem_access',
    'mbp_database_access', 'private_payload_allowed', 'tenant_binding_required',
    'cross_tenant_data_allowed', 'redaction_class',
  ])) return false;
  if (boundary.runtime_dependency_mode !== 'versioned_projection_only'
    || typeof boundary.customer_runtime_import_allowed !== 'boolean'
    || typeof boundary.mbp_filesystem_access !== 'boolean'
    || typeof boundary.mbp_database_access !== 'boolean'
    || typeof boundary.private_payload_allowed !== 'boolean'
    || typeof boundary.tenant_binding_required !== 'boolean'
    || typeof boundary.cross_tenant_data_allowed !== 'boolean'
    || !['customer_safe_metadata', 'customer_safe_contract'].includes(String(boundary.redaction_class))) return false;

  const integrity = release.integrity;
  if (!isRecord(integrity) || !exactKeys(integrity, ['payload_sha256', 'signature_algorithm', 'signature'])) return false;
  if (!(integrity.payload_sha256 === null || (typeof integrity.payload_sha256 === 'string' && SHA64.test(integrity.payload_sha256)))) return false;
  if (!['none', 'ed25519', 'cosign-keyless'].includes(String(integrity.signature_algorithm))) return false;
  if (!(integrity.signature === null
    || (typeof integrity.signature === 'string' && integrity.signature.length >= 64))) return false;

  const rollback = release.rollback;
  if (!isRecord(rollback) || !exactKeys(rollback, ['previous_release_id', 'procedure', 'verified'])) return false;
  if (!(rollback.previous_release_id === null || typeof rollback.previous_release_id === 'string')) return false;
  if (typeof rollback.procedure !== 'string' || rollback.procedure.length === 0 || typeof rollback.verified !== 'boolean') return false;
  return stringArray(release.blockers);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

export function canonicalizeProjectionJson(value: JsonValue): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Projection JSON numbers must be finite');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeProjectionJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalizeProjectionJson(value[key])}`).join(',')}}`;
}

function signingPackage(pkg: CapabilityProjectionPackageV1): JsonValue {
  return {
    schema_id: pkg.schema_id,
    release: {
      ...pkg.release,
      integrity: { ...pkg.release.integrity, signature: null },
    } as unknown as JsonValue,
    payload: pkg.payload,
  };
}

export function capabilityProjectionSigningBytes(pkg: CapabilityProjectionPackageV1): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(canonicalizeProjectionJson(signingPackage(pkg)));
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function decodeBase64(value: string, expectedBytes: number): Uint8Array<ArrayBuffer> | null {
  if (!BASE64.test(value)) return null;
  try {
    const binary = atob(value);
    if (binary.length !== expectedBytes) return null;
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const a = [...actual].sort();
  const b = [...expected].sort();
  return a.every((item, index) => item === b[index]);
}

function sameVerifiers(actual: CapabilityProjectionReleaseV1['verifiers'], expected: Readonly<Record<string, string>>): boolean {
  const entries = Object.entries(expected);
  return actual.length === entries.length
    && actual.every(({ id, source_sha256 }) => expected[id] === source_sha256);
}

function policyIsValid(value: unknown): value is CapabilityProjectionConsumerPolicy {
  if (!isRecord(value) || !exactKeys(value, ['consumerRepo', 'schemaHead', 'trustedCapabilities'])) return false;
  if (value.consumerRepo !== 'x-backend' || !Number.isInteger(value.schemaHead) || Number(value.schemaHead) < 0) return false;
  if (!isRecord(value.trustedCapabilities)) return false;
  return Object.entries(value.trustedCapabilities).every(([capabilityId, candidate]) => {
    if (!isRecord(candidate) || !exactKeys(candidate, [
      'capabilityId', 'releaseId', 'capabilityVersion', 'sourceRepo', 'sourceSha',
      'inputSchemas', 'outputSchemas', 'requiredRoles', 'policyRefs', 'mutationMode',
      'verifierHashes', 'redactionClass', 'ed25519PublicKeyBase64', 'maxPayloadBytes',
    ])) return false;
    if (candidate.capabilityId !== capabilityId || !CAPABILITY_ID.test(capabilityId)) return false;
    if (typeof candidate.releaseId !== 'string' || !RELEASE_ID.test(candidate.releaseId)) return false;
    if (typeof candidate.capabilityVersion !== 'string' || !SEMVER.test(candidate.capabilityVersion)) return false;
    if (typeof candidate.sourceRepo !== 'string' || candidate.sourceRepo.length === 0) return false;
    if (typeof candidate.sourceSha !== 'string' || !SHA40.test(candidate.sourceSha)) return false;
    if (!stringArray(candidate.inputSchemas) || !stringArray(candidate.outputSchemas)
      || !stringArray(candidate.requiredRoles) || !stringArray(candidate.policyRefs)) return false;
    if (!['read_only', 'proposal_approval_receipt', 'forbidden'].includes(String(candidate.mutationMode))) return false;
    if (!isRecord(candidate.verifierHashes)
      || Object.keys(candidate.verifierHashes).length === 0
      || Object.values(candidate.verifierHashes).some((hash) => typeof hash !== 'string' || !SHA64.test(hash))) return false;
    if (!['customer_safe_metadata', 'customer_safe_contract'].includes(String(candidate.redactionClass))) return false;
    if (typeof candidate.ed25519PublicKeyBase64 !== 'string' || !decodeBase64(candidate.ed25519PublicKeyBase64, 32)) return false;
    return Number.isInteger(candidate.maxPayloadBytes) && Number(candidate.maxPayloadBytes) > 0;
  });
}

function reject(code: CapabilityProjectionRejectionCode, reason: string): CapabilityProjectionImportResult {
  return { ok: false, code, reason };
}

export async function importCapabilityProjectionRelease(
  candidate: unknown,
  policy: CapabilityProjectionConsumerPolicy,
): Promise<CapabilityProjectionImportResult> {
  let snapshot: unknown;
  try {
    if (!isJsonValue(candidate)) {
      return reject('invalid_package', 'Projection package does not match the portable v1 contract.');
    }
    snapshot = JSON.parse(canonicalizeProjectionJson(candidate)) as unknown;
  } catch {
    return reject('invalid_package', 'Projection package does not match the portable v1 contract.');
  }
  if (!shapeIsValid(snapshot)) return reject('invalid_package', 'Projection package does not match the portable v1 contract.');
  if (!policyIsValid(policy)) return reject('invalid_consumer_policy', 'Projection consumer trust policy is invalid.');
  const pkg = snapshot;
  const { release } = pkg;
  if (release.status === 'blocked') return reject('release_blocked', 'Projection release is blocked by its producer.');
  if (release.status !== 'active') return reject('release_not_active', 'Projection release is not active.');
  if (release.schemas.inputs.length === 0
    || release.schemas.outputs.length === 0
    || release.authorization.required_roles.length === 0
    || release.authorization.policy_refs.length === 0
    || release.verifiers.length === 0) {
    return reject('untrusted_contract', 'Active projection release is missing activation requirements.');
  }

  const trust = policy.trustedCapabilities[release.capability_id];
  if (!trust) return reject('unknown_capability', 'Capability is not trusted by this consumer.');
  if (release.release_id !== trust.releaseId) return reject('unknown_release', 'Release identifier is not pinned by this consumer.');
  if (release.capability_version !== trust.capabilityVersion) return reject('stale_release', 'Capability version is not the pinned consumer version.');
  if (release.source.repo !== trust.sourceRepo || release.source.sha !== trust.sourceSha) {
    return reject('untrusted_source', 'Producer source identity does not match the consumer pin.');
  }
  if (!sameStrings(release.schemas.inputs, trust.inputSchemas)
    || !sameStrings(release.schemas.outputs, trust.outputSchemas)
    || !sameStrings(release.authorization.required_roles, trust.requiredRoles)
    || !sameStrings(release.authorization.policy_refs, trust.policyRefs)
    || release.authorization.mutation_mode !== trust.mutationMode
    || !sameVerifiers(release.verifiers, trust.verifierHashes)) {
    return reject('untrusted_contract', 'Projection schemas, authorization, or verifier hashes do not match the consumer pin.');
  }
  if (!release.compatibility.consumer_repos.includes(policy.consumerRepo)
    || release.compatibility.minimum_schema_head > policy.schemaHead) {
    return reject('incompatible_release', 'Projection release is incompatible with this repository or schema head.');
  }

  const boundary = release.tenant_boundary;
  if (!boundary.customer_runtime_import_allowed
    || boundary.mbp_filesystem_access
    || boundary.mbp_database_access
    || boundary.private_payload_allowed
    || !boundary.tenant_binding_required
    || boundary.cross_tenant_data_allowed
    || boundary.redaction_class !== trust.redactionClass) {
    return reject('unsafe_tenant_boundary', 'Projection release violates the customer-runtime boundary.');
  }
  if (release.blockers.length > 0) return reject('release_blocked', 'Active projection release still names blockers.');
  if (!release.rollback.verified) return reject('rollback_unverified', 'Projection rollback has not been verified.');

  const payloadBytes = new TextEncoder().encode(canonicalizeProjectionJson(pkg.payload));
  if (!Number.isInteger(trust.maxPayloadBytes) || trust.maxPayloadBytes <= 0 || payloadBytes.byteLength > trust.maxPayloadBytes) {
    return reject('payload_too_large', 'Projection payload exceeds the trusted consumer limit.');
  }
  const payloadSha256 = await sha256Hex(payloadBytes);
  if (release.integrity.payload_sha256 !== payloadSha256) {
    return reject('payload_hash_mismatch', 'Projection payload hash does not match the signed release metadata.');
  }
  if (release.integrity.signature_algorithm === 'none' || !release.integrity.signature) {
    return reject('unsigned_release', 'Projection release is unsigned.');
  }
  if (release.integrity.signature_algorithm !== 'ed25519') {
    return reject('unsupported_signature', 'Projection signature algorithm is not supported by this consumer.');
  }

  const publicKeyBytes = decodeBase64(trust.ed25519PublicKeyBase64, 32);
  const signatureBytes = decodeBase64(release.integrity.signature, 64);
  if (!publicKeyBytes || !signatureBytes) return reject('invalid_signature', 'Projection signature material is malformed.');
  try {
    const publicKey = await crypto.subtle.importKey('raw', publicKeyBytes, { name: 'Ed25519' }, false, ['verify']);
    const signingBytes = capabilityProjectionSigningBytes(pkg);
    const valid = await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, signatureBytes, signingBytes);
    if (!valid) return reject('invalid_signature', 'Projection signature verification failed.');
    return {
      ok: true,
      release,
      payload: pkg.payload,
      payloadSha256,
      packageSha256: await sha256Hex(signingBytes),
    };
  } catch {
    return reject('invalid_signature', 'Projection signature verification failed.');
  }
}
