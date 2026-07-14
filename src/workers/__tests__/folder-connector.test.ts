// folder-connector.test.ts · 2026-06-10 · W3
// Unit tests for the folder connector's pure core (snapshot normalize + checksum diff) and the
// translator/sync orchestrator (change->event mapping + idempotent re-sync). DAL mocked.

import { describe, it, expect } from 'vitest';
import { normalizeFolderSnapshot, diffFolderSnapshots, diffChangeCount } from '../sources/folder-snapshot-core';
import { folderChangeToEvent, diffToChanges, syncFolderSnapshot, type FolderBinding } from '../sources/translators/folder';

describe('folder-snapshot-core', () => {
  it('normalizes: drops entries with no path/checksum, dedupes by path (last wins), sorts', () => {
    const out = normalizeFolderSnapshot([
      { path: 'b.ts', checksum: '2' },
      { path: 'a.ts', checksum: '1' },
      { path: 'a.ts', checksum: '1b' }, // dupe path → last wins
      { path: '', checksum: 'x' },       // no path → dropped
      { path: 'c.ts' },                  // no checksum → dropped
    ]);
    expect(out.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
    expect(out.find((f) => f.path === 'a.ts')!.checksum).toBe('1b');
  });

  it('diffs by path: added / modified (checksum change) / removed', () => {
    const base = [{ path: 'keep.ts', checksum: 'k1' }, { path: 'change.ts', checksum: 'c1' }, { path: 'gone.ts', checksum: 'g1' }];
    const curr = [{ path: 'keep.ts', checksum: 'k1' }, { path: 'change.ts', checksum: 'c2' }, { path: 'new.ts', checksum: 'n1' }];
    const d = diffFolderSnapshots(base, curr);
    expect(d.added.map((f) => f.path)).toEqual(['new.ts']);
    expect(d.modified.map((f) => f.path)).toEqual(['change.ts']);
    expect(d.removed.map((f) => f.path)).toEqual(['gone.ts']);
    expect(diffChangeCount(d)).toBe(3);
  });

  it('an identical re-sync yields an EMPTY diff (idempotent at the diff layer)', () => {
    const snap = [{ path: 'a.ts', checksum: '1' }, { path: 'b.ts', checksum: '2' }];
    expect(diffChangeCount(diffFolderSnapshots(snap, snap))).toBe(0);
  });

  it('a first sync (empty baseline) emits every file as added', () => {
    const d = diffFolderSnapshots([], [{ path: 'a.ts', checksum: '1' }, { path: 'b.ts', checksum: '2' }]);
    expect(d.added).toHaveLength(2);
    expect(d.modified).toHaveLength(0);
    expect(d.removed).toHaveLength(0);
  });
});

const BINDING: FolderBinding = { binding_id: 'fld-1', workspace_id: 'ws-1', project_id: 'proj-1', path: '/Users/op/notes' };

describe('folderChangeToEvent', () => {
  it('maps a change to a reflection_only event (source_tool folder, no body, path as evidence)', () => {
    const ev = folderChangeToEvent(BINDING, 'modified', { path: 'src/main.ts', checksum: 'abcdef123456' }, '2026-06-10T00:00:00.000Z');
    expect(ev.source_tool).toBe('folder');
    expect(ev.body).toBeNull();
    expect(ev.status).toBe('completed');
    expect(ev.project_id).toBe('proj-1');
    expect(ev.visibility).toBe('internal_workspace');
    expect(ev.evidence_link).toBe('src/main.ts');
    expect(ev.summary).toMatch(/notes/);
    expect(ev.summary).toMatch(/changed/);
  });

  it('the id is deterministic from (binding, kind, path, checksum) — idempotent', () => {
    const a = folderChangeToEvent(BINDING, 'added', { path: 'a.ts', checksum: 'cafebabe00' }, '2026-06-10T00:00:00.000Z');
    const b = folderChangeToEvent(BINDING, 'added', { path: 'a.ts', checksum: 'cafebabe00' }, '2026-06-10T09:00:00.000Z');
    expect(a.id).toBe(b.id); // same change → same id regardless of when synced
  });

  it('diffToChanges orders added, then modified, then removed', () => {
    const changes = diffToChanges({ added: [{ path: 'a', checksum: '1' }], modified: [{ path: 'b', checksum: '2' }], removed: [{ path: 'c', checksum: '3' }] });
    expect(changes.map((c) => c.kind)).toEqual(['added', 'modified', 'removed']);
  });
});

describe('syncFolderSnapshot', () => {
  function mockDal(baseline: Array<{ path: string; checksum: string }>) {
    const upserts: unknown[] = [];
    let stored: unknown = null;
    return {
      dal: {
        getFolderBaseline: async () => baseline,
        upsertEvent: async (_ws: string, ev: unknown) => { upserts.push(ev); return { id: (ev as { id: string }).id, created: true }; },
        putFolderBaseline: async (input: unknown) => { stored = input; },
      } as never,
      upserts,
      getStored: () => stored,
    };
  }

  it('emits one event per change and stores the new baseline', async () => {
    const m = mockDal([{ path: 'keep.ts', checksum: 'k1' }, { path: 'change.ts', checksum: 'c1' }, { path: 'gone.ts', checksum: 'g1' }]);
    const curr = [{ path: 'keep.ts', checksum: 'k1' }, { path: 'change.ts', checksum: 'c2' }, { path: 'new.ts', checksum: 'n1' }];
    const res = await syncFolderSnapshot(m.dal, BINDING, curr, '2026-06-10T00:00:00.000Z');
    expect(res).toMatchObject({ emitted: 3, rejected: 0, added: 1, modified: 1, removed: 1 });
    expect(m.upserts).toHaveLength(3);
    expect((m.getStored() as { files: unknown[] }).files).toHaveLength(3); // baseline = the new snapshot
  });

  it('a re-sync of the SAME snapshot emits ZERO events (idempotent end-to-end)', async () => {
    const snap = [{ path: 'a.ts', checksum: '1' }];
    const m = mockDal(snap);
    const res = await syncFolderSnapshot(m.dal, BINDING, snap, '2026-06-10T00:00:00.000Z');
    expect(res.emitted).toBe(0);
    expect(m.upserts).toHaveLength(0);
  });
});
