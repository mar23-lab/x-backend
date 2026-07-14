#!/usr/bin/env node
// bin/cli.ts · `xlooop` CLI for credential management + diagnostics.
//
// Subcommands:
//   xlooop login              — paste a Clerk JWT, save to ~/.xlooop/credentials.json
//   xlooop logout             — delete credentials file
//   xlooop whoami             — call /api/v1/session and print user + workspace
//   xlooop ping               — call /api/v1/health, no auth
//   xlooop tools              — list MCP tool names + descriptions
//   xlooop register-claude    — print the JSON config block to add to claude mcp
//   xlooop version            — print version

import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';

import { credentialsPath, loadCredentials } from '../auth.js';
import { apiRequest, ping } from '../api-client.js';
import { XlooopMcpError } from '../errors.js';
import * as tools from '../tools/index.js';

// R44.1 L2 fix: read version from package.json so it never drifts from the
// published version. createRequire works inside an ES module.
const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };
const VERSION = pkg.version;

// R44.1 M3: 8-hour staleness threshold for credential warnings. Clerk session
// JWTs typically expire in minutes-to-hours; if the saved_at is older than
// this the token is almost certainly expired and the operator should re-login.
const STALENESS_THRESHOLD_HOURS = 8;

function print(s: string): void { stdout.write(s + '\n'); }
function err(s: string): void { stderr.write(s + '\n'); }

async function login(): Promise<number> {
  const rl = createInterface({ input: stdin, output: stdout });
  print('');
  print('Xlooop login · paste a credential token below.');
  print('');
  print('How to get one (until R44.1 ships OAuth):');
  print('  1. Sign in to https://app.xlooop.com in your browser');
  print('  2. Open DevTools → Application → Cookies → __session (Clerk session)');
  print('     OR Console: window.XcpClerk.instance.session.getToken({template:"xlooop-workers"}).then(t=>console.log(t))');
  print('  3. Copy the token JWT (long string starting with "eyJ...")');
  print('  4. Paste below and press Enter.');
  print('');
  const token = (await rl.question('Token: ')).trim();
  rl.close();
  if (!token || token.length < 20) {
    err('Token looks invalid (too short). Aborting.');
    return 1;
  }
  const path = credentialsPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ token, saved_at: new Date().toISOString() }, null, 2), { mode: 0o600 });
  print(`Saved to ${path} (chmod 0600)`);
  // Verify by calling /session
  try {
    const session = await apiRequest<{ state?: string; user?: { id?: string; email?: string }; workspace?: { name?: string } }>(`/api/v1/session`, { method: 'GET' });
    print(`✓ Verified · state=${session.state} · user=${session.user?.email ?? session.user?.id ?? '?'} · workspace=${session.workspace?.name ?? '—'}`);
    return 0;
  } catch (e) {
    err(`✗ Saved but verification failed: ${(e as Error).message}`);
    err('  The token might be expired or invalid. Try again with a fresh JWT.');
    return 2;
  }
}

async function logout(): Promise<number> {
  const path = credentialsPath();
  try {
    await unlink(path);
    print(`Removed ${path}`);
    return 0;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      print(`No credentials at ${path}`);
      return 0;
    }
    err(`Failed to remove credentials: ${(e as Error).message}`);
    return 1;
  }
}

async function whoami(): Promise<number> {
  try {
    const session = await apiRequest<{ state?: string; user?: { id?: string; email?: string; role?: string }; workspace?: { id?: string; name?: string }; projects?: Array<{ name: string }> }>(`/api/v1/session`);
    print(JSON.stringify(session, null, 2));
    return 0;
  } catch (e) {
    const env = e instanceof XlooopMcpError ? e.toEnvelope() : { error: (e as Error).message };
    err(JSON.stringify(env, null, 2));
    return 1;
  }
}

async function pingCmd(): Promise<number> {
  try {
    const result = await ping();
    print(JSON.stringify(result, null, 2));
    return 0;
  } catch (e) {
    err(`✗ ${(e as Error).message}`);
    return 1;
  }
}

function listTools(): number {
  const defs = [
    tools.eventAppendDefinition,
    tools.eventListDefinition,
    tools.projectListDefinition,
    tools.boardReadDefinition,
    tools.workspaceContextDefinition,
    tools.signoffCreateDefinition,
    tools.signoffAwaitDefinition,
  ];
  print('Xlooop MCP tools (v' + VERSION + '):');
  print('');
  for (const d of defs) {
    print(`  ${d.name}`);
    print(`    ${d.description.split(' ').reduce<string[][]>((acc, w) => {
      const last = acc[acc.length - 1] ?? [];
      if (last.join(' ').length + w.length > 78) acc.push([w]);
      else last.push(w);
      return acc;
    }, [[]]).map((l) => l.join(' ')).join('\n    ')}`);
    print('');
  }
  return 0;
}

function registerClaude(): number {
  const config = {
    mcpServers: {
      xlooop: {
        command: 'npx',
        args: ['-y', '@xlooop/mcp-server'],
        env: {
          // Operators set this in their shell or it's already in the cred file.
          // XLOOOP_TOKEN: '<your-token>',
        },
      },
    },
  };
  print('Add this to your Claude Code MCP config (~/.claude.json or via `claude mcp add`):');
  print('');
  print(JSON.stringify(config, null, 2));
  print('');
  print('Or run: claude mcp add xlooop "npx -y @xlooop/mcp-server"');
  return 0;
}

async function main(): Promise<void> {
  const subcommand = (process.argv[2] ?? '').toLowerCase();
  const exitCode = await (async () => {
    switch (subcommand) {
      case 'login': return login();
      case 'logout': return logout();
      case 'whoami': return whoami();
      case 'ping': return pingCmd();
      case 'tools': return listTools();
      case 'register-claude': case 'install-claude': return registerClaude();
      case 'version': case '--version': case '-v': print(`xlooop ${VERSION}`); return 0;
      case 'creds-path': print(credentialsPath()); return 0;
      case 'creds-status': {
        const c = await loadCredentials();
        if (!c) { print('no credentials'); return 1; }
        const ageHours = (Date.now() - Date.parse(c.saved_at)) / (1000 * 60 * 60);
        const ageHoursStr = ageHours.toFixed(1);
        const stale = Number.isFinite(ageHours) && ageHours > STALENESS_THRESHOLD_HOURS;
        print(`source=${c.source} saved_at=${c.saved_at} age=${ageHoursStr}h`);
        if (stale) {
          print(`⚠ token may be expired (age > ${STALENESS_THRESHOLD_HOURS}h) — run "xlooop login" to refresh`);
          return 2;
        }
        return 0;
      }
      case '': case 'help': case '--help': case '-h':
        print('Xlooop CLI — bridges Claude Code (and other MCP clients) to Xlooop.');
        print('');
        print('Subcommands:');
        print('  login            Save a Clerk JWT to ~/.xlooop/credentials.json');
        print('  logout           Remove saved credentials');
        print('  whoami           Print the authenticated session (calls /api/v1/session)');
        print('  ping             Probe api.xlooop.com health (no auth)');
        print('  tools            List MCP tool names + descriptions');
        print('  register-claude  Print the Claude Code MCP config block');
        print('  creds-path       Print the credentials file path');
        print('  creds-status     Print whether credentials are loaded (env or file)');
        print('  version          Print version');
        return 0;
      default:
        err(`Unknown subcommand: ${subcommand}`);
        err('Try: xlooop help');
        return 1;
    }
  })();
  process.exit(exitCode);
}

main().catch((e) => {
  err(`[xlooop] fatal: ${(e as Error)?.stack ?? String(e)}`);
  process.exit(1);
});
