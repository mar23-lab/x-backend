// cron-registry-wrangler-parity.test.ts · J-E TASK 1 (260719) · the regression guard for the dead-cron class.
//
// WHY THIS EXISTS: pattern_suspend + shadow_eval were registered in CRON_REGISTRY with their OWN cron
// expressions ("30 4 * * *" / "15 5 * * *") that were NEVER declared in wrangler.toml [triggers]. Because
// scheduledHandler dispatches ONLY via CRON_BY_EXPRESSION[event.cron] and Cloudflare only ever sends a
// declared expression, those two §16.5 loops NEVER fired autonomously — a silent drift no gate caught.
// This test converts that class into a loud assertion: EVERY expression the registry claims to handle MUST
// be declared in wrangler.toml [triggers], and vice-versa (no orphan trigger with no handler).
//
// Runs in the NODE environment (registered in scripts/run-worker-test-batches.mjs nodeEnvironmentTests) so
// it can read the two source files. It parses text (not imports) to stay free of runtime side-effects.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** The cron expressions Cloudflare will actually fire — the `crons = [ ... ]` array under [triggers]. */
function wranglerTriggerExpressions(): string[] {
  const toml = readFileSync(resolve(repoRoot, 'wrangler.toml'), 'utf8');
  const triggersIdx = toml.indexOf('[triggers]');
  expect(triggersIdx).toBeGreaterThanOrEqual(0);
  const after = toml.slice(triggersIdx);
  const arrayMatch = after.match(/crons\s*=\s*\[([\s\S]*?)\]/);
  expect(arrayMatch).not.toBeNull();
  // Strip line comments (# ...) then pull every quoted cron expression.
  const body = arrayMatch![1].replace(/#[^\n]*/g, '');
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** The cron expressions CRON_REGISTRY registers a handler for — the `cron: '<expr>'` literals. Those are the
 *  ONLY `cron: '...'` occurrences in the file, so the regex captures exactly the registry keys. */
function registryExpressions(): string[] {
  const src = readFileSync(resolve(repoRoot, 'src/workers/crons/index.ts'), 'utf8');
  return [...src.matchAll(/cron:\s*'([^']+)'/g)].map((m) => m[1]);
}

describe('cron registry ↔ wrangler.toml [triggers] parity', () => {
  it('declares no duplicate expressions on either side', () => {
    const wrangler = wranglerTriggerExpressions();
    const registry = registryExpressions();
    expect(new Set(wrangler).size).toBe(wrangler.length);
    expect(new Set(registry).size).toBe(registry.length);
  });

  it('every registered cron expression is declared in wrangler.toml (no dead-registered loop)', () => {
    const wrangler = new Set(wranglerTriggerExpressions());
    const registry = registryExpressions();
    const undeclared = registry.filter((c) => !wrangler.has(c));
    expect(undeclared, `registry expressions absent from wrangler [triggers] (they would NEVER fire): ${undeclared.join(', ')}`).toEqual([]);
  });

  it('every wrangler trigger has a registry handler (no orphan trigger)', () => {
    const registry = new Set(registryExpressions());
    const wrangler = wranglerTriggerExpressions();
    const unhandled = wrangler.filter((c) => !registry.has(c));
    expect(unhandled, `wrangler triggers with no CRON_REGISTRY handler: ${unhandled.join(', ')}`).toEqual([]);
  });

  it('the two sets are identical (1:1)', () => {
    expect([...registryExpressions()].sort()).toEqual([...wranglerTriggerExpressions()].sort());
  });
});
