// ugec-fence.test.ts · ADR-XB-008 gap-2 — the fence decision unit, RED/GREEN both directions.
import { describe, expect, it } from 'vitest';
import { evaluateUgecFence } from '../lib/ugec-fence';

describe('evaluateUgecFence', () => {
  it('passes an in-scope packet with an allowed action', () => {
    expect(evaluateUgecFence({
      packet_id: 'org-acme-pkt-1',
      packet_prefix: 'org-acme',
      allowed_tools: ['submit_evidence', 'report_tool_event'],
      forbidden_tools: [],
      action: 'submit_evidence',
    })).toEqual([]);
  });

  it('flags a packet outside the token packet_prefix scope', () => {
    expect(evaluateUgecFence({
      packet_id: 'org-other-pkt-9',
      packet_prefix: 'org-acme',
      action: 'submit_evidence',
      allowed_tools: ['submit_evidence'],
    })).toEqual(['packet_prefix_scope']);
  });

  it('flags a forbidden tool even when it is also on the allow-list', () => {
    expect(evaluateUgecFence({
      packet_id: 'p1',
      allowed_tools: ['secret_access'],
      forbidden_tools: ['secret_access'],
      action: 'secret_access',
    })).toEqual(['forbidden_tool']);
  });

  it('flags an action missing from a declared allow-list', () => {
    expect(evaluateUgecFence({
      packet_id: 'p1',
      allowed_tools: ['submit_evidence'],
      action: 'report_tool_event',
    })).toEqual(['tool_not_in_allowed']);
  });

  it('does not fence actions when the packet declares no allow-list', () => {
    expect(evaluateUgecFence({
      packet_id: 'p1',
      allowed_tools: [],
      forbidden_tools: [],
      action: 'report_tool_event',
    })).toEqual([]);
  });

  it('skips the action fence for non-tool writes (no action supplied)', () => {
    expect(evaluateUgecFence({
      packet_id: 'p1',
      allowed_tools: ['submit_evidence'],
    })).toEqual([]);
  });

  it('accumulates prefix + tool violations together', () => {
    expect(evaluateUgecFence({
      packet_id: 'zzz-1',
      packet_prefix: 'org-acme',
      allowed_tools: ['a'],
      action: 'b',
    })).toEqual(['packet_prefix_scope', 'tool_not_in_allowed']);
  });

  it('treats an empty/blank prefix as unscoped', () => {
    expect(evaluateUgecFence({ packet_id: 'anything', packet_prefix: '  ', action: '' })).toEqual([]);
  });
});
