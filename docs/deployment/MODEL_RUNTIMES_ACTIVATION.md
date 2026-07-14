# Wave C — model-runtimes activation runbook

**STATUS (260708): LIVE, one step remains.** The worker is deployed (`api.xlooop.com`, build `a45f0c69`),
migration 053 is applied (schema head 55), the `/api/v1/model-runtimes/*` routes are wired + auth-gated. The
ONLY remaining step is binding the master encryption key — until then, credential **writes** return `503`
(fail-closed; nothing stores plaintext) and **reads** degrade to `[]`. Everything else is done.

- ✅ Migration 053 applied (model_runtime_providers + user_runtime_override, RLS, audit CHECK). Verified.
- ✅ Deployed (`npm run deploy:api` → `a45f0c69`; `/api/v1/health` build match, `sentry_active:true`, zero-5xx).
- ⏳ **Step 1 below — bind `MODEL_RUNTIME_ENC_KEY` (YOU do this; I can't hold your master key).**

⚠️ Note: the API is **`api.xlooop.com`**, NOT `app.xlooop.com` (that host is the Pages SPA frontend).

## Step 1 — generate + bind the master key  ← THE ONLY REMAINING STEP
The key is base64 of 32 random bytes. It never goes in git, the DB, or an agent's context — you generate +
bind it directly. ⚠️ Run each line separately (zsh does NOT treat `#` as a comment interactively — never
paste inline comments). First `cd` into the repo, then generate:

```
cd /Users/maratbasyrov/WIP/Xlooop/_wt/frontend-exec-260703
openssl rand -base64 32
```

`openssl` prints a 44-char string ending in `=`. **SAVE it in your password manager** (losing it orphans all
stored credentials), then bind it (paste the SAME value at the `Enter a secret value:` prompt):

```
npx wrangler secret put MODEL_RUNTIME_ENC_KEY --config wrangler.toml
```

Confirm it is set (prints the name only; the value is never shown):

```
npx wrangler secret list --config wrangler.toml | grep MODEL_RUNTIME_ENC_KEY
```

Once bound, credential writes work immediately (the worker reads the secret at runtime — no manual redeploy).
Then run the smoke test (Step 2) to confirm end-to-end.

## Step 2 — smoke test (needs an operator JWT for a real workspace)
Get a JWT from the browser (logged into app.xlooop.com as an owner/operator): DevTools → Application →
copy the Clerk session token, or from a `/api/v1/session` request's `Authorization` header.

Run each block separately (no inline comments — zsh-safe). Set your JWT + the base URL first:

```
JWT='<paste operator JWT>'
API='https://api.xlooop.com/api/v1'
```

List the 13 providers (masked; never a raw/ciphertext key):

```
curl -sS "$API/model-runtimes/providers" -H "Authorization: Bearer $JWT" | jq '{providers:(.providers|length), allowed_actions, workspace_default}'
```

Set a provider key (server encrypts, stores ciphertext, returns masked `····last4`):

```
curl -sS -X PUT "$API/model-runtimes/providers/anthropic" -H "Authorization: Bearer $JWT" -H 'content-type: application/json' -d '{"credential":{"api_key":"sk-ant-YOUR-REAL-KEY"}}' | jq '.provider | {provider, masked_key, configured}'
```

Flip the workspace default (audited → `audit_logs` `model_runtime_default_change`); use an `mrp_` id from the list:

```
curl -sS -X PUT "$API/model-runtimes/default" -H "Authorization: Bearer $JWT" -H 'content-type: application/json' -d '{"provider_id":"<mrp_id>"}' | jq '.workspace_default'
```

Expected: list returns masked entries (never plaintext/ciphertext); the audit trail records the flip
(`GET /api/v1/audit-log?format=csv` shows `model_runtime_default_change`).

## Security properties (enforced by `verify:model-runtime-secret-safety`, ci-local)
- AES-256-GCM encrypted at rest (fresh 96-bit IV per record; tamper-evident tag).
- Reads return only `····last4` — plaintext + ciphertext never leave the worker.
- Writes + the default flip are owner/operator-gated + audited (`target_type = model_runtime_provider`).
- Fail-closed: absent/short `MODEL_RUNTIME_ENC_KEY` → credential writes 503, never a plaintext fallback.

## Key rotation — ⚠️ NOT YET IMPLEMENTED
Rotating `MODEL_RUNTIME_ENC_KEY` orphans all stored credentials (no versioned-keyring / re-encrypt path;
`enc_version` is reserved but unwired). To change the key: bind the new key, then re-enter every provider
credential (`PUT /model-runtimes/providers/:provider`) so they re-seal under it. Dual-key overlap + an
`enc_version`-keyed re-encrypt sweep is future work.

## Rollback
Additive + inert until a key is stored. To disable: `npx wrangler secret delete MODEL_RUNTIME_ENC_KEY`
(writes then 503; masked reads still list). Worker rollback: `npx wrangler rollback` (reverts to the prior
version). Migration 053 is forward-only.
