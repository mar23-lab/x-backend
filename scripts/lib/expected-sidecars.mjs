// scripts/lib/expected-sidecars.mjs
//
// The code-split IIFE sidecars that the MAIN app index.html MUST reference via <script src>.
//
// WHY THIS EXISTS (the defect it closes · validated 260627): the #771 `git merge -X ours` dropped
// the `<script src="dist/v3-readiness.js">` tag from index.html — the tag lived only on #775's side
// of the index.html conflict, so `-X ours` took #771's side (without it). The sidecar FILE still
// built + deployed + served HTTP 200 — but was never REFERENCED, so window.ReadinessJourney never
// registered and the in-app readiness journey could not render even with its flag on. It passed
// ci-local (45/45), current-integrity (64/64), the curl smoke, AND the deploy LIVE-verify — every
// one checks build-correctness / file-existence, NOT tag-presence (a dropped tag = one fewer ref to
// check = still "complete"). Only a manual browser-verify caught it (window.ReadinessJourney
// === undefined). This list is the INDEPENDENT contract: the gate (verify-sidecar-manifest.mjs in
// ci-local + the deploy live-check) FAILS if index.html is missing any of these tags — turning a
// 1-in-5 manual catch into an automatic one.
//
// Maintenance: adding or removing a sidecar is a DELIBERATE contract change — update this list in
// the SAME commit. `dist/v3-investor.js` is intentionally absent: it is host-gated (injected by
// scripts/prepare-cloudflare-pages.mjs into invest.xlooop.com only, never the main index.html).
//
// ARRAY ORDER IS THE LOAD ORDER + drives auto-insertion (260628): scripts/lib/ensure-sidecar-tags.mjs
// (called by build-standalone) re-inserts a dropped tag immediately after its nearest present
// predecessor in THIS array. So a NEW sidecar must be placed at the correct index here = its intended
// load-order position; the build then auto-places its tag there. Worst case of a wrong index is a
// slightly-wrong load order, never a dropped/unreferenced tag.
export const EXPECTED_SIDECARS = [
  { file: 'dist/v3-runtime.js',           global: 'xcpRuntime',                 why: 'precompiled runtime + contracts (loads first)' },
  { file: 'dist/v3-project-workspace.js', global: 'DetailedProjectShellDesign', why: 'Project Operating Space sidecar' },
  { file: 'dist/v3-readiness.js',         global: 'ReadinessJourney',           why: 'M.7 in-app readiness onboarding journey (the one #771 dropped)' },
  { file: 'dist/v3-account-screens.js',   global: 'ProfileScreen',              why: 'N.9 Profile/Account screens sidecar (~82 KB off the AMBER app bundle)' },
  { file: 'dist/v3-app.js',               global: null,                          why: 'the main app bundle (mounts #root)' },
  { file: 'dist/v3-shell-widgets.js',     global: null,                          why: 'shell widget sidecar (MetricCard / EmptyState / EventRow)' },
  { file: 'dist/v3-substrate-widgets.js', global: null,                          why: 'substrate widget sidecar' },
  { file: 'dist/v3-r51-widgets.js',       global: null,                          why: 'R51 widget sidecar' },
];

// Returns the EXPECTED_SIDECARS files NOT referenced by a <script src> tag in `html`
// (empty array = all present). Shared by verify-sidecar-manifest.mjs (build-time, ci-local) and
// deploy-app-prod.mjs (post-deploy LIVE check) so both use one source of truth.
export function missingSidecars(html) {
  const missing = [];
  for (const s of EXPECTED_SIDECARS) {
    const esc = s.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`<script[^>]*\\bsrc=["']${esc}(?:\\?[^"']*)?["']`);
    if (!re.test(html)) missing.push(s.file);
  }
  return missing;
}
