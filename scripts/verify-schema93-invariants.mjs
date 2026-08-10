#!/usr/bin/env node
// verify-schema93-invariants.mjs
//
// WHY THIS EXISTS — the schema-93 proof did not run anywhere.
//
// Every schema93 suite opens with:
//     const describePostgres = databaseUrl ? describe : describe.skip;
// so without XLOOOP_SCHEMA93_PG_URL the whole describe is SKIPPED and vitest reports success.
// With no CI in this estate, that is every machine. Migration 093 — which re-namespaced the
// idempotency keys guarding nine authority writes — shipped with its behaviour asserted only by
// mocks. The DB contract itself was never exercised.
//
// This script asserts the eleven invariants 093 actually creates, against REAL Postgres, and
// refuses to look like a pass when it has not run. It is the schema93 counterpart of the honest
// skip already applied to rls-shadow-soak and verify-postgres-rls-phase2.
//
// FIRST RUN (2026-08-03, Neon branch br-sparkling-tooth-a7ujeei8 @ schema 93): 11/11 PASS.
// Two results were worth the exercise and are NOT visible from the migration source:
//   - same key + a DIFFERENT digest also raises 23505, not a distinct error. So it is
//     readStrictAuthorityReplay's digest comparison — not the database — that separates a replay
//     from a key-reuse 409. The app layer is load-bearing there.
//   - the ordinary and strict namespaces are genuinely independent: an identical key coexists
//     across modes, and the same key on a different route is a distinct claim. That is 093's
//     central design claim, previously argued in prose.

import { Client } from 'pg';

/** The eleven invariants. Each returns the SQLSTATE we expect Postgres to raise, or 'accepted'. */
export const INVARIANTS = [
  {
    name: 'ordinary mode rejects actor+digest',
    expect: '23514',
    sql: (ws) => [`INSERT INTO idempotency_keys (workspace_id, idempotency_key, route, mode, actor_user_id, request_sha256)
                   VALUES ($1,'k1','/r','ordinary_retry_guard','user_x',repeat('a',64))`, [ws]],
  },
  {
    name: 'strict mode rejects null actor',
    expect: '23514',
    sql: (ws) => [`INSERT INTO idempotency_keys (workspace_id, idempotency_key, route, mode, actor_user_id, request_sha256)
                   VALUES ($1,'k2','/r','authority_strict',NULL,repeat('a',64))`, [ws]],
  },
  {
    name: 'strict mode rejects malformed digest',
    expect: '23514',
    sql: (ws) => [`INSERT INTO idempotency_keys (workspace_id, idempotency_key, route, mode, actor_user_id, request_sha256)
                   VALUES ($1,'k3','/r','authority_strict','user_x','NOT-A-SHA')`, [ws]],
  },
  {
    name: 'well-formed strict claim accepted',
    expect: 'accepted',
    sql: (ws) => [`INSERT INTO idempotency_keys (workspace_id, idempotency_key, route, mode, actor_user_id, request_sha256)
                   VALUES ($1,'k4','/consent','authority_strict','user_x',repeat('a',64))`, [ws]],
  },
  {
    name: 'duplicate strict claim raises 23505 (the replay path)',
    expect: '23505',
    sql: (ws) => [`INSERT INTO idempotency_keys (workspace_id, idempotency_key, route, mode, actor_user_id, request_sha256)
                   VALUES ($1,'k4','/consent','authority_strict','user_x',repeat('a',64))`, [ws]],
  },
  {
    name: 'same key + different digest also 23505 (reuse, mapped to 409 in the DAL)',
    expect: '23505',
    sql: (ws) => [`INSERT INTO idempotency_keys (workspace_id, idempotency_key, route, mode, actor_user_id, request_sha256)
                   VALUES ($1,'k4','/consent','authority_strict','user_x',repeat('b',64))`, [ws]],
  },
  {
    name: 'same key on a different route is a distinct claim',
    expect: 'accepted',
    sql: (ws) => [`INSERT INTO idempotency_keys (workspace_id, idempotency_key, route, mode, actor_user_id, request_sha256)
                   VALUES ($1,'k4','/revoke','authority_strict','user_x',repeat('a',64))`, [ws]],
  },
  {
    name: 'ordinary key coexists with an identical strict key',
    expect: 'accepted',
    sql: (ws) => [`INSERT INTO idempotency_keys (workspace_id, idempotency_key, route, mode)
                   VALUES ($1,'k4','/consent','ordinary_retry_guard')`, [ws]],
  },
  {
    name: 'ordinary duplicate still blocked workspace-wide (pre-093 behaviour preserved)',
    expect: '23505',
    sql: (ws) => [`INSERT INTO idempotency_keys (workspace_id, idempotency_key, route, mode)
                   VALUES ($1,'k4','/anything-else','ordinary_retry_guard')`, [ws]],
  },
  {
    name: 'assert_authority_complete(false) raises 23514',
    expect: '23514',
    sql: () => ['SELECT xlooop_assert_authority_complete(false, $1)', ['consent_ack']],
  },
  {
    name: 'assert_authority_complete(true) returns',
    expect: 'accepted',
    sql: () => ['SELECT xlooop_assert_authority_complete(true, $1)', ['consent_ack']],
  },
];

/** Pure: decide what the runner should do given the environment. Testable without a database. */
export function assessEnvironment(env) {
  const url = String(env.XLOOOP_SCHEMA93_PG_URL ?? '').trim();
  const production = String(env.XLOOOP_AUTHORITY_MODE ?? '').trim() === 'production';
  if (url) return { run: true, exitCode: 0, reason: 'database configured' };
  return {
    run: false,
    // Under production authority an unproven migration contract is a red, not a shrug.
    exitCode: production ? 1 : 0,
    reason: production
      ? 'XLOOOP_SCHEMA93_PG_URL is unset under XLOOOP_AUTHORITY_MODE=production'
      : 'XLOOOP_SCHEMA93_PG_URL is unset',
  };
}

async function attempt(client, text, values) {
  try {
    await client.query(text, values);
    return 'accepted';
  } catch (err) {
    return err?.code ?? `unknown:${err?.message ?? err}`;
  }
}

async function run(url) {
  const ws = `ws-093-invariants-${process.pid}`;
  const client = new Client({ connectionString: url });
  await client.connect();
  const results = [];
  try {
    await client.query('DELETE FROM idempotency_keys WHERE workspace_id = $1', [ws]);
    for (const inv of INVARIANTS) {
      const [text, values] = inv.sql(ws);
      // Each attempt gets its own subtransaction: a raised SQLSTATE aborts the current one, and
      // without this a single expected failure would poison every check after it.
      await client.query('BEGIN');
      const actual = await attempt(client, text, values);
      await client.query(actual === 'accepted' ? 'COMMIT' : 'ROLLBACK');
      results.push({ name: inv.name, expect: inv.expect, actual, pass: actual === inv.expect });
    }
  } finally {
    await client.query('DELETE FROM idempotency_keys WHERE workspace_id = $1', [ws]).catch(() => {});
    await client.end().catch(() => {});
  }
  return results;
}

function selfTest() {
  const cases = [
    ['unset + production authority must FAIL', { XLOOOP_AUTHORITY_MODE: 'production' }, (a) => !a.run && a.exitCode === 1],
    ['unset + no authority mode skips soft', {}, (a) => !a.run && a.exitCode === 0],
    ['configured url runs', { XLOOOP_SCHEMA93_PG_URL: 'postgres://x/y' }, (a) => a.run && a.exitCode === 0],
    ['blank url is treated as unset', { XLOOOP_SCHEMA93_PG_URL: '   ' }, (a) => !a.run],
    ['every invariant declares an expectation', {}, () => INVARIANTS.every((i) => i.expect && i.name && typeof i.sql === 'function')],
    ['the suite covers both error classes and the happy path', {}, () => {
      const e = new Set(INVARIANTS.map((i) => i.expect));
      return e.has('23514') && e.has('23505') && e.has('accepted');
    }],
  ];
  const failed = cases.filter(([, env, check]) => !check(assessEnvironment(env)));
  if (failed.length) {
    console.error(`FAIL schema93-invariants:self-test: ${failed.length}/${cases.length} case(s) failed`);
    for (const [name] of failed) console.error(`  - ${name}`);
    process.exit(1);
  }
  const passed = cases.length - failed.length;
  console.log(`PASS schema93-invariants:self-test: ${passed}/${cases.length} cases, ${INVARIANTS.length} invariants declared`);
}

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();

  const decision = assessEnvironment(process.env);
  if (!decision.run) {
    // Deliberately NOT the word PASS, and it names its own assertion count. The whole reason this
    // file exists is that a skip elsewhere was indistinguishable from a green run.
    console.error(`SKIPPED (0 of ${INVARIANTS.length} invariants asserted) schema93-invariants: ${decision.reason}`);
    if (decision.exitCode !== 0) {
      console.error('  Under production authority the 093 contract must be proven, not assumed.');
    }
    process.exit(decision.exitCode);
  }

  const results = await run(process.env.XLOOOP_SCHEMA93_PG_URL);
  const passed = results.filter((r) => r.pass).length;
  for (const r of results) {
    console.log(`  ${r.pass ? 'ok  ' : 'FAIL'} ${r.name} — expected ${r.expect}, got ${r.actual}`);
  }
  if (passed !== results.length) {
    console.error(`FAIL schema93-invariants: ${passed}/${results.length} invariants held`);
    process.exit(1);
  }
  console.log(`PASS schema93-invariants: ${passed}/${results.length} invariants asserted against real Postgres`);
}

main().catch((err) => {
  console.error(`FAIL schema93-invariants: ${err?.message ?? err}`);
  process.exit(1);
});
