// source-tier.test.ts · D-16 (260710) · the pure trust-tier resolver.
// DECLARED AXES: read_policy → tier mapping [metadata_only·read_only·proposal_only·unknown·null] ·
// rank ordering · effectiveTier = max across a source's project bindings · empty ⇒ index.

import { describe, it, expect } from 'vitest';
import { readPolicyToTier, tierRank, effectiveTier, tierLabel } from '../services/source-tier';

describe('readPolicyToTier — the 016 read_policy values are the L1/L2/L3 tiers', () => {
  it('maps the three existing policy values + defaults unknown/null to index', () => {
    expect(readPolicyToTier('metadata_only')).toBe('index');
    expect(readPolicyToTier('read_only')).toBe('rely');
    expect(readPolicyToTier('proposal_only')).toBe('operate');
    expect(readPolicyToTier('nonsense')).toBe('index');
    expect(readPolicyToTier(null)).toBe('index');
    expect(readPolicyToTier(undefined)).toBe('index');
  });
});

describe('tierRank — index < rely < operate', () => {
  it('orders correctly', () => {
    expect(tierRank('index')).toBe(0);
    expect(tierRank('rely')).toBe(1);
    expect(tierRank('operate')).toBe(2);
  });
});

describe('effectiveTier — MAX across a source\'s project bindings', () => {
  it('a source Rely in ANY project is Rely workspace-wide', () => {
    expect(effectiveTier(['metadata_only', 'read_only', 'metadata_only'])).toBe('rely');
  });
  it('operate wins over rely wins over index', () => {
    expect(effectiveTier(['read_only', 'proposal_only'])).toBe('operate');
    expect(effectiveTier(['metadata_only', 'metadata_only'])).toBe('index');
  });
  it('empty ⇒ index (the safe default)', () => {
    expect(effectiveTier([])).toBe('index');
    expect(effectiveTier([null, undefined, ''])).toBe('index');
  });
});

describe('tierLabel', () => {
  it('renders a human label per tier', () => {
    expect(tierLabel('index')).toContain('Index');
    expect(tierLabel('rely')).toContain('Rely');
    expect(tierLabel('operate')).toContain('Operate');
  });
});
