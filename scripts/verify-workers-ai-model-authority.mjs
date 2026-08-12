#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = process.cwd();
const SOURCE_ROOT = resolve(ROOT, 'src/workers');
const AUTHORITY = resolve(SOURCE_ROOT, 'services/model-runtime-capabilities.ts');
const EXPECTED = '@cf/zai-org/glm-4.7-flash';
const RETIRED = [
  '@cf/meta/llama-3.1-8b-instruct',
  '@cf/meta/llama-3.1-70b-instruct',
];
const failures = [];

function filesUnder(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

const authorityText = readFileSync(AUTHORITY, 'utf8');
if (!authorityText.includes(`PLATFORM_WORKERS_AI_MODEL = '${EXPECTED}'`)) {
  failures.push(`managed runtime authority is not ${EXPECTED}`);
}

for (const path of filesUnder(SOURCE_ROOT).filter((value) => /\.(?:ts|tsx|js|mjs)$/.test(value))) {
  const text = readFileSync(path, 'utf8');
  for (const model of RETIRED) {
    if (text.includes(model)) failures.push(`${relative(ROOT, path)} references retired model ${model}`);
  }
}

const result = {
  schema_id: 'xlooop.workers_ai_model_authority.v1',
  status: failures.length ? 'FAIL' : 'PASS',
  authority: relative(ROOT, AUTHORITY),
  current_model: EXPECTED,
  retired_models_checked: RETIRED,
  failures,
};
console.log(JSON.stringify(result, null, 2));
process.exit(failures.length ? 1 : 0);
