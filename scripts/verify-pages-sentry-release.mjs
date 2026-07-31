#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import {
  extractFrontendSha,
  resolveSentryRelease,
  sentryBootstrap,
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
  ['malformed declaration excludes stale release', !sentryBootstrap(env, invalidHtml).includes('SENTRY_RELEASE')],

  // The detector itself is blocking: a consumer check that cannot tell config from an SDK would
  // make the advisory below worse than absent. The first of these is the load-bearing one — it
  // asserts that everything the eight checks above verify is NOT evidence Sentry runs.
  ['bootstrap config alone is not a consumer', sentryConsumerPresent(sentryBootstrap(env, exactHtml)) === false],
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

console.log(`verify-pages-sentry-release · PASS ${checks.length}/${checks.length} exact-artifact and legacy-fallback checks`);

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
