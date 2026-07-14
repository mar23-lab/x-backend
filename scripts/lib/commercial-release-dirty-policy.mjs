// Narrow release-visible dirty policy shared by Xlooop readiness verifiers.
// These files are rewritten by known automation and must stay visible, but
// they should not turn commercial/demo release truth red on their own.

export const AUTOMATION_REGENERATED = new Set([
  'data/operations-live-stream.json',
  'data/mbp-gateway-receipts.json',
  'data/visual-verification-morning-addendum.example.json',
]);

export function isAutomationRegeneratedStatusLine(line) {
  return [...AUTOMATION_REGENERATED].some((path) => line.endsWith(path));
}

export function classifyCommercialReleaseDirty(statusText) {
  const allDirty = String(statusText || '').split('\n').filter(Boolean);
  const dirtyFiles = allDirty.filter((line) => !isAutomationRegeneratedStatusLine(line));
  const allowlistedAutomationDirty = allDirty.filter(isAutomationRegeneratedStatusLine);
  return {
    all_dirty: allDirty,
    dirty_files: dirtyFiles,
    allowlisted_automation_dirty: allowlistedAutomationDirty,
  };
}
