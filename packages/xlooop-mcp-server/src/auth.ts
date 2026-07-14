// auth.ts · loads the bearer token from env var or credentials file.
//
// Precedence (highest wins):
//   1. XLOOOP_TOKEN environment variable
//   2. ~/.xlooop/credentials.json { "token": "...", "saved_at": "..." }
//
// The credentials file is written by `xlooop login` (see bin/cli.ts).
// Tokens are short-lived Clerk session JWTs OR long-lived MCP-mint tokens
// (R44.1 will add the mint endpoint; R44.0 supports only session JWTs).
//
// On any read failure we return null; the api-client converts that into a
// structured AUTH_MISSING error with a hint pointing at `xlooop login`.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { XlooopMcpError } from './errors.js';

const CRED_FILE = join(homedir(), '.xlooop', 'credentials.json');

export interface Credentials {
  token: string;
  saved_at: string;
  source: 'env' | 'file';
}

export async function loadCredentials(): Promise<Credentials | null> {
  const envToken = (process.env.XLOOOP_TOKEN ?? '').trim();
  if (envToken) {
    return { token: envToken, saved_at: new Date().toISOString(), source: 'env' };
  }
  try {
    const raw = await readFile(CRED_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as { token?: unknown; saved_at?: unknown };
    if (typeof parsed.token === 'string' && parsed.token.length > 10) {
      return {
        token: parsed.token,
        saved_at: typeof parsed.saved_at === 'string' ? parsed.saved_at : new Date().toISOString(),
        source: 'file',
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function requireToken(): Promise<string> {
  const creds = await loadCredentials();
  if (!creds) {
    throw new XlooopMcpError('AUTH_MISSING',
      'No Xlooop credentials configured.',
      {
        hint: 'Set XLOOOP_TOKEN env var to a valid Clerk session JWT, OR run `xlooop login` to save credentials to ~/.xlooop/credentials.json',
      },
    );
  }
  return creds.token;
}

/** Where credentials are persisted. Exposed for the CLI. */
export function credentialsPath(): string {
  return CRED_FILE;
}
