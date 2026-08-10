#!/usr/bin/env node
// The backend connector registry is the only provider catalog. The commercial
// frontend consumes GET /api/v1/connectors and must not carry a fallback copy.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = 'src/workers/lib/connector-registry.ts';
const PROD_CONFIG = 'wrangler.toml';
const PILOT_CONFIG = 'wrangler.pilot-shadow.toml';
const RETIRED_FRONTEND_FALLBACK = 'src/widgets/SourceConnectorModal/SourceConnectorModal.jsx';
const FLAG = 'SOURCE_SCOPE_ENFORCEMENT_ENABLED';

const EXPECTED_RESTRICTED_SCOPES = Object.freeze({
  gmail: 'https://www.googleapis.com/auth/gmail.readonly',
  google_drive: 'https://www.googleapis.com/auth/drive.metadata.readonly',
});

function providerMap(src) {
  const map = new Map();
  const re = /\bid:\s*['"]([a-z0-9_]+)['"]([^}]*)}/g;
  let match;
  while ((match = re.exec(src)) !== null) {
    const body = match[2] || '';
    const slug = body.match(/\bclerk_slug:\s*['"]([a-z0-9_]+)['"]/);
    if (!slug) continue;
    const mode = body.match(/\brestricted_scope_mode:\s*['"]([a-z0-9_]+)['"]/);
    const scopes = [...body.matchAll(/https:\/\/www\.googleapis\.com\/auth\/[a-z0-9._-]+/g)].map((m) => m[0]);
    map.set(match[1], {
      clerk_slug: slug[1],
      restricted_scope_mode: mode?.[1] || null,
      restricted_scopes: scopes,
    });
  }
  return map;
}

function configEnforcesRestrictedScopes(src) {
  const escaped = FLAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}\\s*=\\s*["']true["']\\s*$`, 'm').test(src);
}

function assess({ registrySrc, prodConfigSrc, pilotConfigSrc, retiredFallbackExists = false }) {
  const providers = providerMap(registrySrc);
  const failures = [];
  if (providers.size === 0) failures.push('parsed 0 providers from the backend registry');

  for (const [id, expectedScope] of Object.entries(EXPECTED_RESTRICTED_SCOPES)) {
    const provider = providers.get(id);
    if (!provider) {
      failures.push(`required restricted provider '${id}' is absent from the registry`);
      continue;
    }
    if (provider.clerk_slug !== 'google') {
      failures.push(`provider '${id}' must use Clerk slug 'google', found '${provider.clerk_slug}'`);
    }
    if (provider.restricted_scope_mode !== 'connect_time_only') {
      failures.push(`provider '${id}' must declare restricted_scope_mode='connect_time_only'`);
    }
    if (provider.restricted_scopes.length !== 1 || provider.restricted_scopes[0] !== expectedScope) {
      failures.push(`provider '${id}' must declare exactly '${expectedScope}' as its connect-time scope`);
    }
  }

  if (!configEnforcesRestrictedScopes(prodConfigSrc)) {
    failures.push(`${PROD_CONFIG} must set ${FLAG}='true'`);
  }
  if (!configEnforcesRestrictedScopes(pilotConfigSrc)) {
    failures.push(`${PILOT_CONFIG} must set ${FLAG}='true'`);
  }
  if (retiredFallbackExists) {
    failures.push(`${RETIRED_FRONTEND_FALLBACK} must remain retired; clients consume GET /api/v1/connectors`);
  }
  return { failures, providerCount: providers.size };
}

function selfTest() {
  const registry = `export const CONNECTOR_REGISTRY = [
    { id: 'google_drive', clerk_slug: 'google', restricted_scope_mode: 'connect_time_only', restricted_scopes: ['https://www.googleapis.com/auth/drive.metadata.readonly'] },
    { id: 'gmail', clerk_slug: 'google', restricted_scope_mode: 'connect_time_only', restricted_scopes: ['https://www.googleapis.com/auth/gmail.readonly'] },
  ];`;
  const good = assess({
    registrySrc: registry,
    prodConfigSrc: `${FLAG} = "true"`,
    pilotConfigSrc: `${FLAG} = "true"`,
  });
  const badScope = assess({
    registrySrc: registry.replace('gmail.readonly', 'gmail.modify'),
    prodConfigSrc: `${FLAG} = "true"`,
    pilotConfigSrc: `${FLAG} = "true"`,
  });
  const badFlag = assess({
    registrySrc: registry,
    prodConfigSrc: `${FLAG} = "false"`,
    pilotConfigSrc: `${FLAG} = "true"`,
  });
  const badFallback = assess({
    registrySrc: registry,
    prodConfigSrc: `${FLAG} = "true"`,
    pilotConfigSrc: `${FLAG} = "true"`,
    retiredFallbackExists: true,
  });
  const passed = good.failures.length === 0
    && badScope.failures.some((f) => f.includes('gmail.readonly'))
    && badFlag.failures.some((f) => f.includes(PROD_CONFIG))
    && badFallback.failures.some((f) => f.includes('must remain retired'));
  if (!passed) {
    console.error(`FAIL self-test · ${JSON.stringify({ good, badScope, badFlag, badFallback })}`);
    process.exit(1);
  }
  console.log('PASS self-test · catches scope, flag, and retired-frontend-fallback drift');
}

function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  const result = assess({
    registrySrc: readFileSync(join(ROOT, REGISTRY), 'utf8'),
    prodConfigSrc: readFileSync(join(ROOT, PROD_CONFIG), 'utf8'),
    pilotConfigSrc: readFileSync(join(ROOT, PILOT_CONFIG), 'utf8'),
    retiredFallbackExists: existsSync(join(ROOT, RETIRED_FRONTEND_FALLBACK)),
  });
  if (result.failures.length) {
    console.error(`FAIL verify-connector-provider-ssot · ${result.failures.length} issue(s)`);
    for (const failure of result.failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`PASS verify-connector-provider-ssot · ${result.providerCount} backend providers; restricted-scope config paired; no frontend fallback`);
}

main();
