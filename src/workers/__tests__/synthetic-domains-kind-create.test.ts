// synthetic-domains-kind-create.test.ts · ADR-XLOOP-IA-001 R1 (F4 regression)
// The headline R1 capability is "create a kind=company / kind=life lens". Before this
// regression the POST route silently dropped body.kind + body.source_domain_id, so every
// API-created lens was forced kind='work'. These tests lock that the route now:
//   (1) passes kind + source_domain_id into the DAL create input (F4),
//   (2) rejects an invalid kind with 400 (not a DB CHECK 500),
//   (3) enforces the soft invariant: source_domain_id only for kind=life.

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { syntheticDomainsRoute } from '../routes/synthetic-domains';

const OPERATOR = { user_id: 'user_op', role: 'operator', workspace_id: 'me' };

// Captures the input the route hands to the DAL so we can assert kind/source_domain_id survive.
let captured: any = null;
function mockDal() {
  return {
    createSyntheticDomain: async (input: any, _uid: string) => {
      captured = input;
      // echo a serialized row reflecting the input (the real DAL applies kind ?? 'work')
      return { id: 'sd_new', slug: input.slug, label: input.label, kind: input.kind ?? 'work', source_domain_id: input.source_domain_id ?? null };
    },
  };
}

function appFor(auth: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (ctx, next) => {
    ctx.set('request_id', 'test');
    ctx.set('auth', auth as never);
    ctx.set('dal', mockDal() as never);
    await next();
  });
  app.route('/api/v1', syntheticDomainsRoute);
  return app;
}

const post = (auth: Record<string, unknown>, bodyObj: unknown) =>
  appFor(auth).request('/api/v1/synthetic-domains', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bodyObj),
  });

const BASE = { slug: 'companies', label: 'Companies', binding: { version: 1, combine: 'any', filters: [{ type: 'tag_in', values: ['company'] }] } };

describe('R1 create route — kind discriminator wiring (F4)', () => {
  it('passes kind=company through to the DAL create input + echoes it', async () => {
    captured = null;
    const res = await post(OPERATOR, { ...BASE, kind: 'company' });
    expect(res.status).toBe(200);
    expect(captured.kind).toBe('company');                 // F4: route no longer drops body.kind
    const body: any = await res.json();
    expect(body.synthetic_domain.kind).toBe('company');
  });

  it('passes a kind=life mirror lens with source_domain_id', async () => {
    captured = null;
    const res = await post(OPERATOR, { ...BASE, slug: 'career', label: 'Career', kind: 'life', source_domain_id: 'domain:mbp:career' });
    expect(res.status).toBe(200);
    expect(captured.kind).toBe('life');
    expect(captured.source_domain_id).toBe('domain:mbp:career');
  });

  it('defaults to no explicit kind when omitted (DAL applies work)', async () => {
    captured = null;
    const res = await post(OPERATOR, BASE);
    expect(res.status).toBe(200);
    expect(captured.kind).toBeUndefined();                 // DAL coalesces to 'work'
  });

  it('rejects an invalid kind with 400 (not a DB 500)', async () => {
    const res = await post(OPERATOR, { ...BASE, kind: 'bogus' });
    expect(res.status).toBe(400);
  });

  it('rejects source_domain_id on a non-life lens (soft invariant, fail-closed)', async () => {
    const res = await post(OPERATOR, { ...BASE, kind: 'work', source_domain_id: 'domain:mbp:career' });
    expect(res.status).toBe(400);
  });
});
