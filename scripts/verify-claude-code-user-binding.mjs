#!/usr/bin/env node
process.argv.push('--check=binding');
await import('./verify-template-policy-suite.mjs');
