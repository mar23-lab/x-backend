#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stampProducerMeta } from './lib/data-projection-meta.mjs';
import { assertNoReadOnlyVerificationLock } from './lib/generated-artifact-lock.mjs';
import { buildTimestampIso } from './lib/build-timestamp.mjs';
import { stableArtifact } from './lib/stable-generated-artifact.mjs';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const flagVal = (name) => {
  const hit = argv.find((arg) => arg.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
};
const mbpRoot = process.env.MBP_ROOT || '/Users/maratbasyrov/WIP/MB-P';
const inferredXlooopRoot = path.resolve(repoRoot, '..');
const canonicalXlooopRoot = process.env.XLOOOP_WORKSPACE_ROOT || '/Users/maratbasyrov/WIP/Xlooop';
const xBizRoot = resolveXBizRoot();
const requireLive = process.env.XLOOOP_REQUIRE_MBP_LIVE === '1';
const defaultOutPath = path.join(repoRoot, 'data', 'operations-live-stream.json');
const outPath = path.resolve(
  flagVal('--out') || process.env.XLOOOP_OPERATIONS_LIVE_STREAM_OUT || defaultOutPath,
);
const mbpOwnedStreamPath = path.join(mbpRoot, '_sys/xcp-system/cross_repo_drafts/Xlooop-XCP-demo/data/operations-live-stream.json');
const XBIZ_INVESTOR_SOURCE_ADAPTER = 'x-biz-investor-readiness-source-adapter';
const LATEST_EVIDENCE_LEDGER_ADAPTER = 'mbp-latest-committed-evidence-ledger';
const REQUIRED_STREAM_TYPES = [
  'packet',
  'governance_event',
  'collaboration_event',
  'skill_invocation',
  'session_bundle',
  'graph_signal',
  'scorecard_signal',
  'readiness_signal',
  'gateway_receipt',
];
const REQUIRED_SOURCE_ADAPTERS = [
  'mbp-operations-projection',
  'mbp-governance-events-jsonl',
  'active-agent-collaboration-registry',
  'mbp-skill-invocation-log',
  'mbp-session-context-bundle',
  'mbp-ecosystem-graph-summary',
  'mbp-discipline-scorecard',
  'mbp-mode-coverage-report',
  'mbp-gateway-receipt-export',
  LATEST_EVIDENCE_LEDGER_ADAPTER,
];

assertNoReadOnlyVerificationLock('generate-operations-live-stream');

function readJson(absPath, optional = false) {
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch (error) {
    if (optional) return null;
    throw new Error(`Failed to read JSON ${absPath}: ${error.message}`);
  }
}

function readText(absPath, optional = false) {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch (error) {
    if (optional) return null;
    throw new Error(`Failed to read ${absPath}: ${error.message}`);
  }
}

function tailJsonLines(absPath, limit = 20) {
  const raw = readText(absPath, true);
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
}

const _gitTimeCache = new Map();
function fileMtimeIso(absPath) {
  // F5: prefer the file's git COMMIT time (deterministic across rebuilds) over the
  // filesystem mtime - the build mutates mtimes (it regenerates sibling artifacts), so
  // fs.statSync(...).mtime made operations-live-stream.json non-idempotent. fs mtime is
  // kept only as a fallback for untracked/new files. Memoised per path.
  if (_gitTimeCache.has(absPath)) return _gitTimeCache.get(absPath);
  let result = null;
  try {
    const iso = execFileSync('git', ['log', '-1', '--format=%cI', '--', absPath], {
      cwd: repoRoot, encoding: 'utf8',
    }).trim();
    if (iso) result = new Date(iso).toISOString();
  } catch (_) {
    /* fall through to fs mtime */
  }
  if (result === null) {
    try {
      result = fs.statSync(absPath).mtime.toISOString();
    } catch (_) {
      result = null;
    }
  }
  _gitTimeCache.set(absPath, result);
  return result;
}

function exists(absPath) {
  try {
    fs.accessSync(absPath, fs.constants.R_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function resolveXBizRoot() {
  const candidates = [
    process.env.X_BIZ_ROOT,
    path.join(inferredXlooopRoot, 'x-biz'),
    path.join(canonicalXlooopRoot, 'x-biz'),
  ].filter(Boolean);
  return candidates.find((candidate) => exists(candidate)) || candidates[0];
}

function relToMbp(absPath) {
  return path.relative(mbpRoot, absPath).replaceAll(path.sep, '/');
}

function relToXBiz(absPath) {
  return path.relative(xBizRoot, absPath).replaceAll(path.sep, '/');
}

function relSource(absPath) {
  const normalized = path.resolve(absPath);
  if (normalized.startsWith(repoRoot)) {
    return `Xlooop-XCP-demo/${path.relative(repoRoot, normalized).replaceAll(path.sep, '/')}`;
  }
  if (normalized.startsWith(xBizRoot)) {
    return `xlooop-x-biz/${relToXBiz(normalized)}`;
  }
  return relToMbp(normalized);
}

function evidenceRef(absPath, label) {
  return {
    ref_id: `mbp:${relToMbp(absPath)}`,
    label,
    source_path: relToMbp(absPath),
  };
}

function xBizEvidenceRef(absPath, label) {
  const sourcePath = relSource(absPath);
  return {
    ref_id: `x-biz:${relToXBiz(absPath)}`,
    label,
    source_path: sourcePath,
  };
}

function compactText(value, max = 160) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function safeId(value) {
  return String(value || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90) || 'unknown';
}

// W9 fix (260522): when two events share the same source timestamp + skill
// (e.g. an invoke and its outcome both logged in the same second), row_id
// must still differ so React keys stay unique and downstream consumers can
// rely on the contract-declared uniqueness of row_id.
function shortHash(...parts) {
  const input = parts.map(p => p == null ? '' : String(p)).join('|');
  // FNV-1a 32-bit — small, deterministic, no crypto dep needed at row-build time.
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function duplicateRowIds(rows) {
  const seen = new Set();
  const duplicates = new Map();
  for (const row of rows) {
    const rowId = row?.row_id;
    if (!rowId) continue;
    if (seen.has(rowId)) duplicates.set(rowId, (duplicates.get(rowId) || 1) + 1);
    seen.add(rowId);
  }
  return [...duplicates.entries()].map(([row_id, count]) => ({ row_id, count }));
}

// 260702 · GENERAL row_id de-collision — the universal safety net so build:standalone can NEVER break on a
// row_id collision (ANY stream type), not just the governance-event case that first bit us (#830). Deterministic
// + stable: the first occurrence keeps its id; each subsequent duplicate gets a positional ':2'/':3'… suffix.
// Runs before duplicateRowIds(), which stays as a post-condition tripwire — after this pass it must find zero.
function ensureUniqueRowIds(rows) {
  const counts = new Map();
  for (const row of rows) {
    const base = row?.row_id;
    if (!base) continue;
    const n = counts.get(base) || 0;
    counts.set(base, n + 1);
    if (n > 0) row.row_id = `${base}:${n + 1}`;
  }
  return rows;
}

function domainFromProject(projectId, fallback = 'MB-P governance') {
  const project = String(projectId || '').toLowerCase();
  if (project.includes('intake')) return 'Unified intake';
  if (project.includes('xcp')) return 'XCP';
  if (project.includes('xlooop')) return 'Xlooop product';
  if (project.includes('skill')) return 'MB-P skills';
  return fallback;
}

function targetFromDomain(domain, projectId) {
  if (/intake/i.test(domain) || /intake/i.test(projectId || '')) {
    return { workspace_id: 'mbp-private', project_id: 'mbp-intake', mode_jump: 'triage' };
  }
  if (/xcp/i.test(domain) || /xcp/i.test(projectId || '')) {
    return { workspace_id: 'xcp-platform', project_id: 'xcp-roadmap', mode_jump: 'substrate' };
  }
  if (/xlooop/i.test(domain) || /xlooop/i.test(projectId || '')) {
    return { workspace_id: 'xlooop', project_id: 'xlooop-product', mode_jump: 'overview' };
  }
  return { workspace_id: 'mbp-private', project_id: 'mbp-ops', mode_jump: 'signoff' };
}

function domainIdFromTarget(workspaceId, projectId, domain) {
  const project = String(projectId || '').toLowerCase();
  const label = String(domain || '').toLowerCase();
  if (workspaceId === 'mbp-private' && /intake/.test(`${project} ${label}`)) return 'mbp-intake';
  if (workspaceId === 'mbp-private' && /skill/.test(label)) return 'mbp-skills';
  if (workspaceId === 'mbp-private' && /graph/.test(label)) return 'mbp-graph';
  if (workspaceId === 'mbp-private') return 'mbp-governance';
  if (workspaceId === 'xcp-platform') return project.includes('roadmap') ? 'xcp-roadmap' : 'xcp-infrastructure';
  if (workspaceId === 'xlooop') return project.includes('commercial') ? 'xlooop-commercial' : 'xlooop-product';
  if (workspaceId === 'x-biz') return project || 'x-biz';
  if (workspaceId === 'x-docs') return project || 'x-docs';
  if (workspaceId === 'x-front') return project || 'x-front';
  return workspaceId || 'mbp-governance';
}

function domainKindFromTarget(workspaceId, projectId, domain) {
  const project = String(projectId || '').toLowerCase();
  const label = String(domain || '').toLowerCase();
  if (workspaceId === 'mbp-private' && /intake/.test(`${project} ${label}`)) return 'intake';
  if (workspaceId === 'mbp-private' && /skill/.test(label)) return 'skill_system';
  if (workspaceId === 'mbp-private' && /graph/.test(label)) return 'knowledge_graph';
  if (workspaceId === 'mbp-private') return 'governance';
  if (workspaceId === 'xcp-platform') return 'ai_infrastructure';
  if (workspaceId === 'xlooop') return project.includes('commercial') ? 'commercial_readiness' : 'commercial_product';
  if (workspaceId === 'x-biz') return 'business_knowledge';
  if (workspaceId === 'x-docs') return 'development_docs';
  if (workspaceId === 'x-front') return 'frontend_reference';
  return 'operations';
}

function laneIdFromModeJump(modeJump) {
  const value = safeId(modeJump || 'overview');
  if (!value || value === 'inbox') return 'needs-you';
  return value;
}

function boardIdFromStream(streamType, projectId) {
  const type = safeId(streamType || 'activity');
  const project = safeId(projectId || 'workspace');
  if (type.includes('gateway-receipt')) return `${project}-receipt-board`;
  if (type.includes('skill-invocation')) return `${project}-skill-board`;
  if (type.includes('graph')) return `${project}-learning-board`;
  if (type.includes('readiness') || type.includes('scorecard')) return `${project}-readiness-board`;
  return `${project}-activity-board`;
}

function actionForState(row) {
  const joined = `${row.state || ''} ${row.summary || ''} ${row.title || ''}`.toLowerCase();
  if (joined.includes('rollback')) return 'Open rollback';
  if (joined.includes('replay')) return 'Replay';
  if (joined.includes('signoff') || joined.includes('sign-off') || joined.includes('sign off')) return 'Sign off';
  if (joined.includes('owner') || joined.includes('decision')) return 'Confirm owner review';
  if (joined.includes('evidence')) return 'Mark evidence ready';
  if (joined.includes('xcp') || joined.includes('learning') || joined.includes('substrate')) return 'Open learning';
  return 'Open packet';
}

function rowBase(partial) {
  const target = targetFromDomain(partial.domain, partial.project_id);
  const workspaceId = partial.workspace_id || target.workspace_id;
  const projectId = partial.project_id || target.project_id;
  const modeJump = partial.mode_jump || target.mode_jump;
  const row = {
    schema_version: 'xlooop.operations_live_stream.row.v1',
    row_id: partial.row_id,
    stream_type: partial.stream_type,
    domain: partial.domain || 'MB-P governance',
    workspace_id: workspaceId,
    domain_id: partial.domain_id || domainIdFromTarget(workspaceId, projectId, partial.domain),
    domain_kind: partial.domain_kind || domainKindFromTarget(workspaceId, projectId, partial.domain),
    project_id: projectId,
    lane_id: partial.lane_id || laneIdFromModeJump(modeJump),
    board_id: partial.board_id || boardIdFromStream(partial.stream_type, projectId),
    mode_jump: modeJump,
    source_adapter: partial.source_adapter,
    state: partial.state || 'recorded',
    timestamp_iso: partial.timestamp_iso,
    title: partial.title,
    summary: partial.summary,
    quick_actions: partial.quick_actions || [],
    evidence_refs: partial.evidence_refs || [],
    replay_command: partial.replay_command || null,
    rollback_command: partial.rollback_command || null,
    source_event_id: partial.source_event_id || null,
    risk_lane: partial.risk_lane || 'low',
  };
  if (!row.quick_actions.length) row.quick_actions = [actionForState(row)];
  return row;
}

function rowTimestamp(row) {
  const ms = Date.parse(row.timestamp_iso || '');
  return Number.isFinite(ms) ? ms : 0;
}

function claimPosture() {
  return {
    read_model_snapshot: 'allowed_internal_owner_proof',
    live_streaming_operations: 'internal_sla_poll_allowed_public_blocked',
    public_claim_allowed: false,
    required_caveat: 'This is an MB-P-owned read-model snapshot with SLA-protected receipt polling for internal owner proof. Do not claim public live streaming operations or production SaaS until owner public claim sign-off and public-safe redaction exist.',
  };
}

function sourceCoverage(rows) {
  const streamTypes = new Set(rows.map(row => row.stream_type));
  const sourceAdapters = new Set(rows.map(row => row.source_adapter));
  const missingStreamTypes = REQUIRED_STREAM_TYPES.filter(item => !streamTypes.has(item));
  const missingSourceAdapters = REQUIRED_SOURCE_ADAPTERS.filter(item => !sourceAdapters.has(item));
  const requiredCount = REQUIRED_STREAM_TYPES.length + REQUIRED_SOURCE_ADAPTERS.length;
  const missingCount = missingStreamTypes.length + missingSourceAdapters.length;
  return {
    required_stream_types: REQUIRED_STREAM_TYPES,
    required_source_adapters: REQUIRED_SOURCE_ADAPTERS,
    missing_stream_types: missingStreamTypes,
    missing_source_adapters: missingSourceAdapters,
    coverage_percent: Number((((requiredCount - missingCount) / requiredCount) * 100).toFixed(2)),
  };
}

function sourceStatsBy(rows, key) {
  const out = {};
  for (const row of rows) {
    const value = row?.[key] || 'unknown';
    out[value] = (out[value] || 0) + 1;
  }
  return out;
}

function countBy(rows, key) {
  const out = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const value = row?.[key] || 'unknown';
    out[value] = (out[value] || 0) + 1;
  }
  return out;
}

function xBizSourcePath(relativePath) {
  return path.join(xBizRoot, relativePath);
}

function xBizSourceFiles() {
  return [
    'README.md',
    'START_HERE.md',
    'masters/INVESTOR_EVIDENCE_PACK.md',
    'masters/EVIDENCE_GAP_TRACKER.md',
    'masters/PITCH_DECK.md',
    'masters/PILOT_COMMERCIAL_MODEL.md',
    'investor/EXECUTIVE_SUMMARY.md',
    'investor/TRACTION.md',
    'investor/FINANCIAL_MODEL.md',
    'docs/_archive/audits/sales-evidence/sales-claims-evidence-map.json',
    'docs/_archive/audits/x-biz-evidence-gap-tracker.json',
    'docs/_archive/audits/yc-readiness-scorecard-20260502.json',
  ]
    .map(xBizSourcePath)
    .filter(exists);
}

function latestEvidenceLedgerSourceFiles() {
  return [
    path.join(mbpRoot, '_sys/xcp-system/governance/HARD_RULES.md'),
    path.join(mbpRoot, '_sys/scripts/verify_latest_committed_evidence_ledger.py'),
    path.join(mbpRoot, '_sys/skills/ecosystem-status-brief/SKILL.md'),
  ].filter(exists);
}

function buildLatestEvidenceLedgerRows() {
  const hardRulesPath = path.join(mbpRoot, '_sys/xcp-system/governance/HARD_RULES.md');
  const verifierPath = path.join(mbpRoot, '_sys/scripts/verify_latest_committed_evidence_ledger.py');
  const statusSkillPath = path.join(mbpRoot, '_sys/skills/ecosystem-status-brief/SKILL.md');
  const hardRules = readText(hardRulesPath, true) || '';
  const verifier = readText(verifierPath, true) || '';
  const statusSkill = readText(statusSkillPath, true) || '';
  const ruleActive = hardRules.includes('HR-LATEST-COMMITTED-EVIDENCE-1');
  const verifierActive = verifier.includes('latest_committed_evidence_ledger');
  const statusSkillActive = statusSkill.includes('latest_committed_evidence_ledger');
  const active = ruleActive && verifierActive && statusSkillActive;
  const evidenceRefs = latestEvidenceLedgerSourceFiles().map((sourcePath) =>
    evidenceRef(sourcePath, path.basename(sourcePath)),
  );
  if (!evidenceRefs.length) {
    evidenceRefs.push({
      ref_id: 'mbp:latest-committed-evidence-ledger',
      label: 'Latest committed evidence ledger MB-P rule',
      source_path: '_sys/xcp-system/governance/HARD_RULES.md',
    });
  }
  return [rowBase({
    row_id: 'latest-evidence-ledger:hr-latest-committed-evidence-1',
    stream_type: 'readiness_signal',
    domain: 'MB-P governance',
    workspace_id: 'mbp-private',
    project_id: 'mbp-ops',
    mode_jump: 'signoff',
    source_adapter: LATEST_EVIDENCE_LEDGER_ADAPTER,
    state: active ? 'latest_committed_evidence_ledger_active' : 'latest_committed_evidence_ledger_incomplete',
    timestamp_iso: fileMtimeIso(verifierPath) || fileMtimeIso(hardRulesPath) || buildTimestampIso(),
    title: 'Latest committed evidence ledger compliance',
    summary: active
      ? 'HR-LATEST-COMMITTED-EVIDENCE-1 active: latest/progress/blocker reports must list fetched refs plus read_full, read_partial, and not_read scope before claims.'
      : 'Latest committed evidence ledger projection is incomplete; MB-P hard rule, verifier, or status skill route is missing.',
    quick_actions: ['Open hard rule', 'Run ledger verifier', 'Confirm latest refs'],
    evidence_refs: evidenceRefs,
    replay_command: 'make verify-latest-committed-evidence-ledger-diff REF=HEAD~1',
    risk_lane: active ? 'near-0-risk' : 'medium-1',
  })];
}

function firstExistingXBizPath(relativePaths) {
  return relativePaths.map(xBizSourcePath).find(exists) || null;
}

function buildXBizInvestorReadinessRows() {
  if (!exists(xBizRoot)) return [];

  const trackerPath = firstExistingXBizPath([
    'masters/EVIDENCE_GAP_TRACKER.md',
    'docs/_archive/audits/x-biz-evidence-gap-tracker.json',
  ]);
  const trackerJsonPath = firstExistingXBizPath(['docs/_archive/audits/x-biz-evidence-gap-tracker.json']);
  const investorPackPath = firstExistingXBizPath(['masters/INVESTOR_EVIDENCE_PACK.md']);
  const pilotModelPath = firstExistingXBizPath(['masters/PILOT_COMMERCIAL_MODEL.md']);
  const pitchDeckPath = firstExistingXBizPath(['masters/PITCH_DECK.md']);
  const executiveSummaryPath = firstExistingXBizPath(['investor/EXECUTIVE_SUMMARY.md']);
  const tractionPath = firstExistingXBizPath(['investor/TRACTION.md']);
  const financialModelPath = firstExistingXBizPath(['investor/FINANCIAL_MODEL.md']);
  const salesClaimsPath = firstExistingXBizPath(['docs/_archive/audits/sales-evidence/sales-claims-evidence-map.json']);
  const ycScorecardPath = firstExistingXBizPath(['docs/_archive/audits/yc-readiness-scorecard-20260502.json']);

  const trackerJson = trackerJsonPath ? readJson(trackerJsonPath, true) : null;
  const salesClaims = salesClaimsPath ? readJson(salesClaimsPath, true) : null;
  const ycScorecard = ycScorecardPath ? readJson(ycScorecardPath, true) : null;
  const trackerStatusCounts = trackerJson?.claims ? countBy(trackerJson.claims, 'status') : {};
  const salesClaimSafetyCounts = salesClaims?.claims ? countBy(salesClaims.claims, 'claim_safety') : {};
  const rows = [];

  function add(relativeId, sourcePath, partial) {
    if (!sourcePath) return;
    rows.push(rowBase({
      row_id: `xbiz-investor-readiness:${relativeId}`,
      domain: 'x-biz investor readiness',
      workspace_id: 'x-biz',
      project_id: 'x-biz-investor-readiness',
      mode_jump: partial.mode_jump || 'evidence',
      source_adapter: XBIZ_INVESTOR_SOURCE_ADAPTER,
      timestamp_iso: partial.timestamp_iso || fileMtimeIso(sourcePath) || buildTimestampIso(),
      evidence_refs: [
        xBizEvidenceRef(sourcePath, partial.evidence_label || partial.title),
        ...(partial.evidence_refs || []),
      ],
      risk_lane: partial.risk_lane || 'low',
      ...partial,
    }));
  }

  // Round 10 R10.2 (2026-05-20) · naming compression. Stripped redundant
  // 'Investor readiness · ' prefix from titles + 'x-biz ' prefix from
  // evidence labels — when the row is rendered inside the Investor-
  // readiness project scope, the parent context is already shown in the
  // topbar crumbs + project supernav. Rail-only renderers still display
  // row.workspace / row.project as compact scope crumbs, preserving
  // traceability when the row appears outside a master-detail pane
  // (e.g., cross-workspace global feed).
  add('claim-safety-ledger', trackerPath, {
    stream_type: 'readiness_signal',
    state: 'claim_safety_canonical_review_required',
    title: 'Claim-safety ledger',
    summary: compactText(`Canonical x-biz evidence gate is bound. Status mix: ${Object.entries(trackerStatusCounts).map(([k, v]) => `${k}=${v}`).join(' · ') || 'markdown ledger available'}; external claims still require tracker status and owner review.`, 220),
    quick_actions: ['Review claim safety', 'Open evidence', 'Prepare owner sign-off'],
    evidence_label: 'Canonical evidence-gap tracker',
  });

  add('investor-evidence-pack', investorPackPath, {
    stream_type: 'packet',
    state: 'investor_pack_review_required',
    title: 'Investor evidence pack',
    summary: 'Category, demo proof, pilot model, defensibility, risks, missing proof, and next milestone are available from the x-biz master evidence pack.',
    quick_actions: ['Open evidence', 'Prepare investor pack', 'Mark evidence ready'],
    evidence_label: 'Investor evidence pack',
  });

  add('pilot-commercial-model', pilotModelPath, {
    stream_type: 'readiness_signal',
    state: 'pilot_model_ready_for_owner_review',
    title: 'Pilot commercial model',
    summary: 'Current pilot posture is 4-6 weeks, one team, one project, one capability slice; use as the commercial readiness path before broad rollout claims.',
    quick_actions: ['Open pilot model', 'Create proposal receipt', 'Confirm owner review'],
    evidence_label: 'Pilot commercial model',
  });

  add('pitch-deck-claim-posture', pitchDeckPath, {
    stream_type: 'governance_event',
    state: 'deck_claims_require_tracker_alignment',
    title: 'Pitch deck posture',
    summary: 'Pitch materials are bound to x-biz masters and must map factual claims through the evidence tracker before external use.',
    quick_actions: ['Review deck claims', 'Open evidence', 'Confirm owner review'],
    evidence_label: 'Pitch deck',
  });

  add('executive-summary', executiveSummaryPath, {
    stream_type: 'packet',
    state: 'investor_summary_available',
    title: 'Executive summary',
    summary: 'Investor summary is available for owner review with demo posture, problem, solution, traction, market, team, and ask sections.',
    quick_actions: ['Open evidence', 'Review summary', 'Prepare owner sign-off'],
    evidence_label: 'Executive summary',
  });

  add('traction-register', tractionPath, {
    stream_type: 'scorecard_signal',
    state: 'traction_verification_gated',
    title: 'Traction register',
    summary: 'Traction, recognition, strategic interest, IP, grant, customer validation, and pipeline evidence exists with verification status; do not promote unsupported items.',
    quick_actions: ['Review verification status', 'Open evidence', 'Prepare owner sign-off'],
    evidence_label: 'Traction register',
    risk_lane: 'medium-1',
  });

  add('financial-model', financialModelPath, {
    stream_type: 'scorecard_signal',
    state: 'financial_model_owner_review_required',
    title: 'Financial model',
    summary: 'Pricing, ACV, unit economics, 5-year projections, and raise assumptions are available as investor-model evidence pending owner confirmation where marked.',
    quick_actions: ['Open model', 'Confirm owner review', 'Create proposal receipt'],
    evidence_label: 'Financial model',
  });

  add('sales-claims-map', salesClaimsPath, {
    stream_type: 'governance_event',
    state: 'restricted_internal_claim_safety',
    title: 'Sales claims evidence map',
    summary: compactText(`Restricted local sales evidence is summarized without raw PII. Claim-safety mix: ${Object.entries(salesClaimSafetyCounts).map(([k, v]) => `${k}=${v}`).join(' · ') || 'audit map available'}.`, 220),
    quick_actions: ['Review claim safety', 'Open redacted evidence summary', 'Confirm owner review'],
    evidence_label: 'Sales claims evidence map',
    risk_lane: salesClaims?.contains_pii ? 'medium-1' : 'low',
  });

  add('yc-readiness-scorecard', ycScorecardPath, {
    stream_type: 'readiness_signal',
    state: 'historical_scorecard_needs_refresh_check',
    title: 'YC readiness scorecard',
    summary: compactText(`YC readiness scorecard is available as historical evidence${ycScorecard?.date ? ` from ${ycScorecard.date}` : ''}; refresh before using as current investor posture.`, 200),
    quick_actions: ['Review scorecard', 'Refresh readiness', 'Confirm owner review'],
    evidence_label: 'YC readiness scorecard',
  });

  return rows;
}

function mergeXBizInvestorRows(contract) {
  const xbizRows = buildXBizInvestorReadinessRows();
  const latestEvidenceLedgerRows = buildLatestEvidenceLedgerRows();
  if (!xbizRows.length && !latestEvidenceLedgerRows.length) return contract;
  const rows = [
    ...(contract.rows || []).filter((row) =>
      row.source_adapter !== XBIZ_INVESTOR_SOURCE_ADAPTER
      && row.source_adapter !== LATEST_EVIDENCE_LEDGER_ADAPTER
      && !String(row.row_id || '').startsWith('xbiz-investor-readiness:')
      && !String(row.row_id || '').startsWith('latest-evidence-ledger:')),
    ...xbizRows,
    ...latestEvidenceLedgerRows,
  ]
    .filter((row) => row.timestamp_iso && row.title && row.source_adapter)
    .sort((a, b) => rowTimestamp(b) - rowTimestamp(a))
    .slice(0, 64);
  const requiredSourceCoverage = sourceCoverage(rows);
  const sourceFiles = [
    ...(Array.isArray(contract.source_files) ? contract.source_files : []),
    ...xBizSourceFiles().map(relSource),
    ...latestEvidenceLedgerSourceFiles().map(relSource),
  ];
  const uniqueSourceFiles = [...new Set(sourceFiles)];
  return {
    ...contract,
    source_files: uniqueSourceFiles,
    required_source_coverage: requiredSourceCoverage,
    metrics: {
      ...(contract.metrics || {}),
      rows_total: rows.length,
      by_stream_type: sourceStatsBy(rows, 'stream_type'),
      by_domain: sourceStatsBy(rows, 'domain'),
      source_file_count: uniqueSourceFiles.length,
      source_coverage_percent: requiredSourceCoverage.coverage_percent,
      x_biz_investor_readiness_rows: rows.filter((row) => row.workspace_id === 'x-biz' && row.project_id === 'x-biz-investor-readiness').length,
    },
    rows,
  };
}

function isMbpOwnedOperationsLiveStream(contract) {
  return contract
    && contract.schema_id === 'operations_live_stream_v1'
    && contract.schema_version === 'xlooop.operations_live_stream.v1'
    && contract.contract_kind === 'operations_live_stream'
    && contract.contract_version === 'v1.0.0'
    && contract.authority_model === 'mbp_owned_read_model_snapshot'
    && contract.source_repo === 'MB-P'
    && contract.consumer_repo === 'Xlooop-XCP-demo'
    && contract.source_mode === 'staged_snapshot'
    && contract.fallback_fixture_used === false
    && contract.direct_mbp_repo_write_allowed === false
    && contract.claim_posture?.live_streaming_operations === 'internal_sla_poll_allowed_public_blocked'
    && contract.gateway_poll_sla?.state === 'green'
    && isFreshOperationsLiveStream(contract)
    && contract.authoritative_receipt_ingestion?.source_adapter === 'mbp-gateway-receipt-export'
    && contract.authoritative_receipt_ingestion?.coverage_percent === 100
    && Array.isArray(contract.rows)
    && contract.rows.length > 0;
}

function isFreshOperationsLiveStream(contract) {
  const now = Date.now();
  const generatedAt = Date.parse(contract?.generated_at || '');
  const validUntil = Date.parse(contract?.valid_until || '');
  const lastPoll = Date.parse(contract?.gateway_poll_sla?.last_successful_poll_at || '');
  const staleAfterSeconds = Number(contract?.gateway_poll_sla?.stale_after_seconds || 900);
  if (!Number.isFinite(generatedAt) || !Number.isFinite(validUntil) || !Number.isFinite(lastPoll)) {
    return false;
  }
  if (generatedAt > now + 5 * 60 * 1000 || lastPoll > now + 5 * 60 * 1000) {
    return false;
  }
  return validUntil > now && now - lastPoll <= staleAfterSeconds * 1000;
}

function loadSessionBundleRows(sessionDir) {
  if (!exists(sessionDir)) return [];
  return fs
    .readdirSync(sessionDir)
    .filter((file) => file.endsWith('.md'))
    .map((file) => {
      const abs = path.join(sessionDir, file);
      return { file, abs, mtime: fileMtimeIso(abs) };
    })
    .sort((a, b) => Date.parse(b.mtime || 0) - Date.parse(a.mtime || 0))
    .slice(0, 6)
    .map(({ file, abs, mtime }) => {
      const name = file.replace(/\.md$/, '').replace(/-\d{8}$/, '');
      const domain = name.includes('xcp') ? 'XCP' : name.includes('intake') ? 'Unified intake' : 'MB-P governance';
      return rowBase({
        row_id: `session-bundle:${safeId(file)}`,
        stream_type: 'session_bundle',
        domain,
        source_adapter: 'mbp-session-context-bundle',
        state: 'context_bundle_available',
        timestamp_iso: mtime,
        title: `Session bundle · ${name}`,
        summary: 'Latest MB-P role/session context bundle available for operator review and downstream agents.',
        evidence_refs: [evidenceRef(abs, `Session bundle ${file}`)],
        quick_actions: ['Open packet'],
      });
    });
}

function buildRows(sources) {
  const rows = [];
  const projection = sources.operationsProjection;
  if (projection?.packets?.length) {
    for (const packet of projection.packets) {
      const domain = domainFromProject(packet.project_id);
      rows.push(rowBase({
        row_id: `packet:${safeId(packet.packet_id)}`,
        stream_type: 'packet',
        domain,
        workspace_id: packet.workspace_id,
        project_id: packet.project_id,
        source_adapter: 'mbp-operations-projection',
        state: packet.lifecycle_state || 'projected_packet',
        timestamp_iso: projection.generated_at,
        title: packet.title || packet.packet_id,
        summary: compactText([
          `owner=${packet.owner_confirmation_state || 'unknown'}`,
          `evidence=${packet.evidence_state || 'unknown'}`,
          `signoff=${packet.signoff_state || 'unknown'}`,
          `xcp=${packet.xcp_feedback_state || 'unknown'}`,
        ].join(' · ')),
        evidence_refs: [
          evidenceRef(sources.operationsProjectionPath, 'MB-P operations projection'),
          ...(packet.source_refs || []).slice(0, 1).map((ref) => ({
            ref_id: ref.ref_id || `mbp:${safeId(ref.label || ref.uri)}`,
            label: compactText(ref.label || ref.uri || 'MB-P source ref', 80),
            uri: ref.uri || null,
            source_path: ref.content_path || null,
          })),
        ],
        quick_actions: ['Open packet', 'Mark evidence ready', 'Sign off', 'Open learning'],
        replay_command: `npm run verify:mbp-live-projection-adapter -- ${packet.packet_id}`,
        rollback_command: null,
        risk_lane: packet.owner_confirmation_state === 'confirmed' ? 'near-0-risk' : 'low',
      }));
    }
  }

  for (const event of sources.governanceEvents) {
    const payload = event.payload || {};
    const title = event.event_type || payload.signal_class || 'Governance event';
    // 260702 · Same-second, same-event_type governance events collided on row_id — e.g. the 4 closing SkillInvoked
    // events for ONE commit (xcp-atomic-closure / parallel-session-branch-guard / xcp-cycle-retrospective /
    // xcp-plan-completion-handoff) all share timestamp+title. Disambiguate by payload.skill_id for a SEMANTIC
    // row_id; the global ensureUniqueRowIds() pass is the universal positional safety net for any residual clash.
    const disc = payload.skill_id ? `:${safeId(payload.skill_id)}` : '';
    const rowId = `governance-event:${safeId(event.timestamp)}:${safeId(title)}${disc}`;
    rows.push(rowBase({
      row_id: rowId,
      stream_type: 'governance_event',
      domain: /intake|route|prompt/i.test(JSON.stringify(payload)) ? 'Unified intake' : 'MB-P governance',
      source_adapter: 'mbp-governance-events-jsonl',
      state: payload.signal_class || event.event_type || 'governance_event',
      timestamp_iso: event.timestamp,
      title,
      summary: compactText(payload.prompt_excerpt || payload.excerpt || payload.correction_excerpt || payload.signal_phrase || 'Operator/governance signal captured by MB-P.'),
      evidence_refs: [evidenceRef(sources.governanceEventsPath, 'MB-P governance event stream')],
      source_event_id: payload.session_id || null,
      quick_actions: ['Open packet', 'Confirm owner review'],
    }));
  }

  for (const event of sources.collaborationEvents) {
    const payload = event.payload || {};
    const report = payload.report || {};
    const claim = payload;
    rows.push(rowBase({
      row_id: `collaboration-event:${safeId(event.event_id || event.created_at)}`,
      stream_type: 'collaboration_event',
      domain: 'MB-P collaboration',
      source_adapter: 'active-agent-collaboration-registry',
      state: report.status || event.event_type || claim.status || 'collaboration_event',
      timestamp_iso: event.created_at,
      title: event.event_type === 'ClaimWork' ? `Claim · ${claim.work_item_id || claim.session_id}` : event.event_type || 'Collaboration event',
      summary: compactText(report.recommended_action || claim.summary || 'Agent collaboration registry event.'),
      evidence_refs: [evidenceRef(sources.collaborationEventsPath, 'Active agent collaboration events')],
      source_event_id: event.event_id,
      quick_actions: event.event_type === 'PlanCheck' ? ['Open packet', 'Confirm owner review'] : ['Open packet'],
      risk_lane: report.status === 'BLOCKED' ? 'medium-1' : report.status === 'WARN' ? 'low' : 'near-0-risk',
    }));
  }

  for (const entry of sources.skillInvocations) {
    const state = entry.context?.outcome || 'invoked';
    const summary = `${entry.invoked_by || 'unknown'} · ${entry.context?.trigger_pattern || entry.mode || 'runtime invocation'}`;
    rows.push(rowBase({
      row_id: `skill-invocation:${safeId(entry.ts)}:${safeId(entry.skill_id)}:${shortHash(state, summary, entry.invoked_by)}`,
      stream_type: 'skill_invocation',
      domain: entry.skill_id?.includes('intake') ? 'Unified intake' : 'MB-P skills',
      source_adapter: 'mbp-skill-invocation-log',
      state: entry.context?.outcome || 'invoked',
      timestamp_iso: entry.ts,
      title: `Skill invoked · ${entry.skill_id || 'unknown skill'}`,
      summary: compactText(`${entry.invoked_by || 'unknown'} · ${entry.context?.trigger_pattern || entry.mode || 'runtime invocation'}`),
      evidence_refs: [evidenceRef(sources.skillInvocationsPath, 'MB-P skill invocation log')],
      quick_actions: ['Open packet'],
    }));
  }

  rows.push(...loadSessionBundleRows(sources.sessionBundlesDir));

  if (sources.graphSummary?.summary) {
    const summary = sources.graphSummary.summary;
    rows.push(rowBase({
      row_id: `graph-summary:${safeId(sources.graphSummary.generated_at)}`,
      stream_type: 'graph_signal',
      domain: 'MB-P graph',
      source_adapter: 'mbp-ecosystem-graph-summary',
      state: 'graph_summary_current',
      timestamp_iso: sources.graphSummary.generated_at,
      title: 'Ecosystem graph summary',
      summary: compactText(`${summary.total_nodes} nodes · ${summary.total_edges} edges · ${summary.coverage?.intake_events || 0} intake events`),
      evidence_refs: [evidenceRef(sources.graphSummaryPath, 'MB-P ecosystem graph latest summary')],
      quick_actions: ['Open learning'],
    }));
  }

  if (sources.scorecard?.sub_metrics) {
    const metrics = sources.scorecard.sub_metrics;
    const m1 = metrics.M1?.value;
    const m2 = metrics.M2?.value;
    rows.push(rowBase({
      row_id: `scorecard:${safeId(sources.scorecard.scanned_at)}`,
      stream_type: 'scorecard_signal',
      domain: 'MB-P governance',
      source_adapter: 'mbp-discipline-scorecard',
      state: 'discipline_scorecard_current',
      timestamp_iso: sources.scorecard.scanned_at,
      title: 'Governance discipline scorecard',
      summary: compactText(`M1 citation ${m1 ?? 'n/a'} · M2 parity ${m2 ?? 'n/a'} · metrics tracked ${Object.keys(metrics).length}`),
      evidence_refs: [evidenceRef(sources.scorecardPath, 'MB-P discipline scorecard latest')],
      quick_actions: ['Open learning', 'Confirm owner review'],
      risk_lane: Number(m2) < 20 ? 'medium-1' : 'low',
    }));
  }

  const modeCoverageMetric = sources.modeCoverage?.coverage || sources.modeCoverage?.m6b_engine_contract_adoption;
  if (modeCoverageMetric) {
    const adoption = modeCoverageMetric.engine_contract_adoption_pct ?? modeCoverageMetric.adoption_rate_pct ?? 'n/a';
    const target = modeCoverageMetric.target_pct ?? modeCoverageMetric.target_operating_modules ?? 'unratified';
    rows.push(rowBase({
      row_id: `mode-coverage:${safeId(sources.modeCoverage.scanned_at)}`,
      stream_type: 'readiness_signal',
      domain: 'XCP',
      source_adapter: 'mbp-mode-coverage-report',
      state: 'mode_coverage_current',
      timestamp_iso: sources.modeCoverage.scanned_at,
      title: 'Mode coverage and engine adoption',
      summary: compactText(`Engine-contract adoption ${adoption}% · target ${target}`),
      evidence_refs: [evidenceRef(sources.modeCoveragePath, 'MB-P mode coverage report')],
      quick_actions: ['Open learning'],
      risk_lane: 'low',
    }));
  }

  if (sources.gatewayReceipts?.receipts?.length) {
    for (const receipt of sources.gatewayReceipts.receipts) {
      rows.push(rowBase({
        row_id: `gateway-receipt:${safeId(receipt.receipt_id)}`,
        stream_type: 'gateway_receipt',
        domain: 'MB-P gateway',
        workspace_id: 'mbp-private',
        project_id: 'mbp-ops',
        mode_jump: 'signoff',
        source_adapter: 'mbp-gateway-receipt-export',
        state: receipt.receipt_state || 'receipt_recorded',
        timestamp_iso: receipt.receipt_observed_at || sources.gatewayReceipts.generated_at,
        title: `Gateway receipt · ${receipt.proposal_kind}`,
        summary: compactText(`${receipt.source_adapter} -> ${receipt.runtime_adapter} · ${receipt.owner_decision_state} · idempotency ${receipt.idempotency_key}`),
        evidence_refs: (receipt.evidence_refs || []).map((ref) => ({
          ref_id: ref.ref_id || `receipt:${safeId(receipt.receipt_id)}`,
          label: ref.ref_id || 'Gateway receipt evidence',
          uri: ref.uri || null,
          source_path: ref.source_path || null,
        })),
        source_event_id: receipt.receipt_id,
        quick_actions: ['Open packet', 'Confirm owner review', 'Replay', 'Rollback'],
        replay_command: receipt.replay_ref || null,
        rollback_command: receipt.rollback_ref || null,
        risk_lane: receipt.receipt_state === 'accepted_by_mbp' ? 'near-0-risk' : 'medium-1',
      }));
    }
  }

  rows.push(...buildXBizInvestorReadinessRows());
  rows.push(...buildLatestEvidenceLedgerRows());

  return rows
    .filter((row) => row.timestamp_iso && row.title && row.source_adapter)
    .sort((a, b) => rowTimestamp(b) - rowTimestamp(a))
    .slice(0, 64);
}

function buildContract() {
  if (!exists(mbpRoot)) {
    if (requireLive) throw new Error(`MB-P root not found: ${mbpRoot}`);
    if (exists(outPath)) {
      console.warn(`generate-operations-live-stream · WARN MB-P root missing; keeping existing ${outPath}`);
      return null;
    }
    throw new Error(`MB-P root not found and no existing live stream data: ${mbpRoot}`);
  }

  const mbpOwnedStream = readJson(mbpOwnedStreamPath, true);
  if (isMbpOwnedOperationsLiveStream(mbpOwnedStream)) {
    return mergeXBizInvestorRows(mbpOwnedStream);
  }

  const projectionPaths = [
    path.join(mbpRoot, '_sys/xcp-system/cross_repo_drafts/Xlooop-XCP-demo/data/mbp-operations-projection.json'),
    path.join(repoRoot, 'data/mbp-operations-projection.json'),
  ];
  const operationsProjectionPath = projectionPaths.find(exists);
  if (!operationsProjectionPath) throw new Error('No MB-P operations projection found');

  const gatewayReceiptPaths = [
    path.join(repoRoot, 'data/mbp-gateway-receipts.json'),
    path.join(mbpRoot, '_sys/xcp-system/cross_repo_drafts/Xlooop-XCP-demo/data/mbp-gateway-receipts.json'),
  ];
  const gatewayReceiptsPath = gatewayReceiptPaths.find(exists);
  if (!gatewayReceiptsPath) throw new Error('No MB-P gateway receipt projection found');

  const modeCoverageDir = path.join(mbpRoot, '_sys/xcp-system/evidence/discoverability/mode-coverage');
  const modeCoveragePath = exists(modeCoverageDir)
    ? fs.readdirSync(modeCoverageDir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => path.join(modeCoverageDir, file))
      .sort((a, b) => Date.parse(fileMtimeIso(b) || 0) - Date.parse(fileMtimeIso(a) || 0))[0]
    : null;

  const sources = {
    operationsProjectionPath,
    operationsProjection: readJson(operationsProjectionPath),
    governanceEventsPath: path.join(mbpRoot, '_sys/xcp-system/derivative/governance-events.jsonl'),
    collaborationEventsPath: path.join(mbpRoot, '_sys/xcp-system/derivative/active-agent-collaboration/collaboration_events.jsonl'),
    skillInvocationsPath: path.join(mbpRoot, '_sys/xcp-system/derivative/skill-invocation-log.ndjson'),
    sessionBundlesDir: path.join(mbpRoot, '_sys/xcp-system/derivative/session-bundles'),
    graphSummaryPath: path.join(mbpRoot, '_sys/xcp-system/derivative/ecosystem-graph/graph-latest-summary.json'),
    scorecardPath: path.join(mbpRoot, '_sys/xcp-system/derivative/discipline-scorecard-latest.json'),
    modeCoveragePath,
    gatewayReceiptsPath,
  };
  sources.governanceEvents = tailJsonLines(sources.governanceEventsPath, 12);
  sources.collaborationEvents = tailJsonLines(sources.collaborationEventsPath, 12);
  sources.skillInvocations = tailJsonLines(sources.skillInvocationsPath, 10);
  sources.graphSummary = readJson(sources.graphSummaryPath, true);
  sources.scorecard = readJson(sources.scorecardPath, true);
  sources.modeCoverage = modeCoveragePath ? readJson(modeCoveragePath, true) : null;
  sources.gatewayReceipts = readJson(gatewayReceiptsPath, true);

  const rows = buildRows(sources);
  ensureUniqueRowIds(rows); // 260702 · universal de-collision (any stream type) — the build can no longer break on a row_id clash
  const duplicateIds = duplicateRowIds(rows);
  if (duplicateIds.length) {
    throw new Error(`operations-live-stream row_id uniqueness violated: ${JSON.stringify(duplicateIds.slice(0, 10))}`);
  }
  const requiredSourceCoverage = sourceCoverage(rows);
  const byType = {};
  const byDomain = {};
  for (const row of rows) {
    byType[row.stream_type] = (byType[row.stream_type] || 0) + 1;
    byDomain[row.domain] = (byDomain[row.domain] || 0) + 1;
  }

  const generatedAt = buildTimestampIso();
  const sourceFiles = [
    operationsProjectionPath,
    sources.governanceEventsPath,
    sources.collaborationEventsPath,
    sources.skillInvocationsPath,
    sources.graphSummaryPath,
    sources.scorecardPath,
    ...(modeCoveragePath ? [modeCoveragePath] : []),
    gatewayReceiptsPath,
    ...latestEvidenceLedgerSourceFiles(),
  ].filter(Boolean).map(relSource);
  sourceFiles.push(...(sources.gatewayReceipts?.source_files || []));
  sourceFiles.push(...xBizSourceFiles().map(relSource));
  const uniqueSourceFiles = [...new Set(sourceFiles)];
  return {
    schema_id: 'operations_live_stream_v1',
    schema_version: 'xlooop.operations_live_stream.v1',
    contract_kind: 'operations_live_stream',
    contract_version: 'v1.0.0',
    stream_id: `operations-live-stream-${generatedAt.slice(0, 19).replace(/[-:T]/g, '')}`,
    authority_source: 'MB-P operations live stream authority',
    authority_model: 'mbp_owned_read_model_snapshot',
    source_repo: 'MB-P',
    consumer_repo: 'Xlooop-XCP-demo',
    source_mode: 'staged_snapshot',
    claim_posture: claimPosture(),
    gateway_poll_sla: sources.gatewayReceipts?.poll_sla || {
      state: 'red',
      cadence_seconds: 300,
      stale_after_seconds: 900,
      last_successful_poll_at: generatedAt,
      next_poll_due_at: generatedAt,
    },
    authoritative_receipt_ingestion: {
      schema_version: 'mbp.gateway_receipts.v1',
      source_adapter: 'mbp-gateway-receipt-export',
      projection_id: sources.gatewayReceipts?.projection_id || 'missing',
      authority_source: sources.gatewayReceipts?.authority_source || 'mb-p-gateway',
      receipt_count: (sources.gatewayReceipts?.receipts || []).length,
      coverage_percent: sources.gatewayReceipts?.receipt_coverage?.coverage_percent || 0,
      direct_mbp_repo_write_allowed: false,
      raw_content_included: false,
    },
    fallback_fixture_used: false,
    direct_mbp_repo_write_allowed: false,
    private_mbp_data_allowed_by_owner: true,
    generated_at: generatedAt,
    // F5: deterministic (derived from the commit-time generatedAt, not Date.now()) so a
    // no-op rebuild is byte-identical. Freshness stays meaningful: the stream is valid for
    // 4h after the SOURCE commit (a committed snapshot that is genuinely older is correctly
    // treated as stale by the validUntil>now check).
    valid_until: new Date(Date.parse(generatedAt) + 4 * 60 * 60 * 1000).toISOString(),
    source_files: uniqueSourceFiles,
    required_source_coverage: requiredSourceCoverage,
    metrics: {
      rows_total: rows.length,
      by_stream_type: byType,
      by_domain: byDomain,
      source_file_count: uniqueSourceFiles.length,
      source_coverage_percent: requiredSourceCoverage.coverage_percent,
    },
    rows,
  };
}

const contract = buildContract();
if (contract) {
  // Round 13 R13.4 (2026-05-20) · stamp _meta envelope so the smoke validator
  // (R13.2) and runtime reader (R13.3) can detect producer drift. The
  // envelope declares { schema, generated_at, producer, git_sha }.
  const freshStamped = stampProducerMeta(contract, {
    schema: 'operations-live-stream.v1',
    producer: 'scripts/generate-operations-live-stream.mjs',
    generatedAt: contract.generated_at,
    // This file is a tracked freshness snapshot. Stamping the consumer HEAD
    // creates an impossible commit feedback loop because the containing commit
    // cannot be known before the file is generated.
    gitSha: '',
  });
  // A-OPS-1: preserve the committed artifact when only the mechanical HEAD-time fields (generated_at/
  // valid_until/stream_id/git_sha) differ — a no-op rebuild is then byte-identical (no --skip-build).
  let committed = null;
  try { committed = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch { committed = null; }
  const stamped = stableArtifact(freshStamped, committed);
  const output = `${JSON.stringify(stamped, null, 2)}\n`;
  if (process.env.XCP_VERIFY_READONLY === '1') {
    const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
    const status = current === output ? 'unchanged' : 'would_update';
    console.log(`generate-operations-live-stream · readonly ${status} ${path.relative(repoRoot, outPath)} · ${contract.rows.length} rows`);
    process.exit(0);
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, output);
  console.log(`generate-operations-live-stream · wrote ${path.relative(repoRoot, outPath)} · ${contract.rows.length} rows`);
}
