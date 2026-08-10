#!/usr/bin/env node

import { listSecretNames, parseSecretNames } from './preflight-rls-dsn.mjs';

const REQUIRED = ['MODEL_RUNTIME_ENC_KEYS', 'MODEL_RUNTIME_ACTIVE_KEY_ID'];
const EXPECTED_SECRET_COUNT = 2;
const EXPECTED_SELF_TEST_COUNT = 3;

export function missingKeyringSecrets(names) {
  return REQUIRED.filter((name) => !names.includes(name));
}

function selfTest() {
  const complete = parseSecretNames('[{"name":"MODEL_RUNTIME_ENC_KEYS"},{"name":"MODEL_RUNTIME_ACTIVE_KEY_ID"}]');
  const partial = parseSecretNames('[{"name":"MODEL_RUNTIME_ENC_KEYS"}]');
  const cases = [
    ['complete keyring passes', missingKeyringSecrets(complete).length === 0],
    ['missing active key id fails', missingKeyringSecrets(partial).includes('MODEL_RUNTIME_ACTIVE_KEY_ID')],
    ['empty secret set fails both', missingKeyringSecrets([]).length === 2],
  ];
  const failures = cases.filter(([, ok]) => !ok);
  if (cases.length !== EXPECTED_SELF_TEST_COUNT) {
    console.error(`preflight-model-runtime-keyring self-test definition drift: expected ${EXPECTED_SELF_TEST_COUNT}, got ${cases.length}`);
    process.exit(1);
  }
  for (const [name, ok] of cases) console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (failures.length) process.exit(1);
  console.log(`preflight-model-runtime-keyring self-test PASS · ${cases.length - failures.length}/${EXPECTED_SELF_TEST_COUNT}`);
}

if (process.argv.includes('--self-test')) selfTest();
else {
  try {
    const names = listSecretNames();
    const missing = missingKeyringSecrets(names);
    if (missing.length) {
      console.error(`preflight-model-runtime-keyring · FAIL-CLOSED · missing ${missing.join(',')}`);
      console.error('Production credential writes and rotation would fail closed after deployment.');
      process.exit(1);
    }
    if (REQUIRED.length !== EXPECTED_SECRET_COUNT) {
      throw new Error(`keyring control definition drift: expected ${EXPECTED_SECRET_COUNT} required secrets, got ${REQUIRED.length}`);
    }
    console.log(`preflight-model-runtime-keyring · PASS · ${REQUIRED.length - missing.length}/${EXPECTED_SECRET_COUNT} required keyring secrets bound`);
  } catch (error) {
    console.error(`preflight-model-runtime-keyring · FAIL-CLOSED · ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
