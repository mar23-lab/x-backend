#!/usr/bin/env node
/**
 * verify-rate-limit-binding-parity
 *
 * A rate-limit bucket whose Cloudflare binding is not declared does NOT fail. It silently falls
 * back to `checkFallbackBucket` — a per-isolate `Map` that the source itself labels
 * "Per-isolate; not shared. For local dev only." In production that means the effective limit is
 * (limit x isolate count), i.e. no meaningful cap, and NOTHING says so: `checkBucket` returns
 * `{ binding: 'fallback' }` and every caller discards the field.
 *
 * Measured 260731 before this gate existed:
 *
 *   referenced by code : RATE_LIMITER_SIGNUP, CHAT, READINESS, IP, USER, TENANT
 *   declared in wrangler: RATE_LIMITER_SIGNUP, CHAT, READINESS
 *   -> USER and TENANT ran on the dev-only fallback on every authenticated request
 *
 * The trap that hides it: `rateLimit()` merges DEFAULT_CONFIG over every mount, so a mount that
 * only sets `routeBucket` STILL evaluates the user and tenant buckets. "No mount configures them"
 * is therefore false — they are always live, just never bound.
 *
 * Reports the SET DIFFERENCE in both directions, never a count: an equal-cardinality mismatch is
 * exactly the shape a cardinality check cannot see.
 *
 * Exit: 0 parity holds · 1 a referenced binding is undeclared · 2 CANNOT MEASURE (inputs missing
 * or unparseable) — because a detector that goes quiet reproduces the defect it exists to catch.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const SOURCES = [
  'src/workers/middleware/rate-limit.ts',
  'src/workers/index.ts',
];
const WRANGLER = 'wrangler.toml';

/**
 * Strip comments before extracting.
 *
 * The first run of this gate reported RATE_LIMITER_ADMIN as an undeclared binding. It is not a
 * binding — it is an example inside the JSDoc above `rateLimit()`. A detector that reads prose as
 * code is the same false-positive shape `verify-people-seams` had to solve (live-data.js describes
 * its own bug in a comment), and it would have sent someone to declare a binding nothing uses.
 *
 * Line-anchored on purpose: blanket `//`-to-EOL stripping would mangle `https://` inside real code
 * strings. Only lines that BEGIN a comment are dropped.
 */
export function stripComments(text) {
  // Every comment boundary is LINE-ANCHORED. A blanket /\*…\*\// sweep silently ate real mounts
  // here, because the route glob '/readiness/*' contains `/*` and opened a comment span that ran
  // to the next `*/` — the gate then reported CHAT/READINESS/SIGNUP as "declared but never
  // referenced", which was the detector damaging its own input. Same lesson as the JSDoc match
  // above, one layer deeper: a stripper is a parser, and a sloppy parser fabricates findings.
  const out = [];
  let inBlock = false;
  for (const line of String(text).split('\n')) {
    const t = line.trimStart();
    if (inBlock) {
      if (t.includes('*/')) inBlock = false;
      continue;
    }
    if (t.startsWith('/*')) {
      if (!t.includes('*/')) inBlock = true;
      continue;
    }
    if (t.startsWith('//') || t.startsWith('*')) continue;
    out.push(line);
  }
  return out.join('\n');
}

/** Every `bindingName: 'X'` referenced by real code (comments excluded). */
export function referencedBindings(text) {
  const found = new Set();
  for (const m of stripComments(text).matchAll(/bindingName\s*:\s*['"]([A-Z0-9_]+)['"]/g)) found.add(m[1]);
  return found;
}

/** Every ratelimit binding actually declared to Cloudflare. */
export function declaredBindings(tomlText) {
  const found = new Set();
  // [[unsafe.bindings]] blocks — the ONLY form wrangler 4.x recognises for ratelimit (a bare
  // top-level [[ratelimit]] parses but the binding never appears; corrected Wave M-B 260719).
  const blocks = String(tomlText).split(/\[\[unsafe\.bindings\]\]/).slice(1);
  for (const block of blocks) {
    const head = block.split('[[')[0];
    if (!/type\s*=\s*['"]ratelimit['"]/.test(head)) continue;
    const name = head.match(/name\s*=\s*['"]([A-Z0-9_]+)['"]/);
    if (name) found.add(name[1]);
  }
  return found;
}

function cannotMeasure(reason) {
  console.error(`verify-rate-limit-binding-parity · CANNOT MEASURE · ${reason}`);
  process.exit(2);
}

const IS_MAIN = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (!IS_MAIN) {
  // imported for self-test; do not run the CLI
} else {
  let referenced = new Set();
  for (const rel of SOURCES) {
    const p = join(ROOT, rel);
    if (!existsSync(p)) cannotMeasure(`missing source ${rel}`);
    for (const b of referencedBindings(readFileSync(p, 'utf8'))) referenced.add(b);
  }
  const wranglerPath = join(ROOT, WRANGLER);
  if (!existsSync(wranglerPath)) cannotMeasure(`missing ${WRANGLER}`);
  const declared = declaredBindings(readFileSync(wranglerPath, 'utf8'));

  if (referenced.size === 0) cannotMeasure('zero bindings referenced — the extractor matched nothing, which is not the same as "no rate limiting"');
  if (declared.size === 0) cannotMeasure('zero ratelimit bindings declared — refusing to call that parity');

  const undeclared = [...referenced].filter((b) => !declared.has(b)).sort();
  const unused = [...declared].filter((b) => !referenced.has(b)).sort();

  console.log(`verify-rate-limit-binding-parity · referenced=${referenced.size} declared=${declared.size}`);
  if (unused.length) {
    console.log(`  advisory · declared but never referenced: ${unused.join(', ')} (a binding nothing uses is cost without control)`);
  }
  if (undeclared.length) {
    console.error(`verify-rate-limit-binding-parity · FAIL · referenced but NOT declared: ${undeclared.join(', ')}`);
    console.error('  These buckets do not fail — they fall back to a PER-ISOLATE in-memory map that the');
    console.error('  source labels "for local dev only". In production the effective limit becomes');
    console.error('  (limit x isolate count) and nothing reports it. Declare an [[unsafe.bindings]]');
    console.error('  block with type="ratelimit", or remove the bindingName so the intent is explicit.');
    process.exit(1);
  }
  console.log('verify-rate-limit-binding-parity · PASS · every referenced bucket is bound to a real Cloudflare limiter');
}
