# Infrastructure Cost Budget — pilot phase (app.xlooop.com)

**As of:** 2026-07-21 · **Phase:** pilot (unpaid: you ×2 workspaces + Andrey/ASP) · **Owner:** Marat Basyrov

> Purpose: a weekly/monthly cost forecast against each provider's free-tier quota, so infra spend stays
> controlled until we have paying customers. Prices are current-as-of-writing estimates — **verify against
> the live dashboards** (links in §4) before treating any number as billed truth.

## 1. The stack + where money is actually spent

| Service | What it is | Plan | Free quota (the ceiling) | Overage price |
|---|---|---|---|---|
| **Neon** | Postgres (prod DB `flat-truth-23350426`) | Free or Launch $19/mo | Free: 0.5 GB storage · ~191 compute-hr/mo · autosuspend after idle. Launch: 10 GB · 300 compute-hr | ~$0.16 / extra compute-hour |
| **Cloudflare Workers** | the API (`api.xlooop.com`) + crons | Free or Paid $5/mo | Free: 100k requests/day · 10 ms CPU/req | Paid: 10M req/mo included, then $0.30/M |
| **Cloudflare Pages** | `www` + `app.xlooop.com` static | Free | 500 builds/mo · unlimited requests | — |
| **Anthropic API** | Claude (cockpit chat, digests, enrichment) | pay-as-you-go | none | Sonnet ≈ $3/M input · $15/M output tokens |
| **Clerk** | auth / login | Free | 10,000 monthly active users | Pro $25/mo beyond |

## 2. The dominant lever — Neon compute (and why the cron change matters)

Neon bills **compute by the hour the DB is ACTIVE**; it autosuspends after ~5 min idle. Anything that
wakes it frequently keeps it billing 24/7.

- **BEFORE (260721):** a `*/5 * * * *` cron woke Neon **every 5 minutes → it never suspended → ~720
  compute-hr/month.** That is ~3.7× the free-tier ceiling (191 hr) — the single biggest line, likely
  $20–50+/mo in compute alone even with almost no user traffic.
- **AFTER (this change):** all crons dialed to **daily** (6 brief wakes/day) → Neon suspends between wakes
  and real user activity → estimated **~20–60 compute-hr/month** → within Launch, near/within Free.

**This is the headline saving: dialing the crons to daily removes the 24/7 Neon compute bill.** Nothing
else in the stack is a comparable lever at pilot scale.

## 3. Forecast (pilot, AFTER the dial-down)

| Service | Weekly | Monthly | Notes |
|---|---|---|---|
| Neon | ~$0–5 | **~$0–19** | Free tier likely covers it now; Launch $19 only if storage/compute grows |
| Cloudflare Workers | $0 | **$0** | <1k req/day + 6 crons/day ≪ free tier |
| Cloudflare Pages | $0 | **$0** | free tier |
| Clerk | $0 | **$0** | 3 users ≪ 10k MAU |
| Anthropic (Claude) | ~$1–5 | **~$5–20** | the main variable — scales with chat volume; **deep-research (Claude premium) is the pricey path — reserve it** |
| **TOTAL (pilot)** | **~$1–10/wk** | **~$5–40/mo** | dominated by Claude usage + whether Neon needs Launch |

**Interpretation:** at pilot scale this stack should run **under ~$40/month**, and most of that is
usage-based Claude tokens — i.e. it scales with actual value delivered, not idle infra. The infra floor
(Neon/CF/Clerk) is ~$0–19/mo.

## 4. Verify against live quotas (do this weekly — 5 minutes)

| Provider | Dashboard | What to read |
|---|---|---|
| Neon | console.neon.tech → project → **Billing / Usage** | compute-hours used this month vs plan ceiling; storage GB |
| Cloudflare | dash.cloudflare.com → Workers & Pages → **Metrics** | requests/day, CPU-ms vs free tier |
| Anthropic | console.anthropic.com → **Usage** | tokens + $ this month; watch deep-research spend |
| Clerk | dashboard.clerk.com → **Users** | MAU vs 10k free |

## 5. Cost-control rules for the pilot

1. **Crons daily, not sub-daily** (done 260721). Restore `*/5` propagation + hourly loops only when paid
   customers need real-time behaviour — and price the Neon compute delta first.
2. **Reserve deep-research** (Claude premium tier) for high-value queries; default chat uses the cheaper path.
3. **Keep Neon branches clean** — throwaway verify branches must auto-expire (each holds storage).
4. **New always-on/frequent cron = a Neon-cost decision.** Any new sub-daily trigger keeps Neon awake;
   evaluate the compute cost before adding one.
5. **Re-run this forecast when a paying customer lands** — real traffic changes Neon compute + Claude
   tokens materially; the free-tier assumptions no longer hold.

## 6. Not yet costing (watch as they activate)
- Personalization pipeline (SEED/APPLY/MATERIALIZE): **~$0** — MATERIALIZE is an arm of the existing daily
  cron (no new wake), APPLY is one profile read per chat, signals are tiny.
- Turnstile / rate-limiter / Sentry: free/low tiers at pilot volume.
- If `TENANT_PROJECTION_QUEUE` is ever enabled, a Cloudflare Queue is a new (small) line — price it then.
