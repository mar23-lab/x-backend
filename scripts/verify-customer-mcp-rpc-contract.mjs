#!/usr/bin/env node
// Static contract verifier for the hosted MCP (Streamable HTTP / JSON-RPC) endpoint.
// Matches the verify-customer-*.mjs pattern. Protects the protocol + safety invariants:
// read-only allowlist, auth-protected mount, and single-sourced dispatch back to the REST tools.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const failures = [];

const files = {
  rpc: 'src/workers/routes/mcp-rpc.ts',
  gateway: 'src/workers/routes/mcp-gateway.ts',
  index: 'src/workers/index.ts',
  test: 'src/workers/__tests__/mcp-rpc-route.test.ts',
  packageJson: 'package.json',
};
const src = Object.fromEntries(Object.entries(files).map(([k, rel]) => [k, read(rel)]));
const pkg = JSON.parse(src.packageJson);

// ---- Protocol surface ----
check(src.rpc.includes('export function createMcpRpcRoute'), 'rpc_factory', 'Must export createMcpRpcRoute.');
for (const m of ['initialize', 'tools/list', 'tools/call', 'ping']) {
  check(src.rpc.includes(`'${m}'`), `rpc_method_${m.replace(/\W+/g, '_')}`, `Must handle the ${m} JSON-RPC method.`);
}
check(src.rpc.includes("jsonrpc: '2.0'"), 'rpc_jsonrpc_envelope', 'Responses must use the JSON-RPC 2.0 envelope.');
check(src.rpc.includes('-32601'), 'rpc_method_not_found', 'Unknown methods must return -32601.');
check(src.rpc.includes('-32602'), 'rpc_invalid_params', 'Bad/unknown tool calls must return -32602.');

// ---- Read-only safety: the MCP surface must NOT expose write tools ----
for (const writeTool of ['submit_evidence', 'report_tool_event', 'request_approval', 'submit_learning_signal']) {
  check(!src.rpc.includes(`xlooop.${writeTool}`), `rpc_no_write_${writeTool}`, `MCP endpoint must not expose the write tool xlooop.${writeTool}.`);
}
for (const readTool of ['xcp_session_start', 'xlooop.whoami', 'xlooop.get_task_packet', 'xlooop.get_workflow_status', 'xlooop.get_effective_templates', 'xlooop.get_effective_profile']) {
  check(src.rpc.includes(readTool), `rpc_has_read_${readTool.replace(/\W+/g, '_')}`, `MCP endpoint must expose ${readTool}.`);
}

// ---- Single-sourced: tools/call dispatches to the REST handlers, with auth forwarded ----
check(src.rpc.includes('dispatch(') && src.rpc.includes("path: '/api/v1/mcp/session-start'"), 'rpc_dispatch_reuse', 'xcp_session_start must dispatch to the existing authenticated REST path, not re-implement tenant intake.');
check(/headers\.set\('Authorization', auth\)/.test(src.rpc) || src.rpc.includes("headers.set('Authorization'"), 'rpc_forwards_auth', 'tools/call must forward the caller Authorization header.');
check(src.rpc.includes("name: 'xcp-gateway'") && src.rpc.includes("profile: 'customer'"), 'rpc_canonical_customer_profile', 'Server metadata must advertise canonical xcp-gateway with profile=customer.');
check(src.test.includes('requires_additional_gateway: false'), 'rpc_single_hop_test', 'Behavior tests must prove customer session intake needs no second gateway hop.');
for (const marker of ["schema_id: 'xcp.session_start/v1'", "gateway_profile: XCP_GATEWAY_PROFILE", "detected_role: 'not_applicable'", "entry_skill: 'not_applicable'"]) {
  check(src.gateway.includes(marker), `session_contract_${marker.replace(/\W+/g, '_')}`, `Customer session-start contract must include ${marker}.`);
}
check(!src.rpc.includes('xlooop-customer-gateway') && !src.gateway.includes('xlooop-customer-gateway'), 'legacy_gateway_absent', 'Legacy connector names must not appear in live config or discovery.');

// ---- Auth-protected mount (under the operational route group; never a public route) ----
check(src.index.includes('createMcpRpcRoute('), 'index_mounts_rpc', 'index.ts must mount the MCP-RPC route.');
check(/operationalRoutes\.route\('\/mcp', createMcpRpcRoute/.test(src.index), 'index_rpc_operational_mount', 'MCP-RPC must mount under the operational (authenticated) route group.');
check(!/publicRoutes\.route\([^)]*createMcpRpcRoute/.test(src.index), 'index_rpc_not_public', 'MCP-RPC must not be mounted on public routes.');

// ---- Behavioral test exists ----
check(src.test.includes("from '../routes/mcp-rpc'") && src.test.includes('tools/call'), 'rpc_has_behavior_test', 'A behavioral test must cover the MCP-RPC protocol.');

// ---- Self-registration ----
check(pkg.scripts?.['verify:customer-mcp-rpc-contract'] === 'node scripts/verify-customer-mcp-rpc-contract.mjs', 'package_script', 'package must expose the MCP-RPC contract verifier.');

if (failures.length) {
  console.error('customer-mcp-rpc-contract: FAIL');
  for (const failure of failures) console.error(`  FAIL ${failure.id}: ${failure.message}`);
  process.exit(1);
}
console.log('customer-mcp-rpc-contract: PASS (read-only allowlist, JSON-RPC, auth-protected, single-sourced dispatch)');

function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}
function check(ok, id, message) {
  if (!ok) failures.push({ id, message });
}
