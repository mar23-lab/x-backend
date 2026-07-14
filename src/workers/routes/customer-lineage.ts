// customer-lineage.ts · W3 customer-governance wave (260708) · G1 — the customer's own lineage read.
//
// The graph substrate (029: graph_nodes/edges + v_artefact_lineage; rebuilt per workspace) has been
// OPERATOR-ONLY (routes/graph.ts is operator infrastructure by contract). This route gives a CUSTOMER the
// same walk over THEIR OWN workspace — intent → packet → event → tool_action → document — with zero new
// graph logic: it reuses `dal.getArtefactLineage` (the identical ≤5000-row spine read the pinned-card chat
// path uses) and `tenantSafeGraphDigest` (the IP-light aggregate built for exactly this exposure tier).
//
// TENANT-SAFE BY CONSTRUCTION (the customer-chat.ts skeleton): the workspace is ONLY ever the verified JWT's
// auth.workspace_id (never a query param); reads degrade to empty rather than erroring. Cross-tenant denial
// needs no check because no foreign workspace id can enter. WITHIN-tenant, this is a GOVERNANCE surface —
// the causal walk exposes owner-only artefact descriptions and v_artefact_lineage is not visibility-filtered —
// so it is gated to the owner/operator class (authorizeGovernedWrite 'token:read'), matching customer-audit-log,
// not merely to any provisioned member.
//
//   GET /api/v1/customer-lineage?node=<node-id>&cause_only=true — the lineage edges (optionally anchored).
//   GET /api/v1/customer-graph-digest — counts + recent nodes (tenant-safe digest; graph must be rebuilt
//       by the operator with GRAPH_DOCUMENT_NODES_ENABLED for document nodes to appear).

import { Hono } from 'hono';
import { envFlagTrue } from '../lib/env-flag';
import { errorEnvelope } from '../middleware/error';
import { withDataClass } from '../lib/response-envelope';
import { gateCustomerWorkspace } from '../lib/workspace-gates';
import { buildDataGraph } from '../graph/data-graph';
import { tenantSafeGraphDigest } from '../graph/persist-data-graph';
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';

export interface CustomerLineageEnv extends AuthEnv {
  DATABASE_URL: string;
  GRAPH_DOCUMENT_NODES_ENABLED?: string;
}
export interface CustomerLineageVariables extends AuthVariables {
  dal: DalAdapter;
}

export const customerLineageRoute = new Hono<{ Bindings: CustomerLineageEnv; Variables: CustomerLineageVariables }>();

// The provisioning + governance gate is the shared lib/workspace-gates.ts driver (S3 consolidation).
// Governance overlay rationale (unchanged): the intent→packet→event→document walk reveals the workspace's
// full causal structure incl. owner-only artefact descriptions — v_artefact_lineage is NOT
// role-visibility-filtered — so the surface is owner/operator-class, not any provisioned member.
const LINEAGE_GATE = { governedAction: 'token:read', deniedMessage: 'the lineage view requires the workspace owner or an operator' } as const;

// GET /api/v1/customer-lineage?node=...&cause_only=true
customerLineageRoute.get('/customer-lineage', async (ctx) => {
  try {
    const gate = await gateCustomerWorkspace(ctx as never, LINEAGE_GATE);
    if (!gate.ok) return gate.res;
    const node = ctx.req.query('node') || undefined;
    const causeOnly = ctx.req.query('cause_only') === 'true';
    let edges: unknown[] = [];
    try {
      edges = await gate.dal.getArtefactLineage(gate.ws, { nodeId: node, causeOnly });
    } catch { edges = []; /* degrade-to-empty: an unbuilt graph is an empty lineage, not an error */ }
    return ctx.json(withDataClass({
      ok: true,
      workspace_id: gate.ws,
      anchor: node ?? null,
      cause_only: causeOnly,
      edges,
      edge_count: edges.length,
    }, 'live'));
  } catch (err) { return errorEnvelope(ctx, err); }
});

// GET /api/v1/customer-graph-digest — fresh projection of the CALLER's workspace only (counts + recent).
customerLineageRoute.get('/customer-graph-digest', async (ctx) => {
  try {
    const gate = await gateCustomerWorkspace(ctx as never, LINEAGE_GATE);
    if (!gate.ok) return gate.res;
    const includeDocuments = envFlagTrue(ctx.env.GRAPH_DOCUMENT_NODES_ENABLED);
    let digest: unknown = null;
    try {
      const facts = await gate.dal.assembleDataGraphFacts(gate.ws, { includeDocuments });
      const now = new Date().toISOString();
      const { nodes, edges, snapshot } = buildDataGraph(gate.ws, facts);
      digest = tenantSafeGraphDigest(gate.ws, nodes, edges, snapshot.graph_hash, now);
    } catch { digest = null; /* degrade: no digest rather than a 500 */ }
    return ctx.json(withDataClass({ ok: true, workspace_id: gate.ws, digest }, 'live'));
  } catch (err) { return errorEnvelope(ctx, err); }
});
