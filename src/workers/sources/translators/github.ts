// translators/github.ts · R50.3c · 2026-05-28
//
// Authority: R50 plan stage R50.3c · CLERK_OAUTH_PROVIDER_CONFIG.md
//
// Pulls GitHub commits + PRs + issues metadata from repositories the user
// has access to (owner / collaborator / org member). Emits operation_events
// with source_tool='github', subject to contract-enforcer validation.
//
// API SURFACE USED:
//   GET /user/repos                   · list repos the user has access to
//   GET /repos/{owner}/{repo}/commits · commit metadata since last sync
//   GET /repos/{owner}/{repo}/pulls   · PR metadata
//   GET /repos/{owner}/{repo}/issues  · issue metadata (filters out PRs)
//
// RATE LIMIT:
//   Authenticated: 5000 req/hour. We respect X-RateLimit-Remaining and stop
//   the run if remaining < 100 to leave headroom for other Xlooop callers.
//   R50.3d will add per-translator rate-limit accounting; for now we use
//   GitHub's own headers as the source of truth.
//
// CONTRACT INVARIANT:
//   Every emitted event is validated by enforceContract() before DAL.upsertEvent.
//   max_body_bytes (default 200) truncates commit/PR/issue body silently.
//   We NEVER pull file content, diff content, or attachment payloads.

import { enforceContract } from '../contract-enforcer';
import type {
  TranslatorInput,
  TranslatorResult,
  TranslatorError,
} from './types';
import { DEFAULT_MAX_EVENTS_PER_RUN } from './types';
import type { HarnessFlowEventInput } from '../../dal/types';

const GITHUB_API = 'https://api.github.com';
const RATE_LIMIT_HEADROOM = 100;

interface GitHubRepo {
  id?: number;
  name: string;
  full_name: string;
  owner: { login: string };
  default_branch: string;
  pushed_at: string;
  private?: boolean;
  description?: string | null;
  html_url?: string;
}

/** Clean, wire-safe repo shape for the operator-facing repo picker. */
export interface GitHubRepoSummary {
  id: number;
  full_name: string;
  name: string;
  owner: string;
  private: boolean;
  default_branch: string;
  pushed_at: string;
  description: string | null;
  html_url: string;
}

interface GitHubCommit {
  sha: string;
  commit: {
    author?: { name?: string; email?: string; date?: string } | null;
    message: string;
  };
  author?: { login?: string } | null;
}

interface GitHubPull {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
  html_url: string;
}

interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  pull_request?: { url: string }; // present → it's a PR, not a real issue
}

async function gh<T>(
  path: string,
  token: string,
  rateRemaining: { remaining: number },
): Promise<{ data: T; rateRemaining: number } | { error: TranslatorError }> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'xlooop-r50.3c-translator',
    },
  });
  const remainingHeader = res.headers.get('X-RateLimit-Remaining');
  const remaining = remainingHeader ? parseInt(remainingHeader, 10) : rateRemaining.remaining;
  rateRemaining.remaining = remaining;

  if (res.status === 429 || res.status === 403) {
    return { error: { code: 'github_api_rate_limited', message: `GitHub ${res.status}: ${await res.text()}`, upstream: `github_${res.status}` } };
  }
  if (res.status === 401) {
    return { error: { code: 'github_api_unauthorized', message: 'GitHub token rejected', upstream: 'github_401' } };
  }
  if (!res.ok) {
    return { error: { code: 'github_api_error', message: `GitHub ${res.status}: ${await res.text()}`, upstream: `github_${res.status}` } };
  }
  const data = (await res.json()) as T;
  return { data, rateRemaining: remaining };
}

/**
 * List the repositories the authenticated GitHub user can access (owner /
 * collaborator / org member), most-recently-pushed first. Used by the
 * operator-facing repo picker (GET /sources/:id/repos) so a specific repo can
 * be bound to a project (project_source_bindings). Throws an Error (with a
 * `.code`) on GitHub API failure so the route can map it to a status.
 */
export async function listUserRepos(token: string): Promise<GitHubRepoSummary[]> {
  const rate = { remaining: 5000 };
  const resp = await gh<GitHubRepo[]>(
    '/user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=pushed&direction=desc',
    token,
    rate,
  );
  if ('error' in resp) {
    const e = new Error(resp.error.message) as Error & { code?: string; upstream?: string };
    e.code = resp.error.code;
    e.upstream = resp.error.upstream;
    throw e;
  }
  return resp.data.map((r) => ({
    id: r.id ?? 0,
    full_name: r.full_name,
    name: r.name,
    owner: r.owner?.login ?? (r.full_name.split('/')[0] || ''),
    private: !!r.private,
    default_branch: r.default_branch,
    pushed_at: r.pushed_at,
    description: r.description ?? null,
    html_url: r.html_url ?? `https://github.com/${r.full_name}`,
  }));
}

/** Build a deterministic event id from provider primitives — idempotent across runs. */
function eventIdForCommit(repoFullName: string, sha: string): string {
  return `usc_evt_github_commit_${repoFullName.replace('/', '_')}_${sha}`;
}
function eventIdForPull(repoFullName: string, id: number): string {
  return `usc_evt_github_pr_${repoFullName.replace('/', '_')}_${id}`;
}
function eventIdForIssue(repoFullName: string, id: number): string {
  return `usc_evt_github_issue_${repoFullName.replace('/', '_')}_${id}`;
}

/** Construct an event from a GitHub commit. */
function commitToEvent(
  repo: GitHubRepo,
  c: GitHubCommit,
  workspaceId: string,
): HarnessFlowEventInput {
  const firstLine = c.commit.message.split('\n')[0] || c.sha.slice(0, 7);
  const body = c.commit.message.length > firstLine.length
    ? c.commit.message.slice(firstLine.length + 1).trim() // skip the newline
    : null;
  return {
    id: eventIdForCommit(repo.full_name, c.sha),
    source_tool: 'github',
    agent_id: `github:${c.author?.login || c.commit.author?.name || 'unknown'}`,
    project_id: null,
    intent_id: null,
    status: 'completed',
    summary: `[${repo.full_name}] ${firstLine.slice(0, 180)}`,
    body: body && body.length > 0 ? body : null,
    evidence_link: `https://github.com/${repo.full_name}/commit/${c.sha}`,
    visibility: 'internal_workspace',
    occurred_at: c.commit.author?.date || new Date().toISOString(),
  };
}

function pullToEvent(repo: GitHubRepo, p: GitHubPull): HarnessFlowEventInput {
  return {
    id: eventIdForPull(repo.full_name, p.id),
    source_tool: 'github',
    agent_id: `github:${p.user?.login || 'unknown'}`,
    project_id: null,
    intent_id: null,
    status: p.state === 'closed' ? 'completed' : 'running',
    summary: `[${repo.full_name}#${p.number}] PR: ${p.title.slice(0, 180)}`,
    body: p.body && p.body.length > 0 ? p.body : null,
    evidence_link: p.html_url,
    visibility: 'internal_workspace',
    occurred_at: p.created_at,
  };
}

function issueToEvent(repo: GitHubRepo, i: GitHubIssue): HarnessFlowEventInput {
  return {
    id: eventIdForIssue(repo.full_name, i.id),
    source_tool: 'github',
    agent_id: `github:${i.user?.login || 'unknown'}`,
    project_id: null,
    intent_id: null,
    status: i.state === 'closed' ? 'completed' : 'running',
    summary: `[${repo.full_name}#${i.number}] ${i.title.slice(0, 180)}`,
    body: i.body && i.body.length > 0 ? i.body : null,
    evidence_link: i.html_url,
    visibility: 'internal_workspace',
    occurred_at: i.created_at,
  };
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

export async function runTranslator(input: TranslatorInput): Promise<TranslatorResult> {
  const { adapter, dal, userSource, since } = input;
  const maxEvents = input.max_events ?? DEFAULT_MAX_EVENTS_PER_RUN;
  const errors: TranslatorError[] = [];
  let events_emitted = 0;
  let events_rejected = 0;
  const rateRemaining = { remaining: Number.MAX_SAFE_INTEGER };
  const workspaceId = userSource.workspace_id ?? '';

  // 1) Get token via adapter
  let token: string;
  try {
    const snapshot = await adapter.getAccessToken(userSource.user_id, 'github');
    token = snapshot.token;
  } catch (err) {
    return {
      events_emitted: 0,
      events_rejected: 0,
      errors: [{
        code: (err as { code?: string }).code || 'OAUTH_CLERK_API_ERROR',
        message: (err as Error).message,
        upstream: 'clerk_adapter',
      }],
      completed_at: new Date().toISOString(),
    };
  }

  // 2) List repos (page 1 only · ~30 most-recently-pushed; R50.3d will paginate if needed)
  const reposResp = await gh<GitHubRepo[]>(
    `/user/repos?per_page=30&affiliation=owner,collaborator,organization_member&sort=pushed&direction=desc`,
    token,
    rateRemaining,
  );
  if ('error' in reposResp) {
    errors.push(reposResp.error);
    return { events_emitted, events_rejected, errors, completed_at: new Date().toISOString() };
  }
  const repos = reposResp.data;

  // 3) For each repo: pull commits + PRs + issues since the cutoff
  for (const repo of repos) {
    if (events_emitted >= maxEvents) break;
    if (rateRemaining.remaining < RATE_LIMIT_HEADROOM) {
      errors.push({ code: 'github_api_rate_limited', message: `Rate budget headroom < ${RATE_LIMIT_HEADROOM}; stopping early`, upstream: 'github_rate_headroom' });
      break;
    }
    // Skip repos whose pushed_at is older than `since` — no new events.
    if (repo.pushed_at && repo.pushed_at < since) continue;

    // Commits
    const commitsResp = await gh<GitHubCommit[]>(
      `/repos/${repo.full_name}/commits?since=${encodeURIComponent(since)}&per_page=30`,
      token,
      rateRemaining,
    );
    if ('error' in commitsResp) { errors.push(commitsResp.error); continue; }
    for (const c of commitsResp.data) {
      if (events_emitted >= maxEvents) break;
      const event = commitToEvent(repo, c, workspaceId);
      const verdict = enforceContract(event, userSource.contract);
      if (!verdict.ok) { events_rejected++; continue; }
      try {
        await dal.upsertEvent(workspaceId, verdict.event);
        events_emitted++;
      } catch (err) {
        errors.push({ code: 'dal_upsert_failed', message: (err as Error).message });
      }
    }

    // Pulls (no native `since` filter — client-side filter on updated_at)
    if (events_emitted < maxEvents) {
      const pullsResp = await gh<GitHubPull[]>(
        `/repos/${repo.full_name}/pulls?state=all&per_page=30&sort=updated&direction=desc`,
        token,
        rateRemaining,
      );
      if ('error' in pullsResp) { errors.push(pullsResp.error); }
      else {
        for (const p of pullsResp.data) {
          if (events_emitted >= maxEvents) break;
          if (p.updated_at < since) break; // sorted desc · earliest break
          const event = pullToEvent(repo, p);
          const verdict = enforceContract(event, userSource.contract);
          if (!verdict.ok) { events_rejected++; continue; }
          try { await dal.upsertEvent(workspaceId, verdict.event); events_emitted++; }
          catch (err) { errors.push({ code: 'dal_upsert_failed', message: (err as Error).message }); }
        }
      }
    }

    // Issues (filter out PRs — GitHub returns PRs in the issues endpoint by default)
    if (events_emitted < maxEvents) {
      const issuesResp = await gh<GitHubIssue[]>(
        `/repos/${repo.full_name}/issues?state=all&since=${encodeURIComponent(since)}&per_page=30`,
        token,
        rateRemaining,
      );
      if ('error' in issuesResp) { errors.push(issuesResp.error); }
      else {
        for (const i of issuesResp.data) {
          if (events_emitted >= maxEvents) break;
          if (i.pull_request) continue; // skip PRs — handled above
          const event = issueToEvent(repo, i);
          const verdict = enforceContract(event, userSource.contract);
          if (!verdict.ok) { events_rejected++; continue; }
          try { await dal.upsertEvent(workspaceId, verdict.event); events_emitted++; }
          catch (err) { errors.push({ code: 'dal_upsert_failed', message: (err as Error).message }); }
        }
      }
    }
  }

  return {
    events_emitted,
    events_rejected,
    errors,
    completed_at: new Date().toISOString(),
  };
}
