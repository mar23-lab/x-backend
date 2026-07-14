// policy-engine-shadow.test.ts
//
// Stage-2 A7 · unit tests for the flag-gated SHADOW wiring of the policy engine (policy-shadow.ts).
// Locks the byte-identical-off contract (flag off ⇒ evaluator NEVER runs, NOTHING is logged), the
// flag-on observe behavior (one policy_shadow_decision log per fired outcome, write proceeds), and
// the never-throw guarantee. emitEvent is console.log-based, so we spy on console.log and parse it.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { observePolicyShadow, policyEngineEnabled } from '../lib/policy-shadow';

const ON = { POLICY_ENGINE_ENABLED: 'true' };
const OFF = {}; // flag unset

/** Capture the policy_shadow_decision events emitted via emitEvent -> console.log(JSON). */
function captureShadow(fn: () => void): Array<Record<string, unknown>> {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    fn();
    return spy.mock.calls
      .map((c) => { try { return JSON.parse(String(c[0])); } catch { return null; } })
      .filter((o): o is Record<string, unknown> => !!o && o.kind === 'policy_shadow_decision');
  } finally {
    spy.mockRestore();
  }
}

describe('policy-engine shadow wiring (A7)', () => {
  afterEach(() => vi.restoreAllMocks());

  describe('policyEngineEnabled', () => {
    it('reads the flag via envFlagTrue (true / "true" / unset / off)', () => {
      expect(policyEngineEnabled({ POLICY_ENGINE_ENABLED: 'true' })).toBe(true);
      expect(policyEngineEnabled({ POLICY_ENGINE_ENABLED: '"true"' })).toBe(true);
      expect(policyEngineEnabled({ POLICY_ENGINE_ENABLED: 'false' })).toBe(false);
      expect(policyEngineEnabled({})).toBe(false);
      expect(policyEngineEnabled(undefined)).toBe(false);
    });
  });

  describe('flag OFF ⇒ byte-identical no-op', () => {
    it('emits NOTHING even for a payload that would deny', () => {
      const events = captureShadow(() =>
        observePolicyShadow(OFF, { action: 'goal.create', fields: { metric_name: '', target_value: 0 }, role: 'operator' }));
      expect(events).toHaveLength(0);
    });
    it('does not throw', () => {
      expect(() => observePolicyShadow(OFF, { action: 'goal.create', fields: {}, role: 'operator' })).not.toThrow();
    });
  });

  describe('flag ON ⇒ observe (never enforces)', () => {
    it('emits a deny outcome for the ABS-P2 placeholder pair (metric_name="" + target 0)', () => {
      const events = captureShadow(() =>
        observePolicyShadow(ON, { action: 'goal.create', fields: { metric_name: '', target_value: 0 }, role: 'operator' }, { domain_id: 'd1' }));
      expect(events.length).toBeGreaterThanOrEqual(1);
      const deny = events.find((e) => e.policy_key === 'no-placeholder-semantics');
      expect(deny).toBeTruthy();
      expect(deny!.decision).toBe('deny');
      expect(deny!.action).toBe('goal.create');
      expect(deny!.domain_id).toBe('d1'); // meta is carried through
    });

    it('emits require_approval for a completion with no evidence ref', () => {
      const events = captureShadow(() =>
        observePolicyShadow(ON, { action: 'goal.complete', fields: { status: 'achieved' }, role: 'operator' }, { goal_id: 'g1' }));
      const req = events.find((e) => e.policy_key === 'evidence-required-for-completion');
      expect(req).toBeTruthy();
      expect(req!.decision).toBe('require_approval');
      expect(req!.goal_id).toBe('g1');
    });

    it('emits NOTHING for a clean create payload (no policy fires)', () => {
      const events = captureShadow(() =>
        observePolicyShadow(ON, { action: 'goal.create', fields: { metric_name: 'ARR', target_value: 100000 }, role: 'operator' }));
      expect(events).toHaveLength(0);
    });

    it('emits NOTHING for a completion that carries an evidence ref', () => {
      const events = captureShadow(() =>
        observePolicyShadow(ON, { action: 'goal.complete', fields: { status: 'done', evidence_ref_id: 'ev_123' }, role: 'operator' }));
      expect(events).toHaveLength(0);
    });

    it('never throws even if the log sink itself throws', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => { throw new Error('sink down'); });
      try {
        expect(() =>
          observePolicyShadow(ON, { action: 'goal.create', fields: { metric_name: '', target_value: 0 }, role: 'operator' })).not.toThrow();
      } finally {
        spy.mockRestore();
      }
    });
  });
});
