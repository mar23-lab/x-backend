// github-repos.test.ts · 2026-06-07
//
// Unit tests for listUserRepos — the data source behind the operator repo
// picker (GET /api/v1/sources/:id/repos). Mocks global fetch so we assert:
//   1. GitHub /user/repos rows map to the wire-safe GitHubRepoSummary shape
//   2. missing optional fields (id/private/description/html_url) get safe defaults
//   3. the bearer token is sent to /user/repos
//   4. GitHub error statuses map to thrown Errors with the right `.code`
//      (401 -> github_api_unauthorized, 403/429 -> github_api_rate_limited)
// No live GitHub call.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { listUserRepos } from '../sources/translators/github';

/** Minimal Response stand-in matching what gh() reads (status/ok/headers/json/text). */
function res(status: number, body: unknown, remaining = '4999') {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (h: string) => (h === 'X-RateLimit-Remaining' ? remaining : null) },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('listUserRepos', () => {
  it('maps GitHub repos to the wire-safe summary shape', async () => {
    const apiRepos = [
      { id: 1, name: 'demo', full_name: 'mar23/demo', owner: { login: 'mar23' }, default_branch: 'main', pushed_at: '2026-06-01T00:00:00Z', private: false, description: 'd', html_url: 'https://github.com/mar23/demo' },
      { id: 2, name: 'secret', full_name: 'mar23/secret', owner: { login: 'mar23' }, default_branch: 'dev', pushed_at: '2026-05-01T00:00:00Z', private: true, description: null, html_url: 'https://github.com/mar23/secret' },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => res(200, apiRepos)));
    const repos = await listUserRepos('tok');
    expect(repos).toHaveLength(2);
    expect(repos[0]).toMatchObject({ id: 1, full_name: 'mar23/demo', name: 'demo', owner: 'mar23', private: false, default_branch: 'main' });
    expect(repos[1]).toMatchObject({ full_name: 'mar23/secret', private: true, description: null });
  });

  it('fills safe defaults for missing optional fields', async () => {
    const apiRepos = [{ name: 'x', full_name: 'o/x', owner: { login: 'o' }, default_branch: 'main', pushed_at: '2026-06-01T00:00:00Z' }];
    vi.stubGlobal('fetch', vi.fn(async () => res(200, apiRepos)));
    const repos = await listUserRepos('tok');
    expect(repos[0]).toMatchObject({ id: 0, private: false, description: null, html_url: 'https://github.com/o/x' });
  });

  it('requests /user/repos with the bearer token', async () => {
    const fetchMock = vi.fn(async () => res(200, []));
    vi.stubGlobal('fetch', fetchMock);
    await listUserRepos('mytoken');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/user/repos');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer mytoken');
  });

  it('throws github_api_unauthorized on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(401, 'nope')));
    await expect(listUserRepos('bad')).rejects.toMatchObject({ code: 'github_api_unauthorized' });
  });

  it('throws github_api_rate_limited on 403', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(403, 'rate')));
    await expect(listUserRepos('tok')).rejects.toMatchObject({ code: 'github_api_rate_limited' });
  });
});
