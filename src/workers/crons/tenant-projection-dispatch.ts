import type { CronHandler } from './types';
import { dispatchTenantProjectionOutbox } from '../services/tenant-projection-queue';
import { envFlagTrue } from '../lib/env-flag';

const LOOP_NAME = 'tenant_projection_dispatch';

export const tenantProjectionDispatchCron: CronHandler = async (ctx) => {
  const startedAt = ctx.now();
  const enabled = envFlagTrue(ctx.env?.TENANT_PROJECTION_QUEUE_ENABLED);
  if (!ctx.projectionOutbox) {
    return {
      loop_name: LOOP_NAME,
      run_id: `tenant_projection_dispatch_${startedAt.toISOString()}`,
      actions_taken: 0,
      cost_ms: ctx.now().getTime() - startedAt.getTime(),
      status: enabled ? 'failed' : 'skipped',
      error: enabled ? 'projection_outbox_gateway_missing' : undefined,
      metadata: { enabled, claimed: 0, dispatched: 0 },
    };
  }
  const result = await dispatchTenantProjectionOutbox({
    enabled,
    gateway: ctx.projectionOutbox,
    queue: ctx.env?.TENANT_PROJECTION_QUEUE,
    now: startedAt,
  });
  return {
    loop_name: LOOP_NAME,
    run_id: `tenant_projection_dispatch_${startedAt.toISOString()}`,
    actions_taken: result.dispatched,
    cost_ms: ctx.now().getTime() - startedAt.getTime(),
    status: result.status === 'completed' ? 'completed' : result.status === 'skipped' ? 'skipped' : 'failed',
    error: result.error_code,
    metadata: { enabled, claimed: result.claimed, dispatched: result.dispatched },
  };
};
