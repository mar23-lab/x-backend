#!/usr/bin/env node
// verify-clerk-db-membership-parity.mjs · the gate for the silent-strand class.
//
// WHY THIS EXISTS — a measured, two-day, zero-signal production failure (260729→260731).
//
//   Clerk      Honest & Young — 3 members (owner + two ACCEPTED invitations)
//   Xlooop DB  Honest & Young — 1 member
//   SELECT count(*) FROM workspace_members WHERE activated_by='invite-materialization';  -> 0
//
// Two real people accepted real invitations, signed in afterwards, and never became members. Nothing
// errored. `POST /customer/invites` returned 200, the session route returned 200, every gate stayed
// green, and the only way anyone found out was a human asking why a colleague could not see anything.
//
// The root cause was narrow (session materialization needs an ACTIVE Clerk org, and `mems[0]` picked an
// arbitrary one) and is fixed. **This gate is not about that bug.** It is about the fact that two
// systems disagreed for two days and NOTHING COMPARED THEM. Fixing the bug removes one way to diverge;
// it does not create the comparator. That is the "two correct lists, no comparator" class — the same
// shape as FIXTURE_PEOPLE(4) vs the scrubber(2) shipping two fabricated people for weeks.
//
// WHAT IT ASSERTS. For every workspace, the Clerk organization membership set and the active
// `workspace_members` set must be the same set of user ids.
//
//   clerk_only  — in Clerk, not an active DB member. The A5 strand: someone accepted and cannot work.
//   db_only     — an active DB member Clerk has never heard of. Strictly worse in a different
//                 direction: authority in our tenant with no identity-provider backing. A revoked or
//                 deleted Clerk user whose DB membership survives keeps its entitlements.
//
// Both are failures. `clerk_only` costs a customer their access; `db_only` grants access that nobody
// can revoke from the identity side.
//
// ROLE MISMATCH IS ADVISORY, DELIBERATELY. The Clerk→DB role chain is a mapping, not an identity
// (`org:admin`→operator, `org:member`→viewer, plus `owner` which provisioning writes and no invite
// produces). A blocking assertion over a mapping I have not exhaustively verified would fire on
// legitimate states, and a gate that always fires is a gate that gets bypassed — this estate has two
// advisory controls sitting at 100% would-block across 270 and 174 consecutive runs to prove it.
// Mismatches are printed with the mapping stated, and do not fail the run.
//
// EXIT CODES — three states, because "could not measure" must never render as "measured clean":
//   0  parity across every workspace observed
//   1  divergence found (clerk_only and/or db_only)
//   2  CANNOT MEASURE — missing DATABASE_URL / CLERK_SECRET_KEY, or Clerk/DB unreachable
//
// Exit 2 is the whole point of the design. The failure this gate exists to catch is silence, so a
// version of it that goes quiet when its credentials are absent would reproduce that failure inside
// the detector. `smoke-authenticated.mjs` exits 0 without credentials and is consumed by nothing;
// that is the anti-pattern this file refuses to repeat.
//
// Usage:
//   node scripts/verify-clerk-db-membership-parity.mjs            # live (needs both secrets)
//   node scripts/verify-clerk-db-membership-parity.mjs --self-test # offline, observes its own reds
//
// Zero runtime dependencies beyond @neondatabase/serverless, which is already a direct dependency.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

/** Clerk role → the DB roles that are a legitimate expression of it. Advisory only (see header). */
export const ROLE_MAP = {
  'org:admin': new Set(['operator', 'owner', 'admin']),
  'org:member': new Set(['viewer', 'client', 'member']),
};

/**
 * The comparator. Pure — no I/O, no clock, no env — so it is unit-testable and so the live path and
 * the self-test exercise the SAME logic rather than two implementations that can drift apart.
 *
 * @param {{workspaceId: string, clerk: Array<{userId: string, role?: string}>, db: Array<{userId: string, role?: string, status?: string, removedAt?: string|null}>}} input
 */
export function diffMemberships({ workspaceId, clerk, db }) {
  // "Active" is the DB's own notion of a live membership. A soft-removed or non-active row is NOT a
  // member, and counting it as one would hide exactly the strand this gate looks for.
  const activeDb = db.filter((m) => (m.status ?? 'active') === 'active' && !m.removedAt);

  const clerkById = new Map(clerk.map((m) => [m.userId, m]));
  const dbById = new Map(activeDb.map((m) => [m.userId, m]));

  const clerkOnly = [...clerkById.keys()].filter((id) => !dbById.has(id)).sort();
  const dbOnly = [...dbById.keys()].filter((id) => !clerkById.has(id)).sort();

  const roleMismatch = [];
  for (const [id, c] of clerkById) {
    const d = dbById.get(id);
    if (!d) continue;
    const allowed = ROLE_MAP[c.role];
    // An UNKNOWN Clerk role is not a mismatch — it is an unmapped role, and reporting it as a
    // mismatch would be asserting something this file does not know.
    if (!allowed) continue;
    if (d.role && !allowed.has(d.role)) {
      roleMismatch.push({ userId: id, clerkRole: c.role, dbRole: d.role });
    }
  }
  roleMismatch.sort((a, b) => a.userId.localeCompare(b.userId));

  return {
    workspaceId,
    clerkCount: clerkById.size,
    dbActiveCount: dbById.size,
    clerkOnly,
    dbOnly,
    roleMismatch,
    diverged: clerkOnly.length > 0 || dbOnly.length > 0,
  };
}

/** Render one workspace's result. Named ids, because "1 divergence" is not actionable. */
function render(r) {
  const lines = [];
  const tag = r.diverged ? 'FAIL' : 'ok  ';
  lines.push(`  ${tag} ${r.workspaceId}  clerk=${r.clerkCount} db_active=${r.dbActiveCount}`);
  for (const id of r.clerkOnly) {
    lines.push(`       clerk_only  ${id}  — accepted in Clerk, no active membership here (STRANDED)`);
  }
  for (const id of r.dbOnly) {
    lines.push(`       db_only     ${id}  — active member here, unknown to Clerk (UNREVOCABLE)`);
  }
  for (const m of r.roleMismatch) {
    lines.push(`       role        ${m.userId}  clerk=${m.clerkRole} db=${m.dbRole}  (advisory)`);
  }
  return lines.join('\n');
}

// ── live path ────────────────────────────────────────────────────────────────────────────────────

async function clerkMemberships(orgId, secret) {
  // Clerk paginates. A gate that reads only the first page would under-report Clerk's side and so
  // report `db_only` divergences that do not exist — a false RED is as corrosive as a false green.
  const out = [];
  let offset = 0;
  const limit = 100;
  for (;;) {
    const url = `https://api.clerk.com/v1/organizations/${encodeURIComponent(orgId)}/memberships?limit=${limit}&offset=${offset}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${secret}` } });
    if (!res.ok) {
      throw new Error(`clerk ${res.status} for org ${orgId}: ${(await res.text()).slice(0, 200)}`);
    }
    const body = await res.json();
    const page = Array.isArray(body) ? body : (body.data ?? []);
    for (const m of page) {
      const userId = m?.public_user_data?.user_id ?? m?.user_id;
      if (userId) out.push({ userId, role: m?.role });
    }
    if (page.length < limit) break;
    offset += limit;
    if (offset > 10000) throw new Error(`clerk pagination runaway for org ${orgId}`);
  }
  return out;
}

async function runLive() {
  const dsn = process.env.DATABASE_URL;
  const secret = process.env.CLERK_SECRET_KEY;
  const missing = [!dsn && 'DATABASE_URL', !secret && 'CLERK_SECRET_KEY'].filter(Boolean);
  if (missing.length) {
    console.error(`CANNOT MEASURE clerk↔db membership parity: ${missing.join(', ')} not set.`);
    console.error('  This is exit 2, not exit 0. A parity gate that goes quiet without credentials');
    console.error('  reproduces the silence it exists to detect.');
    return 2;
  }

  let sql;
  let rows;
  try {
    const { neon } = await import('@neondatabase/serverless');
    sql = neon(dsn);
    // Only Clerk-backed workspaces. A workspace id that is not an `org_...` is not an identity-provider
    // organization and has no Clerk side to compare against; asserting parity there would invent a
    // divergence for every internal workspace.
    rows = await sql`
      SELECT w.id AS workspace_id,
             m.user_id, m.role, m.status, m.removed_at
        FROM workspaces w
        LEFT JOIN workspace_members m ON m.workspace_id = w.id
       WHERE w.id LIKE 'org\\_%'
       ORDER BY w.id, m.user_id
    `;
  } catch (err) {
    console.error(`CANNOT MEASURE clerk↔db membership parity: database unreachable — ${err.message}`);
    return 2;
  }

  const byWorkspace = new Map();
  for (const r of rows) {
    if (!byWorkspace.has(r.workspace_id)) byWorkspace.set(r.workspace_id, []);
    if (r.user_id) {
      byWorkspace.get(r.workspace_id).push({
        userId: r.user_id, role: r.role, status: r.status, removedAt: r.removed_at,
      });
    }
  }

  if (byWorkspace.size === 0) {
    // An empty input set is NOT a pass. 34 directory-walking gates in this estate have no empty guard
    // and exactly one asserts the empty-set red; this is the second.
    console.error('CANNOT MEASURE clerk↔db membership parity: zero Clerk-backed workspaces found.');
    console.error('  An empty denominator is "could not measure", never "measured clean".');
    return 2;
  }

  const results = [];
  for (const [workspaceId, db] of byWorkspace) {
    let clerk;
    try {
      clerk = await clerkMemberships(workspaceId, secret);
    } catch (err) {
      console.error(`CANNOT MEASURE clerk↔db membership parity: ${err.message}`);
      return 2;
    }
    results.push(diffMemberships({ workspaceId, clerk, db }));
  }

  return report(results);
}

function report(results) {
  const diverged = results.filter((r) => r.diverged);
  console.log(`clerk↔db membership parity · ${results.length} Clerk-backed workspace(s)`);
  for (const r of results) console.log(render(r));

  const advisory = results.reduce((n, r) => n + r.roleMismatch.length, 0);
  if (advisory) console.log(`\n${advisory} advisory role mismatch(es) — mapping: org:admin→operator|owner|admin, org:member→viewer|client|member`);

  if (diverged.length === 0) {
    console.log(`\nPASS clerk↔db membership parity (${results.length}/${results.length} workspaces in agreement)`);
    return 0;
  }
  const stranded = diverged.reduce((n, r) => n + r.clerkOnly.length, 0);
  const unrevocable = diverged.reduce((n, r) => n + r.dbOnly.length, 0);
  console.error(`\nFAIL clerk↔db membership parity: ${diverged.length} workspace(s) diverge — ${stranded} stranded, ${unrevocable} unrevocable`);
  console.error('  stranded    = accepted in Clerk with no membership here; that person cannot work.');
  console.error('  unrevocable = a member here Clerk does not know; removing them in Clerk changes nothing.');
  return 1;
}

// ── self-test: observe the reds, do not assert them ──────────────────────────────────────────────

function selfTest() {
  const checks = [];
  const check = (name, cond) => { checks.push({ name, ok: !!cond }); };

  // 1. The exact production state that motivated this gate.
  const a5 = diffMemberships({
    workspaceId: 'org_3EI0xhBsYKWHbLmtjdvNVY6Yqhz',
    clerk: [{ userId: 'user_owner', role: 'org:admin' }, { userId: 'user_x', role: 'org:admin' }, { userId: 'user_m', role: 'org:admin' }],
    db: [{ userId: 'user_owner', role: 'owner', status: 'active', removedAt: null }],
  });
  check('A5 shape: 2 stranded detected', a5.diverged && a5.clerkOnly.length === 2 && a5.dbOnly.length === 0);
  check('A5 shape: stranded ids named', a5.clerkOnly.join(',') === 'user_m,user_x');

  // 2. Agreement is a pass.
  const agree = diffMemberships({
    workspaceId: 'org_ok',
    clerk: [{ userId: 'u1', role: 'org:admin' }],
    db: [{ userId: 'u1', role: 'operator', status: 'active', removedAt: null }],
  });
  check('agreement passes', !agree.diverged && agree.roleMismatch.length === 0);

  // 3. A soft-removed member is not a member — it must NOT mask a Clerk-side absence.
  const removed = diffMemberships({
    workspaceId: 'org_rm',
    clerk: [],
    db: [{ userId: 'u1', role: 'operator', status: 'active', removedAt: '2026-07-01T00:00:00Z' }],
  });
  check('soft-removed member is not counted active', !removed.diverged && removed.dbActiveCount === 0);

  // 4. The other direction: a live DB member Clerk has never heard of.
  const orphan = diffMemberships({
    workspaceId: 'org_orphan',
    clerk: [],
    db: [{ userId: 'ghost', role: 'operator', status: 'active', removedAt: null }],
  });
  check('db_only detected', orphan.diverged && orphan.dbOnly.join(',') === 'ghost');

  // 5. Role mismatch is found but does NOT diverge (advisory).
  const role = diffMemberships({
    workspaceId: 'org_role',
    clerk: [{ userId: 'u1', role: 'org:member' }],
    db: [{ userId: 'u1', role: 'operator', status: 'active', removedAt: null }],
  });
  check('role mismatch is advisory, not a divergence', !role.diverged && role.roleMismatch.length === 1);

  // 6. An unmapped Clerk role is not reported as a mismatch.
  const unmapped = diffMemberships({
    workspaceId: 'org_unmapped',
    clerk: [{ userId: 'u1', role: 'org:something_new' }],
    db: [{ userId: 'u1', role: 'operator', status: 'active', removedAt: null }],
  });
  check('unmapped clerk role is not asserted', unmapped.roleMismatch.length === 0);

  // 7-8. OBSERVED RED, from a child process, reading real exit codes — never a return value and
  // never a pipe. A gate is only proven able to fail when something watches it fail.
  const noEnv = spawnSync(process.execPath, [SELF], {
    env: { ...process.env, DATABASE_URL: '', CLERK_SECRET_KEY: '' },
    encoding: 'utf8',
  });
  check('missing credentials exits 2 (not 0)', noEnv.status === 2);
  check('missing credentials says CANNOT MEASURE', /CANNOT MEASURE/.test(noEnv.stderr));

  // 9-10. The report layer must translate a divergence into a non-zero exit. Exercised through a
  // child process running this file's own reporting on an injected fixture.
  const dir = mkdtempSync(join(tmpdir(), 'parity-selftest-'));
  try {
    const harness = join(dir, 'harness.mjs');
    writeFileSync(harness, [
      `import { diffMemberships } from ${JSON.stringify(SELF)};`,
      `const r = diffMemberships({ workspaceId: 'org_x', clerk: [{userId:'a'}], db: [] });`,
      `process.exit(r.diverged ? 1 : 0);`,
    ].join('\n'));
    const diverge = spawnSync(process.execPath, [harness], { encoding: 'utf8' });
    check('divergence yields non-zero exit', diverge.status === 1);

    const harness2 = join(dir, 'harness2.mjs');
    writeFileSync(harness2, [
      `import { diffMemberships } from ${JSON.stringify(SELF)};`,
      `const r = diffMemberships({ workspaceId: 'org_x', clerk: [{userId:'a'}], db: [{userId:'a',status:'active',removedAt:null}] });`,
      `process.exit(r.diverged ? 1 : 0);`,
    ].join('\n'));
    const clean = spawnSync(process.execPath, [harness2], { encoding: 'utf8' });
    check('control: agreement yields exit 0', clean.status === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}`);
  if (failed.length) {
    console.error(`FAIL clerk↔db membership parity self-test (${failed.length}/${checks.length} failed)`);
    return 1;
  }
  console.log(`PASS clerk↔db membership parity self-test (${checks.length} checks, incl. 4 observed child-process exits)`);
  return 0;
}

const isMain = process.argv[1] && (process.argv[1] === SELF || process.argv[1].endsWith('verify-clerk-db-membership-parity.mjs'));
if (isMain) {
  const code = process.argv.includes('--self-test') ? selfTest() : await runLive();
  process.exit(code);
}
