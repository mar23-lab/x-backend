import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../lib/assistant-context-lineage', () => ({
  persistAssistantContextLineage: vi.fn(async () => ({
    context_packet_id: 'context_packet_1',
    resolution_id: 'policy_resolution_1',
    action: 'assistant:answer',
    resolution: { selected_skills: [{ key: 'customer-answer', version: '1' }] },
  })),
  completeAssistantSkillLineage: vi.fn(async () => ['skill_receipt_1']),
}));

vi.mock('../lib/model-execution-lineage', () => ({
  createModelExecutionObserver: vi.fn(() => ({
    start: vi.fn(async () => ({
      receipt_id: 'execution_receipt_1',
      complete: vi.fn(async () => undefined),
    })),
  })),
}));

import { customerChatRoute } from '../routes/customer-chat';

const AUTH = { user_id: 'user_a', workspace_id: 'workspace_a', role: 'member' };

function dal() {
  const captured: Array<Record<string, unknown>> = [];
  return {
    captured,
    getSessionEntitlement: async () => ({ state: 'approved_workspace' }),
    listEvents: async () => ({ events: [], pagination: { has_more: false, next_before: null } }),
    countEventStates: async () => ({ needs_you: 0, blocked: 0, done: 0, total: 0 }),
    listUserSources: async () => [],
    getCustomerContextProfile: async () => null,
    modelRuntimes: {
      listProviders: async () => [], getOverride: async () => null, getProviderCredential: async () => null,
    },
    appendChatExchange: async (_userId: string, _scope: unknown, messages: Array<Record<string, unknown>>) => {
      captured.push(...messages);
      return {
        thread_id: 'thread_1',
        messages: messages.map((message, index) => ({
          ...message,
          id: `message_${index + 1}`,
          thread_id: 'thread_1',
          receipt_uid: index === 1 ? 'answer_receipt_1' : null,
          created_at: '2026-08-09T00:00:00Z',
        })),
      };
    },
  };
}

function appFor(currentDal: ReturnType<typeof dal>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'request_1');
    ctx.set('auth', AUTH as never);
    ctx.set('dal', currentDal as never);
    ctx.set('sql', (() => Promise.resolve([])) as never);
    await next();
  });
  app.route('/api/v1', customerChatRoute);
  return app;
}

describe('POST /api/v1/chat/turns', () => {
  it('is live-only, ignores legacy llm authority, persists lineage, and declares streaming deferred', async () => {
    const currentDal = dal();
    const aiRun = vi.fn(async () => ({
      response: 'A live Workers AI answer grounded in the current tenant context and policy.',
      usage: { prompt_tokens: 12, completion_tokens: 10 },
    }));
    const res = await appFor(currentDal).request('/api/v1/chat/turns', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'What should I do next?', llm: 'claude' }),
    }, {
      DATABASE_URL: 'postgres://test', AI: { run: aiRun }, ROLE_SKILL_CATALOG_ENABLED: 'true',
      CUSTOMER_SAFE_SERIALIZER_ENABLED: 'false',
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;
    expect(body.schema_id).toBe('xlooop.chat_turn.v1');
    expect(body.generated_by).toBe('llm');
    expect(body).not.toHaveProperty('llm_requested');
    expect(body).not.toHaveProperty('claude_available');
    expect(body.preference_disposition.legacy_llm).toBe('ignored');
    expect(body.receipts).toEqual({
      answer_receipt_id: 'answer_receipt_1',
      execution_receipt_id: 'execution_receipt_1',
      context_receipt_id: 'context_packet_1',
      policy_resolution_id: 'policy_resolution_1',
      audit_event_id: null,
      skill_invocation_receipt_ids: ['skill_receipt_1'],
    });
    expect(body.receipts).not.toHaveProperty('audit_receipt_id');
    expect(body.streaming).toMatchObject({ status: 'deferred' });
    expect(aiRun).toHaveBeenCalledTimes(1);
    expect(currentDal.captured[1]).toMatchObject({
      resolution_id: 'policy_resolution_1',
      execution_receipt_id: 'execution_receipt_1',
      packet_id: 'context_packet_1',
    });
  });

  it('returns typed 503 with no assistant answer when no live runtime exists', async () => {
    const res = await appFor(dal()).request('/api/v1/chat/turns', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'What should I do next?' }),
    }, { DATABASE_URL: 'postgres://test', ROLE_SKILL_CATALOG_ENABLED: 'true' } as never);
    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    expect(body).not.toHaveProperty('answer');
  });
});
