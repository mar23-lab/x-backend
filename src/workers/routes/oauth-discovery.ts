// oauth-discovery.ts · Stage-2 slice 1 (260806, operator-approved plan) · RFC 9728 discovery.
//
// THE GAP THIS CLOSES: the MCP endpoint returned bare 401s with no `WWW-Authenticate` header and
// no protected-resource metadata anywhere, so an MCP host's discovery ladder (RFC 9728 → RFC 8414)
// could not even START — manual bearer paste was the only onboarding, invisible in the host UI.
// Measured live on production 260806: `POST /api/v1/mcp/rpc` (unauthenticated) → HTTP 401, zero
// challenge headers.
//
// HONEST INTERIM SHAPE: there is no Xlooop authorization server yet (the PKCE flow is the second
// half of Stage 2). `authorization_servers` is therefore ABSENT — not an empty lie, not a fake AS —
// and `resource_documentation` points the human at the real credential path (mint a connector token
// in the app). A host that reads this learns the resource identity and where credentials come from;
// when the AS lands, this document gains its entry and hosts upgrade to one-click sign-in with no
// client change. The challenge header is emitted by the auth middleware (middleware/auth.ts) on
// every 401 so discovery works from any entry point.

import { Hono } from 'hono';

export const OAUTH_PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';

/** The canonical resource identifier — the API origin, stable across deploys. */
export const RESOURCE_ORIGIN = 'https://api.xlooop.com';

export function protectedResourceMetadata() {
  return {
    // RFC 9728 §2 — the resource identifier MUST match what tokens are bound to.
    resource: RESOURCE_ORIGIN,
    // Stage-2 second half (260806): the PKCE AS is LIVE (routes/oauth-as.ts) — advertising it here
    // is the one line that upgrades every MCP host from manual token paste to one-click sign-in.
    authorization_servers: [RESOURCE_ORIGIN],
    bearer_methods_supported: ['header'],
    resource_name: 'Xlooop customer API + MCP gateway',
    resource_documentation: 'https://app.xlooop.com/settings',
    // Non-normative hint for humans reading the doc raw (hosts ignore unknown members per RFC 9728).
    'xlooop:credential_hint':
      'Mint a connector token in app.xlooop.com -> Settings -> Developer access, then connect with: '
      + 'claude mcp add --transport http xlooop https://api.xlooop.com/api/v1/mcp/rpc --header "Authorization: Bearer <token>"',
  };
}

export const oauthDiscoveryRoute = new Hono();

// Path is a LITERAL here (not the exported constant): the route-manifest generator parses route
// paths statically and refuses dynamic expressions — a wrong-but-plausible variable would otherwise
// ship a route the manifest cannot see.
oauthDiscoveryRoute.get('/.well-known/oauth-protected-resource', (ctx) => {
  ctx.header('Cache-Control', 'public, max-age=3600');
  return ctx.json(protectedResourceMetadata());
});
