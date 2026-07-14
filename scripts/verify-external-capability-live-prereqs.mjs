#!/usr/bin/env node
// Verifies local prerequisites for live upstream external-capability canaries.
//
// Normal mode is advisory so internal validation can continue with all external
// capabilities disabled by default. Strict mode fails closed before any default
// promotion attempt if the sandbox runner cannot execute the required upstream
// surfaces.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const strict = process.argv.includes('--strict') || process.env.XLOOOP_REQUIRE_EXTERNAL_DEFAULTS === '1';
const venv = process.env.XLOOOP_UPSTREAM_CAPABILITY_VENV || '/tmp/xlooop-upstream-capability-venv';
const checks = [];
const failures = [];
const warnings = [];

function addCheck(id, ok, details = {}, options = {}) {
  const status = ok ? 'PASS' : (options.block ? 'FAIL' : 'WARN');
  const row = { id, status, ...details };
  checks.push(row);
  if (!ok && options.block) failures.push(row);
  if (!ok && !options.block) warnings.push({ id, ...details, message: options.message || 'Live upstream prerequisite is absent.' });
}

const python = path.join(venv, 'bin', 'python');
const markitdown = path.join(venv, 'bin', 'markitdown');

function pythonJson(code) {
  if (!fs.existsSync(python)) return null;
  const proc = spawnSync(python, ['-c', code], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (proc.status !== 0) return { error: proc.stderr || proc.stdout || `exit ${proc.status}` };
  try {
    return JSON.parse(proc.stdout || '{}');
  } catch (error) {
    return { error: error.message, raw: proc.stdout };
  }
}

addCheck('upstream_capability_venv_exists', fs.existsSync(venv), { venv }, {
  block: strict,
  message: 'Create the upstream capability sandbox venv before strict external default evaluation.',
});
addCheck('upstream_capability_python_exists', fs.existsSync(python), { python }, {
  block: strict,
  message: 'Sandbox Python is required for Headroom and package-surface canaries.',
});
addCheck('markitdown_cli_exists', fs.existsSync(markitdown), { markitdown }, {
  block: strict,
  message: 'MarkItDown live canary requires the sandbox markitdown CLI.',
});

if (fs.existsSync(python)) {
  const metadata = pythonJson(`
import importlib.metadata as md, json
out = {}
for name in ["markitdown", "headroom"]:
    try:
        dist = md.distribution(name)
        meta = dist.metadata
        out[name] = {
            "version": dist.version,
            "name": meta.get("Name", ""),
            "summary": meta.get("Summary", ""),
            "home_page": meta.get("Home-page", ""),
            "project_urls": meta.get_all("Project-URL") or [],
            "requires_python": meta.get("Requires-Python", ""),
            "license": meta.get("License", "") or meta.get("License-Expression", ""),
            "description_sample": (meta.get("Description", "") or "")[:500],
        }
    except Exception as exc:
        out[name] = {"error": str(exc)}
print(json.dumps(out))
`);

  const markitdownMeta = metadata?.markitdown || {};
  addCheck('markitdown_distribution_installed', !markitdownMeta.error, { metadata: markitdownMeta }, {
    block: strict,
    message: 'MarkItDown distribution must be installed in the sandbox before strict external default evaluation.',
  });
  const markitdownIdentityText = [
    markitdownMeta.home_page || '',
    markitdownMeta.summary || '',
    markitdownMeta.description_sample || '',
    ...(markitdownMeta.project_urls || []),
  ].join(' ').toLowerCase();
  const markitdownSourceMatches = markitdownIdentityText.includes('microsoft/markitdown');
  addCheck('markitdown_distribution_has_source_identity', markitdownSourceMatches, {
    expected_source: 'https://github.com/microsoft/markitdown',
    observed_home_page: markitdownMeta.home_page || '',
    observed_version: markitdownMeta.version || '',
  }, {
    block: strict,
    message: 'The installed MarkItDown package must expose recognizable source identity before strict default evaluation.',
  });

  const headroomMeta = metadata?.headroom || {};
  addCheck('headroom_distribution_installed', !headroomMeta.error, { metadata: headroomMeta }, {
    block: strict,
    message: 'Headroom distribution must be installed in the sandbox before strict external default evaluation.',
  });
  const headroomSourceMatches = String(headroomMeta.home_page || '').toLowerCase().includes('chopratejas/headroom');
  addCheck('headroom_distribution_matches_registry_source', headroomSourceMatches, {
    expected_source: 'https://github.com/chopratejas/headroom',
    observed_home_page: headroomMeta.home_page || '',
    observed_license: headroomMeta.license || '',
  }, {
    block: strict,
    message: 'The installed headroom package must match the registry source before it can satisfy strict default prerequisites.',
  });

  const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8' });
  const cargoVersion = (cargo.stdout || '').match(/cargo\s+(\d+)\.(\d+)\.(\d+)/);
  const cargoSupportsEdition2024 = cargoVersion
    ? Number(cargoVersion[1]) > 1 || (Number(cargoVersion[1]) === 1 && Number(cargoVersion[2]) >= 85)
    : false;
  addCheck('headroom_source_build_cargo_supports_edition2024', cargoSupportsEdition2024, {
    cargo_version: (cargo.stdout || cargo.stderr || '').trim(),
    required_minimum: 'cargo 1.85.0',
  }, {
    block: strict,
    message: 'Registry Headroom source currently requires a Cargo toolchain that supports Rust edition2024 before strict default evaluation.',
  });

  const headroom = spawnSync(python, ['-c', 'import headroom; print(hasattr(headroom, "compress")); print(",".join([n for n in dir(headroom) if not n.startswith("_")][:20]))'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  const lines = (headroom.stdout || '').trim().split(/\n/);
  const importOk = headroom.status === 0;
  const hasCompress = lines[0] === 'True';
  addCheck('headroom_package_imports', importOk, { exit_code: headroom.status, stderr_tail: (headroom.stderr || '').slice(-1000) }, {
    block: strict,
    message: 'Headroom package must import in the sandbox before strict default evaluation.',
  });
  addCheck('headroom_compress_api_available', hasCompress, { public_attrs_sample: lines[1] || '' }, {
    block: strict,
    message: 'Installed Headroom package must expose a supported compression API before default evaluation.',
  });
} else {
  warnings.push({
    id: 'headroom_package_not_checked',
    message: 'Headroom package import/API was not checked because sandbox Python is missing.',
    python,
  });
}

const report = {
  schema_id: 'xlooop.external_capability_live_prereqs.verifier.v1',
  status: failures.length ? 'FAIL' : 'PASS',
  strict,
  venv,
  live_upstream_prereqs_ready: failures.length === 0 && warnings.length === 0,
  checks,
  failures,
  warnings,
  conclusion: failures.length === 0 && warnings.length === 0
    ? 'Live upstream capability prerequisites are present.'
    : 'External capabilities must remain canary/benchmark-only until live upstream prerequisites and strict runtime evidence pass.',
};

console.log(JSON.stringify(report, null, 2));
process.exit(failures.length ? 1 : 0);
