#!/usr/bin/env node
// onboard-customer.mjs · interactive runbook for onboarding a new customer
//
// Usage:
//   npm run onboard-customer
//
// Prereqs (script checks these):
//   - DATABASE_URL env var set (Neon production URL)
//   - psql CLI installed
//   - Migration 001_init.sql already applied
//
// What this script does:
//   1. Validates DATABASE_URL is set
//   2. Confirms the schema version is at least 1
//   3. Prompts for all customer details (Clerk org ID, names, IDs, project name)
//   4. Renders src/workers/db/seed/customer-template.sql with substitutions
//   5. Writes to .seed-customer-<slug>.sql (gitignored prefix)
//   6. Runs the seed against $DATABASE_URL via psql
//   7. Runs verification queries
//   8. Prints summary + next steps
//
// This script makes NO destructive operations. The seed is idempotent (uses ON CONFLICT).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const TEMPLATE_PATH = resolve(REPO_ROOT, 'src/workers/db/seed/customer-template.sql');

// ---- helpers ----
const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m',
};

function header(s) { console.log(`\n${c.bold}${c.cyan}━━ ${s} ━━${c.reset}`); }
function info(s) { console.log(`${c.dim}${s}${c.reset}`); }
function ok(s) { console.log(`${c.green}✓ ${c.reset}${s}`); }
function warn(s) { console.log(`${c.yellow}⚠ ${c.reset}${s}`); }
function fail(s) { console.error(`${c.red}✗ ${s}${c.reset}`); }

function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function validateClerkOrgId(s) {
  return /^org_[A-Za-z0-9]{5,}$/.test(s || '');
}

function validateClerkUserId(s) {
  return /^user_[A-Za-z0-9]{5,}$/.test(s || '');
}

// R55 Phase 4b · turn the readiness funnel Q&A into a day-1 roadmap the customer sees on first
// login. Scales depth to the AI-readiness level (L0-L5) and account type. Rendered as
// operation_events (source_tool='xlooop', status='queued', visibility='internal_workspace').
function buildDay1Roadmap({ level, accountType }) {
  const lvl = Number.isInteger(level) ? level : 1;
  const steps = [
    {
      summary: 'Confirm your single source of truth',
      body: 'Pick the one place your team already trusts (docs, tracker, or drive) and connect it first in Watch mode. Nothing is changed — Xlooop only observes until you grant Action authority.',
    },
    {
      summary: 'Acknowledge your privacy + authority boundary',
      body: 'Review and accept the in-app authority + consent screen. Private connectors and team invites stay locked until you do — this is the IP boundary that keeps your data yours.',
    },
    {
      summary: 'Connect your first resource in Watch mode',
      body: 'Once consent is recorded, connect a knowledge base or repository read-only. You will see it appear in your operations stream within minutes.',
    },
  ];
  if (lvl >= 2) {
    steps.push({
      summary: 'Map one recurring workflow',
      body: 'Choose a weekly operation (reporting, triage, or review) and let Xlooop watch one full cycle so it can propose a roadmap grounded in your real cadence.',
    });
  }
  if (lvl >= 4) {
    steps.push({
      summary: 'Pilot Action mode on one low-risk task',
      body: 'With a clear owner and a reversible scope, approve a single Action-mode task. Every action stays operator-gated and fully audited.',
    });
  }
  if (accountType === 'company' || accountType === 'both') {
    steps.push({
      summary: 'Invite a teammate',
      body: 'After consent is recorded, invite one teammate as a viewer so they can follow the operations stream. Owners and operators can invite from Settings.',
    });
  }
  return steps;
}

// R55 Phase 4b · governance readiness brief authored from the Q&A. Customer-safe framing only
// (no MB-P internals, no engine formulas). The operator copies this into the customer's MB-P
// ecosystem as governance/AI_TOOL_READINESS.md, where customer-chief-of-staff consumes it.
function buildReadinessBrief({ customerName, customerEmail, accountType, levelLabel, answers, domain, companyName }) {
  const dims = [
    ['Source clarity', 'Is there a clear, single source of truth to connect first?'],
    ['Workflow clarity', 'Are the recurring workflows well-defined enough to observe and map?'],
    ['Privacy boundaries', 'Has the IP / authority boundary (consent) been acknowledged?'],
    ['Owner authority', 'Is there a clear owner who can grant Action authority?'],
    ['Data quality', 'Is the connected data structured and trustworthy enough to act on?'],
    ['Action-mode readiness', 'Is the customer ready to pilot reversible, operator-gated Action mode?'],
  ];
  const answerEntries = Object.entries(answers || {});
  const answerLines = answerEntries.length
    ? answerEntries.map(([k, v]) => `- **${k}:** ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join('\n')
    : '- _(no structured answers captured in the funnel)_';
  const dimLines = dims
    .map(([name, q]) => `### ${name}\n\n${q}\n\n_Operator to score against the Q&A above (readiness level ${levelLabel})._\n`)
    .join('\n');
  return `# AI Tool Readiness — ${customerName}

> Generated by scripts/onboard-customer.mjs (R55 Phase 4b) from the readiness funnel Q&A.
> Customer-safe framing only — no MB-P internals, no engine formulas.

| Field | Value |
|---|---|
| Customer | ${customerName} |
| Contact | ${customerEmail} |
| Account type | ${accountType} |
| Readiness level | ${levelLabel} |
| Company | ${companyName || '—'} |
| Domain | ${domain || '—'} |

## Readiness Q&A (as submitted)

${answerLines}

## Six readiness dimensions

${dimLines}

## Day-1 posture

The customer starts in **Watch mode**. Private connectors and team invites are **locked** until the
in-app authority + consent acknowledgement is recorded (operator approval is already granted at
provisioning). Scale the roadmap depth to the readiness level above.
`;
}

async function main() {
  // ---- 1. Preflight ----
  header('Preflight');

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    fail('DATABASE_URL env var is not set.');
    info('Get the production URL from Neon Dashboard → Connection Details (pooled, sslmode=require)');
    info('Example: export DATABASE_URL="postgres://user:pass@ep-xxx.neon.tech/dbname?sslmode=require"');
    process.exit(1);
  }
  ok(`DATABASE_URL is set (${databaseUrl.replace(/:[^:@]+@/, ':***@').slice(0, 80)}…)`);

  const psqlCheck = spawnSync('psql', ['--version'], { encoding: 'utf-8' });
  if (psqlCheck.status !== 0) {
    fail('psql is not installed or not in PATH.');
    info('macOS: brew install libpq && brew link --force libpq');
    info('Linux: apt install postgresql-client');
    process.exit(1);
  }
  ok(`psql installed: ${psqlCheck.stdout.trim()}`);

  if (!existsSync(TEMPLATE_PATH)) {
    fail(`Template not found: ${TEMPLATE_PATH}`);
    process.exit(1);
  }
  ok(`Template found: src/workers/db/seed/customer-template.sql`);

  // Verify migration is applied
  const versionCheck = spawnSync(
    'psql',
    [databaseUrl, '-tAc', 'SELECT version FROM workers_schema_version ORDER BY version DESC LIMIT 1'],
    { encoding: 'utf-8' }
  );
  if (versionCheck.status !== 0) {
    fail('Could not query workers_schema_version. Migration not applied?');
    info('Run: psql "$DATABASE_URL" -f src/workers/db/migrations/001_init.sql');
    process.exit(1);
  }
  const version = parseInt((versionCheck.stdout || '').trim(), 10);
  if (!version || version < 1) {
    fail(`Schema version is ${version || 'missing'}; need version >= 1`);
    process.exit(1);
  }
  ok(`Schema version is ${version}`);

  // ---- 2. Prompt for inputs ----
  header('Customer details');
  info('Press Ctrl+C anytime to abort. No DB writes happen until you confirm at the end.');

  const rl = createInterface({ input: stdin, output: stdout });

  async function ask(prompt, { required = true, validate, default: dflt } = {}) {
    while (true) {
      const suffix = dflt ? ` [${dflt}]` : '';
      const ans = (await rl.question(`${c.bold}${prompt}${c.reset}${suffix}: `)).trim();
      const value = ans || dflt || '';
      if (!value && required) { fail('Required.'); continue; }
      if (validate && value && !validate(value)) { fail('Invalid format.'); continue; }
      return value;
    }
  }

  const clerkOrgId = await ask('Clerk org ID (org_…)', { validate: validateClerkOrgId });
  const customerName = await ask('Customer display name (e.g. "Acme Corp")');
  const customerSlug = await ask('URL-safe slug', { default: slugify(customerName) });
  const ownerClerkId = await ask('Owner Clerk user ID (user_…)', { validate: validateClerkUserId });
  const sameAsOwner = (await ask('Is the operator the same user as the owner? (y/N)', { required: false })).toLowerCase().startsWith('y');
  const operatorClerkId = sameAsOwner ? ownerClerkId : await ask('Operator Clerk user ID (user_…)', { validate: validateClerkUserId });
  const projectName = await ask('Initial project name (e.g. "Q3 Operations Launch")');
  const projectId = await ask('Project ID slug', { default: `proj_${customerSlug}_001` });
  const customerEmail = await ask(
    'Customer email — imports their readiness funnel Q&A into a day-1 roadmap (optional)',
    { required: false }
  );

  rl.close();

  // ---- 3. Render template ----
  header('Render seed SQL');

  const template = readFileSync(TEMPLATE_PATH, 'utf-8');
  const substitutions = {
    $CLERK_ORG_ID: clerkOrgId,
    $CUSTOMER_NAME: customerName,
    $CUSTOMER_SLUG: customerSlug,
    $OWNER_CLERK_ID: ownerClerkId,
    $OPERATOR_CLERK_ID: operatorClerkId,
    $PROJECT_NAME: projectName,
    $PROJECT_ID: projectId,
  };

  let rendered = template;
  for (const [key, value] of Object.entries(substitutions)) {
    // SQL-escape single quotes by doubling them
    const escaped = String(value).replace(/'/g, "''");
    rendered = rendered.split(key).join(escaped);
  }

  const outPath = resolve(REPO_ROOT, `.seed-customer-${customerSlug}.sql`);
  writeFileSync(outPath, rendered, 'utf-8');
  ok(`Wrote ${outPath}`);
  warn('This file is gitignored via the .seed-* prefix convention — do not commit it.');

  // ---- 4. Confirm + run ----
  header('Confirm + apply');
  console.log(`\n${c.bold}Summary:${c.reset}`);
  console.log(`  Customer:       ${customerName}`);
  console.log(`  Workspace ID:   ${clerkOrgId}`);
  console.log(`  Slug:           ${customerSlug}`);
  console.log(`  Owner:          ${ownerClerkId}`);
  console.log(`  Operator:       ${operatorClerkId}${sameAsOwner ? ' (same as owner)' : ''}`);
  console.log(`  Project:        ${projectName} (${projectId})`);
  console.log(`  DB target:      ${databaseUrl.replace(/:[^:@]+@/, ':***@').slice(0, 80)}…\n`);

  const rl2 = createInterface({ input: stdin, output: stdout });
  const confirm = (await rl2.question(`${c.bold}Apply seed to the database above? (yes/no): ${c.reset}`)).trim().toLowerCase();
  rl2.close();
  if (confirm !== 'yes' && confirm !== 'y') {
    warn('Aborted by operator. Seed file written but not applied.');
    info(`To apply later: psql "$DATABASE_URL" -f ${outPath}`);
    process.exit(0);
  }

  // ---- 5. Apply ----
  header('Apply seed');
  const seedResult = spawnSync(
    'psql',
    [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f', outPath],
    { encoding: 'utf-8', stdio: 'inherit' }
  );
  if (seedResult.status !== 0) {
    fail(`psql exited with status ${seedResult.status}`);
    process.exit(seedResult.status || 1);
  }
  ok('Seed applied.');

  // ---- 6. Verify (R40 · expanded to include users + active membership) ----
  header('Verify');
  const orgEsc = clerkOrgId.replace(/'/g, "''");
  const ownerEsc = ownerClerkId.replace(/'/g, "''");
  const operatorEsc = operatorClerkId.replace(/'/g, "''");
  const verifyQuery = `
    SELECT 'workspace'            AS check_name, COUNT(*) AS rows FROM workspaces WHERE id = '${orgEsc}'
    UNION ALL SELECT 'members_total',           COUNT(*) FROM workspace_members WHERE workspace_id = '${orgEsc}'
    UNION ALL SELECT 'members_active',          COUNT(*) FROM workspace_members WHERE workspace_id = '${orgEsc}' AND status = 'active'
    UNION ALL SELECT 'projects',                COUNT(*) FROM projects WHERE workspace_id = '${orgEsc}'
    UNION ALL SELECT 'events',                  COUNT(*) FROM operation_events WHERE workspace_id = '${orgEsc}'
    UNION ALL SELECT 'user_owner_approved',     COUNT(*) FROM users WHERE id = '${ownerEsc}' AND status = 'approved'
    UNION ALL SELECT 'user_operator_approved',  COUNT(*) FROM users WHERE id = '${operatorEsc}' AND status = 'approved'
    UNION ALL SELECT 'audit_entries_for_seed',  COUNT(*) FROM audit_logs WHERE workspace_id = '${orgEsc}'
  `;
  const verifyResult = spawnSync('psql', [databaseUrl, '-c', verifyQuery], { encoding: 'utf-8' });
  console.log(verifyResult.stdout || verifyResult.stderr);
  ok('Expected: workspace=1 · members_active=1 or 2 · projects=1 · events=1 · user_*_approved=1 · audit_entries_for_seed≥5');

  // ---- 6b. R55 Phase 4b · import readiness Q&A → day-1 roadmap + AI_TOOL_READINESS.md ----
  // Best-effort: a miss here NEVER fails onboarding (the workspace is already provisioned above).
  let roadmapSeeded = 0;
  if (customerEmail) {
    header('Import readiness Q&A');
    try {
      const emailEsc = customerEmail.toLowerCase().replace(/'/g, "''");
      const raQuery = `SELECT row_to_json(r) FROM (
        SELECT account_type, deep_level, company_name, domain, readiness_answers, created_at
        FROM readiness_assessments WHERE email = '${emailEsc}'
        ORDER BY created_at DESC LIMIT 1
      ) r`;
      const raResult = spawnSync('psql', [databaseUrl, '-tAc', raQuery], { encoding: 'utf-8' });
      const raJson = (raResult.stdout || '').trim();
      if (!raJson) {
        warn(`No readiness assessment found for ${customerEmail} — skipping roadmap import.`);
        info('(The customer may have requested access without completing the readiness funnel.)');
      } else {
        const ra = JSON.parse(raJson);
        const level = Number.isInteger(ra.deep_level) ? ra.deep_level : null;
        const levelLabel = level == null ? 'unscored' : `L${level}`;
        const accountType = ra.account_type || 'company';
        const answers = ra.readiness_answers && typeof ra.readiness_answers === 'object' ? ra.readiness_answers : {};
        ok(`Readiness found: account_type=${accountType} · level=${levelLabel} · ${Object.keys(answers).length} answers`);

        // (a) Day-1 roadmap → operation_events (the proven first-login stream).
        const roadmap = buildDay1Roadmap({ level, accountType });
        const orgEscRm = clerkOrgId.replace(/'/g, "''");
        const projEscRm = projectId.replace(/'/g, "''");
        const slugEscRm = customerSlug.replace(/'/g, "''");
        const eventValues = roadmap
          .map((step, i) => {
            const id = `evt_${slugEscRm}_roadmap_${String(i + 1).padStart(2, '0')}`;
            const summaryEsc = step.summary.replace(/'/g, "''");
            const bodyEsc = step.body.replace(/'/g, "''");
            return `  ('${id}', '${orgEscRm}', '${projEscRm}', 'xlooop', 'queued', '${summaryEsc}', '${bodyEsc}', 'internal_workspace', now() + (interval '1 minute' * ${i + 1}))`;
          })
          .join(',\n');
        const roadmapSql = `BEGIN;\nINSERT INTO operation_events (id, workspace_id, project_id, source_tool, status, summary, body, visibility, occurred_at)\nVALUES\n${eventValues}\nON CONFLICT (id) DO UPDATE SET summary = EXCLUDED.summary, body = EXCLUDED.body, status = EXCLUDED.status;\nCOMMIT;\n`;
        const roadmapPath = resolve(REPO_ROOT, `.seed-customer-${customerSlug}-roadmap.sql`);
        writeFileSync(roadmapPath, roadmapSql, 'utf-8');
        const rmResult = spawnSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f', roadmapPath], {
          encoding: 'utf-8',
          stdio: 'inherit',
        });
        if (rmResult.status === 0) {
          roadmapSeeded = roadmap.length;
          ok(`Seeded ${roadmap.length} day-1 roadmap events (visible on first login).`);
        } else {
          warn(`Roadmap seed exited ${rmResult.status} — onboarding still succeeded.`);
        }

        // (b) Governance readiness brief → local artifact for the operator to copy into the
        //     customer's MB-P ecosystem governance/AI_TOOL_READINESS.md (gitignored .onboard-*).
        const brief = buildReadinessBrief({
          customerName,
          customerEmail,
          accountType,
          levelLabel,
          answers,
          domain: ra.domain,
          companyName: ra.company_name,
        });
        const briefPath = resolve(REPO_ROOT, `.onboard-${customerSlug}-AI_TOOL_READINESS.md`);
        writeFileSync(briefPath, brief, 'utf-8');
        ok(`Wrote readiness brief → ${briefPath}`);
        info('Copy it into the customer ecosystem as governance/AI_TOOL_READINESS.md');
      }
    } catch (err) {
      warn(`Readiness import skipped (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- 7. Next steps ----
  header('Next steps');
  console.log(`${c.bold}✓ Customer ${customerName} seeded successfully.${c.reset}\n`);
  console.log('Next:');
  console.log(`  1. Verify the customer can log in via Clerk: ask them to visit your Clerk-hosted sign-in URL`);
  console.log(`  2. After login, they should see workspace "${customerName}" with project "${projectName}"`);
  console.log(`  3. They should see 1 welcome event${roadmapSeeded ? ` + ${roadmapSeeded} day-1 roadmap steps` : ''} in the operations stream`);
  console.log(`  4. To test their data isolation: sign in as a DIFFERENT customer in another browser — they should see ZERO of this customer's data`);
  console.log(`\nTo seed the next customer, re-run: npm run onboard-customer\n`);
}

main().catch((err) => {
  fail('Unhandled error:');
  console.error(err);
  process.exit(1);
});
