# C29-PERM-01 · Permission And Collaboration Requirements

**Created:** 2026-05-09T11:02:00+10:00  
**Date key:** 260509_1102  
**Owner:** Marat Basyrov  
**Scope:** contract-design/documentation only  
**Source x-front HEAD:** `401e6d40a0befc683a7a410f1ed0aee0afd6f492`  
**Decision:** define permission and collaboration requirements; do not copy x-front source; do not implement runtime code in this slice.

## Role And Skill Panel

| Role lens | Applied to |
|---|---|
| Chief-of-Staff | sequencing, owner decision gates, work-item continuity |
| CTO | product/platform boundary, contract-first architecture |
| UX | human/collaborator flow, workspace clarity, web-first scope |
| Product Manager | commercial workspace model, invited/client use cases |
| Knowledge Architect | graph visibility, evidence linkage, source lineage |
| AI Governed Infrastructure Manager | separation from xcp-platform admin/control-plane surfaces |
| DevSecOps | permissions, expiry, sensitivity, repo authority, no destructive autonomy |
| Lead Engineer | implementability, FSD compatibility, testable future contract shape |

Skills invoked: `product-engineering-router`, `integration-boundary-contracts`, existing artifact discovery.

## Executive Verdict

**Adopt x-front's collaboration intent, not its current permission implementation.**

x-front has useful domain surfaces for member roles, agent roles, workspace membership, and settings navigation. The current x-front permission settings table is placeholder-level and cannot be treated as a production permission model. Xlooop-XCP-demo already has stronger primitives in `src/entities/actor/model.ts`, `src/entities/workspace/model.ts`, `src/runtime/signed-url.ts`, `src/app/App.jsx`, and sign-off widgets, but those primitives are not yet unified into one explicit product permission contract.

The next product contract must model:

`actor -> role -> membership/session -> permission grant -> workspace/project/node/action scope -> expiry/revocation -> evidence/sign-off`

GitHub repository access is a separate authority source. Ilmir / `GraphicDigger` currently has GitHub access to `x-docs` and `x-front`; that must be mirrored as external source authority where relevant, not silently converted into an XCP/Xlooop invitation.

## Source Evidence

| Source | Finding | Use |
|---|---|---|
| `x-front/src/entities/actorRole/api/actorRole.data.js` | member and agent roles are paired for Designer, Frontend Developer, Backend Developer, BA; other human roles exist without agent pair | requirement input for human/agent role binding |
| `x-front/src/entities/actorMember/api/member.data.js` | membership is workspace-scoped and role-labeled, but demo fields are mixed into member records | requirement input only; do not copy shape |
| `x-front/src/entities/workspace/api/workspace.data.js` | workspace exists as a top-level collaboration boundary but lacks owner, policy, expiry, sensitivity | confirms workspace boundary, not sufficient for contract |
| `x-front/src/features/settings/memberAndAgentRoleSettings/ui/components/PermissionSettings.jsx` | permission UI is placeholder data: Project/Members/Teams rows with "Check"/"Permission" copy | do not adopt as implementation |
| `src/entities/actor/model.ts` | actor, session, membership, role, workspace/project scope, `expires_at` | current demo base to extend |
| `src/entities/workspace/model.ts` | workspace kind, owner, identity TTL, sign-off compliance defaults | current demo workspace policy base |
| `src/runtime/signed-url.ts` | client review claims, role, mode, `expires_at`, read-only action allow-list | client/invited access input |
| `src/app/App.jsx` | reducer-side policy checks for approve/promote/sign-off; fail-open caveats documented in code | future hardening input |
| `src/shared/services/data-loader/DataLoader.jsx` | `window.policy.permissionsFor(role, key, projectId)` fixture policy | current policy source, not durable contract |

## Actor Kind Matrix

| Actor kind | Authority source | Required scope | Expiry rule | Allowed product actions | Stop conditions |
|---|---|---|---|---|---|
| Owner | owner record / organisation policy | tenant, workspace, project, domain, archive/sign-off | no default expiry; explicit delegation expiry still required | grant/revoke, approve owner-gated actions, sign-off, archive/delete approval | cannot be substituted by agent/system/local LLM |
| Employee | workspace membership / employment policy | workspace/project/action | explicit expiry or employment-policy review date | delivery, review, sign-off only if delegated | cannot approve owner-only archive/delete/external claims unless delegated |
| Contractor | owner invitation or repo/project contract | project/work item/action | mandatory `expires_at` | implement/review within assigned scope | no implicit access outside assigned workspace/project |
| Partner/client | client invitation, partner workspace, or signed URL | client-visible project/work item/evidence package | mandatory `expires_at` or signed URL TTL | acknowledge, request changes, sign client approval if authorized | cannot see private/internal/confidential fields above sensitivity ceiling |
| Family/friend/personal collaborator | owner invitation into personal domain | explicit personal-domain scope | mandatory `expires_at` | assist in personal-domain tasks only | cannot infer broad MB-P or company authority from personal trust |
| GitHub collaborator | GitHub repo permission | named repository and branch/PR capability | governed by GitHub; mirror `last_verified_at` and optional review due | repo actions permitted by GitHub role | is not an XCP invitation; Xlooop must not override GitHub authority |
| Agent | role-skill assignment and task policy | task/action/tool/input/output | run-scoped expiry | candidate analysis, implementation, review within policy | cannot owner-approve, cannot archive/delete/move, cannot bypass preflight |
| System/automation | deterministic system policy | queue/task/output lane | schedule or run-scoped expiry | deterministic checks, reports, lifecycle events | cannot make discretionary business, owner, or destructive decisions |

## Permission Contract Candidate

Future TypeScript implementation should live under `src/contracts/graph/` after review, not inside widget or page code.

```ts
export type ActorKind =
  | 'owner'
  | 'employee'
  | 'contractor'
  | 'partner_client'
  | 'family_friend_personal_collaborator'
  | 'github_collaborator'
  | 'agent'
  | 'system';

export type PermissionAuthoritySource =
  | 'xcp_invitation'
  | 'xlooop_workspace_membership'
  | 'github_repo_permission'
  | 'signed_url'
  | 'owner_direct_grant'
  | 'employment_policy'
  | 'system_policy';

export type PermissionStatus =
  | 'draft'
  | 'proposed'
  | 'active'
  | 'expired'
  | 'revoked'
  | 'suspended';

export interface PermissionGrantContract {
  permission_id: string;
  schema_version: string;
  actor_id: string;
  actor_kind: ActorKind;
  authority_source: PermissionAuthoritySource;
  workspace_id: string;
  project_id?: string;
  subject_type: 'workspace' | 'project' | 'node' | 'repo' | 'action' | 'evidence_package';
  subject_id: string;
  role: string;
  actions: string[];
  visibility_ceiling: 'private' | 'workspace' | 'project' | 'client' | 'public';
  sensitivity_ceiling: 'public' | 'internal' | 'confidential' | 'restricted';
  granted_by_actor_id: string;
  granted_at: string;
  expires_at: string | null;
  revoked_at?: string;
  revocation_reason?: string;
  review_due?: string;
  source_refs: SourceRefContract[];
  evidence_refs: string[];
  status: PermissionStatus;
  created_at: string;
  updated_at: string;
}
```

## Edge Requirements

| Edge | From | To | Required fields |
|---|---|---|---|
| `has_permission` | actor | subject | action scope, visibility/sensitivity ceiling, grant time, expiry |
| `granted_by` | permission | actor | grant evidence, authority source |
| `revoked_by` | permission | actor | revocation time and reason |
| `bounded_by_repo_permission` | actor/permission | GitHub repo ref | repo, username, last verified time |
| `delegates_to` | owner/admin | employee/contractor/agent | delegated actions and expiry |
| `expires_at` | permission/session/signed URL | timestamp | timezone-aware ISO timestamp |
| `evidenced_by` | permission/sign-off | evidence | source refs and validity |

## Current Gaps

| Gap | Evidence | Risk | Required correction |
|---|---|---:|---|
| No single permission contract | actor/workspace/signed URL/policy gates are split across runtime and fixtures | 70 | define contract before UI expansion |
| x-front permission UI is placeholder | `PermissionSettings.jsx` contains generic "Check"/"Permission" rows | 85 | do not import; use as requirement prompt only |
| GitHub access is not modeled separately | Ilmir access is repo-level, not XCP invite | 80 | add `github_repo_permission` authority source |
| Non-owner collaborator expiry not explicit everywhere | demo has session/signed-url expiry but membership lacks expiry | 75 | require expiry/review due for non-owner grants |
| Policy gates are not contract-backed | `window.policy.permissionsFor` fixture and reducer checks | 65 | future schema + tests before production claims |
| Sensitivity ceiling is missing from actor/session/membership | current role model lacks data classification boundary | 80 | add visibility/sensitivity to permission contract |

## Minimum Acceptance Criteria For Future Implementation

1. Every non-owner permission grant has `granted_at`, `granted_by_actor_id`, `expires_at` or `review_due`, scope, and authority source.
2. GitHub collaborator access is represented as external source authority and last-verified evidence, not as an XCP invite.
3. Client/signed-url access cannot exceed `client` visibility or its sensitivity ceiling.
4. Agent/system permissions are run-scoped and cannot approve archive/delete/move or owner-gated external claims.
5. Workspace/project membership and action permission are separate concepts.
6. Permission edges are graph-visible and testable before user-facing settings UI depends on them.
7. xcp-platform infrastructure admin/dashboard permissions remain outside this product UI; Xlooop-XCP-demo may show xcp-platform as a workspace/domain, not as the control-plane administration surface.

## Go / No-Go

| Action | Decision |
|---|---|
| Use x-front role/member/workspace concepts as requirement evidence | GO |
| Copy x-front permission settings UI or data shape | NO-GO |
| Treat GitHub collaborator access as XCP invitation | NO-GO |
| Add runtime permission code in this slice | NO-GO |
| Create future TypeScript permission contract after owner/PR review | GO |
| Proceed to Storybook DoD/state-matrix adoption | GO after this slice lands |

## Next Step

Proceed to **C29-STORY-01**:

- compare x-front Storybook DoD/state-matrix discipline with current demo Storybook governance;
- adopt maturity/checklist practices where useful;
- do not import x-front runtime or UI code.
