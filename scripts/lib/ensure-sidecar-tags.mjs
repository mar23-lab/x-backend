// scripts/lib/ensure-sidecar-tags.mjs
//
// SELF-HEALING sidecar tags (260628 · prevention for the #771/#790 dropped-tag class).
//
// THE DEFECT THIS PREVENTS: the sidecar `<script src="dist/v3-*.js">` tags in index.html are
// hand-written, committed lines. A `git merge -X ours` (or a hand-edit) on index.html can silently
// DROP a tag whose presence lived only on the other branch's side of the conflict — the FILE still
// builds + deploys + serves HTTP 200, but is never REFERENCED, so its window.* global never registers
// (the in-app feature is dead in prod). This happened twice: #771 dropped dist/v3-readiness.js
// (window.ReadinessJourney), #790 dropped dist/v3-account-screens.js (window.ProfileScreen).
//
// verify-sidecar-manifest.mjs (ci-local) and deploy-app-prod.mjs (live) already DETECT a drop. This
// helper adds PREVENTION: build-standalone.mjs calls ensureSidecarTags() so every build re-inserts any
// missing sidecar tag from the EXPECTED_SIDECARS SSOT, at its correct ordered position, idempotently.
// A drop can no longer survive a rebuild. The two detection gates remain as defense-in-depth (they
// cover a non-built commit and an edge/tenant-projection drop, which build-time inject cannot see).
//
// Presence is tested via missingSidecars() — the SAME predicate the gates use — so "inserted" and
// "missing" can never disagree.

import { EXPECTED_SIDECARS, missingSidecars } from './expected-sidecars.mjs';

// The canonical tag this helper writes — byte-identical to the hand-written tags in index.html
// (plain IIFE <script src>, no extra attributes). If a sidecar ever needs type="module" or similar,
// add a per-entry attribute field to EXPECTED_SIDECARS (out of scope today; all 8 are plain).
function sidecarTag(file, token) {
  return `<script src="${file}?v=${token}"></script>`;
}

// Full-tag matcher (captures the whole <script …></script>) used to find a splice anchor. Tolerant of
// extra attributes + any/no ?v=… so it matches a hand-written or token-bumped tag.
function fullTagRe(file) {
  const esc = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<script[^>]*\\bsrc=["']${esc}(?:\\?[^"']*)?["'][^>]*></script>`);
}

const isPresent = (html, file) => !missingSidecars(html).includes(file);

// Idempotently insert any MISSING EXPECTED_SIDECARS <script> tag into `html`, each at its correct
// ordered position, carrying the cache `token`. Returns { html, inserted: [files] }.
// Running twice on the output is byte-identical (every file then tests present → zero splices).
//
// Insertion-point algorithm for a missing sidecar at EXPECTED index i:
//   (a) splice immediately AFTER the nearest PRESENT predecessor (scan i-1 … 0); else
//   (b) splice immediately BEFORE the nearest PRESENT successor (scan i+1 … end); else
//   (c) degenerate (no EXPECTED_SIDECARS present): before dist/v3-app.js if present, else before </body>.
// Only sidecar-tag boundaries are ever anchored on, so non-sidecar tags (clerk-init, the R41/R54/R55
// hydrators, raw .jsx self-mount widgets) are never moved or rewritten.
export function ensureSidecarTags(html, token, expected = EXPECTED_SIDECARS) {
  const inserted = [];
  for (let i = 0; i < expected.length; i++) {
    const { file } = expected[i];
    if (isPresent(html, file)) continue; // already wired — leave exactly as-is

    const tag = sidecarTag(file, token);
    let spliced = false;

    // (a) nearest present predecessor → after its tag
    for (let p = i - 1; p >= 0 && !spliced; p--) {
      if (!isPresent(html, expected[p].file)) continue;
      const m = html.match(fullTagRe(expected[p].file));
      if (m) {
        const end = m.index + m[0].length;
        html = html.slice(0, end) + '\n' + tag + html.slice(end);
        spliced = true;
      }
    }
    // (b) nearest present successor → before its tag
    for (let s = i + 1; s < expected.length && !spliced; s++) {
      if (!isPresent(html, expected[s].file)) continue;
      const m = html.match(fullTagRe(expected[s].file));
      if (m) {
        html = html.slice(0, m.index) + tag + '\n' + html.slice(m.index);
        spliced = true;
      }
    }
    // (c) degenerate fallback
    if (!spliced) {
      const m = html.match(fullTagRe('dist/v3-app.js'));
      if (m) html = html.slice(0, m.index) + tag + '\n' + html.slice(m.index);
      else html = html.replace(/<\/body>/, `${tag}\n</body>`);
    }
    inserted.push(file);
  }
  return { html, inserted };
}

// --- self-test: proves ensureSidecarTags HEALS a deliberately-dropped tag ---------------------------
// node scripts/lib/ensure-sidecar-tags.mjs --self-test
// Mirrors the #790 incident (drops v3-account-screens); the existing verify-sidecar-manifest --self-test
// already covers #771 (v3-readiness), so the two jointly cover both production incidents.
if (process.argv.includes('--self-test')) {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { resolve, dirname } = await import('node:path');
  const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const real = readFileSync(resolve(REPO, 'index.html'), 'utf8');
  const TOKEN = 'selftest0-000000';

  // RED · drop the v3-account-screens tag like a `merge -X ours` would.
  const dropRe = /<script[^>]*\bsrc=["']dist\/v3-account-screens\.js(?:\?[^"']*)?["'][^>]*><\/script>\s*/;
  const broken = real.replace(dropRe, '');
  const actuallyDropped = broken !== real && missingSidecars(broken).includes('dist/v3-account-screens.js');

  // HEAL.
  const { html: healed1, inserted } = ensureSidecarTags(broken, TOKEN);
  const restored = missingSidecars(healed1).length === 0
    && healed1.includes(`<script src="dist/v3-account-screens.js?v=${TOKEN}"></script>`);

  // POS · restored tag sits between v3-readiness (predecessor) and v3-app (the spine anchor).
  const readinessIdx = healed1.search(/dist\/v3-readiness\.js/);
  const accountIdx = healed1.search(/dist\/v3-account-screens\.js/);
  const appIdx = healed1.search(/dist\/v3-app\.js/);
  const correctPosition = readinessIdx !== -1 && readinessIdx < accountIdx && accountIdx < appIdx;

  // IDEM · second pass byte-identical, inserts nothing.
  const { html: healed2, inserted: inserted2 } = ensureSidecarTags(healed1, TOKEN);
  const idempotent = healed2 === healed1 && inserted2.length === 0;

  // GREEN · the real committed index.html heals to a no-op.
  const greenNoop = ensureSidecarTags(real, TOKEN).inserted.length === 0;

  const ok = actuallyDropped && restored && correctPosition && idempotent && greenNoop
    && inserted.length === 1 && inserted[0] === 'dist/v3-account-screens.js';

  console.log('ensure-sidecar-tags --self-test');
  console.log(`  RED  · account-screens dropped & detected: ${actuallyDropped ? 'PASS' : 'FAIL'}`);
  console.log(`  HEAL · tag restored, all referenced:       ${restored ? 'PASS' : 'FAIL'}`);
  console.log(`  POS  · restored between readiness & app:   ${correctPosition ? 'PASS' : 'FAIL'}`);
  console.log(`  IDEM · second pass byte-identical:         ${idempotent ? 'PASS' : 'FAIL'}`);
  console.log(`  GREEN· real index.html heals to no-op:     ${greenNoop ? 'PASS' : 'FAIL'}`);
  console.log(`\n${ok ? '✓ self-test GREEN' : '✗ self-test RED'}`);
  process.exit(ok ? 0 : 1);
}
