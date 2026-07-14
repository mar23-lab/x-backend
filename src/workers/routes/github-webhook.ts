// github-webhook.ts · R54-Stage1 · GitHub → operation_events producer
//
// THE FIRST REAL EVENT PRODUCER. Public endpoint (no Clerk) gated by GitHub's
// HMAC-SHA256 signature. When the operator pushes a commit / opens a PR / files
// an issue, GitHub POSTs here and we translate it into operation_events — so the
// cockpit shows REAL daily activity (the dogfood objective) instead of only the
// hand-pushed governance stream.
//
// Security model:
//   - PUBLIC route (GitHub can't present a Clerk JWT). The ONLY gate is the
//     X-Hub-Signature-256 HMAC over the raw body, verified against the
//     GITHUB_WEBHOOK_SECRET worker secret (constant-time compare). A bad/absent
//     signature → 401 with ZERO DB writes. Missing secret → 503 (closed).
//   - We read the RAW body for HMAC, then JSON.parse it. Never trust the parsed
//     body before the signature passes.
//
// Attribution: events are written to the workspace resolved from the repo via
// GITHUB_WEBHOOK_REPO_MAP (JSON { "<owner/repo>": { workspace_id, project_id } })
// with a GITHUB_WEBHOOK_DEFAULT_WORKSPACE fallback. The workspace MUST be one the
// operator owns so Stage-2's operator-overlay surfaces it; we never invent a
// workspace from untrusted payload data.

import { Hono } from 'hono';
import { errorEnvelope, clientError } from '../middleware/error';
import type { AuthEnv } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';
import type { HarnessFlowEventInput } from '../dal/types';
import { classifyBodyOfWork } from '../lib/classify-body-of-work';

export interface GithubWebhookEnv extends AuthEnv {
  GITHUB_WEBHOOK_SECRET?: string;
  // JSON: { "owner/repo": { "workspace_id": "...", "project_id"?: "...", "split"?: true } }
  //   - workspace_id (required per repo) — the operator-owned workspace to attribute to.
  //   - project_id   (optional) — pin EVERY event from this repo to one project (legacy behaviour).
  //   - split        (optional) — "going-forward attribution": when true and no explicit project_id
  //                  is set, each event self-files into one of the 8 bodies-of-work projects via
  //                  classifyBodyOfWork(), producing project_id = `${workspace_id}-<slug>`.
  //                  ONLY enable split for a workspace that actually has the 8 canonical projects
  //                  (`${workspace_id}-{cockpit-ux,event-pipeline,infra-deploy,governance,
  //                  onboarding,commercial-gtm,investor,funnel}`) — see the runbook.
  GITHUB_WEBHOOK_REPO_MAP?: string;
  GITHUB_WEBHOOK_DEFAULT_WORKSPACE?: string; // fallback workspace_id when a repo isn't in the map
}

export interface GithubWebhookVariables {
  dal: DalAdapter;
  request_id?: string;
}

export const githubWebhookRoute = new Hono<{ Bindings: GithubWebhookEnv; Variables: GithubWebhookVariables }>();

// ── HMAC-SHA256 signature verification (Workers Web Crypto) ────────────────
async function verifyGithubSignature(secret: string, rawBody: string, sigHeader: string): Promise<boolean> {
  if (!sigHeader || !sigHeader.startsWith('sha256=')) return false;
  const expectedHex = sigHeader.slice('sha256='.length).trim();
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const macBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const computedHex = Array.from(new Uint8Array(macBuf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  // constant-time-ish compare (equal length first, then xor-accumulate)
  if (computedHex.length !== expectedHex.length) return false;
  let diff = 0;
  for (let i = 0; i < computedHex.length; i++) diff |= computedHex.charCodeAt(i) ^ expectedHex.charCodeAt(i);
  return diff === 0;
}

const clip = (s: unknown, n: number): string => String(s ?? '').slice(0, n);

// ── repo → {workspace_id, project_id, split} attribution (operator-owned only) ──
interface Attribution {
  workspace_id: string;
  project_id: string | null; // explicit per-repo pin (null = none)
  split: boolean;            // going-forward per-event classification enabled
}

function resolveAttribution(env: GithubWebhookEnv, fullName: string): Attribution | null {
  let map: Record<string, { workspace_id?: string; project_id?: string; split?: boolean }> = {};
  try { map = env.GITHUB_WEBHOOK_REPO_MAP ? JSON.parse(env.GITHUB_WEBHOOK_REPO_MAP) : {}; } catch { map = {}; }
  const hit = map[fullName];
  if (hit && hit.workspace_id) {
    return { workspace_id: hit.workspace_id, project_id: hit.project_id ?? null, split: hit.split === true };
  }
  const fallback = (env.GITHUB_WEBHOOK_DEFAULT_WORKSPACE || '').trim();
  if (fallback) return { workspace_id: fallback, project_id: null, split: false };
  return null; // no safe attribution → caller drops the event (never guesses)
}

// ── per-event project resolution ──────────────────────────────────────────
// Precedence: explicit attribution.project_id wins (legacy pin). Else, if split
// is enabled, self-file via the classifier into `${workspace_id}-<slug>` (the
// 8 canonical bodies-of-work projects). Else null (unchanged behaviour).
//
// SAFETY: split MUST only be enabled (in GITHUB_WEBHOOK_REPO_MAP) for a workspace
// that actually has the 8 canonical projects. classifyBodyOfWork is total and
// only ever returns one of those 8 slugs, so the resulting id is always one of a
// known, pre-created set — we never invent an arbitrary project id from payload.
function resolveProjectId(
  attribution: Attribution,
  summary: string,
  changedPaths?: string[],
): string | null {
  if (attribution.project_id) return attribution.project_id;
  if (attribution.split) return `${attribution.workspace_id}-${classifyBodyOfWork(summary, changedPaths)}`;
  return null;
}

// changed paths for a single push commit (added ∪ modified ∪ removed), used as
// classifier path-hints when split is enabled. Returns undefined when none.
function commitChangedPaths(c: any): string[] | undefined {
  const parts = [c?.added, c?.modified, c?.removed]
    .filter(Array.isArray)
    .flat()
    .filter((p: unknown): p is string => typeof p === 'string');
  return parts.length > 0 ? parts : undefined;
}

// ── webhook payload → HarnessFlowEventInput[] (mirrors translator field choices) ──
// `attribution` carries workspace_id + optional explicit project_id + split flag;
// each event's project_id is resolved per-event via resolveProjectId (so split
// commits self-file into the right body-of-work project).
function mapPushEvent(payload: any, attribution: Attribution): HarnessFlowEventInput[] {
  const repo = clip(payload?.repository?.full_name, 200) || 'unknown/repo';
  const commits = Array.isArray(payload?.commits) ? payload.commits : [];
  return commits.map((c: any): HarnessFlowEventInput => {
    const firstLine = clip(c?.message, 4000).split('\n')[0] || clip(c?.id, 7);
    const rest = clip(c?.message, 4000).slice(firstLine.length + 1).trim();
    const summary = clip(`[${repo}] ${firstLine}`, 512);
    return {
      id: `gh_commit_${repo}_${clip(c?.id, 40)}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 128),
      source_tool: 'github',
      agent_id: `github:${clip(c?.author?.username || c?.author?.name, 80) || 'unknown'}`,
      project_id: resolveProjectId(attribution, summary, commitChangedPaths(c)),
      status: 'completed',
      summary,
      body: rest.length > 0 ? clip(rest, 4000) : null,
      evidence_link: clip(c?.url, 400) || `https://github.com/${repo}`,
      visibility: 'internal_workspace',
      occurred_at: clip(c?.timestamp, 40) || new Date().toISOString(),
    };
  });
}

function mapPullEvent(payload: any, attribution: Attribution): HarnessFlowEventInput[] {
  const repo = clip(payload?.repository?.full_name, 200) || 'unknown/repo';
  const p = payload?.pull_request;
  if (!p) return [];
  const summary = clip(`[${repo}#${p?.number}] PR: ${clip(p?.title, 300)}`, 512);
  return [{
    id: `gh_pull_${repo}_${clip(p?.id, 40)}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 128),
    source_tool: 'github',
    agent_id: `github:${clip(p?.user?.login, 80) || 'unknown'}`,
    project_id: resolveProjectId(attribution, summary), // PR/issues: classify by summary only
    status: p?.state === 'closed' ? 'completed' : 'running',
    summary,
    body: p?.body ? clip(p.body, 4000) : null,
    evidence_link: clip(p?.html_url, 400),
    visibility: 'internal_workspace',
    occurred_at: clip(p?.updated_at || p?.created_at, 40) || new Date().toISOString(),
  }];
}

function mapIssuesEvent(payload: any, attribution: Attribution): HarnessFlowEventInput[] {
  const repo = clip(payload?.repository?.full_name, 200) || 'unknown/repo';
  const i = payload?.issue;
  if (!i) return [];
  const summary = clip(`[${repo}#${i?.number}] ${clip(i?.title, 300)}`, 512);
  return [{
    id: `gh_issue_${repo}_${clip(i?.id, 40)}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 128),
    source_tool: 'github',
    agent_id: `github:${clip(i?.user?.login, 80) || 'unknown'}`,
    project_id: resolveProjectId(attribution, summary), // PR/issues: classify by summary only
    status: i?.state === 'closed' ? 'completed' : 'running',
    summary,
    body: i?.body ? clip(i.body, 4000) : null,
    evidence_link: clip(i?.html_url, 400),
    visibility: 'internal_workspace',
    occurred_at: clip(i?.updated_at || i?.created_at, 40) || new Date().toISOString(),
  }];
}

githubWebhookRoute.post('/webhooks/github', async (ctx) => {
  try {
    const env = ctx.env as GithubWebhookEnv;
    const secret = (env.GITHUB_WEBHOOK_SECRET || '').trim();
    if (!secret) {
      return clientError(ctx, 503, 'SERVICE_UNAVAILABLE', 'GITHUB_WEBHOOK_SECRET not configured');
    }

    // Read RAW body FIRST (HMAC is over the exact bytes GitHub signed).
    const rawBody = await ctx.req.text();
    const sig = ctx.req.header('X-Hub-Signature-256') || '';
    const ok = await verifyGithubSignature(secret, rawBody, sig);
    if (!ok) {
      return clientError(ctx, 401, 'UNAUTHORIZED', 'invalid or missing X-Hub-Signature-256');
    }

    const eventType = ctx.req.header('X-GitHub-Event') || '';
    if (eventType === 'ping') {
      return ctx.json({ ok: true, pong: true });
    }

    let payload: any;
    try { payload = JSON.parse(rawBody); } catch {
      return clientError(ctx, 400, 'VALIDATION_ERROR', 'body is not valid JSON');
    }

    const fullName = clip(payload?.repository?.full_name, 200);
    const attribution = resolveAttribution(env, fullName);
    if (!attribution) {
      // signature was valid but we have no safe workspace to attribute to.
      // Acknowledge (so GitHub doesn't retry) but record nothing.
      return ctx.json({ ok: true, ignored: 'no_attribution_for_repo', repo: fullName });
    }

    let events: HarnessFlowEventInput[] = [];
    if (eventType === 'push') events = mapPushEvent(payload, attribution);
    else if (eventType === 'pull_request') events = mapPullEvent(payload, attribution);
    else if (eventType === 'issues') events = mapIssuesEvent(payload, attribution);
    else return ctx.json({ ok: true, ignored: 'unhandled_event_type', event: eventType });

    const dal = ctx.get('dal');
    let created = 0, updated = 0;
    for (const ev of events) {
      try {
        const r = await dal.upsertEvent(attribution.workspace_id, ev);
        if (r?.created) created += 1; else updated += 1;
      } catch (_) { /* per-event best-effort; one bad commit never fails the batch */ }
    }
    return ctx.json({ ok: true, event: eventType, repo: fullName, workspace_id: attribution.workspace_id, events_received: events.length, created, updated });
  } catch (err) {
    return errorEnvelope(ctx, err);
  }
});
