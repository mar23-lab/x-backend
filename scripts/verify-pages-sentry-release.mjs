#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import vm from 'node:vm';
import {
  extractFrontendSha,
  resolveSentryRelease,
  sentryBootstrap,
  sentryBootstrapSource,
  SENTRY_BOOTSTRAP_PATH,
  SENTRY_SDK_URL,
  SENTRY_SDK_SRI,
} from '../functions/_lib/frontend-release-provenance.js';

function executeBootstrapTwice(source) {
  let initCalls = 0;
  let appended = 0;
  const listeners = {};
  const window = {
    Sentry: { init: () => { initCalls += 1; } },
  };
  const document = {
    createElement: () => ({
      addEventListener: (name, callback) => { listeners[name] = callback; },
    }),
    head: {
      appendChild: () => {
        appended += 1;
        listeners.load?.();
      },
    },
  };
  const sandbox = { window, document, Sentry: window.Sentry };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  vm.runInContext(source, sandbox);
  return { initCalls, appended };
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
const tag = sentryBootstrap(env, exactHtml);
const source = sentryBootstrapSource(env, exactSha);
const execution = executeBootstrapTwice(source);
const EXPECTED_CHECK_COUNT = 19;

const checks = [
  ['extract exact artifact SHA', extractFrontendSha(exactHtml) === exactSha],
  ['artifact SHA overrides mutable release', resolveSentryRelease(exactHtml, legacyRelease) === exactSha],
  ['legacy artifact uses configured release', resolveSentryRelease(legacyHtml, legacyRelease) === legacyRelease],
  ['malformed declared SHA fails closed', resolveSentryRelease(invalidHtml, legacyRelease) === ''],
  ['missing DSN emits no bootstrap tag', sentryBootstrap({}, exactHtml) === ''],
  ['bootstrap is one same-origin external script', tag === `<script data-xlooop-sentry-bootstrap defer src="${SENTRY_BOOTSTRAP_PATH}?release=${exactSha}"></script>`],
  ['bootstrap tag has no inline body', !tag.replace(/<script[^>]*><\/script>/, '').includes('<script')],
  ['bootstrap tag has no inline event handlers', !/\son(?:load|error)=/i.test(tag)],
  ['malformed release is not carried', !sentryBootstrap(env, invalidHtml).includes('deadbee')],
  ['external source carries exact release', source.includes(`window.SENTRY_RELEASE="${exactSha}"`)],
  ['external source excludes stale release', !source.includes(legacyRelease)],
  ['SDK is version-pinned', /\/\d+\.\d+\.\d+\//.test(SENTRY_SDK_URL)],
  ['SDK carries SRI', /^sha(256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(SENTRY_SDK_SRI)],
  ['external source applies SRI', source.includes(`sdk.integrity="${SENTRY_SDK_SRI}"`)],
  ['external source uses event listeners', source.includes('addEventListener("load"') && source.includes('addEventListener("error"')],
  ['external source contains no html event handlers', !/\son(?:load|error)=/i.test(source)],
  ['external source starts SDK once', execution.appended === 1 && execution.initCalls === 1],
  ['PII is explicitly disabled', source.includes('sendDefaultPii:false')],
  ['init failure cannot break the app', source.includes('catch(e)')],
];

const failed = checks.filter(([, ok]) => !ok).map(([label]) => label);
const passedCount = checks.length - failed.length;
if (checks.length !== EXPECTED_CHECK_COUNT) {
  console.error(`verify-pages-sentry-release · FAIL · expected ${EXPECTED_CHECK_COUNT} checks, registered ${checks.length}`);
  process.exit(1);
}
if (failed.length) {
  console.error(`verify-pages-sentry-release · FAIL · ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`verify-pages-sentry-release · PASS ${passedCount}/${EXPECTED_CHECK_COUNT} same-origin external-bootstrap checks`);

const releaseDir = process.env.XLOOOP_APP_PAGES_RELEASE_DIR;
if (!releaseDir) {
  console.log('verify-pages-sentry-release · release composition SKIPPED — set XLOOOP_APP_PAGES_RELEASE_DIR to measure it');
} else {
  const indexHtml = readFileSync(joinPath(releaseDir, 'index.html'), 'utf8');
  const served = indexHtml.includes('data-xlooop-sentry-bootstrap')
    ? indexHtml
    : indexHtml.replace(/<head([^>]*)>/i, `<head$1>${sentryBootstrap(env, indexHtml)}`);
  if (!served.includes(`src="${SENTRY_BOOTSTRAP_PATH}`)) {
    console.error('verify-pages-sentry-release · FAIL · composed page lacks same-origin bootstrap');
    process.exit(1);
  }
  console.log('verify-pages-sentry-release · release composition PASS · same-origin external bootstrap present');
}
