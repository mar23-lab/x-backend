// stable-generated-artifact.mjs · A-OPS-1 (260707) · byte-stable generated data artifacts.
//
// PROBLEM: operations-live-stream.json + document-context-read-model.json stamp HEAD-commit-time-derived
// fields (generated_at, valid_until, stream_id, git_sha via build-timestamp.mjs). git HEAD advances every
// commit, so a deploy-time rebuild re-stamps them even when the underlying DATA is byte-identical — and
// index.standalone.html inlines these files, so it churns too. That forced `--skip-build` on every deploy.
//
// FIX: when the freshly-generated artifact differs from the committed one ONLY in those mechanical fields
// (identical data), WRITE THE COMMITTED ARTIFACT VERBATIM. A no-op rebuild is then byte-identical (stable
// timestamps preserved), which cascades to index.standalone.html. When the DATA genuinely changes, the
// non-mechanical content differs → the fresh artifact (with fresh timestamps) is written, so freshness
// stays honest (valid_until still tracks the new generated_at).

// Keys whose values are HEAD/build-time-derived (mechanical), anywhere in the artifact tree.
const MECHANICAL_KEYS = new Set(['generated_at', 'valid_until', 'stream_id', 'git_sha']);

function normalizeMechanical(value) {
  if (Array.isArray(value)) return value.map(normalizeMechanical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = MECHANICAL_KEYS.has(k) ? '__MECHANICAL__' : normalizeMechanical(v);
    }
    return out;
  }
  return value;
}

/**
 * Given the freshly-built artifact object and the committed one (parsed), return the object to WRITE:
 * the committed object verbatim if the two are equal after normalizing all mechanical fields (i.e. only
 * timestamps/derived-ids differ → no real data change), otherwise the fresh object.
 */
export function stableArtifact(freshObj, committedObj) {
  if (committedObj) {
    const a = JSON.stringify(normalizeMechanical(committedObj));
    const b = JSON.stringify(normalizeMechanical(freshObj));
    if (a === b) return committedObj;
  }
  return freshObj;
}
