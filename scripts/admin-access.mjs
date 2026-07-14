#!/usr/bin/env node
// admin-access.mjs · Admin CLI for entitlement management
//
// Usage:
//   DATABASE_URL='postgresql://…' npm run admin:list
//   DATABASE_URL='…' npm run admin:approve <request_id> [--workspace-id org_xxx]
//   DATABASE_URL='…' npm run admin:reject <request_id> --reason "..."
//   DATABASE_URL='…' npm run admin:list-users [--status pending|approved|rejected|suspended]
//   DATABASE_URL='…' npm run admin:approve-user <user_id>
//   DATABASE_URL='…' npm run admin:suspend-user <user_id>
//   DATABASE_URL='…' npm run admin:audit [--limit 50]
//
// Direct DB access (no HTTP needed). For when the admin UI isn't built yet.
// Always identifies the actor as ADMIN_USER_ID env var (or '__cli__' if unset).

import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m', magenta: '\x1b[35m',
};

function header(s) { console.log(`\n${c.bold}${c.cyan}━━ ${s} ━━${c.reset}`); }
function ok(s) { console.log(`${c.green}✓ ${c.reset}${s}`); }
function fail(s) { console.error(`${c.red}✗ ${s}${c.reset}`); }
function warn(s) { console.log(`${c.yellow}⚠ ${c.reset}${s}`); }

function dbUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    fail('DATABASE_URL env var is required');
    console.error(`Example: export DATABASE_URL='postgresql://user:pass@host.neon.tech/db?sslmode=require'`);
    process.exit(1);
  }
  return url;
}

function actorId() {
  return process.env.ADMIN_USER_ID || '__cli__';
}

function psql(query) {
  const url = dbUrl();
  const res = spawnSync('psql', [url, '-tAc', query, '-F', '\t'], { encoding: 'utf-8' });
  if (res.status !== 0) {
    fail(`psql failed (exit ${res.status})`);
    console.error(res.stderr || res.stdout);
    process.exit(res.status || 1);
  }
  return res.stdout.trim();
}

function psqlExec(query) {
  const url = dbUrl();
  const res = spawnSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-c', query], { encoding: 'utf-8' });
  if (res.status !== 0) {
    fail(`psql failed (exit ${res.status})`);
    console.error(res.stderr || res.stdout);
    process.exit(res.status || 1);
  }
  return res.stdout.trim();
}

function sqlEscape(s) {
  if (s === null || s === undefined) return 'NULL';
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function parseArgs(argv) {
  const args = { positional: [], flags: {} };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args.flags[key] = next;
        i++;
      } else {
        args.flags[key] = 'true';
      }
    } else {
      args.positional.push(a);
    }
  }
  return args;
}

// ============================================================
// Commands
// ============================================================

function cmdList(args) {
  const status = args.flags.status || 'pending';
  const limit = parseInt(args.flags.limit || '50', 10);
  header(`Access requests · status=${status} · limit=${limit}`);
  const rows = psql(`
    SELECT id, email, company_name, source, ip_address, created_at, reason
    FROM access_requests
    WHERE status = ${sqlEscape(status)}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `);
  if (!rows) { console.log(c.dim + '(no rows)' + c.reset); return; }
  for (const line of rows.split('\n')) {
    const [id, email, company, source, ip, created, reason] = line.split('\t');
    console.log(`${c.bold}${id}${c.reset}  ${c.cyan}${email}${c.reset}  ${c.dim}${company || '—'} · ${source || '—'} · ${ip || '—'} · ${created}${c.reset}`);
    if (reason) console.log(`  ${c.dim}reason:${c.reset} ${reason}`);
  }
}

async function cmdApprove(args) {
  const id = args.positional[1];
  if (!id) { fail('Usage: admin:approve <request_id> [--workspace-id org_xxx]'); process.exit(1); }
  const workspaceId = args.flags['workspace-id'] || null;
  const actor = actorId();

  header(`Approve access request ${id}`);
  const exists = psql(`SELECT email, status FROM access_requests WHERE id = ${sqlEscape(id)}`);
  if (!exists) { fail(`request ${id} not found`); process.exit(1); }
  const [email, currentStatus] = exists.split('\t');
  if (currentStatus !== 'pending') { warn(`request status is '${currentStatus}', not 'pending' — proceeding anyway`); }
  console.log(`  email:        ${email}`);
  console.log(`  workspace:    ${workspaceId || '(not assigned — admin must invite to Clerk org separately)'}`);
  console.log(`  actor:        ${actor}`);

  const rl = createInterface({ input: stdin, output: stdout });
  const confirm = (await rl.question(`Confirm approval? (yes/no): `)).trim().toLowerCase();
  rl.close();
  if (confirm !== 'yes' && confirm !== 'y') { warn('aborted'); process.exit(0); }

  psqlExec(`
    BEGIN;
    UPDATE access_requests
      SET status = 'invited',
          reviewed_at = now(),
          reviewed_by = ${sqlEscape(actor)},
          invited_to_workspace_id = COALESCE(${sqlEscape(workspaceId)}, invited_to_workspace_id),
          updated_at = now()
      WHERE id = ${sqlEscape(id)};
    INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, workspace_id)
      VALUES (${sqlEscape(actor)}, 'access_request_approve', 'access_request', ${sqlEscape(id)}, ${sqlEscape(workspaceId)});
    COMMIT;
  `);
  ok(`Request ${id} marked as invited.`);
  console.log(`\n${c.bold}Next step:${c.reset}`);
  console.log(`  1. In Clerk Dashboard, invite ${email} to the Clerk org ${workspaceId || '(set --workspace-id org_… first)'}`);
  console.log(`  2. After they accept and sign in with that active org, /api/v1/session auto-provisions when CUSTOMER_AUTO_PROVISION_ON_SESSION=true.`);
  console.log(`  3. If auto-provision is disabled, use POST /api/v1/admin/access-requests/${id}/provision { clerk_org_id, owner_clerk_id }.`);
  console.log(`     Local npm run onboard-customer is a break-glass fallback only, not the normal customer onboarding lane.`);
}

async function cmdReject(args) {
  const id = args.positional[1];
  const reason = args.flags.reason;
  if (!id || !reason) { fail('Usage: admin:reject <request_id> --reason "..."'); process.exit(1); }
  const actor = actorId();
  header(`Reject access request ${id}`);
  const rl = createInterface({ input: stdin, output: stdout });
  const confirm = (await rl.question(`Confirm rejection with reason="${reason}"? (yes/no): `)).trim().toLowerCase();
  rl.close();
  if (confirm !== 'yes' && confirm !== 'y') { warn('aborted'); process.exit(0); }

  psqlExec(`
    BEGIN;
    UPDATE access_requests
      SET status = 'rejected',
          reviewed_at = now(),
          reviewed_by = ${sqlEscape(actor)},
          rejection_reason = ${sqlEscape(reason)},
          updated_at = now()
      WHERE id = ${sqlEscape(id)};
    INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, reason)
      VALUES (${sqlEscape(actor)}, 'access_request_reject', 'access_request', ${sqlEscape(id)}, ${sqlEscape(reason)});
    COMMIT;
  `);
  ok(`Request ${id} rejected.`);
}

function cmdListUsers(args) {
  const status = args.flags.status || 'pending';
  const limit = parseInt(args.flags.limit || '50', 10);
  header(`Users · status=${status} · limit=${limit}`);
  const rows = psql(`
    SELECT id, email, status, is_admin, created_at, approved_by
    FROM users
    WHERE status = ${sqlEscape(status)}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `);
  if (!rows) { console.log(c.dim + '(no rows)' + c.reset); return; }
  for (const line of rows.split('\n')) {
    const [id, email, st, isAdmin, created, approvedBy] = line.split('\t');
    const adminTag = isAdmin === 't' ? ` ${c.magenta}[admin]${c.reset}` : '';
    console.log(`${c.bold}${id}${c.reset}${adminTag}  ${c.cyan}${email || '—'}${c.reset}  ${c.dim}${st} · ${created} · approved_by=${approvedBy || '—'}${c.reset}`);
  }
}

async function cmdApproveUser(args) {
  const id = args.positional[1];
  if (!id) { fail('Usage: admin:approve-user <user_id>'); process.exit(1); }
  const actor = actorId();
  header(`Approve user ${id}`);
  const rl = createInterface({ input: stdin, output: stdout });
  const confirm = (await rl.question(`Confirm? (yes/no): `)).trim().toLowerCase();
  rl.close();
  if (confirm !== 'yes' && confirm !== 'y') { warn('aborted'); process.exit(0); }
  psqlExec(`
    BEGIN;
    UPDATE users
      SET status = 'approved',
          approved_at = COALESCE(approved_at, now()),
          approved_by = COALESCE(approved_by, ${sqlEscape(actor)}),
          updated_at = now()
      WHERE id = ${sqlEscape(id)};
    INSERT INTO audit_logs (actor_user_id, action, target_type, target_id)
      VALUES (${sqlEscape(actor)}, 'user_approve', 'user', ${sqlEscape(id)});
    COMMIT;
  `);
  ok(`User ${id} approved.`);
}

async function cmdSuspendUser(args) {
  const id = args.positional[1];
  if (!id) { fail('Usage: admin:suspend-user <user_id>'); process.exit(1); }
  const actor = actorId();
  header(`Suspend user ${id}`);
  const rl = createInterface({ input: stdin, output: stdout });
  const confirm = (await rl.question(`Confirm? (yes/no): `)).trim().toLowerCase();
  rl.close();
  if (confirm !== 'yes' && confirm !== 'y') { warn('aborted'); process.exit(0); }
  psqlExec(`
    BEGIN;
    UPDATE users
      SET status = 'suspended',
          suspended_at = now(),
          updated_at = now()
      WHERE id = ${sqlEscape(id)};
    INSERT INTO audit_logs (actor_user_id, action, target_type, target_id)
      VALUES (${sqlEscape(actor)}, 'user_suspend', 'user', ${sqlEscape(id)});
    COMMIT;
  `);
  ok(`User ${id} suspended.`);
}

function cmdAudit(args) {
  const limit = parseInt(args.flags.limit || '50', 10);
  header(`Audit log · last ${limit} entries`);
  const rows = psql(`
    SELECT occurred_at, actor_user_id, action, target_type, target_id, COALESCE(reason, '')
    FROM audit_logs
    ORDER BY occurred_at DESC
    LIMIT ${limit}
  `);
  if (!rows) { console.log(c.dim + '(no rows)' + c.reset); return; }
  for (const line of rows.split('\n')) {
    const [at, actor, action, ttype, tid, reason] = line.split('\t');
    console.log(`${c.dim}${at}${c.reset}  ${c.bold}${action}${c.reset}  ${c.cyan}${actor}${c.reset} → ${ttype}:${tid}${reason ? `  ${c.dim}${reason}${c.reset}` : ''}`);
  }
}

function help() {
  console.log(`${c.bold}admin-access.mjs${c.reset} — entitlement admin CLI

${c.bold}Commands:${c.reset}
  list                            list pending access requests (--status, --limit)
  approve <id> [--workspace-id W] approve a pending access request
  reject <id> --reason "..."      reject a pending access request
  list-users                      list users (--status, --limit)
  approve-user <user_id>          approve a Neon user (status: pending → approved)
  suspend-user <user_id>          suspend a user (revokes access)
  audit                           tail of audit_logs (--limit)

${c.bold}Env:${c.reset}
  DATABASE_URL=postgresql://…     required, production Neon URL
  ADMIN_USER_ID=user_xxx          your Clerk user_id (for audit attribution; defaults to '__cli__')
`);
}

const args = parseArgs(process.argv);
const cmd = args.positional[0];

switch (cmd) {
  case 'list': cmdList(args); break;
  case 'approve': await cmdApprove(args); break;
  case 'reject': await cmdReject(args); break;
  case 'list-users': cmdListUsers(args); break;
  case 'approve-user': await cmdApproveUser(args); break;
  case 'suspend-user': await cmdSuspendUser(args); break;
  case 'audit': cmdAudit(args); break;
  case undefined:
  case 'help':
  case '-h':
  case '--help':
    help();
    break;
  default:
    fail(`Unknown command: ${cmd}`);
    help();
    process.exit(1);
}
