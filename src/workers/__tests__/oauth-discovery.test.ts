// oauth-discovery.test.ts · Stage-2 slice 1 (260806) · RFC 9728 discovery surface.
//
// Two behaviours, pinned: (1) the protected-resource metadata document is publicly readable and
// carries the resource identity WITHOUT advertising a nonexistent authorization server; (2) the
// auth middleware's 401s carry the WWW-Authenticate challenge naming that document — the exact
// header whose absence was measured live on production 260806 (bare 401, discovery dead end).
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import {
  oauthDiscoveryRoute,
  protectedResourceMetadata,
  OAUTH_PROTECTED_RESOURCE_PATH,
} from '../routes/oauth-discovery';
import { clerkAuth } from '../middleware/auth';

describe('oauth discovery (RFC 9728, interim no-AS shape)', () => {
  it('serves the protected-resource metadata publicly with cacheability', async () => {
    const app = new Hono();
    app.route('/', oauthDiscoveryRoute);
    const res = await app.request(OAUTH_PROTECTED_RESOURCE_PATH);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('max-age');
    const j = await res.json() as Record<string, unknown>;
    expect(j.resource).toBe('https://api.xlooop.com');
    expect(j.bearer_methods_supported).toEqual(['header']);
    // HONEST INTERIM: no AS exists yet, so the member must be ABSENT — advertising an empty list
    // (or a fake AS) would send a conforming client into a broken authorization flow.
    expect('authorization_servers' in j).toBe(false);
    expect(String(j.resource_documentation)).toContain('app.xlooop.com');
  });

  it('metadata shape is stable for the future AS upgrade (pure function)', () => {
    const meta = protectedResourceMetadata();
    expect(meta.resource).toBe('https://api.xlooop.com');
  });

  it('a 401 from the auth middleware carries the WWW-Authenticate challenge naming the metadata', async () => {
    const app = new Hono();
    app.use('*', clerkAuth());
    app.get('/guarded', (ctx) => ctx.json({ ok: true }));
    const res = await app.request('/guarded'); // no Authorization header
    expect(res.status).toBe(401);
    const challenge = res.headers.get('WWW-Authenticate') || '';
    expect(challenge).toContain('Bearer');
    expect(challenge).toContain('/.well-known/oauth-protected-resource');
  });
});
