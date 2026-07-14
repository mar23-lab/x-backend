import { Hono } from 'hono';
import { classifyActionIntent } from '../lib/action-intent';
import { envFlagTrue } from '../lib/env-flag';
import type { AuthEnv, AuthVariables } from '../middleware/auth';

type Env = AuthEnv & { ACTION_INTENT_SHADOW_ENABLED?: string };

export const actionIntentShadowRoute = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

actionIntentShadowRoute.post('/action-intent/shadow', async (ctx) => {
  if (!envFlagTrue(ctx.env.ACTION_INTENT_SHADOW_ENABLED)) {
    return ctx.json({ error: 'action-intent shadow is not enabled', code: 'FEATURE_DISABLED', request_id: ctx.get('request_id') }, 404);
  }
  const body = await ctx.req.json().catch(() => null) as { text?: unknown } | null;
  if (!body || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4000) {
    return ctx.json({ error: 'text must be a non-empty string <= 4000 chars', code: 'VALIDATION_ERROR', request_id: ctx.get('request_id') }, 400);
  }
  const classification = classifyActionIntent(body.text);
  console.log(JSON.stringify({
    kind: 'action_intent_shadow',
    workspace_id: ctx.get('auth').workspace_id,
    action_intent: classification.action_intent,
    confidence: classification.confidence,
    matched_rule: classification.matched_rule,
    input_length: body.text.length,
  }));
  return ctx.json({ classification, authority: 'advisory_shadow_only' });
});
