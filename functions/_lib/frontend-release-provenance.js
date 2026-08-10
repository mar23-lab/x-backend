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

// Pinned by exact version AND subresource integrity. The hash was computed from the fetched bytes
// (74296 B, `@sentry/browser 8.55.0 (134fcf3)`), never transcribed from documentation — a wrong
// integrity value fails CLOSED (the browser refuses the script, Sentry stays dark, the app is
// unaffected), which is the right direction to fail but silent, so the value must be real.
export const SENTRY_SDK_URL = 'https://browser.sentry-cdn.com/8.55.0/bundle.min.js';
export const SENTRY_SDK_SRI = 'sha384-BlRl+vkcjdIA/AKRb8zWtiqlVVXepUsSv0+vho7ZMUTsNudEyQjGUKo9W86Hc1EC';
export const SENTRY_BOOTSTRAP_PATH = '/sentry-bootstrap.js';

export function sentryBootstrap(env, html) {
  const dsn = String(env?.SENTRY_DSN || '').trim();
  if (!dsn) return '';
  const release = resolveSentryRelease(html, env?.SENTRY_RELEASE);
  const query = release ? `?release=${encodeURIComponent(release)}` : '';
  return `<script data-xlooop-sentry-bootstrap defer src="${SENTRY_BOOTSTRAP_PATH}${query}"></script>`;
}

export function sentryBootstrapSource(env, requestedRelease = '') {
  const dsn = String(env?.SENTRY_DSN || '').trim();
  if (!dsn) return '';
  const environment = String(env?.SENTRY_ENVIRONMENT || 'production');
  const release = /^[0-9a-f]{40}$/i.test(String(requestedRelease))
    ? String(requestedRelease).toLowerCase()
    : '';
  const sampleRate = String(env?.SENTRY_SAMPLE_RATE || '1.0');
  const tracesSampleRate = String(env?.SENTRY_TRACES_SAMPLE_RATE || '0.10');
  return [
    '(()=>{',
    'if(window.__XLOOP_SENTRY_BOOTSTRAP_REQUESTED)return;',
    'window.__XLOOP_SENTRY_BOOTSTRAP_REQUESTED=true;',
    `window.SENTRY_DSN=${jsString(dsn)};`,
    `window.SENTRY_ENVIRONMENT=${jsString(environment)};`,
    release ? `window.SENTRY_RELEASE=${jsString(release)};` : '',
    `window.SENTRY_SAMPLE_RATE=${jsString(sampleRate)};`,
    `window.SENTRY_TRACES_SAMPLE_RATE=${jsString(tracesSampleRate)};`,
    'window.__xlooopSentryInit=function(){',
    'try{',
    'if(!window.Sentry||!window.Sentry.init||window.__XLOOP_SENTRY_STARTED)return;',
    'window.__XLOOP_SENTRY_STARTED=true;',
    'Sentry.init({',
    'dsn:window.SENTRY_DSN,',
    'environment:window.SENTRY_ENVIRONMENT,',
    'release:window.SENTRY_RELEASE||undefined,',
    'sampleRate:parseFloat(window.SENTRY_SAMPLE_RATE)||1.0,',
    'tracesSampleRate:parseFloat(window.SENTRY_TRACES_SAMPLE_RATE)||0.0,',
    // Customer workspaces carry real business content. Default-PII OFF is the conservative
    // choice and is stated here rather than inherited, so a future reader sees it was decided.
    'sendDefaultPii:false',
    '});',
    // Never let telemetry break the cockpit. A failed init must stay silent to the user.
    '}catch(e){window.__XLOOP_SENTRY_INIT_ERROR=String(e&&e.message||e);}',
    '};',
    'const sdk=document.createElement("script");',
    `sdk.src=${jsString(SENTRY_SDK_URL)};`,
    `sdk.integrity=${jsString(SENTRY_SDK_SRI)};`,
    'sdk.crossOrigin="anonymous";',
    'sdk.defer=true;',
    'sdk.addEventListener("load",window.__xlooopSentryInit,{once:true});',
    'sdk.addEventListener("error",()=>{window.__XLOOP_SENTRY_SDK_FAILED=true;},{once:true});',
    'document.head.appendChild(sdk);',
    '})();',
  ].join('');
}
