// server.ts · MCP server construction. Registers the 7 Xlooop tools
// against the SDK's high-level Server interface.
//
// Transport choice: stdio (the default for Claude Code MCP integration).
// HTTP transport will land in a follow-up wave if remote use cases appear.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import {
  eventAppendDefinition, eventAppend,
  eventListDefinition, eventList,
  projectListDefinition, projectList,
  projectGetDefinition, projectGet,
  projectSetScopeDefinition, projectSetScope,
  boardReadDefinition, boardRead,
  workspaceContextDefinition, workspaceContext,
  signoffCreateDefinition, signoffCreate,
  signoffAwaitDefinition, signoffAwait,
} from './tools/index.js';
import { XlooopMcpError } from './errors.js';
import { validateAgainst, type SchemaSubset } from './validate.js';

const SERVER_NAME = 'xlooop-mcp-server';
const SERVER_VERSION = '0.1.0';

// Registry of tool name → (definition, handler).
const TOOLS = {
  [eventAppendDefinition.name]: { def: eventAppendDefinition, handler: eventAppend },
  [eventListDefinition.name]: { def: eventListDefinition, handler: eventList },
  [projectListDefinition.name]: { def: projectListDefinition, handler: projectList },
  [projectGetDefinition.name]: { def: projectGetDefinition, handler: projectGet },
  [projectSetScopeDefinition.name]: { def: projectSetScopeDefinition, handler: projectSetScope },
  [boardReadDefinition.name]: { def: boardReadDefinition, handler: boardRead },
  [workspaceContextDefinition.name]: { def: workspaceContextDefinition, handler: workspaceContext },
  [signoffCreateDefinition.name]: { def: signoffCreateDefinition, handler: signoffCreate },
  [signoffAwaitDefinition.name]: { def: signoffAwaitDefinition, handler: signoffAwait },
} as const;

export function buildServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  // ListTools: enumerate definitions.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.values(TOOLS).map((entry) => ({
      name: entry.def.name,
      description: entry.def.description,
      inputSchema: entry.def.inputSchema,
    })),
  }));

  // CallTool: dispatch by name, return JSON-stringified result, surface
  // structured errors with a stable code so MCP clients can branch.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const entry = TOOLS[toolName as keyof typeof TOOLS];
    if (!entry) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: `Unknown tool: ${toolName}`,
            code: 'NOT_FOUND',
            available_tools: Object.keys(TOOLS),
          }),
        }],
      };
    }
    try {
      // R44.1 H1 fix: MCP SDK does NOT validate args against per-tool inputSchema —
      // it only checks the JSON-RPC envelope. Validate ourselves before dispatch so
      // a missing required field becomes a clean VALIDATION_ERROR instead of an
      // upstream Worker 400/500 with confusing context.
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      const violation = validateAgainst(entry.def.inputSchema as SchemaSubset, args);
      if (violation) {
        const e = new XlooopMcpError('VALIDATION_ERROR',
          `Invalid arguments for ${toolName}: ${violation}`,
          { hint: 'Check the tool inputSchema — `xlooop tools` lists them, or call ListTools on this server.' });
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(e.toEnvelope(), null, 2) }],
        };
      }
      // Cast to any because each handler signature differs; runtime shape is right.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (entry.handler as (args: any) => Promise<unknown>)(args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const envelope = err instanceof XlooopMcpError
        ? err.toEnvelope()
        : { error: (err as Error)?.message ?? String(err), code: 'INTERNAL_ERROR' };
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
      };
    }
  });

  return server;
}

export async function runStdioServer(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server runs until the parent process closes stdio.
}
