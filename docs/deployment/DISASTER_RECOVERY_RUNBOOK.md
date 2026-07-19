# Disaster Recovery Runbook — Xlooop production data plane

> **Status:** operational runbook (Wave M-B, 2026-07-19). Operationalizes the posture described in
> `docs/architecture/CUSTOMER_CONTEXT_BACKUP_ROLLBACK_DESIGN.md`. That design doc records the L2
> database recovery layer; before this runbook there was **no procedural DR document in-repo** — the
> gap the Wave M.3 production-ops risk register flagged (the register also names RLS fail-open on a
> silent DSN unbinding as the top isolation risk; that one is closed by `scripts/preflight-rls-dsn.mjs`).

## 1. Scope and system of record

- **Customer + operational data** lives in the **Neon Postgres operational spine** (Neon project
  `flat-truth-23350426`). This is the authoritative SSOT.
- GitHub / evidence artifacts are a **versioned projection / backup**, not the recovery source.
- Recovery of the data plane therefore means **Neon point-in-time restore (PITR) / branch-from-timestamp**.

## 2. Backup posture (as-configured)

| Layer | Mechanism | Coverage | Current state |
| --- | --- | --- | --- |
| L2 database | Neon PITR / branch-from-timestamp | whole DB, retention-bounded | **`history_retention_seconds = 21600` (6 hours)** on prod `flat-truth-23350426` |

**Retention caveat (load-bearing):** the restore window is **6 hours**. Any incident older than 6
hours cannot be recovered by PITR alone. `CUSTOMER_CONTEXT_BACKUP_ROLLBACK_DESIGN.md` records a **P1
action to raise `history_retention_seconds` 21600 → 604800 (7 days)** — an ops-only Neon setting.
Until that bump lands, treat 6h as the hard RPO ceiling for the automated layer.

## 3. RPO / RTO statement

- **RPO (Recovery Point Objective):** effectively near-zero **within** the retention window — Neon
  PITR restores to an arbitrary timestamp, so at most the last few seconds of writes are at risk.
  **However**, the *maximum age* of any recoverable point is bounded by retention: **6h today**
  (target 7d after the P1 bump). An event discovered > 6h after it occurred is **outside RPO**.
- **RTO (Recovery Time Objective):** target **< 1 hour**. A Neon branch-from-timestamp provisions in
  minutes; the RTO cost is human — detection, decision, verification, and repointing the
  `DATABASE_URL` / `XLOOOP_RLS_APP_DATABASE_URL` secrets at the restored branch.

## 4. Restore drill (non-destructive — NEVER run against prod)

Run this drill on a cadence to keep RTO honest. It creates a throwaway branch, verifies it, and
discards it. **It never writes to, and never repoints prod at, the drill branch.**

Via Neon MCP (preferred) or the Neon console, on project `flat-truth-23350426`:

1. **Create a branch from a timestamp** inside the retention window (e.g. 30 minutes ago):
   - MCP: `create_branch` on project `flat-truth-23350426` with a point-in-time timestamp.
   - Console: Branches → New branch → "From a point in time".
2. **Verify the restored branch** — connect to the branch's connection string (read-only) and
   confirm the spine is coherent:
   - Row counts on the core tables (`workspaces`, `documents`, `intents`, `operation_events`) are
     non-zero and within the expected range for that timestamp.
   - `SELECT max(version) FROM workers_schema_version;` matches the deployed migration head.
   - Spot-check one tenant's row set is present and workspace-scoped.
3. **Record** the drill: timestamp restored, branch id, row-count readback, PASS/FAIL.
4. **Discard the branch** (`delete_branch` / console delete). The drill leaves zero residue.

> Do NOT drill against the prod branch, and do NOT repoint any secret at a drill branch. A real
> restore (§5) is a separate, operator-authorized action.

## 5. Real restore (incident) — operator-authorized only

1. **Stop the bleed** if the incident is ongoing (e.g. pause the writing surface).
2. **Create a branch from the last-known-good timestamp** (must be within retention — if the
   incident is > 6h old and the P1 bump has not landed, PITR cannot help; escalate).
3. **Verify** the branch as in §4 step 2.
4. **Repoint prod** at the restored branch: update `DATABASE_URL` **and**
   `XLOOOP_RLS_APP_DATABASE_URL` (the NOBYPASSRLS app DSN) to the restored branch's connection
   strings via `wrangler secret put`, then redeploy the API worker. `scripts/preflight-rls-dsn.mjs`
   gates the redeploy so the RLS DSN cannot be left unbound during the scramble.
5. **Confirm** health readback and tenant isolation post-cutover (RLS soak).

## 6. Escalation path

1. **Detect / declare** — whoever observes the incident declares it and records the discovery time
   (this starts the RPO clock against the 6h window).
2. **Operator (Marat)** authorizes any real restore or secret repoint — DR touches production data
   and secrets, which are operator-gated actions (never agent-initiated).
3. **Execute** the §5 restore under operator authorization; keep the §4 drill as the rehearsed path.
4. **Post-incident:** record the RPO actually achieved, whether retention was the binding
   constraint, and re-raise the P1 retention bump if 6h was insufficient.

## 7. Related

- `docs/architecture/CUSTOMER_CONTEXT_BACKUP_ROLLBACK_DESIGN.md` — the design this operationalizes.
- `scripts/preflight-rls-dsn.mjs` — the deploy hard-gate that keeps the RLS DSN bound (closes the
  M.3 top risk, RLS fail-open on silent unbinding).
- `docs/deployment/PRODUCTION_READINESS_STATE.yml` — the generated readiness projection.
