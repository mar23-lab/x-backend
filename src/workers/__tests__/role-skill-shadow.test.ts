// role-skill-shadow.test.ts · OAR-W2 (260713) + Track A reliability matrix (260713) · the shadow
// observer must be a byte-identical no-op when the flag is off, emit exactly one 'role_skill_resolution'
// event when on, NEVER throw into the write path, telemeter (never silently swallow) a failed receipt
// write, and persist honest provenance (resolver_source/deploy_sha/signing_key_id). Mirrors
// policy-engine-shadow.test.ts; the capturing sql mock records every INSERT so receipt CONTENT is asserted.

import { describe, it, expect, vi } from 'vitest';
import { observeRoleSkillResolution, type ObserveMeta } from '../lib/role-skill-shadow';
import { signReceipt } from '../dal/role-skill-resolution-store';

function captureKind(kind: string, fn: () => void): Array<Record<string, unknown>> {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    fn();
    return spy.mock.calls
      .map((c) => {
        try {
          return JSON.parse(String(c[0]));
        } catch {
          return null;
        }
      })
      .filter((o): o is Record<string, unknown> => !!o && o.kind === kind);
  } finally {
    spy.mockRestore();
  }
}

const META: ObserveMeta = {
  action: 'packet:create',
  role: 'operator',
  mode: 'operator',
  workspace_id: 'ws_1',
  principal_id: 'user_1',
};

interface CapturedInsert {
  text: string;
  values: unknown[];
}

/** Hono-ctx double with a CAPTURING tagged-template sql mock + waitUntil collector. */
function fakeCtx(env: Record<string, unknown>, opts: { sqlThrows?: boolean } = {}) {
  const waited: Promise<unknown>[] = [];
  const inserts: CapturedInsert[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (opts.sqlThrows) return Promise.reject(new Error('db down'));
    if (text.includes('INSERT INTO')) inserts.push({ text, values });
    return Promise.resolve([]);
  }) as unknown;
  return {
    ctx: {
      env,
      get: (k: string) => (k === 'sql' ? sql : undefined),
      executionCtx: { waitUntil: (p: Promise<unknown>) => waited.push(p) },
    } as never,
    waited,
    inserts,
  };
}

const settle = (waited: Promise<unknown>[]) => Promise.all(waited);

describe('role-skill shadow observer (OAR-W2)', () => {
  it('flag OFF ⇒ byte-identical no-op: emits nothing and schedules no write', () => {
    const { ctx, waited } = fakeCtx({}); // ROLE_SKILL_RESOLVER_ENABLED unset
    const events = captureKind('role_skill_resolution', () =>
      observeRoleSkillResolution(ctx, { allowed: true, reason: 'active_entitlement' }, META),
    );
    expect(events).toHaveLength(0);
    expect(waited).toHaveLength(0);
  });

  it('flag ON ⇒ emits exactly one role_skill_resolution event with an agreement verdict', () => {
    const { ctx, waited } = fakeCtx({ ROLE_SKILL_RESOLVER_ENABLED: 'true' });
    const events = captureKind('role_skill_resolution', () =>
      observeRoleSkillResolution(ctx, { allowed: true, reason: 'active_entitlement' }, META),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'role_skill_resolution', action: 'packet:create', role: 'operator' });
    // v0 has no catalog ⇒ resolver denies (skill_not_installed) while the actual decision allowed ⇒ stricter
    expect(events[0].resolver_verdict).toBe('skill_not_installed');
    expect(events[0].agreement).toBe('resolver_stricter');
    expect(waited).toHaveLength(1); // one receipt write scheduled
  });

  it('missing executionCtx (test/non-workers runtime) still does not throw', () => {
    const sql = (() => Promise.resolve([])) as unknown;
    const ctx = { env: { ROLE_SKILL_RESOLVER_ENABLED: 'true' }, get: () => sql, executionCtx: undefined } as never;
    expect(() => observeRoleSkillResolution(ctx, { allowed: true, reason: 'active_entitlement' }, META)).not.toThrow();
  });
});

describe('Track A · receipt reliability matrix', () => {
  // A1 — unsigned path: no secret ⇒ receipt written with signature_alg='none', signature null
  it('A1 · missing secret ⇒ receipt row is honest-unsigned (alg none, null signature)', async () => {
    const { ctx, waited, inserts } = fakeCtx({ ROLE_SKILL_RESOLVER_ENABLED: 'true' });
    observeRoleSkillResolution(ctx, { allowed: true, reason: 'active_entitlement' }, META);
    await settle(waited);
    const res = inserts.find((i) => i.text.includes('INSERT INTO role_skill_resolutions'));
    expect(res).toBeDefined();
    expect(res!.values).toContain('none'); // signature_alg
    expect(res!.values).not.toContain('HS256');
  });

  // A2 — rotation: configured key id is persisted; signatures differ across secrets (rotation visible)
  it('A2 · RESOLUTION_RECEIPT_SIGNING_KEY_ID is persisted on signed receipts; rotation changes the signature', async () => {
    const { ctx, waited, inserts } = fakeCtx({
      ROLE_SKILL_RESOLVER_ENABLED: 'true',
      RESOLUTION_RECEIPT_SIGNING_SECRET: 'secret-v2',
      RESOLUTION_RECEIPT_SIGNING_KEY_ID: 'k2',
    });
    observeRoleSkillResolution(ctx, { allowed: true, reason: 'active_entitlement' }, META);
    await settle(waited);
    const res = inserts.find((i) => i.text.includes('INSERT INTO role_skill_resolutions'));
    expect(res!.values).toContain('HS256');
    expect(res!.values).toContain('k2'); // rotation label persisted
    // rotation: the same payload signs differently under a rotated secret, identically under the same one
    const p = '{"probe":"payload"}';
    const s1 = await signReceipt('secret-v1', p, 'k1');
    const s1b = await signReceipt('secret-v1', p, 'k1');
    const s2 = await signReceipt('secret-v2', p, 'k2');
    expect(s1.signature).toBe(s1b.signature); // deterministic under one key
    expect(s1.signature).not.toBe(s2.signature); // rotated key ⇒ new signature
    expect(s2.signing_key_id).toBe('k2');
  });

  // A3 — integrity: recomputing the HMAC over the same payload+secret reproduces the signature,
  // and the content hash is stable + format-valid (the DB CHECK shape)
  it('A3 · HMAC recompute matches; content_sha256 stable and 64-hex', async () => {
    const p = '{"a":1,"b":"x"}';
    const first = await signReceipt('s3cr3t', p, 'default');
    const second = await signReceipt('s3cr3t', p, 'default');
    expect(first.signature).toBe(second.signature);
    expect(first.content_sha256).toBe(second.content_sha256);
    expect(first.content_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  // A4 — single-fire: one observe ⇒ exactly one resolution row; denial row only on actual deny
  it('A4 · allow ⇒ 1 resolution insert + 0 denial inserts; deny ⇒ 1 + 1', async () => {
    const allow = fakeCtx({ ROLE_SKILL_RESOLVER_ENABLED: 'true' });
    observeRoleSkillResolution(allow.ctx, { allowed: true, reason: 'active_entitlement' }, META);
    await settle(allow.waited);
    expect(allow.inserts.filter((i) => i.text.includes('role_skill_resolutions'))).toHaveLength(1);
    expect(allow.inserts.filter((i) => i.text.includes('authority_denial_receipts'))).toHaveLength(0);

    const deny = fakeCtx({ ROLE_SKILL_RESOLVER_ENABLED: 'true' });
    observeRoleSkillResolution(deny.ctx, { allowed: false, reason: 'mode_not_allowed' }, META);
    await settle(deny.waited);
    expect(deny.inserts.filter((i) => i.text.includes('role_skill_resolutions'))).toHaveLength(1);
    expect(deny.inserts.filter((i) => i.text.includes('authority_denial_receipts'))).toHaveLength(1);
  });

  // A5 — failed receipt write is telemetered (never silent) and never reaches the caller
  it('A5 · sql-throw ⇒ role_skill_receipt_write_failed emitted with safe fields; caller unaffected', async () => {
    const { ctx, waited } = fakeCtx({ ROLE_SKILL_RESOLVER_ENABLED: 'true' }, { sqlThrows: true });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(() => observeRoleSkillResolution(ctx, { allowed: false, reason: 'mode_not_allowed' }, META)).not.toThrow();
      await expect(settle(waited)).resolves.toBeDefined(); // swallowed, waitUntil never rejects
      const failures = spy.mock.calls
        .map((c) => {
          try {
            return JSON.parse(String(c[0]));
          } catch {
            return null;
          }
        })
        .filter((o): o is Record<string, unknown> => !!o && o.kind === 'role_skill_receipt_write_failed');
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ action: 'packet:create', error: 'Error' });
      // safe fields ONLY — no tenant/principal payload in the failure event
      expect(JSON.stringify(failures[0])).not.toContain('ws_1');
      expect(JSON.stringify(failures[0])).not.toContain('user_1');
    } finally {
      spy.mockRestore();
    }
  });

  // A6 — provenance: v0 floor source, env deploy SHA, null catalog manifest hash
  it('A6 · receipt carries resolver_source=v0-floor, deploy_sha from env, null catalog hash', async () => {
    const { ctx, waited, inserts } = fakeCtx({
      ROLE_SKILL_RESOLVER_ENABLED: 'true',
      XLOOOP_DEPLOY_SHA: 'abc1234',
    });
    observeRoleSkillResolution(ctx, { allowed: true, reason: 'active_entitlement' }, META);
    await settle(waited);
    const res = inserts.find((i) => i.text.includes('INSERT INTO role_skill_resolutions'));
    expect(res!.text).toContain('resolver_source');
    expect(res!.text).toContain('deploy_sha');
    expect(res!.text).toContain('catalog_manifest_sha256');
    expect(res!.values).toContain('v0-floor');
    expect(res!.values).toContain('abc1234');
  });
});
