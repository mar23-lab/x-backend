#!/usr/bin/env node
// verify-api-mcp-lifecycle-parity.mjs
//
// Customer-zero canary verifier for the backend-first API/MCP boundary.
// It proves exact packet identity and lifecycle read parity. With only the
// read canary token it proves writes fail closed. With the separate lifecycle
// canary token it writes synthetic pkt-canary-* metadata rows and proves API/MCP
// status converge without opening customer data, raw graph, memory, or admin
// surfaces.
//
// This script intentionally never creates customer data.

import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';

const API_BASE = (process.env.XLOOOP_API_BASE || 'https://api.xlooop.com').replace(/\/+$/, '');
const PACKET_ID = process.env.XLOOOP_PARITY_PACKET_ID || '';
const CANARY_FILE = process.env.XLOOOP_CANARY_API_TOKEN_FILE || '/tmp/xlooop-canary-api-token.txt';
const LIFECYCLE_CANARY_FILE = process.env.XLOOOP_CANARY_LIFECYCLE_API_TOKEN_FILE || '/tmp/xlooop-canary-lifecycle-api-token.txt';
const FORMAT = parseArg('format') || process.env.XLOOOP_PARITY_FORMAT || 'pretty';

const FORBIDDEN_SURFACES = [
  'raw_graph',
  'full_tenant_memory',
  'xlooop_internal_templates',
  'governance_scoring',
  'agent_routing',
  'private_graph_schema',
  'secrets',
  'search_all_memory',
];

const ALLOWED_DISCLOSURE_KEYS = new Set([
  'blocked_surfaces',
  'forbidden_surfaces',
  'forbidden_tools',
]);

const result = {
  schema_id: 'xlooop.api_mcp_lifecycle_parity_verifier.v1',
  status: 'PASS',
  mode: 'read_boundary_canary',
  api_base: API_BASE,
  packet_id: PACKET_ID,
  checks: [],
  failures: [],
  warnings: [],
};

if (!PACKET_ID) {
  fail('packet_id_missing', 'XLOOOP_PARITY_PACKET_ID is required');
  finish();
}

if (!PACKET_ID.startsWith('pkt-canary-')) {
  warn('packet_id_not_canary_prefixed', 'packet id is not prefixed with pkt-canary-; using it only for read parity', {
    packet_id: PACKET_ID,
  });
}

const credential = loadCanaryCredential();
if (!credential.token) {
  fail('canary_credential_missing', 'XLOOOP_CANARY_API_TOKEN or /tmp/xlooop-canary-api-token.txt is required', {
    files_checked: [CANARY_FILE],
  });
  finish();
}

const canary = validateCanaryToken(credential.token);
if (!canary.ok) {
  fail('canary_token_invalid', canary.reason, { token_source: credential.source });
  finish();
}
pass('canary_token_present', { token_source: credential.source, token_length: canary.length });

await run();
finish();

function parseArg(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : '';
}

function cleanToken(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '');
}

function loadCanaryCredential() {
  if (process.env.XLOOOP_CANARY_API_TOKEN) {
    return {
      token: cleanToken(process.env.XLOOOP_CANARY_API_TOKEN),
      source: 'env:XLOOOP_CANARY_API_TOKEN',
    };
  }
  if (existsSync(CANARY_FILE)) {
    return {
      token: cleanToken(readFileSync(CANARY_FILE, 'utf8')),
      source: CANARY_FILE,
    };
  }
  return { token: '', source: CANARY_FILE };
}

function loadLifecycleCanaryCredential() {
  if (process.env.XLOOOP_CANARY_LIFECYCLE_API_TOKEN) {
    return {
      token: cleanToken(process.env.XLOOOP_CANARY_LIFECYCLE_API_TOKEN),
      source: 'env:XLOOOP_CANARY_LIFECYCLE_API_TOKEN',
    };
  }
  if (existsSync(LIFECYCLE_CANARY_FILE)) {
    return {
      token: cleanToken(readFileSync(LIFECYCLE_CANARY_FILE, 'utf8')),
      source: LIFECYCLE_CANARY_FILE,
    };
  }
  return { token: '', source: LIFECYCLE_CANARY_FILE };
}

function validateCanaryToken(token) {
  if (!token || token.length < 32) {
    return { ok: false, reason: 'canary token must be at least 32 characters' };
  }
  if (/\s/.test(token)) {
    return { ok: false, reason: 'canary token must not contain whitespace' };
  }
  return { ok: true, length: token.length };
}

function addCheck(id, status, detail = {}) {
  result.checks.push({ id, status, ...detail });
  if (status === 'FAIL') {
    result.failures.push({ id, ...detail });
    result.status = 'FAIL';
  }
  if (status === 'WARN') {
    result.warnings.push({ id, ...detail });
  }
}

function pass(id, detail = {}) {
  addCheck(id, 'PASS', detail);
}

function warn(id, message, detail = {}) {
  addCheck(id, 'WARN', { message, ...detail });
}

function fail(id, message, detail = {}) {
  addCheck(id, 'FAIL', { message, ...detail });
}

async function fetchJson(pathname, options = {}) {
  const res = await fetch(`${API_BASE}${pathname}`, {
    method: options.method || 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${options.token || credential.token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Keep raw text for diagnostics.
  }
  return { status: res.status, ok: res.ok, body };
}

async function run() {
  const apiPacket = await fetchJson(`/api/v1/packets?packet_id=${encodeURIComponent(PACKET_ID)}&limit=1`);
  const apiRows = apiPacket.body?.packets;
  if (apiPacket.status !== 200 || !Array.isArray(apiRows) || apiRows.length !== 1) {
    fail('api_packet_lookup_failed', 'expected exactly one API packet row', {
      status: apiPacket.status,
      body: summarizeBody(apiPacket.body),
    });
    return;
  }
  const packet = apiRows[0];
  const apiLeakage = findForbiddenSurfaces(apiPacket.body);
  if (apiLeakage.length) {
    fail('api_packet_forbidden_surface_exposed', 'API packet lookup exposed forbidden surfaces', {
      leakage: apiLeakage,
    });
  } else {
    pass('api_packet_lookup_ok', {
      packet_id: packet.id,
      lifecycle_state: packet.lifecycle_state,
      approval_required: !!packet.approval_required,
    });
  }

  const mcpStatus = await fetchJson(`/api/v1/mcp/status?packet_id=${encodeURIComponent(PACKET_ID)}`);
  if (mcpStatus.status !== 200 || mcpStatus.body?.packet?.id !== PACKET_ID) {
    fail('mcp_status_lookup_failed', 'MCP status must return the same packet id', {
      status: mcpStatus.status,
      body: summarizeBody(mcpStatus.body),
    });
  } else {
    const mcpLeakage = findForbiddenSurfaces(mcpStatus.body);
    if (mcpLeakage.length) {
      fail('mcp_status_forbidden_surface_exposed', 'MCP status exposed forbidden surfaces', {
        leakage: mcpLeakage,
      });
    } else {
      pass('mcp_status_lookup_ok', {
        packet_id: mcpStatus.body.packet.id,
        evidence: Array.isArray(mcpStatus.body.evidence) ? mcpStatus.body.evidence.length : 0,
        approvals: Array.isArray(mcpStatus.body.approvals) ? mcpStatus.body.approvals.length : 0,
        tool_events: Array.isArray(mcpStatus.body.tool_events) ? mcpStatus.body.tool_events.length : 0,
        metric_deltas: Array.isArray(mcpStatus.body.metric_deltas) ? mcpStatus.body.metric_deltas.length : 0,
      });
    }
  }

  const mcpPacket = await fetchJson(`/api/v1/mcp/task-packets/${encodeURIComponent(PACKET_ID)}`);
  if (
    mcpPacket.status !== 200 ||
    mcpPacket.body?.schema_id !== 'xlooop.mcp_task_packet_envelope.v1' ||
    mcpPacket.body?.packet?.id !== PACKET_ID ||
    !mcpPacket.body?.signature?.value
  ) {
    fail('mcp_signed_packet_failed', 'MCP signed packet envelope is missing or invalid', {
      status: mcpPacket.status,
      body: summarizeBody(mcpPacket.body),
    });
  } else {
    pass('mcp_signed_packet_envelope_ok', {
      packet_id: mcpPacket.body.packet.id,
      signature_alg: mcpPacket.body.signature.alg,
    });
  }

  if (apiPacket.status === 200 && mcpStatus.status === 200 && mcpStatus.body?.packet?.id === packet.id) {
    const comparable = ['id', 'workspace_id', 'lifecycle_state', 'approval_required'];
    const mismatches = comparable.filter((key) => packet[key] !== mcpStatus.body.packet[key]);
    if (mismatches.length) {
      fail('api_mcp_packet_fields_mismatch', 'API and MCP packet fields differ', { mismatches });
    } else {
      pass('api_mcp_packet_fields_match', { fields: comparable });
    }
  }

  const lifecycleCredential = loadLifecycleCanaryCredential();
  if (lifecycleCredential.token) {
    const lifecycleCanary = validateCanaryToken(lifecycleCredential.token);
    if (!lifecycleCanary.ok) {
      fail('lifecycle_canary_token_invalid', lifecycleCanary.reason, {
        token_source: lifecycleCredential.source,
      });
      return;
    }
    result.mode = 'lifecycle_canary';
    pass('lifecycle_canary_token_present', {
      token_source: lifecycleCredential.source,
      token_length: lifecycleCanary.length,
    });
    await proveCanaryLifecycleWrites(lifecycleCredential.token);
  } else {
    await proveCanaryWriteDenials();
  }
}

async function proveCanaryLifecycleWrites(token) {
  if (!PACKET_ID.startsWith('pkt-canary-')) {
    fail('lifecycle_canary_requires_canary_packet', 'lifecycle canary writes require XLOOOP_PARITY_PACKET_ID to start with pkt-canary-', {
      packet_id: PACKET_ID,
    });
    return;
  }

  const runStamp = new Date().toISOString().replace(/[-:.]/g, '').replace(/z$/i, '').toLowerCase();
  const runNonce = `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const runId = `${runStamp}-${runNonce}`;
  const ids = {
    apiEvidence: `ev-canary-${runId}-api`,
    mcpEvidence: `ev-canary-${runId}-mcp`,
    apiToolEvent: `te-canary-${runId}-api`,
    mcpToolEvent: `te-canary-${runId}-mcp`,
    apiApproval: `apr-canary-${runId}-api`,
    mcpApproval: `apr-canary-${runId}-mcp`,
    metricDelta: `md-canary-${runId}-api`,
  };

  const writes = [
    {
      id: 'api_canary_evidence_created',
      path: '/api/v1/evidence',
      expectKey: 'evidence',
      body: {
        id: ids.apiEvidence,
        packet_id: PACKET_ID,
        kind: 'log',
        title: 'Canary lifecycle API evidence',
        uri: `xlooop://canary/${runId}/api-evidence`,
        summary: 'metadata-only canary API evidence',
        redaction_status: 'metadata_only',
      },
    },
    {
      id: 'mcp_canary_evidence_created',
      path: '/api/v1/mcp/evidence',
      expectKey: 'evidence',
      body: {
        id: ids.mcpEvidence,
        packet_id: PACKET_ID,
        kind: 'log',
        title: 'Canary lifecycle MCP evidence',
        uri: `xlooop://canary/${runId}/mcp-evidence`,
        summary: 'metadata-only canary MCP evidence',
        redaction_status: 'metadata_only',
      },
    },
    {
      id: 'api_canary_tool_event_created',
      path: '/api/v1/tool-events',
      expectKey: 'tool_event',
      body: {
        id: ids.apiToolEvent,
        packet_id: PACKET_ID,
        tool_name: 'xlooop.report_tool_event',
        action: 'report_tool_event',
        status: 'completed',
        evidence_item_id: ids.apiEvidence,
        summary: 'canary API tool-event receipt',
      },
    },
    {
      id: 'mcp_canary_tool_event_created',
      path: '/api/v1/mcp/tool-events',
      expectKey: 'tool_event',
      body: {
        id: ids.mcpToolEvent,
        packet_id: PACKET_ID,
        tool_name: 'xlooop.report_tool_event',
        action: 'report_tool_event',
        status: 'completed',
        evidence_item_id: ids.mcpEvidence,
        summary: 'canary MCP tool-event receipt',
      },
    },
    {
      id: 'api_canary_approval_created',
      path: '/api/v1/approvals',
      expectKey: 'approval',
      body: {
        id: ids.apiApproval,
        packet_id: PACKET_ID,
        reason: 'canary API approval request; no customer action',
      },
    },
    {
      id: 'mcp_canary_approval_created',
      path: '/api/v1/mcp/approval-requests',
      expectKey: 'approval',
      body: {
        id: ids.mcpApproval,
        packet_id: PACKET_ID,
        reason: 'canary MCP approval request; no customer action',
      },
    },
    {
      id: 'api_canary_metric_delta_created',
      path: '/api/v1/metric-deltas',
      expectKey: 'metric_delta',
      body: {
        id: ids.metricDelta,
        packet_id: PACKET_ID,
        metric_id: 'canary.api_mcp_lifecycle_parity',
        before_value: 0,
        after_value: 1,
        evidence_item_id: ids.apiEvidence,
      },
    },
  ];

  for (const write of writes) {
    const response = await fetchJson(write.path, { method: 'POST', body: write.body, token });
    if (response.status !== 201 || response.body?.[write.expectKey]?.id !== write.body.id) {
      fail(`${write.id}_failed`, 'expected lifecycle canary write to create the exact synthetic row', {
        path: write.path,
        http_status: response.status,
        expected_id: write.body.id,
        body: summarizeBody(response.body),
      });
    } else {
      pass(write.id, { path: write.path, id: write.body.id });
    }
  }

  const customerDelete = await fetchJson('/api/v1/customer-data/delete-requests', {
    method: 'POST',
    token,
    body: {
      target_packet_id: PACKET_ID,
      reason: 'canary must not request customer delete',
    },
  });
  if (customerDelete.status === 403) {
    pass('lifecycle_canary_customer_delete_forbidden', { http_status: customerDelete.status });
  } else {
    fail('lifecycle_canary_customer_delete_not_forbidden', 'lifecycle canary must not access customer delete request surface', {
      http_status: customerDelete.status,
      body: summarizeBody(customerDelete.body),
    });
  }

  const status = await fetchJson(`/api/v1/mcp/status?packet_id=${encodeURIComponent(PACKET_ID)}`, { token });
  if (status.status !== 200) {
    fail('lifecycle_status_after_writes_failed', 'MCP status must read the lifecycle rows after writes', {
      http_status: status.status,
      body: summarizeBody(status.body),
    });
    return;
  }

  const evidenceIds = new Set((status.body?.evidence || []).map((row) => row.id));
  const approvalIds = new Set((status.body?.approvals || []).map((row) => row.id));
  const toolEventIds = new Set((status.body?.tool_events || []).map((row) => row.id));
  const metricIds = new Set((status.body?.metric_deltas || []).map((row) => row.id));

  const missing = [
    [ids.apiEvidence, evidenceIds],
    [ids.mcpEvidence, evidenceIds],
    [ids.apiApproval, approvalIds],
    [ids.mcpApproval, approvalIds],
    [ids.apiToolEvent, toolEventIds],
    [ids.mcpToolEvent, toolEventIds],
    [ids.metricDelta, metricIds],
  ].filter(([id, set]) => !set.has(id)).map(([id]) => id);

  if (missing.length) {
    fail('lifecycle_status_rows_missing', 'MCP status did not return every synthetic lifecycle row', { missing });
  } else {
    pass('lifecycle_status_rows_visible_via_mcp', {
      evidence: evidenceIds.size,
      approvals: approvalIds.size,
      tool_events: toolEventIds.size,
      metric_deltas: metricIds.size,
      created_ids: ids,
    });
  }
}

async function proveCanaryWriteDenials() {
  const attempts = [
    {
      id: 'api_evidence_canary_write_denied',
      path: '/api/v1/evidence',
      body: {
        packet_id: PACKET_ID,
        kind: 'log',
        title: 'Canary should not write',
        summary: 'metadata-only denial probe',
        redaction_status: 'metadata_only',
      },
    },
    {
      id: 'api_tool_event_canary_write_denied',
      path: '/api/v1/tool-events',
      body: {
        packet_id: PACKET_ID,
        tool_name: 'xlooop.report_tool_event',
        action: 'report_tool_event',
        status: 'completed',
        summary: 'metadata-only denial probe',
      },
    },
    {
      id: 'api_approval_canary_write_denied',
      path: '/api/v1/approvals',
      body: {
        packet_id: PACKET_ID,
        reason: 'metadata-only denial probe',
      },
    },
    {
      id: 'api_metric_delta_canary_write_denied',
      path: '/api/v1/metric-deltas',
      body: {
        packet_id: PACKET_ID,
        metric_id: 'canary.lifecycle.write_denial',
        before_value: 0,
        after_value: 1,
        delta_value: 1,
        evidence_ref_id: null,
      },
    },
    {
      id: 'mcp_evidence_canary_write_denied',
      path: '/api/v1/mcp/evidence',
      body: {
        packet_id: PACKET_ID,
        kind: 'log',
        title: 'Canary should not write',
        summary: 'metadata-only denial probe',
        redaction_status: 'metadata_only',
      },
    },
    {
      id: 'mcp_tool_event_canary_write_denied',
      path: '/api/v1/mcp/tool-events',
      body: {
        packet_id: PACKET_ID,
        tool_name: 'xlooop.report_tool_event',
        action: 'report_tool_event',
        status: 'completed',
        summary: 'metadata-only denial probe',
      },
    },
    {
      id: 'mcp_approval_canary_write_denied',
      path: '/api/v1/mcp/approval-requests',
      body: {
        packet_id: PACKET_ID,
        reason: 'metadata-only denial probe',
      },
    },
  ];

  for (const attempt of attempts) {
    const response = await fetchJson(attempt.path, { method: 'POST', body: attempt.body });
    if (response.status === 403) {
      pass(attempt.id, { path: attempt.path, http_status: response.status });
    } else {
      fail(attempt.id.replace('_denied', '_not_denied'), 'canary write attempt must fail closed with 403', {
        path: attempt.path,
        http_status: response.status,
        body: summarizeBody(response.body),
      });
    }
  }
}

function findForbiddenSurfaces(value, pathParts = []) {
  if (!value || typeof value !== 'object') return [];
  const hits = [];
  if (Array.isArray(value)) {
    for (const item of value) hits.push(...findForbiddenSurfaces(item, pathParts));
    return hits;
  }
  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...pathParts, key];
    if (ALLOWED_DISCLOSURE_KEYS.has(key)) continue;
    if (FORBIDDEN_SURFACES.includes(key)) {
      hits.push(nextPath.join('.'));
      continue;
    }
    if (typeof child === 'string' && FORBIDDEN_SURFACES.includes(child)) {
      hits.push(nextPath.join('.'));
      continue;
    }
    hits.push(...findForbiddenSurfaces(child, nextPath));
  }
  return hits;
}

function summarizeBody(body) {
  if (typeof body === 'string') return body.slice(0, 300);
  try {
    return JSON.stringify(body).slice(0, 300);
  } catch {
    return String(body).slice(0, 300);
  }
}

function finish() {
  if (FORMAT === 'json') {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.schema_id}: ${result.status} mode=${result.mode}`);
    for (const check of result.checks) {
      console.log(`  ${check.status} ${check.id}${check.message ? ` - ${check.message}` : ''}`);
    }
    if (result.warnings.length) console.log(`warnings=${result.warnings.length}`);
    if (result.failures.length) console.log(`failures=${result.failures.length}`);
  }
  process.exit(result.status === 'PASS' ? 0 : 1);
}
