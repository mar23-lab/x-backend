#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import vm from 'node:vm';
import {
  extractFrontendSha,
  resolveSentryRelease,
  sentryBootstrap,
  SENTRY_SDK_URL,
  SENTRY_SDK_SRI,
} from '../functions/_lib/frontend-release-provenance.js';

/**
 * Does this HTML actually CONSUME Sentry, or does it only CONFIGURE it?
 *
 * `sentryBootstrap()` injects window.SENTRY_DSN / _ENVIRONMENT / _RELEASE / sample rates and
 * NO SDK. Every check below this line asserts those values are CORRECT. None of them asserts
 * anything READS them. A release can therefore pass this gate with Sentry entirely dark.
 *
 * A consumer is an SDK: an init call, an npm import, or a CDN bundle. Config globals are
 * deliberately NOT consumers — `SENTRY_DSN`, `SENTRY_TRACES_SAMPLE_RATE` and friends must all
 * read false here, which is what the self-test below pins.
 */
/**
 * Is the SDK loaded by a real, executing <script src=…> — not merely MENTIONED?
 *
 * `sentryConsumerPresent` matches the CDN host anywhere in the text, so a mutant that turned the
 * script tag into a <span> carrying the same src SURVIVED it (observed 260731). A detector that
 * cannot distinguish an executing element from an inert mention is the same false-positive shape
 * this estate keeps finding — so the structural check exists alongside the textual one.
 */
export function sdkScriptTagPresent(html, url) {
  const tags = String(html || '').match(/<script\b[^>]*>/gi) || [];
  return tags.some((tag) => tag.includes(`src="${url}"`) || tag.includes(`src='${url}'`));
}

/**
 * EXECUTE the emitted init script and count real `Sentry.init` calls across two invocations.
 *
 * The double-init guard was previously asserted by grepping for `__XLOOP_SENTRY_STARTED` — a token
 * that still appears when the guard is broken, so that mutant SURVIVED too. Running the code is the
 * only way to tell a guard that works from a guard that is merely spelled.
 */
export function initCallsAcrossTwoRuns(bootstrapHtml) {
  const match = String(bootstrapHtml || '').match(/<script data-xlooop-sentry-init>([\s\S]*?)<\/script>/);
  if (!match) return -1;
  let calls = 0;
  const win = {
    SENTRY_DSN: 'https://public@example.ingest.sentry.io/1',
    SENTRY_ENVIRONMENT: 'production',
    SENTRY_RELEASE: 'a'.repeat(40),
    SENTRY_SAMPLE_RATE: '0.25',
    SENTRY_TRACES_SAMPLE_RATE: '0.05',
  };
  win.Sentry = { init: () => { calls += 1; } };
  const sandbox = { window: win, Sentry: win.Sentry };
  vm.createContext(sandbox);
  vm.runInContext(match[1], sandbox);
  if (typeof win.__xlooopSentryInit !== 'function') return -1;
  win.__xlooopSentryInit();
  win.__xlooopSentryInit();
  return calls;
}

export function sentryConsumerPresent(html) {
  const text = String(html || '');
  return (
    /Sentry\s*\.\s*init\s*\(/.test(text) ||
    /@sentry\/(browser|react|vue)/.test(text) ||
    /browser\.sentry-cdn\.com/.test(text) ||
    /\bsentry[-.]?(bundle|tracing)\b/i.test(text)
  );
}

const exactSha = 'a'.repeat(40);
const legacyRelease = 'legacy-configured-release';
const exactHtml = `<script>window.__XLOOP_FRONTEND_SHA="${exactSha}";</script>`;
const invalidHtml = '<script>window.__XLOOP_FRONTEND_SHA="deadbee";</script>';
const legacyHtml = '<html><head></head><body></body></html>';
const env = {
  SENTRY_DSN: 'https://public@example.ingest.sentry.io/1',
  SENTRY_ENVIRONMENT: 'production',
  SENTRY_RELEASE: legacyRelease,
  SENTRY_SAMPLE_RATE: '0.25',
  SENTRY_TRACES_SAMPLE_RATE: '0.05',
};

const checks = [
  ['extract exact artifact SHA', extractFrontendSha(exactHtml) === exactSha],
  ['artifact SHA overrides mutable release', resolveSentryRelease(exactHtml, legacyRelease) === exactSha],
  ['legacy artifact uses configured release', resolveSentryRelease(legacyHtml, legacyRelease) === legacyRelease],
  ['malformed declared SHA fails closed', resolveSentryRelease(invalidHtml, legacyRelease) === ''],
  ['missing DSN emits no bootstrap', sentryBootstrap({}, exactHtml) === ''],
  ['bootstrap carries exact artifact release', sentryBootstrap(env, exactHtml).includes(`window.SENTRY_RELEASE="${exactSha}"`)],
  ['bootstrap excludes stale release', !sentryBootstrap(env, exactHtml).includes(legacyRelease)],
  // Asserts the ASSIGNMENT, not the bare token. The init script now references the global by name
  // (`release:window.SENTRY_RELEASE||undefined`), so a substring test for 'SENTRY_RELEASE' would
  // match the reader and report a leak that is not there. The invariant is unchanged: a malformed
  // SHA declaration must never cause the stale configured release to be ASSIGNED.
  ['malformed declaration assigns no stale release', !/window\.SENTRY_RELEASE\s*=/.test(sentryBootstrap(env, invalidHtml))],
  ['malformed declaration leaks no stale release VALUE', !sentryBootstrap(env, invalidHtml).includes(legacyRelease)],

  // The detector itself is blocking: a consumer check that cannot tell config from an SDK would
  // make the advisory below worse than absent. The first of these is the load-bearing one — it
  // asserts that everything the eight checks above verify is NOT evidence Sentry runs.
  // INVERTED 260731, deliberately, when the SDK shipped. This check used to assert that bootstrap
  // emitted config and nothing that reads it — it was the finding. Now it asserts the fix, and it
  // is the regression guard: delete the SDK from sentryBootstrap and this goes red immediately
  // instead of degrading quietly back to a configured-but-dark Sentry.
  ['bootstrap now ships an SDK consumer', sentryConsumerPresent(sentryBootstrap(env, exactHtml)) === true],
  ['bare config globals are still not a consumer', sentryConsumerPresent('<script>window.SENTRY_DSN="x";window.SENTRY_TRACES_SAMPLE_RATE="0.1";</script>') === false],
  ['SDK is version-pinned, not floating', /\/\d+\.\d+\.\d+\//.test(SENTRY_SDK_URL) && !/@latest|\/latest\//.test(SENTRY_SDK_URL)],
  ['SDK carries subresource integrity', /^sha(256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(SENTRY_SDK_SRI)],
  ['emitted SDK tag carries the integrity attribute', sentryBootstrap(env, exactHtml).includes(`integrity="${SENTRY_SDK_SRI}"`)],
  // EXECUTED, not grepped — see initCallsAcrossTwoRuns. Two invocations must yield exactly one init.
  ['init runs exactly once across two invocations', initCallsAcrossTwoRuns(sentryBootstrap(env, exactHtml)) === 1],
  // STRUCTURAL, not substring — the SDK must be loaded by a real <script src=…>, not just mentioned.
  ['SDK arrives via a real script tag', sdkScriptTagPresent(sentryBootstrap(env, exactHtml), SENTRY_SDK_URL) === true],
  ['a mere mention is not a script tag', sdkScriptTagPresent(`<span src="${SENTRY_SDK_URL}"></span>`, SENTRY_SDK_URL) === false],
  ['init cannot throw into the page', sentryBootstrap(env, exactHtml).includes('catch(e)')],
  ['PII is explicitly off, not inherited', sentryBootstrap(env, exactHtml).includes('sendDefaultPii:false')],
  ['no html has no consumer', sentryConsumerPresent('') === false],
  ['Sentry.init counts as a consumer', sentryConsumerPresent('<script>Sentry.init({ dsn: window.SENTRY_DSN });</script>') === true],
  ['npm sdk import counts as a consumer', sentryConsumerPresent('import * as S from "@sentry/browser";') === true],
  ['cdn bundle counts as a consumer', sentryConsumerPresent('<script src="https://browser.sentry-cdn.com/7.120.0/bundle.min.js"></script>') === true],
];

const failed = checks.filter(([, ok]) => !ok).map(([label]) => label);
if (failed.length) {
  console.error(`verify-pages-sentry-release · FAIL · ${failed.join(', ')}`);
  process.exit(1);
}

const passed = checks.length - failed.length;
console.log(`verify-pages-sentry-release · PASS ${passed}/${checks.length} exact-artifact and legacy-fallback checks`);

// ADVISORY, deliberately. Frontend Sentry is dark today, so making this blocking would ship a gate
// that is red from its first run — the always-red-gets-bypassed pattern this estate has measured.
// It is reported LOUDLY instead, and it never renders "measured clean" when it did not measure.
const releaseDir = process.env.XLOOOP_APP_PAGES_RELEASE_DIR;
if (!releaseDir) {
  console.log('verify-pages-sentry-release · consumer-presence SKIPPED — set XLOOOP_APP_PAGES_RELEASE_DIR to measure it (this is NOT a pass)');
} else {
  let indexHtml = null;
  try {
    indexHtml = readFileSync(joinPath(releaseDir, 'index.html'), 'utf8');
  } catch (error) {
    console.log(`verify-pages-sentry-release · consumer-presence CANNOT MEASURE — ${releaseDir}/index.html unreadable (${error.code || error.message}) (this is NOT a pass)`);
  }
  if (indexHtml !== null) {
    // The artifact on disk is NOT what the browser receives. `sentryBootstrap()` runs in a Pages
    // Function and injects at REQUEST time, so the built index.html carries no DSN and reading it
    // alone reports a comfortable "nothing to consume". The deployed page is the composition —
    // measure that, or measure the wrong rung. (Verified against live app.xlooop.com 260731:
    // 5 window.SENTRY_* globals served, 0 consumer markers.)
    const served = indexHtml + sentryBootstrap(env, indexHtml);
    const configured = /window\.SENTRY_DSN\s*=/.test(served);
    const consumer = sentryConsumerPresent(served);
    if (configured && !consumer) {
      console.log('verify-pages-sentry-release · ADVISORY GAP — the release declares window.SENTRY_DSN but ships NO Sentry SDK.');
      console.log('  Every check above passes on config correctness; none of them requires anything to read it.');
      console.log('  Effect: browser errors on the authenticated surface are reported NOWHERE. Fix = ship an SDK, or stop emitting the DSN.');
    } else if (!configured) {
      console.log('verify-pages-sentry-release · consumer-presence n/a — release emits no DSN, so there is nothing to consume');
    } else {
      console.log('verify-pages-sentry-release · consumer-presence OK — DSN declared and an SDK consumer is present');
    }
  }
}
