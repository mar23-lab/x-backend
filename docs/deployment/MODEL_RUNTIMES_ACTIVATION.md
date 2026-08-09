# Wave C — model-runtimes activation runbook

**STATUS:** Source contract implemented; deployment activation still requires environment-specific evidence.
Migration 053 owns provider configuration, and staged migration 098 widens execution receipts to the governed
provider registry. The `/api/v1/model-runtimes/*` routes are auth/RBAC-gated. Credential writes remain
fail-closed when the encryption key is unavailable.

- Migration 053: provider configuration, override, RLS, and audited writes.
- Migration 098: staged provider-superset constraint for execution receipts.
- Production chat: live-provider-only; typed `503 PROVIDER_UNAVAILABLE` when no approved runtime succeeds.
- Execution boundary: tenant credentials are decrypted only in memory inside fixed server adapters for
  Anthropic, OpenAI, Google Gemini, Mistral, DeepSeek, OpenRouter, and allowlisted Azure OpenAI hosts.
  Workers AI and the platform-managed Anthropic credential remain platform fallbacks.
- Local/custom runtimes return `RELAY_REQUIRED` until an authenticated outbound relay exists; Bedrock returns
  `ADAPTER_UNAVAILABLE` until a reviewed SigV4 adapter exists. No arbitrary tenant URL is fetched by cloud code.

⚠️ Note: the API is **`api.xlooop.com`**, NOT `app.xlooop.com` (that host is the Pages SPA frontend).

## Step 1 — configure deployment secrets through the approved operator process
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

`MODEL_RUNTIME_ENC_KEY` enables encrypted configuration writes and in-memory decryption for tenant execution.
`ANTHROPIC_API_KEY` is the separately managed platform fallback credential; the Workers AI path uses the
`AI` binding. Do not paste secret values into
chat, tickets, logs, or repository files. Then run the smoke test to confirm the deployed contract.

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

Inspect the effective runtime and supported model catalog:

```
curl -sS "$API/model-runtimes/effective" -H "Authorization: Bearer $JWT" | jq '{effective, fallback_count, resolution_attempts}'
curl -sS "$API/model-runtimes/providers/anthropic/models" -H "Authorization: Bearer $JWT" | jq
```

Perform a bounded content-free validation call:

```
curl -sS -X POST "$API/model-runtimes/providers/anthropic/validate" -H "Authorization: Bearer $JWT" | jq '{ok, validation_receipt_id, audit_recorded, runtime_id, provider, model, latency_ms, usage}'
```

Validation must return an audit receipt and must not return credential material. Customer and operator chat
resolve `request preference -> user override -> workspace default -> platform default`. A request preference
is accepted only after tenant and model validation. When all approved live runtimes are
unavailable, chat returns `503 PROVIDER_UNAVAILABLE` without an `answer` field; deterministic prose is never
substituted in commercial mode.

## Security properties (enforced by `verify:model-runtime-secret-safety`, ci-local)
- AES-256-GCM encrypted at rest (fresh 96-bit IV per record; tamper-evident tag).
- Reads return only `····last4` — plaintext + ciphertext never leave the worker.
- Writes + the default flip are owner/operator-gated + audited (`target_type = model_runtime_provider`).
- Live validation is owner/operator-gated, entitlement-aware, content-free, and audited.
- Chat, discovery, and validation decrypt only the selected tenant credential in server memory; responses,
  audit metadata, and logs contain neither plaintext nor ciphertext.
- Fail-closed: absent/short `MODEL_RUNTIME_ENC_KEY` → credential writes 503, never a plaintext fallback.

## Key rotation — ⚠️ NOT YET IMPLEMENTED
Rotating `MODEL_RUNTIME_ENC_KEY` orphans all stored credentials (no versioned-keyring / re-encrypt path;
`enc_version` is reserved but unwired). To change the key: bind the new key, then re-enter every provider
credential (`PUT /model-runtimes/providers/:provider`) so they re-seal under it. Dual-key overlap + an
`enc_version`-keyed re-encrypt sweep is future work.

## Rollback
Migration 098 only widens the execution-receipt provider constraint and is forward-compatible with earlier
providers. Roll back the worker through the normal release process while preserving encryption material;
deleting `MODEL_RUNTIME_ENC_KEY` is not an ordinary dispatcher rollback because it makes stored configuration
credentials unreadable. Migration 053 remains forward-only.
