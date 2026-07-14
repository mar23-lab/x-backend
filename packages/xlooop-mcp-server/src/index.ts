#!/usr/bin/env node
// index.ts · MCP server entrypoint. Used by `claude mcp add xlooop` registration.
//
// Listens on stdio for MCP protocol messages from the host (Claude Code,
// Cursor, any MCP-compatible agent runtime). Each tool call is dispatched
// to the corresponding handler in src/tools/.
//
// Auth: bearer token loaded from XLOOOP_TOKEN env or ~/.xlooop/credentials.json
// (see auth.ts).
//
// API base: defaults to https://api.xlooop.com; override with
// XLOOOP_API_BASE_URL for staging or local dev.

import { runStdioServer } from './server.js';

runStdioServer().catch((err) => {
  // Anything reaching this catch is a process-fatal error; the MCP host
  // will see stdio closed and may auto-restart depending on its policy.
  // We write to stderr (NOT stdout — stdout is the MCP protocol channel).
  process.stderr.write(
    `[xlooop-mcp-server] fatal: ${(err as Error)?.stack ?? String(err)}\n`,
  );
  process.exit(1);
});
