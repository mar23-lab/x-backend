// github-webhook-split.test.ts
//
// Integration coverage for "going-forward attribution" in the GitHub webhook
// producer. We post a synthetic, HMAC-signed `push` whose commits map to
// different bodies-of-work buckets and assert:
//   - split:true  → each event self-files into `${workspace_id}-<slug>`.
//   - split:false → project_id stays null (unchanged legacy behaviour).
//   - explicit project_id in the repo map still wins over split.
//
// The route's ONLY gate is the X-Hub-Signature-256 HMAC over the raw body, so we
// compute a real signature with Web Crypto (workerd test env). The DAL is a stub
// that records every (workspace_id, event) it's asked to upsert.

import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { githubWebhookRoute } from '../routes/github-webhook';

const SECRET = 'whsec_test_going_forward';
const WS = 'org_3EG82VEzc8t3t65XSZ0YDlcaDMI';
const REPO = 'mar23-lab/Xlooop-XCP-demo';

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const hex = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}`;
}

interface Recorded { workspace_id: string; project_id: string | null; summary: string }

function appWith(repoMap: Record<string, unknown>) {
  const recorded: Recorded[] = [];
  const dal = {
    upsertEvent: async (workspace_id: string, event: { project_id?: string | null; summary: string }) => {
      recorded.push({ workspace_id, project_id: event.project_id ?? null, summary: event.summary });
      return { created: true };
    },
  };
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    ctx.set('dal', dal as never);
    await next();
  });
  app.route('/api/v1', githubWebhookRoute);
  const env = {
    GITHUB_WEBHOOK_SECRET: SECRET,
    GITHUB_WEBHOOK_REPO_MAP: JSON.stringify(repoMap),
  };
  return { app, env, recorded };
}

// Synthetic push: 4 commits, each authored to land in a distinct bucket.
const PUSH_PAYLOAD = {
  repository: { full_name: REPO },
  commits: [
    { id: 'aaa1111', message: 'feat(investor): pitch deck v3 + data room download', author: { username: 'mar23' }, url: `https://github.com/${REPO}/commit/aaa1111`, timestamp: '2026-06-09T01:00:00Z', added: ['investor/deck.html'], modified: [], removed: [] },
    { id: 'bbb2222', message: 'feat(R54-Stage1): GitHub webhook producer — ingest commits', author: { username: 'mar23' }, url: `https://github.com/${REPO}/commit/bbb2222`, timestamp: '2026-06-09T02:00:00Z', added: [], modified: ['src/workers/routes/github-webhook.ts'], removed: [] },
    { id: 'ccc3333', message: 'chore(deploy): bump __V3_BUILD and ship to app.xlooop.com', author: { username: 'mar23' }, url: `https://github.com/${REPO}/commit/ccc3333`, timestamp: '2026-06-09T03:00:00Z', added: [], modified: ['wrangler.toml'], removed: [] },
    { id: 'ddd4444', message: 'tweak whitespace', author: { username: 'mar23' }, url: `https://github.com/${REPO}/commit/ddd4444`, timestamp: '2026-06-09T04:00:00Z', added: [], modified: ['src/widgets/Cockpit.tsx'], removed: [] },
  ],
};

async function postPush(app: Hono, env: unknown) {
  const body = JSON.stringify(PUSH_PAYLOAD);
  const sig = await sign(SECRET, body);
  return app.request(
    '/api/v1/webhooks/github',
    {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        'X-Hub-Signature-256': sig,
      },
    },
    env as never,
  );
}

describe('GitHub webhook · going-forward attribution (split)', () => {
  let recorded: Recorded[];

  it('split:true → each commit self-files into ${workspace_id}-<slug>', async () => {
    const ctx = appWith({ [REPO]: { workspace_id: WS, split: true } });
    recorded = ctx.recorded;
    const res = await postPush(ctx.app, ctx.env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; events_received: number };
    expect(body.ok).toBe(true);
    expect(body.events_received).toBe(4);

    expect(recorded).toHaveLength(4);
    for (const r of recorded) expect(r.workspace_id).toBe(WS);

    const bySha = (substr: string) => recorded.find((r) => r.summary.includes(substr))!;
    expect(bySha('pitch deck').project_id).toBe(`${WS}-investor`);
    expect(bySha('webhook producer').project_id).toBe(`${WS}-event-pipeline`);
    expect(bySha('bump __V3_BUILD').project_id).toBe(`${WS}-infra-deploy`);
    // ambiguous summary "tweak whitespace" → path hint src/widgets rescues cockpit-ux
    expect(bySha('tweak whitespace').project_id).toBe(`${WS}-cockpit-ux`);
  });

  it('split:false (default) → project_id stays null for every event', async () => {
    const ctx = appWith({ [REPO]: { workspace_id: WS } }); // no split flag
    const res = await postPush(ctx.app, ctx.env);
    expect(res.status).toBe(200);
    expect(ctx.recorded).toHaveLength(4);
    for (const r of ctx.recorded) {
      expect(r.workspace_id).toBe(WS);
      expect(r.project_id).toBeNull();
    }
  });

  it('explicit project_id in the repo map wins over split classification', async () => {
    const PINNED = `${WS}-legacy-pin`;
    const ctx = appWith({ [REPO]: { workspace_id: WS, project_id: PINNED, split: true } });
    const res = await postPush(ctx.app, ctx.env);
    expect(res.status).toBe(200);
    expect(ctx.recorded).toHaveLength(4);
    for (const r of ctx.recorded) expect(r.project_id).toBe(PINNED);
  });

  it('rejects an unsigned push with 401 and writes nothing', async () => {
    const ctx = appWith({ [REPO]: { workspace_id: WS, split: true } });
    const body = JSON.stringify(PUSH_PAYLOAD);
    const res = await ctx.app.request(
      '/api/v1/webhooks/github',
      { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'push' } },
      ctx.env as never,
    );
    expect(res.status).toBe(401);
    expect(ctx.recorded).toHaveLength(0);
  });
});

describe('GitHub webhook · split applies to pull_request + issues (summary-only)', () => {
  it('a split PR self-files by its title', async () => {
    const ctx = appWith({ [REPO]: { workspace_id: WS, split: true } });
    const payload = {
      repository: { full_name: REPO },
      pull_request: { id: 99, number: 520, title: 'feat(onboarding): customer provisioner', state: 'open', user: { login: 'mar23' }, html_url: `https://github.com/${REPO}/pull/520`, created_at: '2026-06-09T05:00:00Z' },
    };
    const body = JSON.stringify(payload);
    const sig = await sign(SECRET, body);
    const res = await ctx.app.request(
      '/api/v1/webhooks/github',
      { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'pull_request', 'X-Hub-Signature-256': sig } },
      ctx.env as never,
    );
    expect(res.status).toBe(200);
    expect(ctx.recorded).toHaveLength(1);
    expect(ctx.recorded[0].project_id).toBe(`${WS}-onboarding`);
  });
});
