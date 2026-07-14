import { describe, it, expect } from 'vitest';
import { evaluateCompletion, type CompletionInput } from '../lib/completion-contract';

// A fully-satisfied contract; each test flips one field to prove the corresponding unmet reason fires.
const PASS: CompletionInput = {
  hasRequestedOutput: true,
  acceptanceCriteriaRequired: true,
  acceptanceCriteriaPass: true,
  evidenceRequired: true,
  evidenceAttachedCount: 3,
  executionFinished: true,
  openBlockerCount: 0,
  blockersExplicitlyAccepted: false,
  approvalRequired: true,
  approvalPresent: true,
  approvedVersion: 6,
  currentVersion: 6,
  receiptPresent: true,
  planProjectionUpdated: true,
};

describe('completion-contract · evaluateCompletion (PURE Definition-of-Done gate)', () => {
  it('passes when all nine preconditions are satisfied', () => {
    const v = evaluateCompletion(PASS);
    expect(v.can_complete).toBe(true);
    expect(v.unmet).toEqual([]);
  });

  it('blocks when the requested output does not exist', () => {
    const v = evaluateCompletion({ ...PASS, hasRequestedOutput: false });
    expect(v.can_complete).toBe(false);
    expect(v.unmet.join(' ')).toMatch(/requested output/);
  });

  it('blocks on failed acceptance criteria only when required', () => {
    expect(evaluateCompletion({ ...PASS, acceptanceCriteriaPass: false }).can_complete).toBe(false);
    // not required ⇒ the failed flag is ignored
    expect(
      evaluateCompletion({ ...PASS, acceptanceCriteriaRequired: false, acceptanceCriteriaPass: false })
        .can_complete,
    ).toBe(true);
  });

  it('blocks when required evidence is missing (counts-only)', () => {
    expect(evaluateCompletion({ ...PASS, evidenceAttachedCount: 0 }).can_complete).toBe(false);
    // not required ⇒ zero evidence is fine
    expect(evaluateCompletion({ ...PASS, evidenceRequired: false, evidenceAttachedCount: 0 }).can_complete).toBe(true);
  });

  it('blocks while execution has not finished', () => {
    expect(evaluateCompletion({ ...PASS, executionFinished: false }).can_complete).toBe(false);
  });

  it('blocks on an open, non-accepted blocker but allows an explicitly-accepted one', () => {
    expect(evaluateCompletion({ ...PASS, openBlockerCount: 1 }).can_complete).toBe(false);
    expect(
      evaluateCompletion({ ...PASS, openBlockerCount: 1, blockersExplicitlyAccepted: true }).can_complete,
    ).toBe(true);
  });

  it('blocks on missing approval and on a stale approval version', () => {
    expect(evaluateCompletion({ ...PASS, approvalPresent: false }).can_complete).toBe(false);
    const stale = evaluateCompletion({ ...PASS, approvedVersion: 5, currentVersion: 6 });
    expect(stale.can_complete).toBe(false);
    expect(stale.unmet.join(' ')).toMatch(/stale/);
    // approval not required ⇒ version mismatch is irrelevant
    expect(
      evaluateCompletion({ ...PASS, approvalRequired: false, approvalPresent: false, approvedVersion: null })
        .can_complete,
    ).toBe(true);
  });

  it('blocks when no receipt exists', () => {
    expect(evaluateCompletion({ ...PASS, receiptPresent: false }).can_complete).toBe(false);
  });

  it('blocks when the plan projection has not been updated', () => {
    expect(evaluateCompletion({ ...PASS, planProjectionUpdated: false }).can_complete).toBe(false);
  });

  it('accumulates every unmet reason (not fail-fast)', () => {
    const v = evaluateCompletion({
      ...PASS,
      hasRequestedOutput: false,
      executionFinished: false,
      receiptPresent: false,
    });
    expect(v.unmet.length).toBe(3);
  });
});
