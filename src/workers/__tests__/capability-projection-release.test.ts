import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_PROJECTION_PACKAGE_SCHEMA,
  capabilityProjectionSigningBytes,
  canonicalizeProjectionJson,
  importCapabilityProjectionRelease,
  type CapabilityProjectionConsumerPolicy,
  type CapabilityProjectionPackageV1,
  type JsonValue,
} from '../lib/capability-projection-release';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function sha256(value: JsonValue): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalizeProjectionJson(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const PAYLOAD: JsonValue = {
  capability_id: 'tool.doc-governance',
  commands: [{ id: 'document.report', mode: 'read_only' }],
  schema_version: '1.0.0',
};

async function fixture() {
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
  const pkg: CapabilityProjectionPackageV1 = {
    schema_id: CAPABILITY_PROJECTION_PACKAGE_SCHEMA,
    release: {
      release_id: 'projection.release.tool.doc-governance.v1',
      capability_id: 'tool.doc-governance',
      capability_version: '3.0.0',
      status: 'active',
      source: {
        repo: 'doc-governance',
        path: '.',
        sha: '694772ac52b70bb591c6b6e5b2aa49267a498d7c',
      },
      schemas: { inputs: ['document-report-input.v1'], outputs: ['document-report-output.v1'] },
      authorization: {
        required_roles: ['knowledge-architect'],
        policy_refs: ['mbp.TOOLS_REGISTRY', 'tool_command_safety_matrix_v1'],
        mutation_mode: 'read_only',
      },
      verifiers: [
        { id: 'doc-governance-config', source_sha256: 'c561f4a9b2d5e25b731f4ca666037575e9783fa6259894efa3bab4ffeb662c66' },
        { id: 'doc-governance-test-runner', source_sha256: '4c7fa2f84288dc2373c948e448ec8586899fe4848c7da862c89e75235f34ee92' },
      ],
      compatibility: {
        consumer_repos: ['x-backend'],
        minimum_schema_head: 93,
        breaking_change_policy: 'semver_major',
      },
      tenant_boundary: {
        runtime_dependency_mode: 'versioned_projection_only',
        customer_runtime_import_allowed: true,
        mbp_filesystem_access: false,
        mbp_database_access: false,
        private_payload_allowed: false,
        tenant_binding_required: true,
        cross_tenant_data_allowed: false,
        redaction_class: 'customer_safe_contract',
      },
      integrity: {
        payload_sha256: await sha256(PAYLOAD),
        signature_algorithm: 'ed25519',
        signature: null,
      },
      rollback: {
        previous_release_id: null,
        procedure: 'Reject the projection and retain the previous consumer pin.',
        verified: true,
      },
      blockers: [],
    },
    payload: PAYLOAD,
  };
  const signature = await crypto.subtle.sign({ name: 'Ed25519' }, keys.privateKey, capabilityProjectionSigningBytes(pkg));
  pkg.release.integrity.signature = bytesToBase64(new Uint8Array(signature));
  const policy: CapabilityProjectionConsumerPolicy = {
    consumerRepo: 'x-backend',
    schemaHead: 93,
    trustedCapabilities: {
      'tool.doc-governance': {
        capabilityId: 'tool.doc-governance',
        releaseId: pkg.release.release_id,
        capabilityVersion: pkg.release.capability_version,
        sourceRepo: pkg.release.source.repo,
        sourceSha: pkg.release.source.sha,
        inputSchemas: pkg.release.schemas.inputs,
        outputSchemas: pkg.release.schemas.outputs,
        requiredRoles: pkg.release.authorization.required_roles,
        policyRefs: pkg.release.authorization.policy_refs,
        mutationMode: pkg.release.authorization.mutation_mode,
        verifierHashes: Object.fromEntries(pkg.release.verifiers.map((item) => [item.id, item.source_sha256])),
        redactionClass: pkg.release.tenant_boundary.redaction_class,
        ed25519PublicKeyBase64: bytesToBase64(publicKey),
        maxPayloadBytes: 16_384,
      },
    },
  };
  return { pkg, policy, keys };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe('Capability ProjectionRelease consumer', () => {
  it('accepts an exactly pinned, signed, compatible, customer-safe release', async () => {
    const { pkg, policy } = await fixture();
    const result = await importCapabilityProjectionRelease(pkg, policy);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payloadSha256).toBe(pkg.release.integrity.payload_sha256);
      expect(result.packageSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(result.release.capability_id).toBe('tool.doc-governance');
    }
  });

  it('rejects the current blocked MB-P release before activation', async () => {
    const { pkg, policy } = await fixture();
    pkg.release.status = 'blocked';
    pkg.release.schemas = { inputs: [], outputs: [] };
    pkg.release.tenant_boundary.customer_runtime_import_allowed = false;
    pkg.release.integrity = { payload_sha256: null, signature_algorithm: 'none', signature: null };
    pkg.release.rollback.verified = false;
    pkg.release.blockers = ['x_backend_consumer_rejection_gate_not_implemented'];
    await expect(importCapabilityProjectionRelease(pkg, policy)).resolves.toMatchObject({ ok: false, code: 'release_blocked' });
  });

  it.each([
    ['unknown capability', (pkg: CapabilityProjectionPackageV1) => { pkg.release.capability_id = 'tool.unknown'; }, 'unknown_capability'],
    ['unknown release', (pkg: CapabilityProjectionPackageV1) => { pkg.release.release_id = 'projection.release.tool.doc-governance.v2'; }, 'unknown_release'],
    ['stale version', (pkg: CapabilityProjectionPackageV1) => { pkg.release.capability_version = '2.9.9'; }, 'stale_release'],
    ['untrusted source', (pkg: CapabilityProjectionPackageV1) => { pkg.release.source.sha = '0'.repeat(40); }, 'untrusted_source'],
    ['incompatible schema', (pkg: CapabilityProjectionPackageV1) => { pkg.release.compatibility.minimum_schema_head = 94; }, 'incompatible_release'],
    ['unsafe boundary', (pkg: CapabilityProjectionPackageV1) => { pkg.release.tenant_boundary.private_payload_allowed = true as false; }, 'unsafe_tenant_boundary'],
    ['unverified rollback', (pkg: CapabilityProjectionPackageV1) => { pkg.release.rollback.verified = false; }, 'rollback_unverified'],
  ])('rejects %s', async (_name, mutate, expectedCode) => {
    const { pkg, policy } = await fixture();
    mutate(pkg);
    await expect(importCapabilityProjectionRelease(pkg, policy)).resolves.toMatchObject({ ok: false, code: expectedCode });
  });

  it('rejects traversal and unknown fields as an invalid portable package', async () => {
    const { pkg, policy } = await fixture();
    const traversal = clone(pkg);
    traversal.release.source.path = '../private';
    await expect(importCapabilityProjectionRelease(traversal, policy)).resolves.toMatchObject({ ok: false, code: 'invalid_package' });
    const expanded = clone(pkg) as CapabilityProjectionPackageV1 & { private_context?: string };
    expanded.private_context = 'must never cross the boundary';
    await expect(importCapabilityProjectionRelease(expanded, policy)).resolves.toMatchObject({ ok: false, code: 'invalid_package' });
  });

  it('rejects an unsigned or unsupported release', async () => {
    const { pkg, policy } = await fixture();
    pkg.release.integrity.signature = null;
    await expect(importCapabilityProjectionRelease(pkg, policy)).resolves.toMatchObject({ ok: false, code: 'unsigned_release' });
    pkg.release.integrity.signature_algorithm = 'cosign-keyless';
    pkg.release.integrity.signature = 'A'.repeat(64);
    await expect(importCapabilityProjectionRelease(pkg, policy)).resolves.toMatchObject({ ok: false, code: 'unsupported_signature' });
  });

  it('rejects payload tamper even when the old signature remains', async () => {
    const { pkg, policy } = await fixture();
    pkg.payload = { ...pkg.payload as Record<string, JsonValue>, commands: [] };
    await expect(importCapabilityProjectionRelease(pkg, policy)).resolves.toMatchObject({ ok: false, code: 'payload_hash_mismatch' });
  });

  it('rejects metadata or payload re-signing with an untrusted key', async () => {
    const { pkg, policy } = await fixture();
    pkg.payload = { ...pkg.payload as Record<string, JsonValue>, commands: [{ id: 'document.mutate', mode: 'write' }] };
    pkg.release.integrity.payload_sha256 = await sha256(pkg.payload);
    const attacker = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const signature = await crypto.subtle.sign({ name: 'Ed25519' }, attacker.privateKey, capabilityProjectionSigningBytes(pkg));
    pkg.release.integrity.signature = bytesToBase64(new Uint8Array(signature));
    await expect(importCapabilityProjectionRelease(pkg, policy)).resolves.toMatchObject({ ok: false, code: 'invalid_signature' });
  });

  it('binds schemas, roles, policies, mutation mode, and verifier hashes to the consumer pin', async () => {
    const { pkg, policy } = await fixture();
    pkg.release.authorization.mutation_mode = 'proposal_approval_receipt';
    await expect(importCapabilityProjectionRelease(pkg, policy)).resolves.toMatchObject({ ok: false, code: 'untrusted_contract' });
  });

  it('rejects payloads above the consumer limit', async () => {
    const { pkg, policy } = await fixture();
    policy.trustedCapabilities['tool.doc-governance'].maxPayloadBytes = 8;
    await expect(importCapabilityProjectionRelease(pkg, policy)).resolves.toMatchObject({ ok: false, code: 'payload_too_large' });
  });

  it('rejects an invalid local trust policy instead of throwing', async () => {
    const { pkg, policy } = await fixture();
    policy.trustedCapabilities['tool.doc-governance'].ed25519PublicKeyBase64 = 'not-base64';
    await expect(importCapabilityProjectionRelease(pkg, policy)).resolves.toMatchObject({ ok: false, code: 'invalid_consumer_policy' });
  });

  it('rejects duplicate verifier identities in the producer package', async () => {
    const { pkg, policy } = await fixture();
    pkg.release.verifiers[1].id = pkg.release.verifiers[0].id;
    await expect(importCapabilityProjectionRelease(pkg, policy)).resolves.toMatchObject({ ok: false, code: 'invalid_package' });
  });

  it('returns a verified snapshot that is detached from later caller mutation', async () => {
    const { pkg, policy } = await fixture();
    const result = await importCapabilityProjectionRelease(pkg, policy);
    expect(result.ok).toBe(true);
    pkg.release.capability_id = 'tool.changed-after-verification';
    pkg.payload = { commands: [] };
    if (result.ok) {
      expect(result.release.capability_id).toBe('tool.doc-governance');
      expect(result.payload).toEqual(PAYLOAD);
    }
  });

  it('rejects cyclic or undersized signature input without throwing', async () => {
    const { pkg, policy } = await fixture();
    pkg.release.integrity.signature = 'short';
    await expect(importCapabilityProjectionRelease(pkg, policy)).resolves.toMatchObject({ ok: false, code: 'invalid_package' });

    const cyclic = clone(pkg) as CapabilityProjectionPackageV1 & { payload: Record<string, JsonValue> };
    cyclic.release.integrity.signature = 'A'.repeat(64);
    cyclic.payload = {};
    (cyclic.payload as Record<string, unknown>).self = cyclic.payload;
    await expect(importCapabilityProjectionRelease(cyclic, policy)).resolves.toMatchObject({ ok: false, code: 'invalid_package' });
  });

  it('canonicalizes object keys deterministically for producer-consumer parity', () => {
    expect(canonicalizeProjectionJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
  });
});
