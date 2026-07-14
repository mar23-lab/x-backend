// heartbeat.test.ts · AR-2.5 (260713) · proves the health-plane classifier kernel + writers (mig-072).
//
// The invariant that matters: the DEAD-MAN switch — a producer past its expires_at is `stale` even if it
// last reported `healthy` (it cannot self-certify liveness it no longer has). Plus rollup worst-of + the
// INSERT column shapes. Pure kernel + mock-`Sql` (same pattern as role-skill-resolution-store.test).

import { describe, it, expect } from 'vitest';
import {
  classifyHeartbeatStatus, rollupStatus, tallyStatuses, isAlerting,
  type HeartbeatStatus,
} from '../lib/heartbeat';
import { insertHeartbeatRow, insertHealthRollupRow } from '../dal/heartbeat-store';

const T0 = new Date('2026-07-13T00:00:00Z');
const FRESH_EXPIRY = new Date('2026-07-13T00:05:00Z'); // 5 min ahead
const PAST_EXPIRY = new Date('2026-07-12T23:59:00Z');  // 1 min behind

describe('classifyHeartbeatStatus — dead-man switch', () => {
  it('within the freshness window, passes the reported status through', () => {
    expect(classifyHeartbeatStatus({ reported: 'healthy', observed_at: T0, expires_at: FRESH_EXPIRY }, T0)).toBe('healthy');
    expect(classifyHeartbeatStatus({ reported: 'degraded', observed_at: T0, expires_at: FRESH_EXPIRY }, T0)).toBe('degraded');
    expect(classifyHeartbeatStatus({ reported: 'failed', observed_at: T0, expires_at: FRESH_EXPIRY }, T0)).toBe('failed');
  });

  it('DEAD-MAN: past expires_at → stale even if the producer reported healthy', () => {
    expect(classifyHeartbeatStatus({ reported: 'healthy', observed_at: PAST_EXPIRY, expires_at: PAST_EXPIRY }, T0)).toBe('stale');
  });

  it('expected_dark short-circuits everything (never an alert, even if stale)', () => {
    expect(classifyHeartbeatStatus({ reported: 'healthy', observed_at: PAST_EXPIRY, expires_at: PAST_EXPIRY, expected_dark: true }, T0)).toBe('expected_dark');
  });
});

describe('rollup — worst-of + tally + alerting', () => {
  it('worst status wins (failed > stale > degraded > healthy > expected_dark)', () => {
    expect(rollupStatus(['healthy', 'degraded', 'healthy'])).toBe('degraded');
    expect(rollupStatus(['healthy', 'stale', 'degraded'])).toBe('stale');
    expect(rollupStatus(['stale', 'failed'])).toBe('failed');
    expect(rollupStatus([])).toBe('expected_dark');
    expect(rollupStatus(['expected_dark', 'healthy'])).toBe('healthy');
  });

  it('tally counts by kind', () => {
    const t = tallyStatuses(['healthy', 'healthy', 'stale']);
    expect(t.healthy).toBe(2);
    expect(t.stale).toBe(1);
    expect(t.failed).toBe(0);
  });

  it('only stale + failed alert', () => {
    expect(isAlerting('stale')).toBe(true);
    expect(isAlerting('failed')).toBe(true);
    expect(isAlerting('degraded')).toBe(false);
    expect(isAlerting('expected_dark')).toBe(false);
  });
});

type Row = Record<string, any>;
function makeSql() {
  const calls: Array<{ query: string; values: any[] }> = [];
  const sql: any = (strings: TemplateStringsArray, ...values: any[]) => {
    calls.push({ query: strings.join(' ? ').replace(/\s+/g, ' ').trim(), values });
    return Promise.resolve([] as Row[]);
  };
  sql.calls = calls;
  return sql;
}

describe('insertHeartbeatRow / insertHealthRollupRow — INSERT shape', () => {
  it('heartbeat: hb_ id, platform scope binds NULL workspace_id, serializes internal_detail', async () => {
    const sql = makeSql();
    await insertHeartbeatRow(sql, {
      scope: 'platform', workspace_id: null, producer: 'api-worker', sequence: 7,
      observed_at: T0, expires_at: FRESH_EXPIRY, status: 'healthy',
      safe_summary: 'API worker healthy', internal_detail: { build: 'abc' },
    });
    const { query, values } = sql.calls[0];
    expect(query).toContain('INSERT INTO system_heartbeats');
    expect(query).toContain('internal_detail');
    expect(values[0]).toMatch(/^hb_/);
    expect(values).toContain(null);          // NULL workspace_id (platform)
    expect(values).toContain('healthy');
    expect(values).toContain(JSON.stringify({ build: 'abc' }));
  });

  it('rollup: hr_ id + the 5 count columns bound from tally', async () => {
    const sql = makeSql();
    const counts = tallyStatuses(['healthy', 'stale'] as HeartbeatStatus[]);
    await insertHealthRollupRow(sql, {
      scope: 'bridge', workspace_id: 'ws_1', status: 'stale', counts,
      window_start: T0, window_end: FRESH_EXPIRY, generated_at: FRESH_EXPIRY,
    });
    const { query, values } = sql.calls[0];
    expect(query).toContain('INSERT INTO health_rollups');
    expect(values[0]).toMatch(/^hr_/);
    expect(values).toContain('stale');
    expect(values).toContain(1); // healthy_count == 1 and stale_count == 1
  });
});
