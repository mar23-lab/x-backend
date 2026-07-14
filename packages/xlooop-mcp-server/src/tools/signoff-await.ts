// tools/signoff-await.ts · xlooop.signoff.await
//
// Long-poll a sign-off until the operator decides OR a timeout fires.
// Implemented as a client-side polling loop with exponential backoff so we
// don't need a special Worker endpoint — every poll hits the existing
// GET /api/v1/sign-offs/:id which returns the current status. The Worker
// is stateless and Neon is fast (~50ms warm); this is cheap.
//
// Why polling instead of WebSocket / SSE:
//   - Cloudflare Workers + Neon Postgres don't natively support PG LISTEN/NOTIFY
//     pass-through, so a true push requires Durable Objects (deferred to R48)
//   - For sign-off latency (operator clicks button), 1-2s poll is fine
//   - Simpler ops: no long-lived connection to debug

import { apiRequest } from '../api-client.js';
import type { SignOff } from '../types.js';
import { XlooopMcpError } from '../errors.js';

export const signoffAwaitDefinition = {
  name: 'xlooop.signoff.await',
  description:
    'Block until a sign-off is decided (approved/rejected/cancelled) or a timeout fires. ' +
    'Useful for blocking a Claude session until the operator approves a proposed action. ' +
    'Default poll interval 2s; default timeout 300s (5 min).',
  inputSchema: {
    type: 'object',
    properties: {
      sign_off_id: { type: 'string', description: 'Sign-off id from xlooop.signoff.create' },
      timeout_seconds: { type: 'integer', description: 'Max seconds to wait (default 300; clamped to [10, 3600])', minimum: 10, maximum: 3600 },
      poll_interval_seconds: { type: 'integer', description: 'Seconds between polls (default 2; clamped to [1, 30])', minimum: 1, maximum: 30 },
    },
    required: ['sign_off_id'],
    additionalProperties: false,
  },
} as const;

export async function signoffAwait(args: {
  sign_off_id: string;
  timeout_seconds?: number;
  poll_interval_seconds?: number;
}): Promise<SignOff> {
  const timeoutMs = Math.max(10, Math.min(args.timeout_seconds ?? 300, 3600)) * 1000;
  const intervalMs = Math.max(1, Math.min(args.poll_interval_seconds ?? 2, 30)) * 1000;
  const deadline = Date.now() + timeoutMs;

  let polls = 0;
  while (true) {
    polls += 1;
    // R44.1 H2 fix: bound each poll's request timeout by the remaining outer
    // deadline so a hung Worker can't make total wall-clock time exceed the
    // stated `timeout_seconds` contract.
    const remainingMs = Math.max(0, deadline - Date.now());
    if (remainingMs === 0) {
      throw new XlooopMcpError(
        'TIMEOUT',
        `sign-off ${args.sign_off_id} deadline reached before poll ${polls}`,
        { hint: 'Extend timeout_seconds or nudge the operator. The sign-off is NOT cancelled.' },
      );
    }
    const perPollTimeoutMs = Math.min(intervalMs * 2, remainingMs);
    const current = await apiRequest<SignOff>(
      `/api/v1/sign-offs/${encodeURIComponent(args.sign_off_id)}`,
      { method: 'GET', timeoutMs: perPollTimeoutMs },
    );
    if (current.status !== 'pending') {
      // Decided. Return current state.
      return current;
    }
    if (Date.now() + intervalMs >= deadline) {
      throw new XlooopMcpError(
        'TIMEOUT',
        `sign-off ${args.sign_off_id} still pending after ${polls} polls (${Math.round((Date.now() - (deadline - timeoutMs)) / 1000)}s)`,
        {
          hint: 'Either extend timeout_seconds, or nudge the operator. The sign-off is NOT cancelled — they can still approve later.',
        },
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
