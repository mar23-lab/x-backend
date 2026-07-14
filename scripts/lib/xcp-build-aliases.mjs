// scripts/lib/xcp-build-aliases.mjs
//
// R-N-2-γ-N lesson-codification (per HR-SUBSTRATE-ALIAS-SSOT-1) —
// single source of truth for `@xcp/data-substrate` + React-window-shim
// + jsx-runtime-shim aliases. Imported by ALL three build configs:
//
//   - vite.standalone.config.ts        (file:// singlefile)
//   - vite.config.ts                   (Storybook + H-3 verifier)
//   - scripts/build-app.mjs            (legacy esbuild IIFE)
//
// Why this exists
// ---------------
// During R-N-2-γ-N session, the substrate alias was authored 3 times
// (once per config). Each config diverged slightly, and two were
// discovered to be missing only after the consumer build broke at a
// new pipeline. This module is the deduplication: every consumer
// imports it and uses the appropriate output shape.
//
// Sunset condition
// ----------------
// When R-N-3-γ retires the local-path substrate alias (npm publish or
// pnpm workspace bridge), this module's `substrateAliases()` output
// becomes empty and can be deleted. The React-shim aliases remain
// regardless (CDN React is a singleton pattern, not a path-coupling).

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Build absolute paths to the shim/source files. `repoRoot` is the
 * Xlooop-XCP-demo repo root (caller passes a resolved absolute path).
 *
 * @param {string} repoRoot — absolute path to Xlooop-XCP-demo
 * @returns {{ substrate: {find: RegExp, replacement: string}[],
 *             react:     {find: RegExp, replacement: string}[] }}
 */
export function buildAliasGroups(repoRoot) {
  // Substrate path: sibling xcp-platform checkout. Vite alias points at
  // the TS source so Vite/esbuild compile on the fly (avoiding the
  // dist/-gitignored issue).
  const siblingPlatformRoot = resolve(repoRoot, '../../xcp-platform');
  const platformRoot = process.env.XCP_PLATFORM_ROOT
    || (existsSync(resolve(siblingPlatformRoot, 'packages/xcp-data-substrate/src'))
      ? siblingPlatformRoot
      : '/Users/maratbasyrov/WIP/xcp-platform');
  const substrateSrc = resolve(platformRoot, 'packages/xcp-data-substrate/src');
  const reactWindowShim = resolve(repoRoot, 'src/entry/react-window-shim.js');
  const reactDomWindowShim = resolve(repoRoot, 'src/entry/react-dom-window-shim.js');
  const jsxRuntimeShim = resolve(repoRoot, 'src/entry/jsx-runtime-shim.js');

  return {
    substrate: [
      // Most-specific subpaths first (regex find for exact match).
      { find: /^@xcp\/data-substrate\/adapters$/, replacement: `${substrateSrc}/adapters/index.ts` },
      { find: /^@xcp\/data-substrate\/repositories$/, replacement: `${substrateSrc}/repositories/index.ts` },
      { find: /^@xcp\/data-substrate$/, replacement: `${substrateSrc}/index.ts` },
    ],
    react: [
      { find: /^react$/, replacement: reactWindowShim },
      { find: /^react\/jsx-runtime$/, replacement: jsxRuntimeShim },
      { find: /^react\/jsx-dev-runtime$/, replacement: jsxRuntimeShim },
      { find: /^react-dom$/, replacement: reactDomWindowShim },
      { find: /^react-dom\/client$/, replacement: reactDomWindowShim },
    ],
  };
}

/**
 * Convenience: flatten react + substrate aliases for a Vite
 * `resolve.alias: [...]` (array form for exact-match regex).
 *
 * Order: react aliases first (most-imported; resolve fastest), substrate next.
 */
export function viteAliasArray(repoRoot) {
  const g = buildAliasGroups(repoRoot);
  return [...g.react, ...g.substrate];
}

/**
 * Convenience: flatten for esbuild's `alias: {key: value}` map.
 * esbuild doesn't support regex find — only exact-string keys. We
 * derive the key from the regex source (strip ^$ anchors + escapes).
 */
export function esbuildAliasMap(repoRoot, extras = {}) {
  const g = buildAliasGroups(repoRoot);
  const out = { ...extras };
  for (const { find, replacement } of [...g.react, ...g.substrate]) {
    const key = find.source.replace(/^\^|\$$/g, '').replace(/\\/g, '');
    out[key] = replacement;
  }
  return out;
}
