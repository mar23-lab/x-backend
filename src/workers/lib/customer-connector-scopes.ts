export const CUSTOMER_CONNECTOR_SCOPES = [
  'read:session',
  'read:packets',
  'read:profiles',
  'read:templates',
  'read:status',
  'read:evidence',
  'read:metrics',
  'write:evidence',
  'write:tool_events',
  'write:approval_requests',
] as const;

export type CustomerConnectorScope = (typeof CUSTOMER_CONNECTOR_SCOPES)[number];

export const CUSTOMER_CONNECTOR_READ_SCOPES: readonly CustomerConnectorScope[] = [
  'read:session',
  'read:packets',
  'read:profiles',
  'read:templates',
  'read:status',
  'read:evidence',
  'read:metrics',
];

export const CUSTOMER_CONNECTOR_OPERATOR_SCOPES: readonly CustomerConnectorScope[] = [
  ...CUSTOMER_CONNECTOR_READ_SCOPES,
  'write:evidence',
  'write:tool_events',
  'write:approval_requests',
];

const KNOWN_SCOPES = new Set<string>(CUSTOMER_CONNECTOR_SCOPES);

export type CustomerScopeRequest =
  | { ok: true; role: 'viewer' | 'operator'; scopes: CustomerConnectorScope[] }
  | { ok: false; reason: string };

export function resolveRequestedCustomerScopes(
  rawScope: string,
  operationalTokensEnabled: boolean,
): CustomerScopeRequest {
  const requested = rawScope.trim().split(/\s+/).filter(Boolean);
  if (requested.length === 0 || (requested.length === 1 && requested[0] === 'viewer')) {
    return { ok: true, role: 'viewer', scopes: [...CUSTOMER_CONNECTOR_READ_SCOPES] };
  }
  if (requested.length === 1 && requested[0] === 'operator') {
    return operationalTokensEnabled
      ? { ok: true, role: 'operator', scopes: [...CUSTOMER_CONNECTOR_OPERATOR_SCOPES] }
      : { ok: false, reason: 'operator scope is not enabled for this deployment' };
  }

  const unique = [...new Set(requested)];
  const unknown = unique.filter((scope) => !KNOWN_SCOPES.has(scope));
  if (unknown.length > 0) {
    return { ok: false, reason: `unsupported scope: ${unknown.join(', ')}` };
  }
  if (!unique.includes('read:session')) {
    return { ok: false, reason: 'read:session is required for every connector token' };
  }

  const hasWrite = unique.some((scope) => scope.startsWith('write:'));
  if (hasWrite && !operationalTokensEnabled) {
    return { ok: false, reason: 'write scopes are not enabled for this deployment' };
  }
  return {
    ok: true,
    role: hasWrite ? 'operator' : 'viewer',
    scopes: unique as CustomerConnectorScope[],
  };
}

export function requiredCustomerScope(method: string, path: string): CustomerConnectorScope | null {
  const verb = method.toUpperCase();

  if (path === '/api/v1/whoami' || path === '/api/v1/mcp/whoami'
    || path === '/api/v1/mcp/session-start' || path === '/api/v1/mcp/tools'
    || path === '/api/v1/mcp/rpc') return 'read:session';

  if (verb === 'GET' && (path.startsWith('/api/v1/packets')
    || path.startsWith('/api/v1/mcp/task-packets')
    || path.startsWith('/api/v1/mcp/current-work')
    || path.startsWith('/api/v1/mcp/events')
    || path.startsWith('/api/v1/mcp/plan/'))) return 'read:packets';

  if (verb === 'GET' && (path.startsWith('/api/v1/evidence')
    || path.startsWith('/api/v1/mcp/evidence')
    || path.startsWith('/api/v1/mcp/receipts')
    || path.startsWith('/api/v1/mcp/documents')
    || path.startsWith('/api/v1/mcp/sources'))) return 'read:evidence';

  if (verb === 'GET' && path.startsWith('/api/v1/template-policy/effective-templates')) return 'read:templates';
  if (verb === 'GET' && (path.startsWith('/api/v1/template-policy/effective-snapshots')
    || path.startsWith('/api/v1/template-policy/personalization/effective-profile'))) return 'read:profiles';

  if (verb === 'GET' && (path.startsWith('/api/v1/metric-deltas')
    || path.startsWith('/api/v1/mcp/status'))) return 'read:metrics';

  if (verb === 'GET' && (path.startsWith('/api/v1/approvals')
    || path.startsWith('/api/v1/tool-events')
    || path.startsWith('/api/v1/template-policy/status'))) return 'read:status';

  if (verb === 'POST' && (path === '/api/v1/evidence' || path === '/api/v1/mcp/evidence')) return 'write:evidence';
  if (verb === 'POST' && (path === '/api/v1/tool-events' || path === '/api/v1/mcp/tool-events')) return 'write:tool_events';
  if (verb === 'POST' && (path === '/api/v1/approvals' || path === '/api/v1/mcp/approval-requests')) return 'write:approval_requests';

  return null;
}

