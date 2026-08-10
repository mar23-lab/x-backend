#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import process from 'node:process';

const API_BASE = (process.env.XLOOOP_API_BASE || 'https://api.xlooop.com').replace(/\/+$/, '');
const TOKEN_FILE = process.env.XLOOOP_CANARY_LIFECYCLE_API_TOKEN_FILE || '/tmp/xlooop-canary-lifecycle-api-token.txt';
const APPLY = process.argv.includes('--apply');
const MAX_ATTEMPTS = 3;

export function createCanaryPacketId(workspaceId, now = new Date(), entropy = crypto.randomBytes(6).toString('hex')) {
  const workspaceDigest = crypto.createHash('sha256').update(String(workspaceId), 'utf8').digest('hex').slice(0, 10);
  const timestamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14).toLowerCase();
  return `pkt-canary-${workspaceDigest}-${timestamp}-${entropy}`;
}

export function packetPayload(packetId) {
  return {
    id: packetId,
    title: 'Pilot shadow API MCP lifecycle canary',
    summary: 'Synthetic metadata-only packet for tenant-scoped API and MCP lifecycle parity.',
    lifecycle_state: 'ready',
    allowed_tools: [],
    forbidden_tools: ['customer_data_delete'],
    approval_required: false,
    source_refs: ['xlooop://canary/api-mcp-lifecycle'],
  };
}

if (process.argv.includes('--self-test')) {
  const id = createCanaryPacketId('ws_example', new Date('2026-08-11T00:00:00.000Z'), 'abcdef123456');
  const payload = packetPayload(id);
  const checks = [
    id === 'pkt-canary-35b14591ad-20260811000000-abcdef123456',
    id.startsWith('pkt-canary-'),
    payload.id === id,
    payload.lifecycle_state === 'ready',
    payload.approval_required === false,
    payload.source_refs[0].startsWith('xlooop://canary/'),
    !JSON.stringify(payload).includes('customer data'),
  ];
  console.log(JSON.stringify({
    schema_id: 'xlooop.api_mcp_canary_packet_provisioner.self_test.v1',
    status: checks.every(Boolean) ? 'PASS' : 'FAIL',
    check_count: checks.length,
    failure_count: checks.filter((value) => !value).length,
  }, null, 2));
  process.exit(checks.every(Boolean) ? 0 : 1);
}

const token = loadToken();
if (!token) refuse(`lifecycle canary token missing: ${TOKEN_FILE}`);
if (token.length < 32 || /\s/.test(token)) refuse('lifecycle canary token is malformed');

const whoami = await request('/api/v1/whoami', { token });
if (whoami.status !== 200 || !whoami.body?.identity?.tenant_id) {
  refuse(`whoami failed closed (${whoami.status})`);
}

const workspaceId = whoami.body.identity.tenant_id;
if (!APPLY) {
  const packetId = createCanaryPacketId(workspaceId);
  console.log(JSON.stringify({
    schema_id: 'xlooop.api_mcp_canary_packet_provisioner.v1',
    status: 'PLAN',
    mutation_performed: false,
    api_base: API_BASE,
    workspace_id_hash: hash(workspaceId).slice(0, 12),
    proposed_packet_id: packetId,
    next_action: 'Re-run with --apply to create and verify synthetic metadata in the scoped canary tenant.',
  }, null, 2));
  process.exit(0);
}

let created = null;
let attempts = 0;
for (; attempts < MAX_ATTEMPTS; attempts += 1) {
  const packetId = createCanaryPacketId(workspaceId);
  const response = await request('/api/v1/packets', {
    method: 'POST',
    token,
    body: packetPayload(packetId),
  });
  if (response.status === 201 && response.body?.packet?.id === packetId) {
    created = response.body.packet;
    break;
  }
  if (!isUniqueCollision(response)) {
    refuse(`packet creation failed closed (${response.status})`);
  }
}
if (!created) refuse(`packet id collision persisted after ${MAX_ATTEMPTS} attempts`);

const readBack = await request(`/api/v1/packets?packet_id=${encodeURIComponent(created.id)}&limit=1`, { token });
const rows = readBack.body?.packets;
if (readBack.status !== 200 || !Array.isArray(rows) || rows.length !== 1 || rows[0]?.workspace_id !== workspaceId) {
  refuse('created packet did not read back in the authenticated tenant');
}

console.log(JSON.stringify({
  schema_id: 'xlooop.api_mcp_canary_packet_provisioner.v1',
  status: 'PASS',
  mutation_performed: true,
  evidence_class: 'synthetic_internal_canary',
  api_base: API_BASE,
  packet_id: created.id,
  lifecycle_state: created.lifecycle_state,
  workspace_id_hash: hash(workspaceId).slice(0, 12),
  attempts: attempts + 1,
  tenant_read_back_verified: true,
  raw_customer_data_used: false,
}, null, 2));

function loadToken() {
  if (process.env.XLOOOP_CANARY_LIFECYCLE_API_TOKEN) return clean(process.env.XLOOOP_CANARY_LIFECYCLE_API_TOKEN);
  if (!fs.existsSync(TOKEN_FILE)) return '';
  return clean(fs.readFileSync(TOKEN_FILE, 'utf8'));
}

function clean(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '');
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function isUniqueCollision(response) {
  return response.status === 409 || JSON.stringify(response.body || {}).includes('23505');
}

async function request(pathname, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${API_BASE}${pathname}`, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Preserve non-JSON diagnostics without exposing credentials.
  }
  return { status: response.status, body: parsed };
}

function refuse(message) {
  console.error(`provision-api-mcp-canary-packet · REFUSED · ${message}`);
  process.exit(1);
}
