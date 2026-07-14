# Claude, Codex, and Cursor API Onboarding

This guide is the customer-safe path for connecting Claude Code, Codex, Cursor, and similar customer-controlled coding assistants to Xlooop through the backend API/MCP gateway.

## Architecture

Customers do not connect Claude, Codex, or Cursor to raw MB-P governance files, private graph schema, full tenant memory, internal scoring templates, or broad search tools. Each assistant connects to Xlooop as an authenticated customer client and receives only tenant-scoped projections:

- `xlooop.whoami`
- scoped task packets
- scoped workflow/status/metrics
- evidence submission
- tool-event reporting
- approval requests
- effective redacted templates
- effective personalization profile
- private user learning signal submission

Forbidden surfaces stay server-side: raw graph, full tenant memory, Xlooop internal templates, governance scoring, agent routing, private graph schema, secrets, and broad search-all-memory.

## Customer Setup Flow

1. Create the customer company tenant in Xlooop.
2. Customer admin invites the employee through Clerk, OAuth, or SSO.
3. Xlooop provisions the company workspace, owner/member row, first project, welcome event, authority state, starting templates, and audit receipt from the Clerk org/session lane.
4. Employee opens Xlooop Profile and uses **Developer Access Center** for tenant-scoped directions.
5. Employee runs **Run connection check** and confirms the redacted receipt identifies only their company and user.
6. Employee connects Claude Code, Codex, or Cursor through Xlooop OAuth/device flow when the connector is available; any scoped Xlooop connector token remains a controlled fallback only after lifecycle and revocation proof passes.
7. The first assistant call must be `xlooop.whoami`.
8. The user confirms that the returned redacted identity matches their Xlooop account.
9. Every packet, evidence item, tool event, approval request, and metric delta records the actor, tenant, auth method, client id, and token hash or JTI.
10. Revoking the connector token must make Claude Code, Codex, and Cursor access fail.

## In-App Customer Directions

After sign-in, customers should not need terminal onboarding or a pasted chat runbook. The app surfaces the current controlled path at:

- Profile -> Developer Access Center

This panel is personalized from the active Clerk/Xlooop session and shows:

- the signed-in customer identity and workspace;
- the read-only validation status;
- tool-specific setup tabs for Claude Code, Codex, Cursor, and Browser test;
- a server-side **Run connection check** that validates `/api/v1/session`, `xlooop.whoami`, and the read-only customer MCP allowlist without asking the customer to copy a raw token;
- a copyable human setup note for the selected tool;
- the token safety rule: never paste token values into chat, feedback, docs, tickets, or email;
- the blocked surfaces: database credentials, Clerk secrets, operator tokens, raw graph authority, full memory search, internal governance templates, and cross-tenant data.

This is a customer convenience surface, not public API authority. Public API readiness still requires the live evidence gates below.

## Personalization And Learning

Xlooop may learn from each company and each employee, but learning is scoped and
private by default.

Company-level configuration:

- company terminology
- company-approved role packs
- shared skills
- workflow defaults
- evidence and approval presentation defaults

User-level configuration:

- personal preferences
- personal rules
- personal skills
- learned defaults
- repeated corrections
- preferred evidence and digest style

User-level learning is not automatically shared with the company. A user signal
can become a company or role pattern only when it has explicit consent, admin or
operator promotion, approval reference, evidence reference when available, and
audit coverage.

Personalization may improve wording, examples, defaults, terminology, workflow
preferences, skill ordering, and evidence presentation. It must never weaken
tenant isolation, redaction, retention, approvals, tool permissions, evidence,
RCA, or forbidden API/MCP surfaces.

## Required `whoami` Evidence

The `xlooop.whoami` response must include:

- `user_id`
- `tenant_id`
- redacted `membership_ref` or server-side membership proof
- role
- scopes
- `client_id`
- token expiry
- auth method
- service-principal marker when applicable

If a dedicated `membership_id` is not exposed in the public response yet, the backend must still prove membership through Clerk organization membership and the server-side database membership/RBAC check. The public response may expose a redacted `membership_ref` and `membership_resolution` instead of an internal database id. Do not let Claude Code supply or override tenant identity from prompt text.

## Service Principals

Service principals are for explicit automation identities only. They must never impersonate a customer employee.

Allowed service-principal use:

- read-only canary status checks
- API/MCP parity validation
- synthetic canary packet lifecycle checks under `pkt-canary-*`

Forbidden service-principal use:

- customer impersonation
- destructive delete/export
- admin mutation
- raw graph access
- full tenant memory access
- governance scoring
- secret retrieval

## Local Proof Scenario

Run this scenario before calling the Claude/Codex/Cursor customer path production-ready:

1. Create synthetic `company_a` and `company_b`.
2. Add `employee_a`, `employee_b`, and `admin`.
3. Connect Claude Code as `employee_a` through the read-only customer MCP path, then repeat the same identity check for Codex and Cursor when their connectors are installed.
4. Call `xlooop.whoami` and verify the returned identity maps to `employee_a` and `company_a`.
5. Confirm `employee_a` can read only scoped packets and effective templates for `company_a`.
6. Confirm `employee_a` cannot access `company_b`.
7. Confirm `employee_a` cannot access raw graph, governance scoring, private graph schema, secrets, or broad memory search.
8. Submit a metadata-only evidence item and tool event against an allowed scoped packet.
9. Revoke the connector token.
10. Confirm assistant access fails after revocation.

Acceptance thresholds:

- assistant user binding accuracy: `100%`
- cross-tenant leakage: `0`
- forbidden surface exposure: `0`
- unauthorized tool escalation: `0`
- audit coverage for packet/evidence/tool/approval actions: `100%`
- token revocation failure proof: present

## Verification Commands

```bash
cd /Users/maratbasyrov/WIP/Xlooop/Xlooop-XCP-demo
npm run verify:customer-api-access-guidance
npm run verify:claude-code-user-binding
npm run verify:customer-claude-code-oauth-binding
npm run verify:api-mcp-parity -- --transport=all --format=json
npm run verify:customer-learning-personalization
```

For a live customer canary, create a `pkt-canary-*` packet and scoped
read/lifecycle canary tokens. Store tokens in local files, then run:

```bash
export XLOOOP_API_BASE=https://api.xlooop.com
export XLOOOP_PARITY_PACKET_ID=pkt-canary-...
export XLOOOP_CANARY_API_TOKEN_FILE=/path/to/read-token.txt
export XLOOOP_CANARY_LIFECYCLE_API_TOKEN_FILE=/path/to/lifecycle-token.txt
npm run verify:api-mcp-lifecycle-parity -- --format=json
npm run verify:api-mcp-live-canary-hard-stop -- --strict-live
```

External customer onboarding resumes only when the public go/no-go command
passes with `public_production_authority: true`:

```bash
npm run verify:public-production-readiness-hard-stop -- --strict-public
```

Do not paste long-lived user secrets into tickets, chat, docs, or source files.
