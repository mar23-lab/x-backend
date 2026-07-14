# Execution-Pipeline Activation Runbook — `EXECUTOR_MODE`

**What this flips on:** the OS-3 execution pipeline (PRs #610/#611). Today a chat **Command** "draft a
digest" persists `operation_events` `status='queued'` / `next_action='execute:digest'` but **nothing
runs it** — the executor is built and merged but **INERT** (`EXECUTOR_MODE="disabled"`). Activating it
lets the hourly `:45` cron drain the queue: atomically claim `queued→running`, draft the digest, and
**append a governed `needs_review`/`pending` proposal** the operator signs off. It never auto-posts.

**Risk:** low. Governed (proposal-only) · run-exactly-once (atomic claim) · never-throws · status-only
transitions on an append-only log. Worst case = a stranded `running` row in a crash window (known
Wave-2.2+ gap; needs a claim-timestamp reclaim). Fully reversible (flip back to `disabled`).

---

## 0 · Pre-flight (read-only — confirm before flipping)

```bash
# (a) the executor code is deployed (HEAD on the api worker must include a2b4caff / #610).
git log --oneline -1 a2b4caff   # the executor commit must be an ancestor of the deployed SHA

# (b) the operator identity set is configured — the executor scopes the queue to it and FAIL-CLOSES
#     to a no-op if unset (zero workspaces found). Same var the digest sweep already uses.
#     Confirm MBP_OWNER_USER_ID is set on the worker (Cloudflare dashboard → xlooop-api → Variables),
#     or it's already a secret (do NOT print its value).

# (c) EXECUTOR_MODE is currently disabled (the default).
grep '^EXECUTOR_MODE' wrangler.toml     # -> EXECUTOR_MODE = "disabled"
```

If (b) is unset, set `MBP_OWNER_USER_ID` first (it's also required by the weekly digest sweep, so it
is almost certainly already set in prod).

---

## 1 · Activate (pick ONE)

**Option A — no redeploy (fastest, recommended for the first trial):**
Set the worker env var directly, exactly as `DIGEST_SWEEP_ENABLED` / `RECLASSIFY_CRON_ENABLED` are:

- Cloudflare dashboard → Workers & Pages → **xlooop-api** → Settings → Variables and Secrets →
  add/edit `EXECUTOR_MODE` = `enabled` → Save & deploy.
- OR: `wrangler secret put EXECUTOR_MODE` → type `enabled`.

Only the exact string `enabled` (case-insensitive) activates it; anything else stays inert.

**Option B — via redeploy (makes it the committed default):**
```bash
# edit wrangler.toml: EXECUTOR_MODE = "enabled"
npm run deploy:api
```

---

## 2 · Verify (live, end-to-end)

1. **Enqueue.** Signed into the cockpit, open the composer, switch the Send-dropdown to **Command**,
   send: `draft a digest`. (Read modes / Intent do NOT enqueue an executor verb — only Command.)
2. **Confirm queued.** The new row should carry `status='queued'`, `next_action='execute:digest'`:
   ```sql
   SELECT id, status, next_action, occurred_at
   FROM operation_events
   WHERE next_action = 'execute:digest'
   ORDER BY occurred_at DESC LIMIT 3;
   ```
3. **Wait for the cron.** It runs hourly at **:45** (`45 * * * *`). (For an immediate test you can
   trigger the scheduled handler via the Cloudflare dashboard's "Trigger scheduled event" / `wrangler`
   cron trigger, choosing the `45 * * * *` schedule.)
4. **Confirm it ran.** After the cron:
   - the **request** row flips `queued → completed`;
   - a **new** proposal row `evt_exec_digest_<request-id>` appears with `status='needs_review'`,
     `approval_state='pending'`, `next_action='approve_to_post_digest'` — and lands in the **"needs you"**
     queue / notifications bell.
   ```sql
   SELECT id, status, approval_state, next_action FROM operation_events
   WHERE id LIKE 'evt_exec_digest_%' ORDER BY occurred_at DESC LIMIT 3;
   ```
5. **Monitor the run** (`wrangler tail xlooop-api`): look for
   `[cron:reclassify_unattributed] {... "ops_queue_drain": {"status":"completed","executed":1,...}}`.
   The drain is chained into the hourly reclassify slot (`reclassifyThenDrainQueue`); `executed` counts
   verbs run, `failed`/`skipped_*` the rest. A `status:'skipped','reason':'executor_disabled'` means the
   flag didn't take.
6. **Approve.** Sign off the proposal (POST /sign-offs / the "needs you" approve action) → it becomes a
   governed, official digest. This is the full loop the operator could not previously close.

---

## 3 · Rollback (instant, reversible)

Set `EXECUTOR_MODE` back to `disabled` (same mechanism as activation). The very next cron run is inert
— zero DB calls. No data migration, no cleanup: already-appended proposals remain as normal pending
proposals the operator can approve or reject.

---

## Notes
- **Cadence is hourly by design.** The cron is the guaranteed-eventually backstop. A future slice may
  add an inline drain at enqueue for sub-minute responsiveness.
- **One verb today** (`digest`). Adding a verb = a handler in `operations-queue-consumer.ts`
  `VERB_HANDLERS` + an enqueue path in `operator-capture.js` `executableVerb` — kept in sync by the
  `verify:execution-pipeline-parity` gate (it fails the build if you add one without the other).
- **Known gap:** a worker crash between claim and finalize strands a request in `running` (the next
  poll only sees `queued`). Documented in the consumer header; the reclaim needs a claim timestamp.
