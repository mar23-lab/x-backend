# Readiness Contract (SSOT) — Part R/S · 260629

**Status:** canonical · enforced by `scripts/verify-readiness-journey-parity.mjs` (S-R2b).
**Why:** the readiness journey has TWO implementations — the public website funnel (`x-web`,
`xlooop.com/readiness`) and the in-app journey (`Xlooop-XCP-demo`, `src/widgets/ReadinessJourney`).
They diverged silently (caps, dropped fields, demo-vs-real) — the Part-R failure. This doc is the
single source of truth both MUST conform to; the parity gate asserts the backend accepts + consumes
the canonical field set so a future change to one journey can't silently break the other.

See `[[journey-parity-verify-the-live-surface]]` (memory) for the discipline.

---

## 1. The capture surfaces (both POST the same shape)

| Journey | Auth | Endpoint | Notes |
|---|---|---|---|
| Website funnel (x-web) | anonymous (public) | `POST /api/v1/request-access` | early lead-capture at the report + the explicit register step |
| In-app journey (Xlooop-XCP-demo) | Clerk JWT | `POST /api/v1/readiness/submit` | first-login / Profile re-entry |

Both routes persist into `access_requests` + `readiness_assessments` and feed the SAME consumers (§4).

## 2. The questions + caps (canonical)

| id | question (intent) | type | cap | maps to |
|---|---|---|---|---|
| `q1` | biggest problem to solve in 90 days | text | **4000** | `focus_90d` |
| `q2` | top-customer revenue share | text | **120** | `customer_concentration` |
| `q3` | cyber incident / near-miss? (+ `q3_detail`) | yes/no + text | detail unbounded | `cyber_flag` |
| `q4` | grow / sustain / transition / exit | select | — | `growth_posture` |
| `q5` | anything else | text (optional) | **4000** | `notes` |

Caps MUST match across both journeys. The serialized `readiness_answers` object is bounded to **256 KB**
(`boundedRecord`, `request-access.ts` / `readiness.ts`) — the whole object is dropped past that, so
keep per-field caps well under it.

## 3. The payload (canonical request body)

```
{
  email,                      // required
  company_name, domain, country,
  account_type,               // 'personal' | 'company' | 'both'
  also_personal_space,
  deep_level,                 // 0-5 (AI-readiness)
  readiness_answers: {        // JSONB — the canonical field set
    q1, q2, q3, q3_detail, q4, q5,
    ai_tools,                 // string[]  → ai_tools_in_use
    integrations,             // [{id,label}] → data_lives_in + Connect-tasks
    oauth_granted, oauth_platform,
    context,                  // ctx_v1 CompanyContext (optional; drives the resolver roadmap)
  },
  deep_check, enrichment,     // JSONB — enrichment = the real /enrich public-signal sweep → public_signals
  consent,                    // { privacy, data_processing, contact, auto_captured? }
  source,                     // 'x-web-readiness-funnel' | 'x-web-readiness-register' | 'inapp-readiness-journey'
  reason, turnstile_token,
}
```

**CANONICAL `readiness_answers` keys** (the parity gate asserts the backend reads each): `q1 q2 q3
q3_detail q4 q5 ai_tools integrations`. Dropping any of these from a journey's payload is the Part-R
regression (the website was silently dropping `ai_tools` / `integrations` / `enrichment`).

## 4. The consumers (capture implies consumption — S7 `verify:context-reaches-consumer`)

- `buildCustomerContextProfile` (`src/workers/dal/customer-context-store.ts`) — `focus_90d`(q1) ·
  `growth_posture`(q4) · `customer_concentration`(q2) · `cyber_flag`(q3) · `notes`(q5) ·
  `ai_tools_in_use`(ai_tools) · `data_lives_in`(integrations) · `maturity_level`(deep_level) ·
  `public_signals`(enrichment). Read by the MCP `get_effective_profile` + the cockpit chat + the digest.
- `provisionCustomerFromAccessRequest` (`onboarding-provisioner.ts`) — scales the day-1 roadmap from
  `deep_level`/`context` + appends a Connect-task per `integrations` (`buildConnectTasks`).
- `notifyAdminAccessRequest` (`email-notifier.ts`) — the operator lead email (+ the not-registered marker).

## 5. The demo boundary (S-R2a `verify-data-source-truth` / demo-must-be-labeled)

A readiness REPORT shown before the user's real data is connected is a DEMO and MUST carry an explicit
demo marker (the x-web `report-welcome.jsx` SAMPLE banner). The real report is the provisioned
workspace (real data via the consumers above), never the seeded marketing report.

## 6. Change rule (S-R0 meta-rule)

Changing the question set, a cap, or a `readiness_answers` key REQUIRES: (a) updating this doc, (b) both
journeys conforming, (c) the parity gate green. Never change one journey's readiness surface alone.
