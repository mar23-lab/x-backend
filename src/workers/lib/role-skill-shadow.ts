// role-skill-shadow.ts · OAR-W2 (260713) · shadow observer for the role/skill resolver (default-off).
//
// Mirrors lib/policy-shadow.ts: flag-gated (default OFF ⇒ byte-identical no-op), never throws into the
// write path, fires via ctx.executionCtx.waitUntil so the receipt write is latency-neutral and inert
// under test. Hooked at the TOP of authorizeSpineWrite (before the enforcement branch) so it observes on
// BOTH the legacy path (what actually executes in prod today, ENTITLEMENT_ENFORCEMENT off) AND the
// enforce path — otherwise resolution coverage would stay 0 forever in prod.
//
// What it writes (mig-070): a role_skill_resolutions row for every governed-write decision (this is the
// metric that moves off zero), plus an authority_denial_receipts row when the decision is a DENY
// (upgrading the console-only deny log to a durable, customer-safe receipt). skill_invocation_receipts +
// closing_attestations are reserved for the closed loop (OAR-W6).

import type { Context } from 'hono';
import { envFlagTrue } from './env-flag';
import { emitEvent } from './observability';
import { neonClient } from '../db/client';
import type { Sql } from '../db/client';
import { resolveRoleAndSkills, ROLE_SKILL_V0_FLOOR } from './role-skill-resolver';
import type { RoleSkillBinding, RoleSkillResolutionInput } from './role-skill-resolver';
import { catalogBindingsIfEnabled } from './role-skill-catalog-loader'; // AR-2.1 · the keystone loader (flag-gated)
import {
  signReceipt,
  resolutionSigningPayload,
  insertRoleSkillResolutionRow,
  insertAuthorityDenialRow,
  type Agreement,
} from '../dal/role-skill-resolution-store';

export function roleSkillResolverEnabled(env: unknown): boolean {
  return envFlagTrue((env as { ROLE_SKILL_RESOLVER_ENABLED?: string } | undefined)?.ROLE_SKILL_RESOLVER_ENABLED);
}

/** The actual spine outcome the observer compares its own verdict against. */
export interface ObservedDecision {
  allowed: boolean;
  reason: string;
}

export interface ObserveMeta {
  action: string;
  role: string;
  mode: string;
  workspace_id: string;
  principal_id: string;
  service_principal?: boolean;
  intent?: string | null;
  entitlementActive?: boolean;
  tenantMismatch?: boolean;
}

function agreementOf(resolverAllowed: boolean, actualAllowed: boolean): Agreement {
  if (resolverAllowed === actualAllowed) return 'agree';
  return resolverAllowed ? 'resolver_looser' : 'resolver_stricter';
}

/** The binding source + its provenance. v0 = the (empty) floor; when W3's published catalog is loaded
 *  this seam returns source='catalog' (or 'mixed') + the manifest hash, and every receipt carries it —
 *  so a receipt is always auditable against the catalog state that produced it (review item R5). */
export interface BindingSource {
  bindings: readonly RoleSkillBinding[];
  resolver_source: 'v0-floor' | 'catalog' | 'mixed';
  catalog_manifest_sha256: string | null;
}

function resolveBindings(env: unknown): BindingSource {
  // AR-2.1 keystone: when ROLE_SKILL_CATALOG_ENABLED is on, resolve against the W3-published catalog
  // (real skill bindings) instead of the empty floor. OFF (default) ⇒ the floor ⇒ byte-identical shadow.
  const cat = catalogBindingsIfEnabled(env);
  if (cat) return { bindings: cat.bindings, resolver_source: 'catalog', catalog_manifest_sha256: cat.catalog_manifest_sha256 };
  return { bindings: ROLE_SKILL_V0_FLOOR, resolver_source: 'v0-floor', catalog_manifest_sha256: null };
}

/**
 * Observe one governed-write decision. Flag-off ⇒ returns immediately (byte-identical). Never throws:
 * the whole body is guarded and the DB write is deferred to waitUntil, so a resolver/DB error can never
 * affect the authorization result the caller already computed.
 */
export function observeRoleSkillResolution(ctx: Context, decision: ObservedDecision, meta: ObserveMeta): void {
  const env = ctx.env as Record<string, unknown> | undefined;
  if (!roleSkillResolverEnabled(env)) return; // flag-off ⇒ byte-identical no-op
  try {
    const input: RoleSkillResolutionInput = {
      tenant: meta.workspace_id,
      principal: meta.principal_id,
      role: meta.role,
      mode: meta.mode,
      action: meta.action,
      serviceP: meta.service_principal,
      intent: meta.intent ?? null,
      entitlementActive: meta.entitlementActive,
      tenantMismatch: meta.tenantMismatch,
    };
    const bindingSource = resolveBindings(env);
    const resolution = resolveRoleAndSkills(input, bindingSource.bindings, new Date());
    const agreement = agreementOf(resolution.verdict.allowed, decision.allowed);

    // observability: one structured event per resolution (log-only, greppable). Mirrors policy-shadow.
    emitEvent('role_skill_resolution', {
      action: meta.action,
      role: resolution.selected_role,
      skill_coverage: resolution.skill_coverage,
      resolver_verdict: resolution.verdict.reason,
      resolver_allowed: resolution.verdict.allowed,
      actual_allowed: decision.allowed,
      agreement,
    });

    // durable receipt(s): fire-and-forget via waitUntil (latency-neutral; test runtimes lack executionCtx).
    // A write failure must NEVER break the request — but it must also never be SILENT (activation-readiness
    // R4): the catch emits role_skill_receipt_write_failed with safe fields only (no tenant payload).
    const swallowWithTelemetry = (p: Promise<unknown>): Promise<unknown> =>
      p.catch((err) => {
        emitEvent('role_skill_receipt_write_failed', {
          action: meta.action,
          agreement,
          error: err instanceof Error ? err.name : 'unknown',
        });
      });
    const fire = (p: Promise<unknown>) => {
      const safe = swallowWithTelemetry(p);
      try {
        ctx.executionCtx?.waitUntil ? ctx.executionCtx.waitUntil(safe) : void safe;
      } catch {
        void safe;
      }
    };

    const sqlFor = (): Sql => (ctx.get('sql') as Sql | undefined) ?? neonClient((env as { DATABASE_URL?: string })?.DATABASE_URL || '');
    const secret = (env as { RESOLUTION_RECEIPT_SIGNING_SECRET?: string })?.RESOLUTION_RECEIPT_SIGNING_SECRET;
    const signingKeyId = (env as { RESOLUTION_RECEIPT_SIGNING_KEY_ID?: string })?.RESOLUTION_RECEIPT_SIGNING_KEY_ID;
    const deploySha = (env as { XLOOOP_DEPLOY_SHA?: string })?.XLOOOP_DEPLOY_SHA ?? null;
    const issued_at = new Date().toISOString();

    fire(
      (async () => {
        const sql = sqlFor();
        const payload = resolutionSigningPayload(resolution, {
          workspace_id: meta.workspace_id,
          principal_id: meta.principal_id,
          actual_reason: decision.reason,
          actual_allowed: decision.allowed,
          issued_at,
          resolver_source: bindingSource.resolver_source,
          deploy_sha: deploySha,
        });
        const receipt = await signReceipt(secret, payload, signingKeyId);
        await insertRoleSkillResolutionRow(sql, {
          workspace_id: meta.workspace_id,
          principal_id: meta.principal_id,
          action: meta.action,
          mode: meta.mode,
          intent_ref: meta.intent ?? null,
          resolution,
          actual_reason: decision.reason,
          actual_allowed: decision.allowed,
          agreement,
          receipt,
          resolver_source: bindingSource.resolver_source,
          deploy_sha: deploySha,
          catalog_manifest_sha256: bindingSource.catalog_manifest_sha256,
        });
        // denial receipt only when the ACTUAL decision denied (upgrades the console-only deny log)
        if (!decision.allowed) {
          const denied_by =
            !resolution.verdict.allowed && !decision.allowed
              ? 'both'
              : 'entitlement';
          await insertAuthorityDenialRow(sql, {
            workspace_id: meta.workspace_id,
            principal_id: meta.principal_id,
            role_key: resolution.selected_role,
            action: meta.action,
            mode: meta.mode,
            denied_by,
            entitlement_reason: decision.reason,
            resolver_reason: resolution.verdict.allowed ? null : resolution.verdict.reason,
            safe_explanation: resolution.safe_explanation,
            receipt,
          });
        }
      })(),
    );
  } catch {
    /* shadow observability must never break the write path */
  }
}
