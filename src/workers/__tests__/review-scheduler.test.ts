// review-scheduler.test.ts
//
// Stage-2 A10 · unit tests for the pure review-cadence kernel (v0). Isolated, no IO — locks the
// cadence->days map, next-due math, due-selection (most-overdue-first, null review_due excluded),
// and reschedule-to-future-slot.
import { describe, it, expect } from 'vitest';
import {
  cadenceToDays, nextReviewDue, selectDueReviews, rescheduleReviewDue,
} from '../services/review-scheduler';

describe('review-scheduler v0', () => {
  describe('cadenceToDays', () => {
    it('maps MB-P cadences from free text', () => {
      expect(cadenceToDays('weekly health closeout or fatigue signal')).toBe(7);
      expect(cadenceToDays('monthly finance/career closeout')).toBe(30);
      expect(cadenceToDays('quarterly re-evaluation')).toBe(90);
      expect(cadenceToDays('daily')).toBe(1);
      expect(cadenceToDays('annual review')).toBe(365);
    });
    it('returns null for event-only / null cadences', () => {
      expect(cadenceToDays('on material opportunity change')).toBeNull();
      expect(cadenceToDays(null)).toBeNull();
      expect(cadenceToDays('')).toBeNull();
    });
  });

  describe('nextReviewDue', () => {
    it('adds the cadence interval', () => {
      const next = nextReviewDue('weekly', new Date('2026-07-13T00:00:00Z'));
      expect(next?.toISOString().slice(0, 10)).toBe('2026-07-20');
    });
    it('null for event-only cadence', () => {
      expect(nextReviewDue('when a blocker appears', new Date('2026-07-13T00:00:00Z'))).toBeNull();
    });
  });

  describe('selectDueReviews', () => {
    const now = new Date('2026-07-13T00:00:00Z');
    it('selects only goals whose review_due has passed', () => {
      const due = selectDueReviews([
        { id: 'a', review_cadence: 'weekly', review_due: '2026-07-01' }, // overdue
        { id: 'b', review_cadence: 'monthly', review_due: '2026-08-01' }, // future
        { id: 'c', review_cadence: 'weekly', review_due: null },          // unscheduled
        { id: 'd', review_cadence: 'quarterly', review_due: '2026-07-13' }, // due today
      ], now);
      expect(due.map((d) => d.goal_id).sort()).toEqual(['a', 'd']);
    });
    it('orders most-overdue first + computes overdue_days', () => {
      const due = selectDueReviews([
        { id: 'a', review_cadence: 'weekly', review_due: '2026-07-11' }, // 2 days
        { id: 'b', review_cadence: 'weekly', review_due: '2026-06-13' }, // 30 days
      ], now);
      expect(due[0]!.goal_id).toBe('b');
      expect(due[0]!.overdue_days).toBe(30);
      expect(due[1]!.overdue_days).toBe(2);
    });
    it('carries the resolved cadence_days', () => {
      const due = selectDueReviews([{ id: 'a', review_cadence: 'monthly review', review_due: '2026-07-01' }], now);
      expect(due[0]!.cadence_days).toBe(30);
    });
    it('empty when nothing is due', () => {
      expect(selectDueReviews([{ id: 'a', review_cadence: 'weekly', review_due: '2027-01-01' }], now)).toHaveLength(0);
    });
  });

  describe('rescheduleReviewDue', () => {
    it('advances to the next slot after now', () => {
      expect(rescheduleReviewDue('weekly', new Date('2026-07-13T00:00:00Z'))).toBe('2026-07-20');
    });
    it('null for event-only cadence (not auto-rescheduled)', () => {
      expect(rescheduleReviewDue('on demand', new Date('2026-07-13T00:00:00Z'))).toBeNull();
    });
  });
});
