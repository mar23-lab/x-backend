// Customer-safe live readiness projection for the Settings control plane.
// Every check is derived from this authenticated request, tenant-scoped DAL reads, or an explicit
// runtime binding. Missing proof is attention/unavailable; configuration is never promoted to proof.

import { Hono } from 'hono';
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';
import { gateCustomerWorkspace } from '../lib/workspace-gates';
import { envFlagTrue } from '../lib/env-flag';
import { rlsBindingMode } from '../db/rls-connection';
import { isSentryActive } from '../sentry';
import { SAFE_TOOLS, XCP_GATEWAY_NAME, XCP_GATEWAY_PROFILE } from './mcp-gateway';
import {
  ProviderUnavailableError,
  resolveEffectiveRuntimePlan,
  type LiveRuntimeEnv,
} from '../services/model-runtime-execution';
import { isConnectorOAuthEncryptionConfigured, type ConnectorOAuthEncryptionEnv } from '../lib/connector-oauth-crypto';
import {
  googleConnectorOAuthVerificationStatus,
  isGoogleConnectorOAuthConfigured,
  type ConnectorOAuthProviderEnv,
} from '../services/connector-oauth-provider';
import { runtimePolicyEnforcement } from '../services/runtime-policy-enforcement';

type ReadinessStatus = 'ready' | 'attention' | 'unavailable';

interface ReadinessCheck {
  id: string;
  status: ReadinessStatus;
  checked_at: string;
  summary: string;
  receipt_refs: string[];
  source_refs: string[];
  details?: Record<string, unknown>;
}

export interface SettingsReadinessEnv extends AuthEnv, LiveRuntimeEnv, ConnectorOAuthEncryptionEnv, ConnectorOAuthProviderEnv {
  DATABASE_URL: string;
  XLOOOP_RLS_APP_DATABASE_URL?: string;
  XLOOOP_AUTHORITY_MODE?: string;
  XLOOOP_SCHEMA_HEAD?: string;
  SINGLE_INTAKE_ENABLED?: string;
  SENTRY_DSN?: string;
  CONNECTOR_OAUTH_REVOCATION_MODE?: string;
  CONNECTOR_OAUTH_AUTHORITY_MODE?: string;
  LIFECYCLE_RECEIPTS?: R2Bucket;
  DELETE_EXPORT_RECEIPT_KEY?: string;
  DELETE_EXPORT_RECEIPT_SHA256?: string;
}

export interface SettingsReadinessVariables extends AuthVariables {
  dal: DalAdapter;
}

export const settingsReadinessRoute = new Hono<{
  Bindings: SettingsReadinessEnv;
  Variables: SettingsReadinessVariables;
}>();

function check(
  checkedAt: string,
  input: Omit<ReadinessCheck, 'checked_at'>,
): ReadinessCheck {
  return { ...input, checked_at: checkedAt };
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

async function sha256Hex(value: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', value);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function verifyProductionLifecycleReceipt(env: SettingsReadinessEnv): Promise<{
  verified: boolean;
  reason: string;
  receiptId?: string;
  immutableReceiptRef?: string;
  generatedAt?: string;
}> {
  const key = env.DELETE_EXPORT_RECEIPT_KEY?.trim();
  const expectedHash = env.DELETE_EXPORT_RECEIPT_SHA256?.trim().toLowerCase();
  if (!env.LIFECYCLE_RECEIPTS || !key || !isSha256(expectedHash)) {
    return { verified: false, reason: 'receipt_store_or_pinned_identity_not_configured' };
  }

  const object = await env.LIFECYCLE_RECEIPTS.get(key);
  if (!object) return { verified: false, reason: 'pinned_receipt_not_found' };

  const bytes = await object.arrayBuffer();
  if ((await sha256Hex(bytes)) !== expectedHash) {
    return { verified: false, reason: 'pinned_receipt_hash_mismatch' };
  }

  let receipt: Record<string, unknown>;
  try {
    receipt = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    return { verified: false, reason: 'pinned_receipt_invalid_json' };
  }

  const proofs = receipt.receipt_proofs as Record<string, unknown> | undefined;
  const requiredFields = [
    'receipt_id',
    'immutable_receipt_ref',
    'source_system',
    'tenant_scope',
    'company_id',
    'user_id',
    'actor_id',
    'workspace_scope',
    'approval_id',
    'export_request_id',
    'delete_request_id',
    'audit_id',
    'storage_provider',
    'storage_bucket',
    'object_key',
    'object_hash_sha256',
    'export_manifest_hash_sha256',
    'receipt_proofs',
    'legal_hold_policy_id',
    'retention_class',
    'rollback_boundary',
    'erasure_boundary',
    'tombstone_proof',
    'action_executed_at',
    'generated_at',
    'verifier_command',
  ];
  const proofKeys = [
    'object_storage_receipt_id',
    'export_manifest_receipt_id',
    'proof_bundle_receipt_id',
    'delete_request_receipt_id',
    'legal_hold_receipt_id',
    'negative_read_receipt_id',
  ];
  const actionTime = Date.parse(String(receipt.action_executed_at ?? ''));
  const generatedTime = Date.parse(String(receipt.generated_at ?? ''));
  const generatedAgeDays = (Date.now() - generatedTime) / 86_400_000;
  const contractValid = requiredFields.every((field) => receipt[field] !== undefined && receipt[field] !== '')
    && receipt.schema_id === 'xlooop.delete_export_object_storage_receipt.v1'
    && receipt.evidence_class === 'production_live_receipt'
    && receipt.source_system === 'production_object_storage_lifecycle'
    && receipt.storage_provider === 'cloudflare_r2'
    && /^receipt\.[a-z0-9_.:-]+$/.test(String(receipt.receipt_id))
    && /^xlooop:\/\/receipts\//.test(String(receipt.immutable_receipt_ref))
    && receipt.negative_read_after_delete === true
    && receipt.raw_customer_data_used === false
    && !Number.isNaN(actionTime)
    && !Number.isNaN(generatedTime)
    && actionTime <= generatedTime
    && generatedAgeDays >= 0
    && generatedAgeDays <= 7
    && /verify:public-self-serve-production-receipts/.test(String(receipt.verifier_command))
    && typeof receipt.legal_hold_state === 'string' && receipt.legal_hold_state.length > 0
    && typeof receipt.retention_class === 'string' && receipt.retention_class.length > 0
    && isSha256(receipt.object_hash_sha256)
    && isSha256(receipt.export_manifest_hash_sha256)
    && proofKeys.every((proofKey) => typeof proofs?.[proofKey] === 'string' && proofs[proofKey].length > 0);
  if (!contractValid) return { verified: false, reason: 'pinned_receipt_contract_invalid' };

  return {
    verified: true,
    reason: 'verified',
    receiptId: String(receipt.receipt_id),
    immutableReceiptRef: String(receipt.immutable_receipt_ref),
    generatedAt: String(receipt.generated_at),
  };
}

settingsReadinessRoute.get('/settings/readiness', async (ctx) => {
  const checkedAt = new Date().toISOString();
  const auth = ctx.get('auth');
  const gate = await gateCustomerWorkspace(ctx as never);
  if (!gate.ok) return gate.res;

  const checks: ReadinessCheck[] = [];
  checks.push(check(checkedAt, {
    id: 'auth_tenant',
    status: 'ready',
    summary: 'Authenticated identity and provisioned tenant membership were verified for this request.',
    receipt_refs: [ctx.get('request_id')],
    source_refs: ['clerk_or_service_principal', 'workspace_entitlement'],
    details: {
      tenant_id: gate.ws,
      auth_method: auth.auth_method ?? (auth.service_principal ? 'service_principal' : 'clerk_jwt'),
      role: auth.role,
    },
  }));

  const intakeReady = envFlagTrue(ctx.env.SINGLE_INTAKE_ENABLED);
  checks.push(check(checkedAt, {
    id: 'api_gateway',
    status: intakeReady ? 'ready' : 'attention',
    summary: intakeReady
      ? 'The versioned API and canonical customer gateway profile are active.'
      : 'The API is reachable, but canonical single-intake activation is not verified.',
    receipt_refs: [ctx.get('request_id')],
    source_refs: ['GET /api/v1/settings/readiness', 'SINGLE_INTAKE_ENABLED'],
    details: { gateway: XCP_GATEWAY_NAME, profile: XCP_GATEWAY_PROFILE },
  }));

  const schemaHead = Number(ctx.env.XLOOOP_SCHEMA_HEAD);
  const schemaKnown = Number.isSafeInteger(schemaHead) && schemaHead > 0;
  const rlsMode = rlsBindingMode(ctx.env);
  checks.push(check(checkedAt, {
    id: 'database_schema_rls',
    status: schemaKnown && rlsMode === 'app' ? 'ready' : 'attention',
    summary: schemaKnown && rlsMode === 'app'
      ? 'Tenant reads are bound to the RLS-subject role and a schema head is declared.'
      : 'Database access succeeded, but schema-head or RLS-subject proof is incomplete.',
    receipt_refs: [ctx.get('request_id')],
    source_refs: ['workspace_entitlement_read', 'XLOOOP_SCHEMA_HEAD', 'rlsBindingMode'],
    details: { schema_head: schemaKnown ? schemaHead : null, rls_binding: rlsMode },
  }));

  try {
    const plan = await resolveEffectiveRuntimePlan({
      facade: gate.dal.modelRuntimes,
      env: ctx.env,
      userId: auth.user_id,
      workspaceId: gate.ws,
    });
    checks.push(check(checkedAt, {
      id: 'effective_runtime',
      status: 'ready',
      summary: 'A server-executable live runtime resolved for this user and workspace.',
      receipt_refs: [],
      source_refs: ['effective_runtime_resolver'],
      details: {
        runtime_id: plan.primary.runtime_id,
        provider: plan.primary.provider,
        model: plan.primary.model,
        source: plan.primary.source,
        policy_enforcement: runtimePolicyEnforcement(),
      },
    }));
  } catch (err) {
    checks.push(check(checkedAt, {
      id: 'effective_runtime',
      status: 'unavailable',
      summary: err instanceof ProviderUnavailableError
        ? 'No server-executable live runtime could be verified.'
        : 'Effective runtime readiness could not be verified.',
      receipt_refs: [],
      source_refs: ['effective_runtime_resolver'],
    }));
  }

  const authMethod = auth.auth_method ?? (auth.service_principal ? 'service_principal' : 'clerk_jwt');
  const customerConnectorVerified = auth.service_principal === 'customer_token' && Boolean(auth.client_id);
  checks.push(check(checkedAt, {
    id: 'mcp_oauth',
    status: intakeReady && customerConnectorVerified ? 'ready' : 'attention',
    summary: intakeReady && customerConnectorVerified
      ? 'A customer connector principal reached the tenant-scoped gateway.'
      : 'The gateway contract is present, but end-to-end customer connector OAuth/token proof is not present on this request.',
    receipt_refs: [ctx.get('request_id')],
    source_refs: ['customer_gateway_safe_tools', 'request_auth_context'],
    details: {
      auth_method: authMethod,
      allowed_tool_count: SAFE_TOOLS.length,
      customer_connector_verified: customerConnectorVerified,
    },
  }));

  try {
    const sources = (await gate.dal.listUserSources(auth.user_id))
      .filter((source) => source.workspace_id === gate.ws);
    const connected = sources.filter((source) => source.status === 'connected');
    const failed = sources.filter((source) => Boolean(source.last_sync_error));
    const newest = connected
      .map((source) => source.last_sync_at || source.connected_at)
      .filter((value): value is string => Boolean(value))
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
    checks.push(check(checkedAt, {
      id: 'sources_freshness',
      status: connected.length > 0 && failed.length === 0 && newest ? 'ready' : 'attention',
      summary: connected.length > 0
        ? (failed.length ? 'One or more connected sources report a sync error.' : 'Connected source freshness was checked.')
        : 'No connected tenant source is currently verified.',
      receipt_refs: [],
      source_refs: ['tenant_scoped_user_sources'],
      details: { connected_count: connected.length, sync_error_count: failed.length, newest_sync_at: newest },
    }));
  } catch {
    checks.push(check(checkedAt, {
      id: 'sources_freshness',
      status: 'unavailable',
      summary: 'Source freshness could not be verified.',
      receipt_refs: [],
      source_refs: ['tenant_scoped_user_sources'],
    }));
  }

  const connectorEncryptionReady = await isConnectorOAuthEncryptionConfigured(ctx.env);
  const connectorProviderReady = isGoogleConnectorOAuthConfigured(ctx.env);
  const connectorVerificationStatus = googleConnectorOAuthVerificationStatus(ctx.env);
  const connectorCanaryReady = ctx.env.CONNECTOR_OAUTH_AUTHORITY_MODE === 'dedicated_google'
    && connectorEncryptionReady
    && connectorProviderReady;
  const connectorCommercialReady = connectorCanaryReady && connectorVerificationStatus === 'verified';
  checks.push(check(checkedAt, {
    id: 'connector_revocation',
    status: connectorCommercialReady ? 'ready' : 'attention',
    summary: connectorCommercialReady
      ? 'Connector authorization is separate from sign-in identity, encrypted, tenant-scoped, and revocation-verified.'
      : connectorCanaryReady
        ? 'Connector authorization is executable for approved pilot test users; commercial OAuth verification remains incomplete.'
        : 'Connector disconnect is fail-closed until the dedicated connector OAuth broker is fully configured.',
    receipt_refs: [],
    source_refs: ['CONNECTOR_OAUTH_AUTHORITY_MODE', 'CONNECTOR_OAUTH_ENC_KEYS', 'CONNECTOR_OAUTH_STATE_KEY', 'DELETE /api/v1/sources/:id'],
    details: {
      authority_mode: connectorCanaryReady ? 'dedicated_google' : 'unproven_or_incomplete',
      encryption_ready: connectorEncryptionReady,
      provider_ready: connectorProviderReady,
      canary_ready: connectorCanaryReady,
      commercial_authorization_ready: connectorCommercialReady,
      oauth_verification_status: connectorVerificationStatus,
      disconnect_semantics: 'upstream_revoke_then_local_soft_disconnect',
      shared_grant_policy: 'retain_until_last_source_then_revoke',
      legacy_clerk_revocation_mode: ctx.env.CONNECTOR_OAUTH_REVOCATION_MODE || 'disabled',
    },
  }));

  const sentryActive = isSentryActive();
  checks.push(check(checkedAt, {
    id: 'telemetry',
    status: sentryActive ? 'ready' : 'attention',
    summary: sentryActive
      ? 'Error telemetry is active for this request runtime.'
      : 'An active error-telemetry client could not be verified for this request runtime.',
    receipt_refs: [],
    source_refs: ['sentry_active_probe'],
  }));

  try {
    const [evidence, lifecycleReceipt] = await Promise.all([
      gate.dal.listEvidenceItems(gate.ws, { limit: 100 }),
      verifyProductionLifecycleReceipt(ctx.env),
    ]);
    const boundedReceipts = evidence.filter((item) => item.kind === 'receipt');
    checks.push(check(checkedAt, {
      id: 'delete_export',
      status: lifecycleReceipt.verified ? 'ready' : 'attention',
      summary: lifecycleReceipt.verified
        ? 'A hash-pinned production object-storage, retention, legal-hold, and erasure receipt was verified.'
        : 'A hash-verified production lifecycle receipt is not available from the authoritative receipt store.',
      receipt_refs: lifecycleReceipt.verified
        ? [lifecycleReceipt.receiptId!, lifecycleReceipt.immutableReceiptRef!]
        : boundedReceipts.map((item) => item.id),
      source_refs: lifecycleReceipt.verified
        ? ['cloudflare_r2:LIFECYCLE_RECEIPTS', 'DELETE_EXPORT_RECEIPT_KEY', 'DELETE_EXPORT_RECEIPT_SHA256']
        : ['tenant_scoped_evidence_items_bounded_metadata'],
      details: {
        bounded_evidence_count: boundedReceipts.length,
        bounded_evidence: boundedReceipts.map((item) => ({
          id: item.id,
          content_hash: item.content_hash,
          created_at: item.created_at,
        })),
        production_live_receipt_authority: lifecycleReceipt.verified ? 'verified' : 'unavailable',
        structured_receipt_verified: lifecycleReceipt.verified,
        receipt_generated_at: lifecycleReceipt.generatedAt ?? null,
        verification_failure: lifecycleReceipt.verified ? null : lifecycleReceipt.reason,
        required_authority: 'hash-pinned Cloudflare R2 receipt with production lifecycle contract validation',
      },
    }));
  } catch {
    checks.push(check(checkedAt, {
      id: 'delete_export',
      status: 'unavailable',
      summary: 'Delete/export readiness evidence could not be verified.',
      receipt_refs: [],
      source_refs: ['tenant_scoped_evidence_items'],
    }));
  }

  const status: ReadinessStatus = checks.some((item) => item.status === 'unavailable')
    ? 'unavailable'
    : checks.some((item) => item.status === 'attention') ? 'attention' : 'ready';
  return ctx.json({
    schema_id: 'xlooop.settings_readiness.v1',
    status,
    checked_at: checkedAt,
    request_id: ctx.get('request_id'),
    checks,
  });
});
