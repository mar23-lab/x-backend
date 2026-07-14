// workspace-gates.ts · S3 consolidation (260709) — the ONE customer-workspace provisioning gate.
//
// The identical inline pattern (JWT-workspace check → getSessionEntitlement → 403 unless
// 'approved_workspace') was repeated across customer-chat, customer-lineage, customer-audit-log and
// workspace-upgrade (~5 LOC ×4, plus a local helper copy in customer-lineage). One driver so a change to
// the provisioning gate changes every consumer — the same single-driver rule the frontend's data-cmp
// registry enforces. Byte-identical to the inlined originals (same status codes, same JSON bodies,
// same key order); `opts.governedAction` layers the owner/operator-class governance gate
// (authorizeGovernedWrite) the read-audit surfaces use, with the site's own denial copy.
//
// TENANT-SAFE BY CONSTRUCTION: the workspace is ONLY ever the verified JWT's auth.workspace_id.
// (customer-workspace-feed keeps its own pre-existing inline copy: its 403 body text diverges
// ("this signed-in organization") and harmonizing would change a customer-visible string — a separate,
// deliberate decision, not a silent side effect of consolidation.)

import { authorizeGovernedWrite } from './spine-authority';
import type { SpineAction } from './permissions';
import type { DalAdapter } from '../dal/DalAdapter';

/** Minimal structural ctx (matches the shape every customer route already passes). */
export interface GateCtx {
  get: (k: 'auth' | 'dal' | 'request_id') => unknown;
  status: (n: number) => void;
  json: (o: unknown) => Response;
}

export type GateResult = { ok: true; ws: string; dal: DalAdapter } | { ok: false; res: Response };

export async function gateCustomerWorkspace(
  ctx: GateCtx,
  opts: { governedAction?: SpineAction; deniedMessage?: string } = {},
): Promise<GateResult> {
  const auth = ctx.get('auth') as { user_id: string; workspace_id?: string; email?: string | null };
  const dal = ctx.get('dal') as DalAdapter;
  const ws = String(auth.workspace_id || '').trim();
  if (!ws) {
    ctx.status(403);
    return { ok: false, res: ctx.json({ error: 'no signed-in workspace', code: 'FORBIDDEN', request_id: ctx.get('request_id') }) };
  }
  const entitlement = await dal.getSessionEntitlement(auth.user_id, ws, auth.email ?? null);
  if (entitlement.state !== 'approved_workspace') {
    ctx.status(403);
    return { ok: false, res: ctx.json({ error: 'workspace is not provisioned for this organization', code: 'FORBIDDEN', state: entitlement.state, request_id: ctx.get('request_id') }) };
  }
  if (opts.governedAction) {
    // Governance-surface overlay: flag-off ≡ canWrite(role) (owner/operator pass, viewer/client 403);
    // flag-on rides the one-core entitlement authority like every governed surface.
    if (!(await authorizeGovernedWrite(ctx as never, opts.governedAction)).allowed) {
      ctx.status(403);
      return { ok: false, res: ctx.json({ error: opts.deniedMessage ?? 'this surface requires the workspace owner or an operator', code: 'FORBIDDEN', request_id: ctx.get('request_id') }) };
    }
  }
  return { ok: true, ws, dal };
}
