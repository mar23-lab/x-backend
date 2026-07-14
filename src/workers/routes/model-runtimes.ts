// model-runtimes.ts · Wave C (260708) · /api/v1/model-runtimes — per-workspace model-provider config with
// ENCRYPTED-AT-REST customer credentials, a workspace default, and a per-user session override.
//
// SECURITY: this route is the ONLY layer that encrypts a customer provider credential (via
// ../lib/model-runtime-crypto with ctx.env.MODEL_RUNTIME_ENC_KEY). The DAL stores only sealed ciphertext and
// never sees plaintext or the master key. A client response NEVER contains the plaintext OR the ciphertext —
// reads return a masked `····last4` only. Provider writes + the default flip are OWNER/OPERATOR-gated and
// audited (audit_logs, target_type 'model_runtime_provider'); the session override is the caller's own
// preference. Every path is workspace-scoped from the JWT (auth.workspace_id) — no cross-tenant reach.

import { Hono, type Context } from 'hono';
import { errorEnvelope } from '../middleware/error';
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';
import { isOperatorContext } from '../lib/permissions';
import { authorizeGovernedWrite, entitlementEnforcementOn } from '../lib/spine-authority';
import { withAuthority } from '../lib/allowed-actions';
import { encryptCredential, lastFour, renderMaskedCredential, isEncryptionConfigured } from '../lib/model-runtime-crypto';
import {
  isModelRuntimeProvider,
  PROVIDER_SPECS,
  MODEL_RUNTIME_PROVIDERS,
  type ModelRuntimeProvider,
  type ProviderConfigRow,
  type ProviderSpec,
} from '../dal/model-runtime-store';

export interface ModelRuntimesEnv extends AuthEnv {
  MODEL_RUNTIME_ENC_KEY?: string; // AES-256 master key (base64 32 bytes) — worker secret; NEVER in the DB
  MBP_OWNER_USER_ID?: string;
  MBP_OWNER_LINKED_USER_IDS?: string;
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

// The full 13-provider catalog merged with stored config, so the UI can render every provider + its state.
function catalogView(rows: ProviderConfigRow[]) {
  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  return MODEL_RUNTIME_PROVIDERS.map((p) => {
    const row = byProvider.get(p);
    if (row) return toClientProvider(row);
    const spec = PROVIDER_SPECS[p];
    return {
      id: null, provider: p, auth_kind: spec.auth_kind, locality: spec.locality,
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
      if (!(await isEncryptionConfigured(ctx.env.MODEL_RUNTIME_ENC_KEY))) {
        return errorEnvelope(ctx, { status: 503, code: 'SERVICE_UNAVAILABLE', message: 'credential storage is not configured (MODEL_RUNTIME_ENC_KEY unset)' });
      }
      const { json, primary } = normalizeCredential(spec, cred);
      if (!primary) return errorEnvelope(ctx, { status: 422, code: 'UNPROCESSABLE', message: `${provider} requires a complete credential` });
      const enc = await encryptCredential(ctx.env.MODEL_RUNTIME_ENC_KEY, json);
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
    return ctx.json({ provider: toClientProvider(saved) });
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
    return ctx.json({ ok: true, provider });
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
    return ctx.json({ workspace_default: saved.id, provider: toClientProvider(saved) });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

// PUT /model-runtimes/override — set the caller's OWN session override (personal preference; not audited).
modelRuntimesRoute.put('/model-runtimes/override', async (ctx) => {
  try {
    const auth = ctx.get('auth');
    if (!auth?.user_id) return errorEnvelope(ctx, { status: 401, code: 'UNAUTHORIZED', message: 'auth required' });
    if (!auth.workspace_id) return errorEnvelope(ctx, { status: 403, code: 'FORBIDDEN', message: 'no workspace in session' });
    if (auth.role === 'client') return errorEnvelope(ctx, { status: 403, code: 'FORBIDDEN', message: 'client role cannot set a runtime override' });
    let body: { provider_id?: unknown } = {};
    try { body = (await ctx.req.json()) as typeof body; } catch { body = {}; }
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
