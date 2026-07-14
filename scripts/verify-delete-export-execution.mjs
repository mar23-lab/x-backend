#!/usr/bin/env node
process.argv.push('--check=delete_export');
await import('./verify-template-policy-suite.mjs');
