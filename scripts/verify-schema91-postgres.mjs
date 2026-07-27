#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

function assess(env) {
  const url = String(env.XLOOOP_SCHEMA91_PG_URL || '').trim();
  const productionUrl = String(env.DATABASE_URL || '').trim();
  const problems = [];

  if (!url) problems.push('XLOOOP_SCHEMA91_PG_URL is required');
  if (env.XLOOOP_SCHEMA91_PG_DISPOSABLE !== '1') {
    problems.push('XLOOOP_SCHEMA91_PG_DISPOSABLE=1 is required');
  }
  if (url && productionUrl && url === productionUrl) {
    problems.push('XLOOOP_SCHEMA91_PG_URL must not equal DATABASE_URL');
  }
  if (url) {
    try {
      const parsed = new URL(url);
      if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
        problems.push('XLOOOP_SCHEMA91_PG_URL must use postgres or postgresql');
      }
    } catch {
      problems.push('XLOOOP_SCHEMA91_PG_URL must be a valid URL');
    }
  }

  return problems;
}

if (process.argv.includes('--self-test')) {
  const cases = [
    assess({}).length === 2,
    assess({
      XLOOOP_SCHEMA91_PG_URL: 'postgresql://127.0.0.1/test',
      XLOOOP_SCHEMA91_PG_DISPOSABLE: '1',
    }).length === 0,
    assess({
      DATABASE_URL: 'postgresql://db.example/prod',
      XLOOOP_SCHEMA91_PG_URL: 'postgresql://db.example/prod',
      XLOOOP_SCHEMA91_PG_DISPOSABLE: '1',
    }).includes('XLOOOP_SCHEMA91_PG_URL must not equal DATABASE_URL'),
    assess({
      XLOOOP_SCHEMA91_PG_URL: 'https://db.example/test',
      XLOOOP_SCHEMA91_PG_DISPOSABLE: '1',
    }).includes('XLOOOP_SCHEMA91_PG_URL must use postgres or postgresql'),
  ];
  if (cases.every(Boolean)) {
    console.log('verify-schema91-postgres self-test PASS');
    process.exit(0);
  }
  console.error('verify-schema91-postgres self-test FAIL');
  process.exit(1);
}

const problems = assess(process.env);
if (problems.length) {
  console.error(`verify-schema91-postgres · FAIL-CLOSED · ${problems.join('; ')}`);
  process.exit(2);
}

const result = spawnSync(
  'npx',
  [
    '--no-install',
    'vitest',
    'run',
    'src/workers/__tests__/intake-schema91-postgres.test.ts',
  ],
  {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    stdio: 'inherit',
  },
);
if (result.error) {
  console.error(`verify-schema91-postgres · FAIL · ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);
console.log('verify-schema91-postgres · PASS · disposable schema-91 PostgreSQL authority');
