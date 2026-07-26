const FRONTEND_SHA_DECLARATION = 'window.__XLOOP_FRONTEND_SHA';
const EXACT_FRONTEND_SHA = /window\.__XLOOP_FRONTEND_SHA\s*=\s*["']([0-9a-f]{40})["']/i;

export function extractFrontendSha(html) {
  const match = String(html || '').match(EXACT_FRONTEND_SHA);
  return match ? match[1].toLowerCase() : null;
}

export function resolveSentryRelease(html, configuredRelease) {
  const source = String(html || '');
  const artifactSha = extractFrontendSha(source);
  if (artifactSha) return artifactSha;

  // A release artifact that declares an invalid SHA must not inherit a mutable,
  // potentially stale Pages environment label. The fallback is legacy-only.
  if (source.includes(FRONTEND_SHA_DECLARATION)) return '';
  return String(configuredRelease || '').trim();
}

function jsString(value) {
  return JSON.stringify(String(value ?? ''));
}

export function sentryBootstrap(env, html) {
  const dsn = String(env?.SENTRY_DSN || '').trim();
  if (!dsn) return '';
  const environment = String(env?.SENTRY_ENVIRONMENT || 'production');
  const release = resolveSentryRelease(html, env?.SENTRY_RELEASE);
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
