import { Hono } from 'hono';
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';
import type { IntakeOperation } from '../dal/types';
import { envFlagTrue } from '../lib/env-flag';
import { authorizeSpineWrite } from '../lib/spine-authority';
import { buildIntakeResolution, type IntakeResolveRequest } from '../lib/intake-resolution';
import { errorEnvelope } from '../middleware/error';

interface IntakeEnv extends AuthEnv {
  DATABASE_URL: string;
  SINGLE_INTAKE_ENABLED?: string;
}

export const intakeRoute = new Hono<{ Bindings: IntakeEnv; Variables: AuthVariables & { dal: DalAdapter } }>();

function fail(ctx: any, status: 400 | 404 | 409, code: string, error: string) {
  ctx.status(status);
  return ctx.json({ error, code, request_id: ctx.get('request_id') });
}

async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

intakeRoute.post('/intake/resolve', async (ctx) => {
  try {
    if (!envFlagTrue(ctx.env.SINGLE_INTAKE_ENABLED)) return fail(ctx, 404, 'FEATURE_DISABLED', 'single intake is not enabled');
    const body = await ctx.req.json().catch(() => null) as IntakeResolveRequest | null;
    if (!body || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4000) {
      return fail(ctx, 400, 'VALIDATION_ERROR', 'text must be a non-empty string up to 4000 characters');
    }
    if (typeof body.client_request_id !== 'string' || !body.client_request_id.trim() || body.client_request_id.length > 160) {
      return fail(ctx, 400, 'VALIDATION_ERROR', 'client_request_id is required');
    }
    const { workspace_id, user_id } = ctx.get('auth');
    const [packets, approvals, createDecision, decideDecision] = await Promise.all([
      ctx.get('dal').listTaskPackets(workspace_id, { limit: 100 }),
      ctx.get('dal').listApprovalRequests(workspace_id, { limit: 100 }),
      authorizeSpineWrite(ctx as never, 'packet:create'),
      authorizeSpineWrite(ctx as never, 'approval:decide'),
    ]);
    const authorityFor = (operation: IntakeOperation) => {
      if (operation === 'create_work' || operation === 'continue_work') {
        return { allowed: createDecision.allowed, safe_reason: createDecision.reason };
      }
      if (operation === 'decide') return { allowed: decideDecision.allowed, safe_reason: decideDecision.reason };
      return { allowed: true, safe_reason: 'read_only_or_draft' };
    };
    const requestDigest = await digest(JSON.stringify({
      text: body.text.trim(),
      project_id: body.project_id ?? null,
      target: body.target ?? null,
    }));
    const input = buildIntakeResolution(body, requestDigest, { packets, approvals, authorityFor, now: new Date() });
    const resolution = await ctx.get('dal').createIntakeResolution(workspace_id, user_id, input);
    ctx.status(201);
    return ctx.json({ resolution });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});

intakeRoute.post('/intake/:resolution_id/execute', async (ctx) => {
  try {
    if (!envFlagTrue(ctx.env.SINGLE_INTAKE_ENABLED)) return fail(ctx, 404, 'FEATURE_DISABLED', 'single intake is not enabled');
    const body = await ctx.req.json().catch(() => null) as { version?: unknown; current_work_version?: unknown; client_request_id?: unknown } | null;
    if (!body || !Number.isInteger(body.version) || !Number.isInteger(body.current_work_version)
      || typeof body.client_request_id !== 'string' || !body.client_request_id.trim() || body.client_request_id.length > 160) {
      return fail(ctx, 400, 'VALIDATION_ERROR', 'version, current_work_version, and client_request_id are required');
    }
    const { workspace_id, user_id } = ctx.get('auth');
    const result = await ctx.get('dal').executeIntakeResolution(
      workspace_id,
      user_id,
      ctx.req.param('resolution_id'),
      Number(body.version),
      Number(body.current_work_version),
      body.client_request_id.trim(),
    );
    if (!result.ok) {
      const status = result.reason === 'not_found' ? 404 : 409;
      return fail(ctx, status, result.reason === 'not_found' ? 'NOT_FOUND' : 'CONFLICT', `intake execution ${result.reason}`);
    }
    return ctx.json(result);
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});
