// tests/tools.test.mjs · smoke tests for tool definitions.
// Run with: npm test (from packages/xlooop-mcp-server/)
//
// These tests do NOT hit the network. They verify:
//   - all 7 tools are exported
//   - each tool definition has name + description + valid JSON Schema
//   - tool names follow `xlooop.<domain>.<verb>` convention
//   - inputSchema is well-formed (type object, additionalProperties set)
//
// Network/integration tests live in a separate suite (TBD R44.1) that hits
// a stub Worker.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as tools from '../dist/tools/index.js';

const EXPECTED_TOOLS = [
  'xlooop.event.append',
  'xlooop.event.list',
  'xlooop.project.list',
  'xlooop.project.get',
  'xlooop.project.set_scope',
  'xlooop.board.read',
  'xlooop.workspace.context',
  'xlooop.signoff.create',
  'xlooop.signoff.await',
];

const DEFINITIONS = [
  tools.eventAppendDefinition,
  tools.eventListDefinition,
  tools.projectListDefinition,
  tools.projectGetDefinition,
  tools.projectSetScopeDefinition,
  tools.boardReadDefinition,
  tools.workspaceContextDefinition,
  tools.signoffCreateDefinition,
  tools.signoffAwaitDefinition,
];

test('all 9 tool definitions exported', () => {
  assert.equal(DEFINITIONS.length, 9);
  for (const d of DEFINITIONS) assert.ok(d);
});

test('all tool names match expected list and convention', () => {
  const names = DEFINITIONS.map((d) => d.name).sort();
  assert.deepEqual(names, [...EXPECTED_TOOLS].sort());
  for (const name of names) {
    // Allow snake_case in verb segment (e.g. set_scope)
    assert.match(name, /^xlooop\.[a-z]+\.[a-z_]+$/, `name ${name} should be xlooop.<domain>.<verb>`);
  }
});

test('each tool has non-empty description', () => {
  for (const d of DEFINITIONS) {
    assert.equal(typeof d.description, 'string');
    assert.ok(d.description.length > 30, `description for ${d.name} too short`);
  }
});

test('each tool inputSchema is a well-formed JSON Schema object', () => {
  for (const d of DEFINITIONS) {
    assert.equal(d.inputSchema.type, 'object', `${d.name} inputSchema.type must be object`);
    assert.ok(
      d.inputSchema.properties !== undefined || d.inputSchema.additionalProperties === false,
      `${d.name} inputSchema must have properties or explicitly disable additional`,
    );
  }
});

test('event-append + signoff-create are the only "write" tools requiring workspace_id', () => {
  const writers = [tools.eventAppendDefinition, tools.signoffCreateDefinition];
  for (const w of writers) {
    assert.ok(
      w.inputSchema.required?.includes('workspace_id'),
      `${w.name} must require workspace_id`,
    );
  }
});

test('workspace.context takes no required arguments', () => {
  const def = tools.workspaceContextDefinition;
  assert.deepEqual(def.inputSchema.properties, {});
  assert.equal(def.inputSchema.additionalProperties, false);
});

test('signoff.await timeout is clamped to [10, 3600]', () => {
  const def = tools.signoffAwaitDefinition;
  const timeoutProp = def.inputSchema.properties?.timeout_seconds;
  assert.ok(timeoutProp);
  assert.equal(timeoutProp.minimum, 10);
  assert.equal(timeoutProp.maximum, 3600);
});

test('handlers are async functions', () => {
  const handlers = [
    tools.eventAppend, tools.eventList, tools.projectList,
    tools.projectGet, tools.projectSetScope,
    tools.boardRead, tools.workspaceContext,
    tools.signoffCreate, tools.signoffAwait,
  ];
  for (const h of handlers) {
    assert.equal(typeof h, 'function');
    assert.equal(h.constructor.name, 'AsyncFunction', `${h.name} must be async`);
  }
});

test('R45.2: project.set_scope requires owner/operator role (server-enforced)', () => {
  // Schema requirement check — full role enforcement is server-side
  assert.ok(tools.projectSetScopeDefinition.inputSchema.required?.includes('project_id'));
  assert.ok(tools.projectSetScopeDefinition.inputSchema.required?.includes('scope_binding'));
});

test('R45.2: project.get returns full project with scope_binding', () => {
  assert.ok(tools.projectGetDefinition.inputSchema.required?.includes('project_id'));
  assert.match(tools.projectGetDefinition.description, /scope_binding/);
});

// R44.1 M1 + M4: tighten schema invariants
test('R44.1: event-append schema enforces additionalProperties:false', () => {
  assert.equal(tools.eventAppendDefinition.inputSchema.additionalProperties, false);
});

test('R44.1: signoff-create requires reason', () => {
  assert.ok(tools.signoffCreateDefinition.inputSchema.required?.includes('reason'));
});

// R44.1 M2: description tightness
test('R44.1: all tool descriptions >= 80 chars (rich enough for LLM selection)', () => {
  const defs = [
    tools.eventAppendDefinition, tools.eventListDefinition, tools.projectListDefinition,
    tools.boardReadDefinition, tools.workspaceContextDefinition,
    tools.signoffCreateDefinition, tools.signoffAwaitDefinition,
  ];
  for (const d of defs) {
    assert.ok(d.description.length >= 80,
      `${d.name} description must be >= 80 chars for LLM selection clarity (got ${d.description.length})`);
  }
});

// R44.1 H1: validator catches missing required fields
test('R44.1: validateAgainst rejects missing required workspace_id on event-append', async () => {
  const { validateAgainst } = await import('../dist/validate.js');
  const result = validateAgainst(tools.eventAppendDefinition.inputSchema, {
    source_tool: 'test', status: 'completed', summary: 'hi',
  });
  assert.ok(result !== null, 'expected validation error when workspace_id missing');
  assert.match(result, /workspace_id/);
});

test('R44.1: validateAgainst rejects unknown property when additionalProperties:false', async () => {
  const { validateAgainst } = await import('../dist/validate.js');
  const result = validateAgainst(tools.eventAppendDefinition.inputSchema, {
    workspace_id: 'ws', source_tool: 't', status: 's', summary: 'x',
    unknown_field: 'phantom',
  });
  assert.ok(result !== null);
  assert.match(result, /unknown_field|additionalProperties/);
});

test('R44.1: validateAgainst rejects out-of-range integer (signoff-await timeout_seconds)', async () => {
  const { validateAgainst } = await import('../dist/validate.js');
  const result = validateAgainst(tools.signoffAwaitDefinition.inputSchema, {
    sign_off_id: 'so_1', timeout_seconds: 99999,
  });
  assert.ok(result !== null);
  assert.match(result, /maximum/);
});

test('R44.1: validateAgainst passes valid input', async () => {
  const { validateAgainst } = await import('../dist/validate.js');
  const result = validateAgainst(tools.eventAppendDefinition.inputSchema, {
    workspace_id: 'ws_1', source_tool: 'claude-code', status: 'completed', summary: 'hello',
  });
  assert.equal(result, null);
});
