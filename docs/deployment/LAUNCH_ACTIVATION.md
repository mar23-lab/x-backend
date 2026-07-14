# Launch Activation Runbook — Xlooop commercial launch (260629)

The product is **built + deployed + LIVE in production, dormant behind flags**. Everything below is
operator-gated (it needs the Cloudflare/Clerk/Neon dashboards or real sign-ups an agent can't perform).
Do them in order; each is independently reversible.

## 1 · Cloudflare dashboard → Workers → `xlooop-api` → Settings → Variables
Enter values **unquoted** (e.g. `true`, not `"true"` — the worker parses tolerantly either way, but unquoted is cleanest).

| Variable | Set to | Activates | Reversible |
|---|---|---|---|
| `ADMIN_NOTIFICATION_EMAIL` | your ops email(s), comma-sep | the lead emails actually SEND (else they only log to Workers console) | delete the var |
| `EMAIL_FROM_ADDRESS` | e.g. `noreply@notify.xlooop.com` | the Cloudflare Email sender | — |
| `CUSTOMER_SELF_SERVICE_ENABLED` | `true` | event delete/restore + "Update my onboarding roadmap" re-entry | set to `false` |
| `ENRICHMENT_SWEEP_ENABLED` | `true` | the REAL public-signal sweep on submit (free DNS SPF/DMARC + HTTPS/TLS immediately) | set to `false` |
| `HIBP_API_KEY` *(optional)* | your HaveIBeenPwned key | breach-exposure signal in enrichment | delete |
| `BUILTWITH_API_KEY` *(optional)* | your BuiltWith key | tech-stack signal in enrichment | delete |

`CUSTOMER_INAPP_READINESS_GATE` is already on (Part M).

## 2 · Browser-verify on real accounts (the round-trips an agent can't perform)
1. **Funnel → lead → email:** complete `xlooop.com/readiness` **without** registering → confirm a row lands in `access_requests`/`readiness_assessments` + an operator email fires marked **"NO — anonymous website lead"**. Then register with that same email → the new workspace inherits the captured context (the AI knows the company).
2. **Connected Claude knows the company:** after a real sign-up, run the connector command (`claude mcp add --transport http xlooop https://api.xlooop.com/api/v1/mcp/rpc --header "Authorization: Bearer <token>"`) → ask a company-specific question → it answers from the captured context, not a generic stereotype.
3. **Self-service (after flag 1):** delete an event → the Profile "recently deleted" panel → 30-day countdown → restore.
4. **Real sweep (after flag 2):** a fresh submit → the AI profile carries real `public_signals` (SPF/DMARC/TLS).

## 3 · Neon (prod-DB — apply ONLY when activating the feature)
- `src/workers/db/migrations/039_gmail_source.sql` + `040_outlook_source.sql` — admit gmail/outlook to the source/provider CHECKs. Apply ONLY together with §4 (the translators are dormant until then).
- **Reconcile the migration-037 collision:** there are now two `037_*.sql` (the customer-token one + an RLS one from a parallel PR). Renumber one before applying migrations in order.

## 4 · Per-provider OAuth — for Gmail/Outlook ingestion
1. Do **not** make restricted mailbox scopes a blanket Google/Microsoft sign-in requirement. `gmail.readonly` and `Mail.Read` must be requested/proven only for the source-connect flow, or the provider must remain canary/test-user only.
2. Run ONE real-API smoke (a live call against a test mailbox) per provider and confirm the source row is workspace-bound before any translator writes events.
3. Flip `TRANSLATOR_VERIFICATION` (`src/workers/sources/translators/index.ts`) gmail/outlook → `true` only after the restricted-scope path, sync, and operation_events ingestion are proven. **The `verify:translator-live-verification` gate blocks exposing unverified translators before this** — that ordering is enforced.

## 5 · Remaining product roadmap (mine, next focused sessions)
- **Wave C S5b** — the remaining picker providers (Slack/Jira/Confluence/Salesforce/Xero/Linear/Trello), each its own build on the proven gmail/outlook recipe.
- **DAL facade decomposition** — the mechanical file-split of `WorkersDalAdapter.ts`. The structural fix (stop the ceiling-bump treadmill) is already enforced by the `FROZEN_DECOMPOSE` ratchet check; the split is now forced on the next DAL addition.
