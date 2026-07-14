// session-env-flag.test.ts · 260628 · envFlagTrue dashboard-flag tolerance
// The Cloudflare dashboard stores Text env values literally, so an operator who
// enters `"true"` (with surrounding quotes) when flipping a flag would otherwise
// defeat a strict `=== 'true'` check. This guards the CUSTOMER_INAPP_READINESS_GATE
// flip (M.7 / Part O.3): the deployed value `"true"` MUST read as true so the
// readiness journey activates. Quote/whitespace/case tolerant; nothing else loosened.

import { describe, it, expect } from 'vitest';
import { envFlagTrue } from '../lib/env-flag';

describe('envFlagTrue · dashboard-flag tolerance', () => {
  it('reads canonical unquoted true', () => {
    expect(envFlagTrue('true')).toBe(true);
  });

  it('tolerates double-quotes — the exact 260628 readiness-gate flip', () => {
    expect(envFlagTrue('"true"')).toBe(true);
  });

  it('tolerates single-quotes, surrounding whitespace, and case', () => {
    expect(envFlagTrue("'true'")).toBe(true);
    expect(envFlagTrue('  true  ')).toBe(true);
    expect(envFlagTrue('"true" ')).toBe(true);
    expect(envFlagTrue('TRUE')).toBe(true);
    expect(envFlagTrue('"TRUE"')).toBe(true);
  });

  it('stays false for off / unset / non-true values (no over-loosening)', () => {
    expect(envFlagTrue('false')).toBe(false);
    expect(envFlagTrue('"false"')).toBe(false);
    expect(envFlagTrue('')).toBe(false);
    expect(envFlagTrue(undefined)).toBe(false);
    expect(envFlagTrue('1')).toBe(false);
    expect(envFlagTrue('yes')).toBe(false);
    expect(envFlagTrue('truthy')).toBe(false);
  });
});
