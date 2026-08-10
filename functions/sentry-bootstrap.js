import { sentryBootstrapSource } from './_lib/frontend-release-provenance.js';

export function onRequestGet({ request, env }) {
  const release = new URL(request.url).searchParams.get('release') || '';
  const source = sentryBootstrapSource(env || {}, release);
  if (!source) return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  return new Response(source, {
    status: 200,
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
