// folder-snapshot-core.ts · the shared snapshot + checksum-diff primitive (W3).
//
// Extracted from the SourceSnapshotContract idea (a folder = versioned files + checksums) as a PURE
// library: snapshot normalization + a 3-way-free checksum diff ONLY — NO event emission, NO mutation,
// NO merge. The product folder-connector consumes it to emit reflection_only events; the operator
// devtool MAY later consume it for a baseline/recon. Keeping this boundary is the whole point of the
// critique: the connector OBSERVES, it never coordinates writers — so this lib must never do either.

/** One file in a folder snapshot — a subset of SourceSnapshotFileContract (path + checksum is the core). */
export interface FolderFile {
  path: string;
  checksum: string;
  size?: number;
}

/** A normalized, deduped, sorted file list — the canonical baseline shape stored + diffed. */
export type FolderSnapshot = FolderFile[];

/** The result of diffing two snapshots, by path. modified = same path, different checksum. */
export interface FolderDiff {
  added: FolderFile[];
  modified: FolderFile[];
  removed: FolderFile[];
}

const str = (v: unknown): string => (v == null ? '' : String(v));

/** Coerce arbitrary input into a clean snapshot: keep {path, checksum}, dedupe by path (last wins), sort. */
export function normalizeFolderSnapshot(input: unknown): FolderSnapshot {
  const list = Array.isArray(input) ? input : [];
  const byPath = new Map<string, FolderFile>();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const path = str(r.path).trim();
    const checksum = str(r.checksum).trim();
    if (!path || !checksum) continue; // a file with no path or no checksum is not a usable snapshot entry
    const size = Number.isFinite(Number(r.size)) ? Number(r.size) : undefined;
    byPath.set(path, size != null ? { path, checksum, size } : { path, checksum });
  }
  return Array.from(byPath.values()).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Diff two snapshots by path. Deterministic + pure. added = in current not baseline; removed = in
 * baseline not current; modified = in both with a different checksum. An identical resync yields an
 * empty diff (so re-posting the same snapshot emits ZERO events — idempotent at the diff layer).
 */
export function diffFolderSnapshots(baseline: unknown, current: unknown): FolderDiff {
  const base = normalizeFolderSnapshot(baseline);
  const curr = normalizeFolderSnapshot(current);
  const baseByPath = new Map(base.map((f) => [f.path, f]));
  const currByPath = new Map(curr.map((f) => [f.path, f]));
  const added: FolderFile[] = [];
  const modified: FolderFile[] = [];
  const removed: FolderFile[] = [];
  for (const f of curr) {
    const prev = baseByPath.get(f.path);
    if (!prev) added.push(f);
    else if (prev.checksum !== f.checksum) modified.push(f);
  }
  for (const f of base) {
    if (!currByPath.has(f.path)) removed.push(f);
  }
  return { added, modified, removed };
}

/** Total change count — convenience for "N changes since last sync". */
export function diffChangeCount(d: FolderDiff): number {
  return d.added.length + d.modified.length + d.removed.length;
}
