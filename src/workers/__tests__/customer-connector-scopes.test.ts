import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_CONNECTOR_OPERATOR_SCOPES,
  CUSTOMER_CONNECTOR_READ_SCOPES,
  requiredCustomerScope,
  resolveRequestedCustomerScopes,
} from '../lib/customer-connector-scopes';

describe('customer connector scope contract', () => {
  it('defaults to the complete read-only contract', () => {
    expect(resolveRequestedCustomerScopes('', false)).toEqual({
      ok: true,
      role: 'viewer',
      scopes: CUSTOMER_CONNECTOR_READ_SCOPES,
    });
  });

  it('rejects unknown, incomplete, and disabled write scopes', () => {
    expect(resolveRequestedCustomerScopes('read:session delete:tenant', true).ok).toBe(false);
    expect(resolveRequestedCustomerScopes('read:packets', true).ok).toBe(false);
    expect(resolveRequestedCustomerScopes('read:session write:evidence', false).ok).toBe(false);
    expect(resolveRequestedCustomerScopes('operator', false).ok).toBe(false);
  });

  it('maps the compatibility operator alias to explicit least-privilege action scopes', () => {
    expect(resolveRequestedCustomerScopes('operator', true)).toEqual({
      ok: true,
      role: 'operator',
      scopes: CUSTOMER_CONNECTOR_OPERATOR_SCOPES,
    });
  });

  it('denies unregistered operations by returning no required scope', () => {
    expect(requiredCustomerScope('POST', '/api/v1/customer-data/delete-requests')).toBeNull();
    expect(requiredCustomerScope('POST', '/api/v1/packets')).toBeNull();
    expect(requiredCustomerScope('PATCH', '/api/v1/approvals/apr_1')).toBeNull();
  });

  it('maps only the approved customer API and MCP operations', () => {
    expect(requiredCustomerScope('GET', '/api/v1/mcp/session-start')).toBe('read:session');
    expect(requiredCustomerScope('GET', '/api/v1/packets/pkt_1')).toBe('read:packets');
    expect(requiredCustomerScope('POST', '/api/v1/mcp/evidence')).toBe('write:evidence');
    expect(requiredCustomerScope('POST', '/api/v1/mcp/tool-events')).toBe('write:tool_events');
    expect(requiredCustomerScope('POST', '/api/v1/mcp/approval-requests')).toBe('write:approval_requests');
  });
});

