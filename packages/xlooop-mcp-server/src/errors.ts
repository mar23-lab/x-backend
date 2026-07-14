// errors.ts · structured error types for the MCP layer.
//
// Goal: every failure surfaces a stable code + actionable message so the
// MCP client (Claude Code, agents) can branch on the code instead of
// parsing the message.

export type ErrorCode =
  | 'AUTH_MISSING'           // no token configured
  | 'AUTH_INVALID'           // token rejected by Worker (401)
  | 'AUTH_FORBIDDEN'         // token valid but caller not entitled (403)
  | 'NOT_FOUND'              // referenced resource doesn't exist (404)
  | 'VALIDATION_ERROR'       // bad input to a tool (400)
  | 'NETWORK_ERROR'          // fetch failed before reaching Worker
  | 'TIMEOUT'                // long-poll exceeded operator-set bound
  | 'WORKER_ERROR'           // Worker returned 5xx
  | 'INTERNAL_ERROR';        // anything else

export class XlooopMcpError extends Error {
  readonly code: ErrorCode;
  readonly status?: number;
  readonly request_id?: string;
  readonly hint?: string;

  constructor(
    code: ErrorCode,
    message: string,
    opts?: { status?: number; request_id?: string; hint?: string; cause?: unknown },
  ) {
    super(message, opts?.cause ? { cause: opts.cause } : undefined);
    this.name = 'XlooopMcpError';
    this.code = code;
    if (opts?.status !== undefined) this.status = opts.status;
    if (opts?.request_id !== undefined) this.request_id = opts.request_id;
    if (opts?.hint !== undefined) this.hint = opts.hint;
  }

  /** Render to a stable JSON envelope for MCP tool errors. */
  toEnvelope(): Record<string, unknown> {
    return {
      error: this.message,
      code: this.code,
      status: this.status ?? null,
      request_id: this.request_id ?? null,
      hint: this.hint ?? null,
    };
  }
}

/** Map an HTTP status + body to a typed error. Used by api-client.ts. */
export function errorFromHttpStatus(
  status: number,
  body?: { error?: string; code?: string; request_id?: string },
  url?: string,
): XlooopMcpError {
  const msg = body?.error ?? `HTTP ${status} from ${url ?? 'Worker'}`;
  const reqId = body?.request_id;
  if (status === 401) {
    return new XlooopMcpError('AUTH_INVALID', msg, {
      status, request_id: reqId,
      hint: 'Run `xlooop login` to refresh the credential, or check that XLOOOP_TOKEN matches an active Clerk session for an approved Xlooop user.',
    });
  }
  if (status === 403) {
    return new XlooopMcpError('AUTH_FORBIDDEN', msg, {
      status, request_id: reqId,
      hint: 'The token is valid but the user is not entitled to this workspace. Confirm the workspace_id and the user\'s active workspace_member row via /api/v1/diagnose-user/<user_id>.',
    });
  }
  if (status === 404) {
    return new XlooopMcpError('NOT_FOUND', msg, { status, request_id: reqId });
  }
  if (status === 400 || status === 422) {
    return new XlooopMcpError('VALIDATION_ERROR', msg, { status, request_id: reqId });
  }
  if (status >= 500) {
    return new XlooopMcpError('WORKER_ERROR', msg, {
      status, request_id: reqId,
      hint: 'Worker returned 5xx. Inspect logs via `npx wrangler tail xlooop-api --config wrangler.toml` in the Xlooop-XCP-demo repo.',
    });
  }
  return new XlooopMcpError('INTERNAL_ERROR', msg, { status, request_id: reqId });
}
