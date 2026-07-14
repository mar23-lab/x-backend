#!/usr/bin/env node
// scripts/verify-data-schemas.mjs · Round 13 R13.2 (2026-05-20).
//
// Validates the three load-bearing data projections against their JSON Schemas
// at data/schemas/*.v1.schema.json. Runs in two contexts:
//
//   1. Direct: `node scripts/verify-data-schemas.mjs` — prints per-file results
//      and exits non-zero on any schema violation. Used by CI and operator
//      ad-hoc.
//   2. Library: imported by scripts/smoke-cli.v3-source.mjs which adds three
//      check() rows (one per data file) so smoke 355 → 358.
//
// In-tree validator (subset of JSON Schema draft-07). Implements only what
// the R13.1 schemas use: type, required, properties, additionalProperties,
// items, enum, pattern, const, anyOf, minimum, $schema/$id/title/description.
// No `ajv` runtime dep — keeps the smoke + standalone build dependency-free.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

export const SCHEMA_BINDINGS = [
  {
    schemaPath: 'data/schemas/operations-live-stream.v1.schema.json',
    dataPath: 'data/operations-live-stream.json',
    schemaName: 'operations-live-stream.v1',
  },
  {
    schemaPath: 'data/schemas/document-context-read-model.v1.schema.json',
    dataPath: 'data/document-context-read-model.json',
    schemaName: 'document-context-read-model.v1',
  },
  {
    schemaPath: 'data/schemas/mbp-operations-projection.v1.schema.json',
    dataPath: 'data/mbp-operations-projection.json',
    schemaName: 'mbp-operations-projection.v1',
  },
];

function typeMatches(schemaType, value) {
  const types = Array.isArray(schemaType) ? schemaType : [schemaType];
  return types.some(t => {
    if (t === 'string') return typeof value === 'string';
    if (t === 'number') return typeof value === 'number';
    if (t === 'integer') return typeof value === 'number' && Number.isInteger(value);
    if (t === 'boolean') return typeof value === 'boolean';
    if (t === 'null') return value === null;
    if (t === 'array') return Array.isArray(value);
    if (t === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
    return false;
  });
}

function validate(value, schema, pointer, errors) {
  if (schema == null) return;

  if (Object.prototype.hasOwnProperty.call(schema, 'const')) {
    if (value !== schema.const) {
      errors.push({ pointer, message: `const violation · expected ${JSON.stringify(schema.const)} got ${JSON.stringify(value)}` });
      return;
    }
  }

  if (schema.enum) {
    if (!schema.enum.includes(value)) {
      errors.push({ pointer, message: `enum violation · not in ${JSON.stringify(schema.enum)}` });
      return;
    }
  }

  if (schema.type && !typeMatches(schema.type, value)) {
    errors.push({ pointer, message: `type violation · expected ${JSON.stringify(schema.type)} got ${value === null ? 'null' : typeof value}` });
    return;
  }

  if (schema.anyOf) {
    const subErrors = [];
    const passed = schema.anyOf.some(sub => {
      const sErrors = [];
      validate(value, sub, pointer, sErrors);
      if (sErrors.length === 0) return true;
      subErrors.push(sErrors);
      return false;
    });
    if (!passed) {
      errors.push({ pointer, message: `anyOf violation · no branch matched (${schema.anyOf.length} candidates)` });
    }
  }

  if (typeof value === 'string' && schema.pattern) {
    const re = new RegExp(schema.pattern);
    if (!re.test(value)) {
      errors.push({ pointer, message: `pattern violation · ${schema.pattern}` });
    }
  }

  if (typeof value === 'number' && typeof schema.minimum === 'number') {
    if (value < schema.minimum) {
      errors.push({ pointer, message: `minimum violation · ${value} < ${schema.minimum}` });
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, idx) => {
      validate(item, schema.items, `${pointer}/${idx}`, errors);
    });
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          errors.push({ pointer, message: `required-key missing · "${key}"` });
        }
      }
    }
    if (schema.properties) {
      for (const [key, subSchema] of Object.entries(schema.properties)) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          validate(value[key], subSchema, `${pointer}/${key}`, errors);
        }
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      const known = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(value)) {
        if (!known.has(key)) {
          errors.push({ pointer, message: `additionalProperties forbidden · "${key}"` });
        }
      }
    }
  }
}

export function validateFile(binding) {
  const result = {
    schemaName: binding.schemaName,
    schemaPath: binding.schemaPath,
    dataPath: binding.dataPath,
    ok: false,
    errors: [],
  };
  try {
    const schemaAbs = path.join(repoRoot, binding.schemaPath);
    const dataAbs = path.join(repoRoot, binding.dataPath);
    if (!fs.existsSync(schemaAbs)) {
      result.errors.push({ pointer: '', message: `schema file missing at ${binding.schemaPath}` });
      return result;
    }
    if (!fs.existsSync(dataAbs)) {
      result.errors.push({ pointer: '', message: `data file missing at ${binding.dataPath}` });
      return result;
    }
    const schema = JSON.parse(fs.readFileSync(schemaAbs, 'utf8'));
    const data = JSON.parse(fs.readFileSync(dataAbs, 'utf8'));
    validate(data, schema, '', result.errors);
    if (data && typeof data === 'object' && data._meta && typeof data._meta.schema === 'string') {
      if (data._meta.schema !== binding.schemaName) {
        result.errors.push({ pointer: '/_meta/schema', message: `declared schema ${data._meta.schema} does not match resolved ${binding.schemaName}` });
      }
    }
    result.ok = result.errors.length === 0;
  } catch (err) {
    result.errors.push({ pointer: '', message: `validator threw · ${err.message}` });
  }
  return result;
}

export function runAll() {
  return SCHEMA_BINDINGS.map(validateFile);
}

const isDirectInvocation = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectInvocation) {
  const results = runAll();
  let failed = 0;
  console.log('verify-data-schemas · R13.2');
  for (const r of results) {
    if (r.ok) {
      console.log(`  ☑ ${r.schemaName} · ${r.dataPath}`);
    } else {
      failed += 1;
      console.log(`  ✗ ${r.schemaName} · ${r.dataPath}`);
      for (const e of r.errors.slice(0, 12)) {
        console.log(`      ${e.pointer || '/'} · ${e.message}`);
      }
      if (r.errors.length > 12) {
        console.log(`      ... (+${r.errors.length - 12} more errors)`);
      }
    }
  }
  console.log(`\n${failed === 0 ? '☑' : '✗'} ${results.length - failed}/${results.length} schemas validated${failed === 0 ? ' · all data files match contract' : ''}`);
  process.exit(failed === 0 ? 0 : 1);
}
