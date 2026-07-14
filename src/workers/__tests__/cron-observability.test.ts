// cron-observability.test.ts · Safety floor SF-1 (260711) — the cron→Sentry reporting RULE.
// The dispatcher wiring (which sentry fn to call, the flush) is trivial; the load-bearing decision is
// "report a failing loop, stay quiet on routine outcomes" — pinned exhaustively here.

import { describe, it, expect } from 'vitest';
import { decideCronReport } from '../lib/cron-observability';

describe('decideCronReport — the silent-cron finding rule', () => {
  it('a thrown cron → exception finding', () => {
    expect(decideCronReport({ routed: true, threw: true, loopName: 'reclassify' }))
      .toMatchObject({ report: 'exception', kind: 'cron_threw' });
  });

  it("status 'failed' → message finding (error swallowed into the result envelope)", () => {
    const d = decideCronReport({ routed: true, resultStatus: 'failed', loopName: 'weight_retune' });
    expect(d.report).toBe('message');
    expect(d.kind).toBe('cron_failed_status');
    expect(d.message).toContain('weight_retune');
  });

  it("routine outcomes do NOT report (avoid alarm fatigue): completed / skipped / undefined", () => {
    for (const status of ['completed', 'skipped', undefined]) {
      expect(decideCronReport({ routed: true, resultStatus: status }))
        .toMatchObject({ report: null, kind: 'cron_ok' });
    }
  });

  it("OBS-1/OBS-2 (J-W3): 'degraded' (a partial/secondary-loop failure) DOES report", () => {
    const d = decideCronReport({ routed: true, resultStatus: 'degraded', loopName: 'permanent_suppress+graph_rebuild' });
    expect(d.report).toBe('message');
    expect(d.kind).toBe('cron_degraded_status');
  });

  it('an UNROUTED cron expression → message finding (misconfigured trigger is itself silent)', () => {
    const d = decideCronReport({ routed: false, cron: '7 7 7 7 7' });
    expect(d.report).toBe('message');
    expect(d.kind).toBe('cron_unrouted');
    expect(d.message).toContain('7 7 7 7 7');
  });

  it('a thrown cron outranks any status (throw wins over a stale result)', () => {
    expect(decideCronReport({ routed: true, threw: true, resultStatus: 'completed' }))
      .toMatchObject({ report: 'exception' });
  });
});
