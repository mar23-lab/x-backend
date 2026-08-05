// health.ts · GET /api/v1/health · uptime check (no auth)
//
// Authority: API_CONTRACT_V1.md §GET /api/v1/health

import { Hono } from 'hono';
import { isSentryActive } from '../sentry';
import { envFlagTrue } from '../lib/env-flag';
import { rlsBindingMode } from '../db/rls-connection';
import apiContract from '../../../docs/contracts/api-contract.v1.json';

export const healthRoute = new Hono();

healthRoute.get('/health', (ctx) => {
  // `version` is the API CONTRACT version (semver) — it is NOT a deploy signal and is
  // intentionally constant. `build` / `built_at` ARE the deploy signal: they are injected
  // at `npm run deploy:api` (--var BUILD_SHA / BUILD_TIME) and CHANGE per deploy, so a
  // consumer can confirm the exact live commit. Per HR-CONFIG-REALITY-MATCH-1: never infer
  // deploy/release state from a hardcoded constant — use a value that tracks reality.
  // Falls back to 'dev' / null when run locally or deployed without injection.
  const env = ctx.env as {
    BUILD_SHA?: string;
    BUILD_TIME?: string;
    ENVIRONMENT?: string;
    XLOOOP_SCHEMA_HEAD?: string;
    XLOOOP_AUTHORITY_MODE?: string;
    XLOOOP_RLS_APP_DATABASE_URL?: string;
    SINGLE_INTAKE_ENABLED?: string;
    ROLE_SKILL_CATALOG_ENABLED?: string;
    CONTEXT_PACKET_PERSISTENCE_ENABLED?: string;
    CHAT_HISTORY_PERSISTENCE_REQUIRED?: string;
    TENANT_PROJECTION_QUEUE_ENABLED?: string;
    CURRENT_WORK_PROJECTION_ENABLED?: string;
    TENANT_PROJECTION_QUEUE?: unknown;
  };
  const authority = env.XLOOOP_AUTHORITY_MODE === 'production' ? 'production' : 'shadow';
  const configuredSchemaHead = Number(env.XLOOOP_SCHEMA_HEAD);
  const schemaHead = Number.isSafeInteger(configuredSchemaHead) && configuredSchemaHead > 0
    ? configuredSchemaHead
    : null;
  return ctx.json({
    status: 'ok',
    version: '1.0.0',
    build: env.BUILD_SHA || 'dev',
    built_at: env.BUILD_TIME || null,
    environment: env.ENVIRONMENT || 'development',
    authority,
    contract_hash: apiContract.contract_hash,
    schema_head: schemaHead,
    // Read via the ONE sanctioned reader, `envFlagTrue`. Until 260729 these six went through a
    // LOCAL helper defined in this file — `(v?: string) => v?.trim().toLowerCase() === 'true'` —
    // which was quote-INTOLERANT: a Cloudflare dashboard value entered as `"true"` (with the
    // quote characters) read as false, so the feature stayed off while /health reported it off
    // too, i.e. the posture surface agreed with the bug instead of exposing it.
    // verify-flag-parse-hygiene matched `_ENABLED` per LINE, so a read behind a local helper was
    // invisible to it; the gate now also detects the helper shape.
    feature_posture: {
      single_intake: envFlagTrue(env.SINGLE_INTAKE_ENABLED),
      role_skill_catalog: envFlagTrue(env.ROLE_SKILL_CATALOG_ENABLED),
      context_packet_persistence: envFlagTrue(env.CONTEXT_PACKET_PERSISTENCE_ENABLED),
      chat_history_persistence_required: envFlagTrue(env.CHAT_HISTORY_PERSISTENCE_REQUIRED),
      tenant_projection_queue: envFlagTrue(env.TENANT_PROJECTION_QUEUE_ENABLED),
      current_work_projection: envFlagTrue(env.CURRENT_WORK_PROJECTION_ENABLED),
    },
    bindings: {
      tenant_projection_queue: Boolean(env.TENANT_PROJECTION_QUEUE),
      // rls_binding — 'app' when reads route through the NOBYPASSRLS role, 'owner' when they
      // silently fall back to the owner connection, which BYPASSES RLS.
      //
      // WHY THIS IS EXPOSED (260728). index.ts:170/363/432 select the connection with
      //   env.XLOOOP_RLS_APP_DATABASE_URL ? neonClient(env.XLOOOP_RLS_APP_DATABASE_URL) : sql
      // — a silent fail-OPEN. If that secret is ever unbound or rotated away, every read that
      // believed it was tenant-scoped runs as owner, no error is raised, no log is written, and
      // NOTHING observable changes. An audit this session could not tell from outside whether
      // production was enforcing RLS at all; it took `wrangler secret list` to find out. That is
      // an unobservable security-critical state, which is the defect — independent of whether the
      // secret happens to be bound today (it is).
      //
      // This publishes the state without changing behaviour, so the pairing can be asserted from
      // outside. Deliberately a boolean-derived label, never the DSN.
      //
      // 260805: this line used to re-derive the label inline from the secret. That made /health a
      // SECOND source of truth for the same decision resolveRlsSql makes — so a change to the
      // resolution rule would leave the one externally observable signal reporting the old posture.
      // It now calls the same module, which is the point of that module existing.
      rls_binding: rlsBindingMode(env),
    },
    capabilities: {
      sign_offs: true,
      single_intake: true,
      customer_chat: true,
      source_connections: true,
      document_uploads: true,
    },
    // A-W6 · public-safe activation signal: true iff the SDK is bound to a valid (parseable) DSN — the
    // honest getDsn() probe, not merely a bound client. (The temporary DSN-shape triage fields — dsn_len,
    // dsn_looks_like_url — were removed once the malformed-DSN incident was resolved 260707.)
    sentry_active: isSentryActive(),
    timestamp: new Date().toISOString(),
  });
});
