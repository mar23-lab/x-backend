// Per-workspace model-provider config, encrypted credentials, defaults, and user overrides.
// SECURITY: only this route seals credentials through the tenant-bound versioned keyring. The DAL sees
// envelopes, never plaintext, DEKs, or platform KEKs; clients see only `····last4`. Provider writes and
// defaults are operator-gated and audited. Every path is scoped from auth.workspace_id.

import { Hono, type Context } from 'hono';
import { errorEnvelope } from '../middleware/error';
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';
import { isOperatorContext } from '../lib/permissions';
import { authorizeGovernedWrite, entitlementEnforcementOn } from '../lib/spine-authority';
import { withAuthority } from '../lib/allowed-actions';
import { emitEvent } from '../lib/observability';
import {
  credentialEnvelopeKeyId,
  credentialEnvelopeVersion,
  decryptCredential,
  encryptCredential,
  isEncryptionConfigured,
  isTenantEnvelopeEncryptionConfigured,
  lastFour,
  modelRuntimeActiveKeyId,
  modelRuntimeEncryptionConfig,
  renderMaskedCredential,
} from '../lib/model-runtime-crypto';
import {
  isModelRuntimeProvider,
  PROVIDER_SPECS,
  MODEL_RUNTIME_PROVIDERS,
  type ModelRuntimeProvider,
  type ProviderConfigRow,
  type ProviderSpec,
} from '../dal/model-runtime-store';
import {
  ProviderUnavailableError,
  discoverRuntimeModels,
  resolveConfiguredRuntime,
  resolveEffectiveRuntimePlan,
  validateRuntime,
} from '../services/model-runtime-execution';
import type { AiRunner } from '../services/agent-digest';
import { runtimePolicyEnforcement } from '../services/runtime-policy-enforcement';

export interface ModelRuntimesEnv extends AuthEnv {
  MODEL_RUNTIME_ENC_KEY?: string; // legacy decrypt-only AES-256 key during migration
  MODEL_RUNTIME_ENC_KEYS?: string; // JSON key-id -> platform KEK; wraps random tenant credential DEKs
  MODEL_RUNTIME_ACTIVE_KEY_ID?: string;
  MBP_OWNER_USER_ID?: string;
  MBP_OWNER_LINKED_USER_IDS?: string;
  AI?: AiRunner;
  ANTHROPIC_API_KEY?: string;
}
export interface ModelRuntimesVariables extends AuthVariables {
  dal: DalAdapter;
}
export const modelRuntimesRoute = new Hono<{ Bindings: ModelRuntimesEnv; Variables: ModelRuntimesVariables }>();

// isOperatorContext/isMbpOperator: consolidated into lib/permissions.ts (S3, 260709) — one driver.

// U4b · runtime configuration is a GOVERNED write, so when ENTITLEMENT_ENFORCEMENT is on it must ALSO obey the
// operating mode + entitlement (like the spine) — a watch-mode owner can no longer reconfigure runtimes. This
// runs AFTER isOperatorContext, so flag-OFF it is inert (returns null immediately → byte-identical to today);
// flag-ON it adds the 'runtime:configure' authority gate. Returns a 403 Response to short-circuit, or null.
async function runtimeEnforcementGate(ctx: Context<{ Bindings: ModelRuntimesEnv; Variables: ModelRuntimesVariables }>): Promise<Response | null> {
  if (!entitlementEnforcementOn(ctx.env)) return null; // flag off → no extra gate (today's behaviour)
  const d = await authorizeGovernedWrite(ctx as never, 'runtime:configure');
  if (d.allowed) return null;
  return errorEnvelope(ctx, { status: 403, code: 'FORBIDDEN', message: 'runtime configuration requires operator mode', reason: d.reason });
}

// Serialize a stored row to the client-safe view. NEVER includes ciphertext/iv — only the masked tail.
function toClientProvider(row: ProviderConfigRow) {
  const spec = PROVIDER_SPECS[row.provider];
  return {
    id: row.id,
    provider: row.provider,
    auth_kind: row.auth_kind,
    locality: spec?.locality ?? 'external',
    execution_mode: spec?.execution_mode ?? 'adapter_unavailable',
    base_url: row.base_url,
    model: row.model,
    requires_key: spec?.requires_key ?? false,
    requires_base_url: spec?.requires_base_url ?? false,
    configured: Boolean(row.credential_last4) || Boolean(spec && !spec.requires_key && row.base_url),
    enabled: row.enabled,
    is_default: row.is_default,
    masked_key: renderMaskedCredential(row.credential_last4),
    updated_at: row.updated_at,
  };
}

function requireRuntimeReceipt(value: unknown, field: string): string {
  const id = value && typeof value === 'object' ? (value as Record<string, unknown>)[field] : null;
  if (typeof id !== 'string' || !id.trim()) throw new Error(`model runtime write missing ${field}`);
  return id;
}

// The full 13-provider catalog merged with stored config, so the UI can render every provider + its state.
function catalogView(rows: ProviderConfigRow[]) {
  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  return MODEL_RUNTIME_PROVIDERS.map((p) => {
    const row = byProvider.get(p);
    if (row) return toClientProvider(row);
    const spec = PROVIDER_SPECS[p];
    return {
      id: null, provider: p, auth_kind: spec.auth_kind, locality: spec.locality, execution_mode: spec.execution_mode,
      base_url: null, model: null, requires_key: spec.requires_key, requires_base_url: spec.requires_base_url,
      configured: false, enabled: false, is_default: false, masked_key: null, updated_at: null,
    };
  });
}

// Turn the client's credential input into { json (to encrypt), primary (for last4) }. Providers vary:
// aws_bedrock needs 3 fields (no bearer key), azure needs key+deployment, the rest a single api_key. A bare
// string is accepted as the api_key. `primary` is empty when a required sub-field is missing → the caller 422s.
function normalizeCredential(spec: ProviderSpec, cred: unknown): { json: string; primary: string } {
  if (typeof cred === 'string') return { json: JSON.stringify({ api_key: cred }), primary: cred };
  const c = cred && typeof cred === 'object' ? (cred as Record<string, unknown>) : {};
  const str = (k: string) => (typeof c[k] === 'string' ? (c[k] as string).trim() : '');
  if (spec.auth_kind === 'aws_sigv4') {
    const accessKeyId = str('access_key_id');
    const secret = str('secret_access_key');
    const region = str('region');
    const complete = Boolean(accessKeyId && secret && region);
    return { json: JSON.stringify({ access_key_id: accessKeyId, secret_access_key: secret, region }), primary: complete ? secret : '' };
  }
  if (spec.auth_kind === 'azure_key') {
    const apiKey = str('api_key');
    const deployment = str('deployment');
    return { json: JSON.stringify({ api_key: apiKey, deployment: deployment || undefined }), primary: apiKey };
  }
  const apiKey = str('api_key');
  return { json: JSON.stringify({ api_key: apiKey }), primary: apiKey };
}

// ── reads ────────────────────────────────────────────────────────────────────

// GET /model-runtimes/providers — any workspace member EXCEPT client; response is masked.
modelRuntimesRoute.get('/model-runtimes/providers', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    if (!auth.workspace_id) return errorEnvelope(ctx, { status: 403, code: 'FORBIDDEN', message: 'no workspace in session' });
    if (auth.role === 'client') return errorEnvelope(ctx, { status: 403, code: 'FORBIDDEN', message: 'client role cannot read model-runtime config' });
    const dal = ctx.get('dal');
    const rows = await dal.modelRuntimes.listProviders(auth.workspace_id);
    const sessionOverride = await dal.modelRuntimes.getOverride(auth.user_id, auth.workspace_id);
    // Server-derived authority envelope (M4): allowed_actions + disabled_reasons, NOT a bare boolean, so the
    // UI renders a disabled control WITH its reason and never re-derives authority client-side. The route's
    // real write gate is isOperatorContext (includes the MB-P orgless operator by user_id, whom the pure role
    // matrix can't see) → grant the write actions via override so the envelope stays faithful to that gate.
    const manage = isOperatorContext(auth, ctx.env) ? { grant: ['set', 'delete', 'set_default'] } : undefined;
    const body = {
      providers: catalogView(rows),
      workspace_default: rows.find((r) => r.is_default)?.id ?? null,
      session_override: sessionOverride,
    };
    return ctx.json(withAuthority(body, auth, 'model_runtime', manage));
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// The runtime customer chat will use after user override -> workspace default -> platform default.
// Credentials and fallback internals never leave the worker.
modelRuntimesRoute.get('/model-runtimes/effective', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    if (!auth.workspace_id) return errorEnvelope(ctx, { status: 403, code: 'FORBIDDEN', message: 'no workspace in session' });
    if (auth.role === 'client') return errorEnvelope(ctx, { status: 403, code: 'FORBIDDEN', message: 'client role cannot read model-runtime config' });
    const plan = await resolveEffectiveRuntimePlan({
      facade: ctx.get('dal').modelRuntimes,
      env: ctx.env,
      userId: auth.user_id,
      workspaceId: auth.workspace_id,
    });
    return ctx.json({
      effective: {
        runtime_id: plan.primary.runtime_id,
        provider: plan.primary.provider,
        model: plan.primary.model,
        source: plan.primary.source,
        provider_config_version_id: plan.primary.provider_config_version_id,
      },
      fallback_count: plan.fallbacks.length,
      resolution_attempts: plan.resolution_attempts,
      policy_enforcement: runtimePolicyEnforcement(),
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// Live model discovery uses the configured tenant credential. Plaintext remains inside the resolver
// and provider fetch call; only model ids are returned.
modelRuntimesRoute.get('/model-runtimes/providers/:provider/models', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    if (!auth.workspace_id) return errorEnvelope(ctx, { status: 403, code: 'FORBIDDEN', message: 'no workspace in session' });
    if (!isOperatorContext(auth, ctx.env)) return errorEnvelope(ctx, { status: 403, code: 'FORBIDDEN', message: 'only an owner or operator can inspect model runtimes' });
    const provider = ctx.req.param('provider');
    if (!isModelRuntimeProvider(provider)) return errorEnvelope(ctx, { status: 400, code: 'VALIDATION_ERROR', message: 'unknown provider' });
    const runtime = await resolveConfiguredRuntime({
      facade: ctx.get('dal').modelRuntimes,
      env: ctx.env,
      workspaceId: auth.workspace_id,
      provider,
    });
    const models = await discoverRuntimeModels(runtime);
    return ctx.json({
      provider,
      runtime_id: runtime.runtime_id,
      models,
      catalog_source: 'live_provider_api_with_configured_fallback',
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// A real content-free probe using the configured tenant credential. Plaintext is decrypted only inside
// the server execution path and is never included in the response, audit metadata, or observability event.
modelRuntimesRoute.post('/model-runtimes/providers/:provider/validate', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    if (!auth.workspace_id) return errorEnvelope(ctx, { status: 403, code: 'FORBIDDEN', message: 'no workspace in session' });
    if (!isOperatorContext(auth, ctx.env)) return errorEnvelope(ctx, { status: 403, code: 'FORBIDDEN', message: 'only an owner or operator can validate model runtimes' });
    { const rg = await runtimeEnforcementGate(ctx); if (rg) return rg; }
    const provider = ctx.req.param('provider');
    if (!isModelRuntimeProvider(provider)) return errorEnvelope(ctx, { status: 400, code: 'VALIDATION_ERROR', message: 'unknown provider' });
    const runtime = await resolveConfiguredRuntime({
      facade: ctx.get('dal').modelRuntimes,
      env: ctx.env,
      workspaceId: auth.workspace_id,
      provider,
    });
    const result = await validateRuntime(runtime);
    const validationReceiptId = `mrv_${crypto.randomUUID()}`;
    await ctx.get('dal').appendAuditLog({
      actor_user_id: auth.user_id,
      action: 'model_runtime_validate',
      target_type: 'model_runtime_provider',
      target_id: runtime.runtime_id,
      workspace_id: auth.workspace_id,
      reason: 'live provider validation passed',
      metadata: {
        validation_receipt_id: validationReceiptId,
        provider,
        model: runtime.model,
        latency_ms: result.latency_ms,
      },
    });
    emitEvent('model_runtime_validated', {
      workspace_id: auth.workspace_id,
      provider,
      latency_ms: result.latency_ms,
    });
    return ctx.json({
      ok: true,
      validation_receipt_id: validationReceiptId,
      audit_recorded: true,
      runtime_id: runtime.runtime_id,
      provider,
      model: runtime.model,
      latency_ms: result.latency_ms,
      usage: result.usage,
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// ── writes (owner/operator, audited) ──────────────────────────────────────────

// PUT /model-runtimes/providers/:provider — upsert config + (optional) credential.
modelRuntimesRoute.put('/model-runtimes/providers/:provider', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    if (!auth.workspace_id) return errorEnvelope(ctx, { status: 403, code: 'FORBIDDEN', message: 'no workspace in session' });
    if (!isOperatorContext(auth, ctx.env)) return errorEnvelope(ctx, { status: 403, code: 'FORBIDDEN', message: 'only an owner or operator can configure model runtimes' });
    { const rg = await runtimeEnforcementGate(ctx); if (rg) return rg; } // flag-on: also require operator mode
    const provider = ctx.req.param('provider');
    if (!isModelRuntimeProvider(provider)) return errorEnvelope(ctx, { status: 400, code: 'VALIDATION_ERROR', message: 'unknown provider' });
    const spec = PROVIDER_SPECS[provider];

    let body: { base_url?: unknown; model?: unknown; enabled?: unknown; credential?: unknown } = {};
    try { body = (await ctx.req.json()) as typeof body; } catch { body = {}; }
    const base_url = typeof body.base_url === 'string' && body.base_url.trim() ? body.base_url.trim() : null;
    const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null;
    const enabled = typeof body.enabled === 'boolean' ? body.enabled : true;

    if (spec.requires_base_url && !base_url) {
      return errorEnvelope(ctx, { status: 422, code: 'UNPROCESSABLE', message: `${provider} requires a base_url` });
    }
    if (!spec.requires_base_url && base_url) {
      return errorEnvelope(ctx, { status: 422, code: 'UNPROCESSABLE', message: `${provider} does not accept a base_url` });
    }

    const dal = ctx.get('dal');
    let sealed: { ciphertext: string; iv: string; last4: string } | null = null;
    const cred = body.credential;
    const credentialProvided = cred !== undefined && cred !== null &&
      !(typeof cred === 'object' && Object.keys(cred as object).length === 0) &&
      !(typeof cred === 'string' && cred.trim() === '');

    if (credentialProvided) {
      if (spec.auth_kind === 'none') {
        return errorEnvelope(ctx, { status: 422, code: 'UNPROCESSABLE', message: `${provider} is a keyless (local) provider — no credential` });
      }
      const encryption = modelRuntimeEncryptionConfig(ctx.env);
      if (!(await isTenantEnvelopeEncryptionConfigured(encryption))) {
        return errorEnvelope(ctx, { status: 503, code: 'SERVICE_UNAVAILABLE', message: 'tenant envelope credential storage is not configured' });
      }
      const { json, primary } = normalizeCredential(spec, cred);
      if (!primary) return errorEnvelope(ctx, { status: 422, code: 'UNPROCESSABLE', message: `${provider} requires a complete credential` });
      const enc = await encryptCredential(encryption, json, {
        tenant_id: auth.workspace_id,
        purpose: provider,
      });
      sealed = { ciphertext: enc.ciphertext, iv: enc.iv, last4: lastFour(primary) };
    } else if (spec.requires_key) {
      // No credential this call: allow a metadata-only update of an EXISTING config, else 422 on first create.
      const existing = await dal.modelRuntimes.getProviderCredential(auth.workspace_id, provider);
      if (!existing?.ciphertext) {
        return errorEnvelope(ctx, { status: 422, code: 'UNPROCESSABLE', message: `${provider} requires a credential` });
      }
    }

    const saved = await dal.modelRuntimes.upsertProvider(
      auth.workspace_id,
      provider,
      { auth_kind: spec.auth_kind, base_url, model, enabled, sealed },
      auth.user_id,
    );
    const providerConfigVersionId = requireRuntimeReceipt(saved, 'provider_config_version_id');
    const auditEventId = requireRuntimeReceipt(saved, 'audit_event_id');
    return ctx.json({
      provider: toClientProvider(saved.provider),
      provider_config_version_id: providerConfigVersionId,
      audit_event_id: auditEventId,
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// POST /model-runtimes/providers/:provider/rotate-credential — re-encrypt one credential under the
// active keyring key. Per-provider rotation is deliberate: each write is atomic, audited and safely
// replayable, so a workspace-wide workflow cannot hide partial completion.
modelRuntimesRoute.post('/model-runtimes/providers/:provider/rotate-credential', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    if (!auth.workspace_id) return errorEnvelope(ctx, { status: 403, code: 'FORBIDDEN', message: 'no workspace in session' });
    if (!isOperatorContext(auth, ctx.env)) return errorEnvelope(ctx, { status: 403, code: 'FORBIDDEN', message: 'only an owner or operator can rotate model-runtime credentials' });
    { const rg = await runtimeEnforcementGate(ctx); if (rg) return rg; }
    const provider = ctx.req.param('provider');
    if (!isModelRuntimeProvider(provider)) return errorEnvelope(ctx, { status: 400, code: 'VALIDATION_ERROR', message: 'unknown provider' });
    if (!PROVIDER_SPECS[provider].requires_key) {
      return errorEnvelope(ctx, { status: 422, code: 'UNPROCESSABLE', message: `${provider} has no stored credential to rotate` });
    }

    const encryption = modelRuntimeEncryptionConfig(ctx.env);
    const activeKeyId = modelRuntimeActiveKeyId(encryption);
    if (!activeKeyId || !(await isEncryptionConfigured(encryption))) {
      return errorEnvelope(ctx, {
        status: 503,
        code: 'SERVICE_UNAVAILABLE',
        message: 'versioned credential rotation is not configured',
      });
    }
    const dal = ctx.get('dal');
    const stored = await dal.modelRuntimes.getProviderCredential(auth.workspace_id, provider);
    if (!stored?.ciphertext || !stored.iv) {
      return errorEnvelope(ctx, { status: 404, code: 'NOT_FOUND', message: 'provider credential is not configured' });
    }
    const sealedStored = { ciphertext: stored.ciphertext, iv: stored.iv };
    const fromKeyId = credentialEnvelopeKeyId(sealedStored);
    if (fromKeyId === activeKeyId && credentialEnvelopeVersion(sealedStored) === 2) {
      return errorEnvelope(ctx, { status: 409, code: 'CREDENTIAL_ALREADY_ACTIVE', message: 'provider credential already uses the active key' });
    }

    const context = { tenant_id: auth.workspace_id, purpose: provider };
    const plaintext = await decryptCredential(encryption, sealedStored, context);
    const rotated = await encryptCredential(encryption, plaintext, context);
    const receipt = await dal.modelRuntimes.rotateProviderCredential(
      auth.workspace_id,
      provider,
      rotated,
      auth.user_id,
      fromKeyId,
      activeKeyId,
    );
    if (!receipt) return errorEnvelope(ctx, { status: 404, code: 'NOT_FOUND', message: 'provider credential is not configured' });
    emitEvent('model_runtime_credential_rotated', {
      workspace_id: auth.workspace_id,
      provider,
      from_key_id: fromKeyId ?? 'legacy',
      to_key_id: activeKeyId,
    });
    return ctx.json({
      ok: true,
      provider,
      from_key_id: fromKeyId ?? 'legacy',
      to_key_id: activeKeyId,
      provider_config_version_id: receipt.provider_config_version_id,
      credential_rotation_receipt_id: receipt.credential_rotation_receipt_id,
      audit_event_id: receipt.audit_event_id,
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// DELETE /model-runtimes/providers/:provider — remove a provider config (audited).
modelRuntimesRoute.delete('/model-runtimes/providers/:provider', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    if (!auth.workspace_id) return errorEnvelope(ctx, { status: 403, code: 'FORBIDDEN', message: 'no workspace in session' });
    if (!isOperatorContext(auth, ctx.env)) return errorEnvelope(ctx, { status: 403, code: 'FORBIDDEN', message: 'only an owner or operator can configure model runtimes' });
    { const rg = await runtimeEnforcementGate(ctx); if (rg) return rg; } // flag-on: also require operator mode
    const provider = ctx.req.param('provider');
    if (!isModelRuntimeProvider(provider)) return errorEnvelope(ctx, { status: 400, code: 'VALIDATION_ERROR', message: 'unknown provider' });
    const removed = await ctx.get('dal').modelRuntimes.deleteProvider(auth.workspace_id, provider, auth.user_id);
    if (!removed) return errorEnvelope(ctx, { status: 404, code: 'NOT_FOUND', message: 'provider not configured' });
    const providerConfigVersionId = requireRuntimeReceipt(removed, 'provider_config_version_id');
    const auditEventId = requireRuntimeReceipt(removed, 'audit_event_id');
    return ctx.json({
      ok: true,
      provider,
      deleted_provider_config_id: removed.deleted_provider_config_id,
      provider_config_version_id: providerConfigVersionId,
      audit_event_id: auditEventId,
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// PUT /model-runtimes/default — flip the workspace default provider (the audited governed change).
modelRuntimesRoute.put('/model-runtimes/default', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    if (!auth.workspace_id) return errorEnvelope(ctx, { status: 403, code: 'FORBIDDEN', message: 'no workspace in session' });
    if (!isOperatorContext(auth, ctx.env)) return errorEnvelope(ctx, { status: 403, code: 'FORBIDDEN', message: 'only an owner or operator can set the default runtime' });
    { const rg = await runtimeEnforcementGate(ctx); if (rg) return rg; } // flag-on: also require operator mode
    let body: { provider_id?: unknown } = {};
    try { body = (await ctx.req.json()) as typeof body; } catch { body = {}; }
    const providerId = typeof body.provider_id === 'string' ? body.provider_id.trim() : '';
    if (!providerId) return errorEnvelope(ctx, { status: 400, code: 'VALIDATION_ERROR', message: 'provider_id required' });
    const dal = ctx.get('dal');
    // Validate the id belongs to this workspace BEFORE the flip (avoids an all-false no-op that still audits).
    const rows = await dal.modelRuntimes.listProviders(auth.workspace_id);
    if (!rows.some((r) => r.id === providerId)) return errorEnvelope(ctx, { status: 404, code: 'NOT_FOUND', message: 'provider not configured in this workspace' });
    const saved = await dal.modelRuntimes.setDefaultProvider(auth.workspace_id, providerId, auth.user_id);
    if (!saved) return errorEnvelope(ctx, { status: 404, code: 'NOT_FOUND', message: 'provider not configured in this workspace' });
    const defaultRevisionId = requireRuntimeReceipt(saved, 'default_revision_id');
    const auditEventId = requireRuntimeReceipt(saved, 'audit_event_id');
    return ctx.json({
      workspace_default: saved.provider.id,
      provider: toClientProvider(saved.provider),
      default_revision_id: defaultRevisionId,
      audit_event_id: auditEventId,
    });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// PUT /model-runtimes/override — set or clear the caller's OWN session override (personal preference).
modelRuntimesRoute.put('/model-runtimes/override', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    if (!auth.workspace_id) return errorEnvelope(ctx, { status: 403, code: 'FORBIDDEN', message: 'no workspace in session' });
    if (auth.role === 'client') return errorEnvelope(ctx, { status: 403, code: 'FORBIDDEN', message: 'client role cannot set a runtime override' });
    let body: { provider_id?: unknown; clear_override?: unknown } = {};
    try { body = (await ctx.req.json()) as typeof body; } catch { body = {}; }
    if (body.clear_override === true) {
      await ctx.get('dal').modelRuntimes.clearOverride(auth.user_id, auth.workspace_id);
      return ctx.json({ session_override: null, effective_source: 'workspace_default' });
    }
    const providerId = typeof body.provider_id === 'string' ? body.provider_id.trim() : '';
    if (!providerId) return errorEnvelope(ctx, { status: 400, code: 'VALIDATION_ERROR', message: 'provider_id required' });
    const dal = ctx.get('dal');
    const rows = await dal.modelRuntimes.listProviders(auth.workspace_id);
    if (!rows.some((r) => r.id === providerId)) return errorEnvelope(ctx, { status: 404, code: 'NOT_FOUND', message: 'provider not configured in this workspace' });
    const saved = await dal.modelRuntimes.setOverride(auth.user_id, auth.workspace_id, providerId);
    return ctx.json({ session_override: saved });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});
