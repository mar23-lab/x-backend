// functions/_middleware.js · Pages app response headers (security + asset MIME).
//
// app.xlooop.com (and the other xlooop Pages projects) run in CF Pages "advanced mode":
// wrangler compiles this functions/ dir into a _worker.js, and in advanced mode CF Pages
// IGNORES the static `_headers` file that scripts/prepare-cloudflare-pages.mjs generates.
// So the intended app document-plane headers never reach the browser unless re-applied
// here. This catch-all middleware re-applies them on every response. It mirrors the API
// worker's src/workers/middleware/security-headers.ts for the Pages document plane (the
// real XSS surface) - but those are SEPARATE policies (the API one is deliberately stricter).
//
// SINGLE SOURCE OF TRUTH: data/security-headers.manifest.json (also consumed by
// scripts/prepare-cloudflare-pages.mjs to write the static _headers file). Edit header
// values ONLY in the manifest; scripts/verify-app-security-header-parity.mjs asserts the
// live deploy matches it. The JSON is bundled into the _worker.js at build time by wrangler.

import MANIFEST from '../data/security-headers.manifest.json';

function jsString(value) {
  return JSON.stringify(String(value ?? ''));
}

function sentryBootstrap(env) {
  const dsn = String(env?.SENTRY_DSN || '').trim();
  if (!dsn) return '';
  const environment = String(env?.SENTRY_ENVIRONMENT || 'production');
  const release = String(env?.SENTRY_RELEASE || '');
  const sampleRate = String(env?.SENTRY_SAMPLE_RATE || '1.0');
  const tracesSampleRate = String(env?.SENTRY_TRACES_SAMPLE_RATE || '0.10');
  return [
    '<script data-xlooop-sentry-bootstrap>',
    `window.SENTRY_DSN=${jsString(dsn)};`,
    `window.SENTRY_ENVIRONMENT=${jsString(environment)};`,
    release ? `window.SENTRY_RELEASE=${jsString(release)};` : '',
    `window.SENTRY_SAMPLE_RATE=${jsString(sampleRate)};`,
    `window.SENTRY_TRACES_SAMPLE_RATE=${jsString(tracesSampleRate)};`,
    '</script>',
  ].join('');
}

async function maybeInjectSentryBootstrap(response, env) {
  const bootstrap = sentryBootstrap(env);
  if (!bootstrap) return response;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return response;
  const html = await response.text();
  const injected = html.includes('data-xlooop-sentry-bootstrap')
    ? html
    : html.replace(/<head([^>]*)>/i, `<head$1>${bootstrap}`);
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(injected, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Convert a CF Pages _headers glob (e.g. "/src/widgets/*.jsx", where "*" matches across
// "/") into an anchored RegExp for runtime pathname matching.
function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$');
}

const PATH_OVERRIDES = (MANIFEST.path_overrides || []).map((o) => ({
  test: globToRegExp(o.match),
  headers: o.headers,
}));

export async function onRequest(context) {
  const response = await maybeInjectSentryBootstrap(await context.next(), context.env || {});
  // Clone into a mutable response (the asset/next() response headers may be immutable).
  const out = new Response(response.body, response);
  for (const name in MANIFEST.global_headers) {
    out.headers.set(name, MANIFEST.global_headers[name]);
  }
  const { pathname } = new URL(context.request.url);
  for (const override of PATH_OVERRIDES) {
    if (override.test.test(pathname)) {
      for (const name in override.headers) {
        out.headers.set(name, override.headers[name]);
      }
    }
  }
  return out;
}
