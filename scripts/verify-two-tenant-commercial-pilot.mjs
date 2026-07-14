#!/usr/bin/env node
process.argv.push('--check=two_tenant');
await import('./verify-template-policy-suite.mjs');
