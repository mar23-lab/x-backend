// policy-engine.test.ts
//
// Stage-2 A7 · unit tests for the pure governance policy evaluator (v0). The evaluator has no IO
// and is not wired into the write path, so it is exhaustively testable in isolation. Locks the
// three seed policy classes + the most-restrictive resolution order.
import { describe, it, expect } from 'vitest';
import {
  evaluateGovernedWrite, resolveDecision, POLICY_EVALUATORS,
  type GovernedWriteContext,
} from '../services/policy-engine';

describe('policy-engine v0', () => {
  describe('no-placeholder-semantics', () => {
    it('denies an empty-string metric_name', () => {
      const out = evaluateGovernedWrite({ action: 'goal.create', fields: { metric_name: '' } });
      expect(out.some((o) => o.policy_key === 'no-placeholder-semantics' && o.decision === 'deny')).toBe(true);
    });
    it('denies the empty/0 placeholder pair (the ABS-P2 incident shape)', () => {
      const out = evaluateGovernedWrite({ action: 'goal.create', fields: { metric_name: '', target_value: 0 } });
      expect(out.filter((o) => o.policy_key === 'no-placeholder-semantics').length).toBeGreaterThan(0);
    });
    it('allows a real metric name + target', () => {
      const out = evaluateGovernedWrite({ action: 'goal.create', fields: { metric_name: 'applications/Q', target_value: 12 } });
      expect(out.some((o) => o.policy_key === 'no-placeholder-semantics')).toBe(false);
    });
    it('ignores goals with no metric field (qualitative goal)', () => {
      const out = evaluateGovernedWrite({ action: 'goal.create', fields: { title: 'keep records discoverable' } });
      expect(out.some((o) => o.policy_key === 'no-placeholder-semantics')).toBe(false);
    });
  });

  describe('evidence-required-for-completion', () => {
    it('requires approval when completing without evidence', () => {
      const out = evaluateGovernedWrite({ action: 'goal.complete', fields: {} });
      expect(out.some((o) => o.policy_key === 'evidence-required-for-completion' && o.decision === 'require_approval')).toBe(true);
    });
    it('fires on a status=achieved write too', () => {
      const out = evaluateGovernedWrite({ action: 'goal.update', fields: { status: 'achieved' } });
      expect(out.some((o) => o.policy_key === 'evidence-required-for-completion')).toBe(true);
    });
    it('allows completion WITH an evidence ref', () => {
      const out = evaluateGovernedWrite({ action: 'goal.complete', fields: { evidence_ref_id: 'ev_123' } });
      expect(out.some((o) => o.policy_key === 'evidence-required-for-completion')).toBe(false);
    });
    it('allows completion with a non-empty evidence_refs array', () => {
      const out = evaluateGovernedWrite({ action: 'packet.signoff', fields: { evidence_refs: ['a'] } });
      expect(out.some((o) => o.policy_key === 'evidence-required-for-completion')).toBe(false);
    });
    it('does not fire on a non-completion write', () => {
      const out = evaluateGovernedWrite({ action: 'goal.create', fields: { status: 'active' } });
      expect(out.some((o) => o.policy_key === 'evidence-required-for-completion')).toBe(false);
    });
  });

  describe('archive-not-delete', () => {
    it('denies a hard delete', () => {
      const out = evaluateGovernedWrite({ action: 'document.delete', fields: { hard: true } });
      expect(out.some((o) => o.policy_key === 'archive-not-delete' && o.decision === 'deny')).toBe(true);
    });
    it('allows a soft delete', () => {
      const out = evaluateGovernedWrite({ action: 'document.delete', fields: {} });
      expect(out.some((o) => o.policy_key === 'archive-not-delete')).toBe(false);
    });
  });

  describe('activePolicyKeys filtering', () => {
    it('only evaluates active policies', () => {
      const out = evaluateGovernedWrite(
        { action: 'goal.create', fields: { metric_name: '' } },
        new Set(['evidence-required-for-completion']),  // no-placeholder NOT active
      );
      expect(out.some((o) => o.policy_key === 'no-placeholder-semantics')).toBe(false);
    });
    it('evaluates all evaluators when no active set is given (dry-run)', () => {
      expect(Object.keys(POLICY_EVALUATORS).length).toBe(3);
    });
  });

  describe('resolveDecision (most-restrictive)', () => {
    it('allow when nothing fired', () => {
      expect(resolveDecision([])).toBe('allow');
    });
    it('deny beats require_approval', () => {
      const ctx: GovernedWriteContext = { action: 'x' };
      void ctx;
      expect(resolveDecision([
        { policy_key: 'a', decision: 'require_approval', reason: '' },
        { policy_key: 'b', decision: 'deny', reason: '' },
      ])).toBe('deny');
    });
    it('require_approval beats redact', () => {
      expect(resolveDecision([
        { policy_key: 'a', decision: 'redact', reason: '' },
        { policy_key: 'b', decision: 'require_approval', reason: '' },
      ])).toBe('require_approval');
    });
  });
});
