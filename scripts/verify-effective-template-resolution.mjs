#!/usr/bin/env node
process.argv.push('--check=resolution');
await import('./verify-template-policy-suite.mjs');
