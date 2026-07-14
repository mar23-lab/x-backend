#!/usr/bin/env node
process.argv.push('--check=admin');
await import('./verify-template-policy-suite.mjs');
