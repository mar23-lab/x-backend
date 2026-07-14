// src/workers/sentry.ts
//
// R51-θ-3 · Sentry integration for Cloudflare Workers (ACTIVATED 260707).
//
// Authority: federated-waterfall plan §"PHASE 6 / Wave θ"; A-W6 wiring.
//
// Scope
// -----
// @sentry/cloudflare (v10) has NO standalone `init()` — a Worker cannot init at module load because
// env (and thus SENTRY_DSN) is only available per-request. The SDK is initialized by wrapping the
// exported handler with `Sentry.withSentry(optionsCallback, handler)` (see src/workers/index.ts). This
// module therefore exposes:
//   - `sentryOptions(env)` — the withSentry options builder; returns undefined when SENTRY_DSN is absent
//     (local dev / tests / unbound secret) so withSentry becomes a pass-through no-op (dormant-safe).
//   - `captureException` / `captureMessage` — thin delegates to the request-scoped SDK client that
//     withSentry establishes; they fall back to console logging when Sentry is inactive (no client).
//   - `sentryFlush` — flush buffered telemetry before the isolate suspends (called from app.onError).
//   - `sentryInit` / `sentryInitAsync` — retained no-op shims (init now happens in withSentry); kept so
//     existing call-sites + the production-hardening gate stay stable.
//
// What this DOES NOT do
// ---------------------
// - Send PII to Sentry. `beforeSend` (in sentryOptions) strips any field whose KEY matches
//   /password|token|secret|key|jwt|authorization|cookie|api[_-]?key/i before transport.
// - Force tracing on every route. tracesSampleRate defaults to 10% (config-driven).

import * as Sentry from '@sentry/cloudflare';

export interface SentryEnv {
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  SENTRY_RELEASE?: string;
  SENTRY_SAMPLE_RATE?: string;
  SENTRY_TRACES_SAMPLE_RATE?: string;
}

const REDACT_FIELD_RE = /password|token|secret|key|jwt|authorization|cookie|api[_-]?key/i;

/**
 * Build the withSentry options for this request's env, or `undefined` when SENTRY_DSN is unset so
 * withSentry passes through untouched (dormant-safe). Called once per request by the handler wrapper.
 */
export function sentryOptions(env: SentryEnv): Sentry.CloudflareOptions | undefined {
  if (!env.SENTRY_DSN) return undefined;
  return {
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT ?? 'production',
    release: env.SENTRY_RELEASE ?? 'unknown',
    sampleRate: env.SENTRY_SAMPLE_RATE ? Number(env.SENTRY_SAMPLE_RATE) : 1.0,
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE ? Number(env.SENTRY_TRACES_SAMPLE_RATE) : 0.10,
    // beforeSend runs on every event just before transport — last-line PII scrub.
    beforeSend: (event) => redactPii(event as unknown as Record<string, unknown>) as unknown as typeof event,
  };
}

/**
 * Retained no-op shims — withSentry now performs initialization. Kept so existing call-sites
 * (middleware/error.ts) and the production-hardening gate remain stable without a behaviour change.
 */
export function sentryInit(_env: SentryEnv): void { /* init handled by withSentry in index.ts */ }
export async function sentryInitAsync(_env: SentryEnv): Promise<void> { /* init handled by withSentry */ }

/**
 * Capture an exception via the request-scoped Sentry client. When Sentry is inactive (no DSN → no
 * client), logs to console.error so the operator still sees the stack trace.
 */
export function captureException(err: unknown, opts?: Record<string, unknown>): void {
  // F14 fix · gate on isSentryActive() (a client WITH a DSN), NOT merely getClient(): withSentry binds a
  // client on every request even when SENTRY_DSN is unbound, and that DSN-less client silently DROPS events.
  // Guarding on getClient() alone therefore swallowed 5xx traces in DSN-unbound envs and never reached the
  // console fallback — a regression vs the dormant original. isSentryActive() restores honest degradation.
  if (isSentryActive()) {
    try {
      Sentry.captureException(err, opts ? { extra: opts } : undefined);
      return;
    } catch (e) {
      console.warn('[sentry] captureException failed:', e);
    }
  }
  console.error('[sentry-fallback]', err instanceof Error ? err.stack : String(err), opts ?? '');
}

/**
 * Capture a structured message (non-exception telemetry).
 */
export function captureMessage(msg: string, opts?: Record<string, unknown>): void {
  if (isSentryActive()) {
    try {
      Sentry.captureMessage(msg, opts ? { extra: opts } : undefined);
      return;
    } catch (e) {
      console.warn('[sentry] captureMessage failed:', e);
    }
  }
  console.log('[sentry-fallback-msg]', msg, opts ?? '');
}

/**
 * True ONLY when the SDK is initialized for the current request AND bound to a real DSN. Surfaced (public-safe
 * boolean) on GET /health so an operator can confirm error monitoring is LIVE.
 *
 * F13 fix: must check getClient()?.getDsn(), NOT just getClient(). @sentry/cloudflare v10's withSentry calls
 * sdk.init() UNCONDITIONALLY — a client is bound on every request even when SENTRY_DSN is unbound (a disabled,
 * DSN-less client that drops events). `!!getClient()` was therefore always true and proved nothing;
 * `!!getClient()?.getDsn()` is the honest activation signal (false = dormant / DSN missing or mistyped).
 */
export function isSentryActive(): boolean {
  try { return !!Sentry.getClient()?.getDsn(); } catch { return false; }
}

/**
 * Flush pending Sentry events before the Workers isolate suspends (call from app.onError / cron).
 * No-op-safe: resolves true when Sentry is inactive.
 */
export async function sentryFlush(timeoutMs = 2000): Promise<boolean> {
  try {
    return await Sentry.flush(timeoutMs);
  } catch (e) {
    console.warn('[sentry] flush failed:', e);
    return false;
  }
}

// ── PII redaction ─────────────────────────────────────────────────────

/**
 * Walk the event object and redact any field whose KEY matches REDACT_FIELD_RE. Applied recursively.
 * Returns the mutated event (Sentry's beforeSend contract permits mutation / a new object).
 */
function redactPii(event: Record<string, unknown>): Record<string, unknown> {
  function walk(obj: unknown): unknown {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(walk);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (REDACT_FIELD_RE.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = walk(v);
      }
    }
    return out;
  }
  return walk(event) as Record<string, unknown>;
}

// Test-only reset (no cached state now that init is withSentry-managed; kept for back-compat).
export function __resetSentryState(): void { /* no-op */ }
