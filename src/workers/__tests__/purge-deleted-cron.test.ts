// purge-deleted-cron.test.ts · F3 (260628) · the customer self-service rollback purge cron.
// Pins: default-OFF (zero DB writes), enables on the flag with the 30-day window, the quote-bug
// lesson applied (a quoted "true" still enables), and never-throws on a DB error.
// The SCOPE guard (source_tool='xlooop' — governance events never hard-purged) is enforced in the
// DAL SQL (purgeArchivedXlooopEventsRow); the cron correctly delegates to that scoped method.

import { describe, it, expect, vi } from 'vitest';
import { purgeDeletedCron } from '../crons/purge-deleted';

function makeCtx(env: Record<string, string>, purgeImpl?: () => Promise<{ deleted: number }>) {
  const purgeArchivedXlooopEvents = vi.fn(purgeImpl ?? (async () => ({ deleted: 3 })));
  return {
    ctx: {
      dal: { purgeArchivedXlooopEvents } as never,
      now: () => new Date('2026-06-28T04:00:00Z'),
      cronExpression: '0 4 * * *',
      env,
    },
    purgeArchivedXlooopEvents,
  };
}

describe('purgeDeletedCron · F3 (flag-gated rollback purge)', () => {
  it('flag off (default) → skipped, ZERO DB writes', async () => {
    const { ctx, purgeArchivedXlooopEvents } = makeCtx({});
    const r = await purgeDeletedCron(ctx);
    expect(r.status).toBe('skipped');
    expect(purgeArchivedXlooopEvents).not.toHaveBeenCalled();
  });

  it('flag on → purges with the 30-day window (ROLLBACK_WINDOW_DAYS)', async () => {
    const { ctx, purgeArchivedXlooopEvents } = makeCtx({ PURGE_DELETED_ENABLED: 'true' });
    const r = await purgeDeletedCron(ctx);
    expect(r.status).toBe('completed');
    expect(r.actions_taken).toBe(3);
    expect(purgeArchivedXlooopEvents).toHaveBeenCalledWith(30);
  });

  it('quoted "true" still enables (envFlagTrue — the quote-bug lesson applied to this flag)', async () => {
    const { ctx, purgeArchivedXlooopEvents } = makeCtx({ PURGE_DELETED_ENABLED: '"true"' });
    const r = await purgeDeletedCron(ctx);
    expect(r.status).toBe('completed');
    expect(purgeArchivedXlooopEvents).toHaveBeenCalledWith(30);
  });

  it('DB error → status failed, never throws', async () => {
    const { ctx } = makeCtx({ PURGE_DELETED_ENABLED: 'true' }, async () => { throw new Error('db down'); });
    const r = await purgeDeletedCron(ctx);
    expect(r.status).toBe('failed');
    expect(r.error).toContain('db down');
  });
});
