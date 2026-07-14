// translators/gitlab.ts · R50.3c · 2026-05-28
//
// Authority: R50 plan stage R50.3c · CLERK_OAUTH_PROVIDER_CONFIG.md
//
// Pulls GitLab commits + merge requests + issues metadata from projects the
// user is a member of (owned + collaborator + group membership). Emits
// operation_events with source_tool='gitlab'.
//
// API SURFACE USED:
//   GET /api/v4/projects                                    · list projects
//   GET /api/v4/projects/{id}/repository/commits            · commit metadata
//   GET /api/v4/projects/{id}/merge_requests                · MR metadata
//   GET /api/v4/projects/{id}/issues                        · issue metadata
//
// SCOPES REQUIRED (configured in Clerk dashboard):
//   read_user · read_repository · read_api
//
// RATE LIMIT:
//   GitLab.com authenticated: 600 req/min. We respect RateLimit-Remaining
//   header (no X- prefix on GitLab; just `RateLimit-Remaining`).
//   R50.3d adds explicit backoff; R50.3c stops on low remaining or 429.
//
// CONTRACT INVARIANT:
//   Per-event enforceContract() before DAL.upsertEvent.

import { enforceContract } from '../contract-enforcer';
import type { TranslatorInput, TranslatorResult, TranslatorError } from './types';
import { DEFAULT_MAX_EVENTS_PER_RUN } from './types';
import type { HarnessFlowEventInput } from '../../dal/types';

// GitLab.com by default; self-hosted instances would override via a future
// user_source_connections.metadata.host_override (out of scope for R50.3c).
const GITLAB_API = 'https://gitlab.com/api/v4';
const RATE_LIMIT_HEADROOM = 50;

interface GitLabProject {
  id: number;
  path_with_namespace: string;
  default_branch: string;
  last_activity_at: string;
  web_url: string;
}

interface GitLabCommit {
  id: string;
  short_id: string;
  title: string;
  message: string;
  author_name: string;
  author_email: string;
  authored_date: string;
  web_url: string;
}

interface GitLabMergeRequest {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  state: 'opened' | 'closed' | 'merged' | 'locked';
  author: { username: string } | null;
  created_at: string;
  updated_at: string;
  web_url: string;
}

interface GitLabIssue {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  state: 'opened' | 'closed';
  author: { username: string } | null;
  created_at: string;
  updated_at: string;
  web_url: string;
}

async function gl<T>(
  path: string,
  token: string,
  rateRemaining: { remaining: number },
): Promise<{ data: T } | { error: TranslatorError }> {
  const res = await fetch(`${GITLAB_API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': 'xlooop-r50.3c-translator',
    },
  });
  const remainingHeader = res.headers.get('RateLimit-Remaining') || res.headers.get('X-RateLimit-Remaining');
  if (remainingHeader) rateRemaining.remaining = parseInt(remainingHeader, 10);
  if (res.status === 429) {
    const retryAfter = res.headers.get('Retry-After') || '';
    return { error: { code: 'gitlab_rate_limited', message: `GitLab 429; Retry-After=${retryAfter}`, upstream: 'gitlab_429' } };
  }
  if (res.status === 401) {
    return { error: { code: 'gitlab_unauthorized', message: 'GitLab token rejected', upstream: 'gitlab_401' } };
  }
  if (!res.ok) {
    return { error: { code: 'gitlab_api_error', message: `GitLab ${res.status}: ${await res.text()}`, upstream: `gitlab_${res.status}` } };
  }
  return { data: (await res.json()) as T };
}

function eventIdForCommit(projectId: number, sha: string): string {
  return `usc_evt_gitlab_commit_${projectId}_${sha.slice(0, 16)}`;
}
function eventIdForMR(projectId: number, id: number): string {
  return `usc_evt_gitlab_mr_${projectId}_${id}`;
}
function eventIdForIssue(projectId: number, id: number): string {
  return `usc_evt_gitlab_issue_${projectId}_${id}`;
}

function commitToEvent(project: GitLabProject, c: GitLabCommit): HarnessFlowEventInput {
  const body = c.message.length > c.title.length
    ? c.message.slice(c.title.length).trim()
    : null;
  return {
    id: eventIdForCommit(project.id, c.id),
    source_tool: 'gitlab',
    agent_id: `gitlab:${c.author_name || 'unknown'}`,
    project_id: null,
    intent_id: null,
    status: 'completed',
    summary: `[${project.path_with_namespace}] ${c.title.slice(0, 180)}`,
    body: body && body.length > 0 ? body : null,
    evidence_link: c.web_url,
    visibility: 'internal_workspace',
    occurred_at: c.authored_date,
  };
}

function mrToEvent(project: GitLabProject, m: GitLabMergeRequest): HarnessFlowEventInput {
  return {
    id: eventIdForMR(project.id, m.id),
    source_tool: 'gitlab',
    agent_id: `gitlab:${m.author?.username || 'unknown'}`,
    project_id: null,
    intent_id: null,
    status: m.state === 'merged' || m.state === 'closed' ? 'completed' : 'running',
    summary: `[${project.path_with_namespace}!${m.iid}] MR: ${m.title.slice(0, 180)}`,
    body: m.description && m.description.length > 0 ? m.description : null,
    evidence_link: m.web_url,
    visibility: 'internal_workspace',
    occurred_at: m.created_at,
  };
}

function issueToEvent(project: GitLabProject, i: GitLabIssue): HarnessFlowEventInput {
  return {
    id: eventIdForIssue(project.id, i.id),
    source_tool: 'gitlab',
    agent_id: `gitlab:${i.author?.username || 'unknown'}`,
    project_id: null,
    intent_id: null,
    status: i.state === 'closed' ? 'completed' : 'running',
    summary: `[${project.path_with_namespace}#${i.iid}] ${i.title.slice(0, 180)}`,
    body: i.description && i.description.length > 0 ? i.description : null,
    evidence_link: i.web_url,
    visibility: 'internal_workspace',
    occurred_at: i.created_at,
  };
}

export async function runTranslator(input: TranslatorInput): Promise<TranslatorResult> {
  const { adapter, dal, userSource, since } = input;
  const maxEvents = input.max_events ?? DEFAULT_MAX_EVENTS_PER_RUN;
  const errors: TranslatorError[] = [];
  let events_emitted = 0;
  let events_rejected = 0;
  const rateRemaining = { remaining: Number.MAX_SAFE_INTEGER };
  const workspaceId = userSource.workspace_id ?? '';

  let token: string;
  try {
    const snapshot = await adapter.getAccessToken(userSource.user_id, 'gitlab');
    token = snapshot.token;
  } catch (err) {
    return {
      events_emitted: 0,
      events_rejected: 0,
      errors: [{ code: (err as { code?: string }).code || 'OAUTH_CLERK_API_ERROR', message: (err as Error).message, upstream: 'clerk_adapter' }],
      completed_at: new Date().toISOString(),
    };
  }

  // List projects (page 1 only, sorted by recent activity)
  const projectsResp = await gl<GitLabProject[]>(
    `/projects?membership=true&simple=true&per_page=30&order_by=last_activity_at&sort=desc`,
    token,
    rateRemaining,
  );
  if ('error' in projectsResp) {
    errors.push(projectsResp.error);
    return { events_emitted, events_rejected, errors, completed_at: new Date().toISOString() };
  }

  for (const project of projectsResp.data) {
    if (events_emitted >= maxEvents) break;
    if (rateRemaining.remaining < RATE_LIMIT_HEADROOM) {
      errors.push({ code: 'gitlab_rate_limited', message: `Rate budget < ${RATE_LIMIT_HEADROOM}; stopping early`, upstream: 'gitlab_rate_headroom' });
      break;
    }
    if (project.last_activity_at && project.last_activity_at < since) continue;

    // Commits
    const commitsResp = await gl<GitLabCommit[]>(
      `/projects/${project.id}/repository/commits?since=${encodeURIComponent(since)}&per_page=30`,
      token,
      rateRemaining,
    );
    if ('error' in commitsResp) { errors.push(commitsResp.error); continue; }
    for (const c of commitsResp.data) {
      if (events_emitted >= maxEvents) break;
      const event = commitToEvent(project, c);
      const verdict = enforceContract(event, userSource.contract);
      if (!verdict.ok) { events_rejected++; continue; }
      try { await dal.upsertEvent(workspaceId, verdict.event); events_emitted++; }
      catch (err) { errors.push({ code: 'dal_upsert_failed', message: (err as Error).message }); }
    }

    // Merge requests
    if (events_emitted < maxEvents) {
      const mrsResp = await gl<GitLabMergeRequest[]>(
        `/projects/${project.id}/merge_requests?state=all&updated_after=${encodeURIComponent(since)}&per_page=30`,
        token,
        rateRemaining,
      );
      if ('error' in mrsResp) { errors.push(mrsResp.error); }
      else {
        for (const m of mrsResp.data) {
          if (events_emitted >= maxEvents) break;
          const event = mrToEvent(project, m);
          const verdict = enforceContract(event, userSource.contract);
          if (!verdict.ok) { events_rejected++; continue; }
          try { await dal.upsertEvent(workspaceId, verdict.event); events_emitted++; }
          catch (err) { errors.push({ code: 'dal_upsert_failed', message: (err as Error).message }); }
        }
      }
    }

    // Issues
    if (events_emitted < maxEvents) {
      const issuesResp = await gl<GitLabIssue[]>(
        `/projects/${project.id}/issues?state=all&updated_after=${encodeURIComponent(since)}&per_page=30`,
        token,
        rateRemaining,
      );
      if ('error' in issuesResp) { errors.push(issuesResp.error); }
      else {
        for (const i of issuesResp.data) {
          if (events_emitted >= maxEvents) break;
          const event = issueToEvent(project, i);
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
