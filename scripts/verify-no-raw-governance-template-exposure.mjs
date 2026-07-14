#!/usr/bin/env node

process.argv.push('--check=raw_exposure');
await import('./verify-template-policy-suite.mjs');
