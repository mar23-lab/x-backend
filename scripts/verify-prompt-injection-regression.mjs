#!/usr/bin/env node
process.argv.push('--check=injection');
await import('./verify-template-policy-suite.mjs');
