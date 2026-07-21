import { describe, it, expect } from 'vitest';
import { personalizationMaterializeCron } from '../crons/personalization-materialize';
import type { CronHandlerContext } from '../crons/types';
import type {
  LearningSignalForMaterialization,
  UserPersonalizationProfileUpsert,
} from '../dal/personalization-materialize-store';

function mkCtx(over: {
  flag?: string;
  gatewayAbsent?: boolean;
  signals?: LearningSignalForMaterialization[];
  upserts?: UserPersonalizationProfileUpsert[];
  throwOnUpsertFor?: string;
}): CronHandlerContext {
  const upserts = over.upserts ?? [];
  return {
    dal: {} as never,
    now: () => new Date('2026-07-21T05:00:00.000Z'),
    cronExpression: '0 5 * * *',
    env: over.flag === undefined ? {} : { PERSONALIZATION_MATERIALIZE_ENABLED: over.flag },
    personalization: over.gatewayAbsent ? undefined : {
      listActiveSignals: async () => over.signals ?? [],
      upsertProfile: async (row) => {
        if (over.throwOnUpsertFor && row.user_id === over.throwOnUpsertFor) throw new Error('boom');
        upserts.push(row);
      },
    },
  } as unknown as CronHandlerContext;
}

const sig = (o: Partial<LearningSignalForMaterialization>): LearningSignalForMaterialization => ({
  id: 's1', workspace_id: 'ws1', user_id: 'u1', signal_kind: 'preference', signal_json: {},
  created_at: '2026-07-21T00:00:00.000Z', ...o,
});

describe('personalizationMaterializeCron — Y-wave MATERIALIZE (ADR-XB-012)', () => {
  it('flag OFF (default) ⇒ skipped, ZERO reads/writes (byte-inert)', async () => {
    let read = false;
    const ctx = mkCtx({}); // no flag
    (ctx.personalization as { listActiveSignals: () => Promise<[]> }).listActiveSignals = async () => { read = true; return []; };
    const r = await personalizationMaterializeCron(ctx);
    expect(r.status).toBe('skipped');
    expect(r.actions_taken).toBe(0);
    expect(read).toBe(false); // never read the gateway
  });

  it('flag ON but gateway unbound ⇒ skipped', async () => {
    const r = await personalizationMaterializeCron(mkCtx({ flag: 'true', gatewayAbsent: true }));
    expect(r.status).toBe('skipped');
    expect(r.metadata?.reason).toBe('personalization_gateway_unbound');
  });

  it('flag ON ⇒ folds each user\'s signals into one profile (grouped by workspace×user)', async () => {
    const upserts: UserPersonalizationProfileUpsert[] = [];
    const ctx = mkCtx({
      flag: 'TRUE', upserts,
      signals: [
        sig({ id: 'a', user_id: 'u1', signal_kind: 'preference', signal_json: { tone: 'concise' } }),
        sig({ id: 'b', user_id: 'u1', signal_kind: 'personal_skill', signal_json: { governed_shipping: true } }),
        sig({ id: 'c', user_id: 'u2', workspace_id: 'ws1', signal_kind: 'preference', signal_json: { tone: 'formal' } }),
      ],
    });
    const r = await personalizationMaterializeCron(ctx);
    expect(r.status).toBe('completed');
    expect(r.actions_taken).toBe(2); // 2 users → 2 profiles
    const u1 = upserts.find((u) => u.user_id === 'u1')!;
    expect(u1.preference_json).toEqual({ tone: 'concise' });
    expect(u1.personal_skills_json).toEqual({ governed_shipping: true });
    expect(u1.source_signal_ids.sort()).toEqual(['a', 'b']);
    expect(u1.role_key).toBe('member');
    expect(upserts.find((u) => u.user_id === 'u2')!.preference_json).toEqual({ tone: 'formal' });
  });

  it('a per-user upsert failure is isolated ⇒ degraded, the batch continues', async () => {
    const upserts: UserPersonalizationProfileUpsert[] = [];
    const r = await personalizationMaterializeCron(mkCtx({
      flag: 'true', upserts, throwOnUpsertFor: 'u1',
      signals: [sig({ id: 'a', user_id: 'u1' }), sig({ id: 'b', user_id: 'u2' })],
    }));
    expect(r.status).toBe('degraded');
    expect(r.actions_taken).toBe(1); // u2 succeeded
    expect(r.metadata?.users_errored).toBe(1);
  });
});
