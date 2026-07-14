#!/usr/bin/env node
// verify-old-ui-consumes-envelope.mjs · A-W2 · old-UI response-truth-envelope consumption gate (260707).
//
// WHY: the backend now serves data_class (M3) / allowed_actions+disabled_reasons (M4) / admissibility (M6),
// but authority + data-labelling are only real if the UI READS them from the server rather than
// re-deriving client-side (ACCESS_CONTROL_MATRIX.md invariant #1). This gate freezes the consumption
// contract: there is ONE reader (src/shared/services/api-client/envelope.ts) exposing the canonical helpers,
// and the wired consumer surfaces actually import it. It ratchets UP as A-W2b migrates more surfaces.
//
// Prevention > detection: a refactor that drops the envelope reader or a surface's consumption fails here.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENVELOPE = 'src/shared/services/api-client/envelope.ts';

// The canonical reader must export these (the contract the old UI + future new UI both consume).
const REQUIRED_EXPORTS = [
  'extractDataClass', 'isLiveData', 'extractAllowedActions',
  'isActionAllowed', 'disabledReasonFor', 'isAdmissibleForContext',
];

// Surfaces that MUST consume the reader (import from envelope). Grows as each widget migrates.
const REQUIRED_CONSUMERS = [
  { file: 'src/shared/hooks/useProjectEvents.js', uses: 'extractDataClass' },
  // A-W2d · SyntheticDomainsPanel gates its write controls (canEdit) on server allowed_actions.
  { file: 'src/widgets/SyntheticDomainsPanel/SyntheticDomainsPanel.jsx', uses: 'isActionAllowed' },
  // A-W2d · DetailedWorkspaceShellDesign gates project-source actions on the /sources envelope.
  { file: 'src/widgets/DetailedWorkspaceShellDesign/DetailedWorkspaceShellDesign.jsx', uses: 'isActionAllowedDWS' },
  // A-W2e · CockpitTopBarNotifications gates its one-tap governed approve on the events response's
  // server authority (allowed_actions/status_repoint) instead of always showing a live control.
  { file: 'src/widgets/CockpitTopBarNotifications/CockpitTopBarNotifications.jsx', uses: 'isActionAllowed' },
  // A-W2e · LiveStreamRailV3 sources rows from the client stream plane (no envelope in its data path),
  // so its rail-body gates the governed approve on a shared server-authority probe (useEventsAuthority).
  { file: 'src/widgets/LiveStreamRailV3/_shared/rail-body.jsx', uses: 'isActionAllowed' },
  // A-W2e · the shared events-authority probe feeding stream-plane surfaces reads the envelope helpers.
  { file: 'src/shared/hooks/useEventsAuthority.js', uses: 'extractAllowedActions' },
  // A-W2f · SettingsScreen gates the owner-only member role editor on the /members envelope (role_change).
  { file: 'src/widgets/AccountScreens/_shared/SettingsScreen.jsx', uses: 'isActionAllowed' },
];

const violations = [];

const envAbs = path.join(ROOT, ENVELOPE);
if (!fs.existsSync(envAbs)) {
  violations.push(`${ENVELOPE} · the single envelope reader is missing`);
} else {
  const src = fs.readFileSync(envAbs, 'utf8');
  for (const fn of REQUIRED_EXPORTS) {
    if (!new RegExp(`export function ${fn}\\b`).test(src)) {
      violations.push(`${ENVELOPE} · missing export \`${fn}\` (envelope reader contract incomplete)`);
    }
  }
}

for (const { file, uses } of REQUIRED_CONSUMERS) {
  const abs = path.join(ROOT, file);
  if (!fs.existsSync(abs)) { violations.push(`${file} · consumer not found`); continue; }
  const src = fs.readFileSync(abs, 'utf8');
  if (!/from ['"].*api-client\/envelope(\.ts)?['"]/.test(src)) {
    violations.push(`${file} · does not import the envelope reader`);
  }
  if (!new RegExp(`\\b${uses}\\b`).test(src)) {
    violations.push(`${file} · no longer consumes \`${uses}\` from the envelope (data_class dropped?)`);
  }
}

if (violations.length) {
  console.error('✗ old-ui-consumes-envelope · FAIL — response-truth-envelope consumption regressed:');
  for (const v of violations) console.error(`    ${v}`);
  console.error('  Authority + data_class must be read server-side via envelope.ts, never re-derived. See docs/contracts/OLD_UI_TRUTH_ENVELOPE_MAP.md.');
  process.exit(1);
}

console.log(`☑ old-ui-consumes-envelope · PASS · reader exports ${REQUIRED_EXPORTS.length} helpers · ${REQUIRED_CONSUMERS.length} consumer(s) wired`);
process.exit(0);
