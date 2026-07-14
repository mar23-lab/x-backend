// graph.ts · ADR-XLOOP-ARCH-003 Phase 2 · the data-graph's PRODUCTION home (operator-gated).
//
// Gives buildDataGraph its first real runtime caller (closes self-critique C6):
//   POST /api/v1/graph/rebuild   — re-project + persist the materialized graph for a workspace (drift-aware).
//   GET  /api/v1/graph/drift     — read-side drift gate (stored hash vs a fresh re-projection).
//   GET  /api/v1/graph/lineage   — the v_artefact_lineage spine (optionally anchored at a node).
//   GET  /api/v1/graph/digest    — the tenant-safe IP-light aggregate (counts + recent + root-causes).
//
// Auth: OPERATOR-ONLY (user_id === MBP_OWNER_USER_ID) + owned-workspace guard — the data-graph is
// operator/system infrastructure (Tier-3a engine over the operator's own facts), never a tenant surface.

import { Hono } from 'hono';
import { envFlagTrue } from '../lib/env-flag';
import { operatorIds } from '../lib/permissions';
import { errorEnvelope } from '../middleware/error';
import type { AuthEnv, AuthVariables } from '../middleware/auth';
import type { DalAdapter } from '../dal/DalAdapter';
import { buildDataGraph } from '../graph/data-graph';
import { persistDataGraph, checkGraphDrift, tenantSafeGraphDigest, type GraphPersistDeps } from '../graph/persist-data-graph';

export interface GraphEnv extends AuthEnv {
  DATABASE_URL: string;
  MBP_OWNER_USER_ID?: string;
  MBP_OWNER_LINKED_USER_IDS?: string;
}
export interface GraphVariables extends AuthVariables {
  dal: DalAdapter;
}

export const graphRoute = new Hono<{ Bindings: GraphEnv; Variables: GraphVariables }>();

type GateResult =
  | { ok: true; ws: string }
  | { ok: false; status: 403 | 400; error: string };

/** Operator gate + owned-workspace guard — ctx-free + pure-ish (one DAL read). */
async function gateOperatorWorkspace(auth: { user_id?: string }, env: GraphEnv, dal: DalAdapter, workspaceId: string | undefined): Promise<GateResult> {
  const { ownerUserId, ids } = operatorIds(env);
  const user_id = auth?.user_id;
  if (!ownerUserId || !user_id || user_id !== ownerUserId) return { ok: false, status: 403, error: 'operator only' };
  const ws = String(workspaceId || '').trim();
  if (!ws) return { ok: false, status: 400, error: 'workspace_id required' };
  if (!(await dal.operatorOwnsWorkspace(ids, ws))) return { ok: false, status: 403, error: 'workspace not owned' };
  return { ok: true, ws };
}

// POST /api/v1/graph/rebuild { workspace_id }
graphRoute.post('/graph/rebuild', async (ctx) => {
  try {
    const dal = ctx.get('dal');
    const body = await ctx.req.json().catch(() => ({})) as { workspace_id?: string };
    const gate = await gateOperatorWorkspace(ctx.get('auth'), ctx.env, dal, body.workspace_id);
    if (!gate.ok) { ctx.status(gate.status); return ctx.json({ error: gate.error }); }
    const includeDocuments = envFlagTrue((ctx.env as { GRAPH_DOCUMENT_NODES_ENABLED?: string }).GRAPH_DOCUMENT_NODES_ENABLED);
    const result = await persistDataGraph(dal as unknown as GraphPersistDeps, gate.ws, new Date().toISOString(), { includeDocuments });
    return ctx.json({ ok: true, ...result });
  } catch (err) { return errorEnvelope(ctx, err); }
});

// GET /api/v1/graph/drift?workspace_id=...
graphRoute.get('/graph/drift', async (ctx) => {
  try {
    const dal = ctx.get('dal');
    const gate = await gateOperatorWorkspace(ctx.get('auth'), ctx.env, dal, ctx.req.query('workspace_id'));
    if (!gate.ok) { ctx.status(gate.status); return ctx.json({ error: gate.error }); }
    const drift = await checkGraphDrift(dal as unknown as GraphPersistDeps, gate.ws, { includeDocuments: envFlagTrue((ctx.env as { GRAPH_DOCUMENT_NODES_ENABLED?: string }).GRAPH_DOCUMENT_NODES_ENABLED) });
    return ctx.json({ ok: true, workspace_id: gate.ws, ...drift });
  } catch (err) { return errorEnvelope(ctx, err); }
});

// GET /api/v1/graph/lineage?workspace_id=...&node=...&cause_only=true
graphRoute.get('/graph/lineage', async (ctx) => {
  try {
    const dal = ctx.get('dal');
    const gate = await gateOperatorWorkspace(ctx.get('auth'), ctx.env, dal, ctx.req.query('workspace_id'));
    if (!gate.ok) { ctx.status(gate.status); return ctx.json({ error: gate.error }); }
    const node = ctx.req.query('node') || undefined;
    const causeOnly = ctx.req.query('cause_only') === 'true';
    const edges = await dal.getArtefactLineage(gate.ws, { nodeId: node, causeOnly });
    return ctx.json({ ok: true, workspace_id: gate.ws, anchor: node ?? null, cause_only: causeOnly, edges });
  } catch (err) { return errorEnvelope(ctx, err); }
});

// GET /api/v1/graph/digest?workspace_id=...
graphRoute.get('/graph/digest', async (ctx) => {
  try {
    const dal = ctx.get('dal');
    const gate = await gateOperatorWorkspace(ctx.get('auth'), ctx.env, dal, ctx.req.query('workspace_id'));
    if (!gate.ok) { ctx.status(gate.status); return ctx.json({ error: gate.error }); }
    const facts = await dal.assembleDataGraphFacts(gate.ws, { includeDocuments: envFlagTrue((ctx.env as { GRAPH_DOCUMENT_NODES_ENABLED?: string }).GRAPH_DOCUMENT_NODES_ENABLED) });
    const now = new Date().toISOString();
    const { nodes, edges, snapshot } = buildDataGraph(gate.ws, facts);
    const digest = tenantSafeGraphDigest(gate.ws, nodes, edges, snapshot.graph_hash, now);
    return ctx.json({ ok: true, ...digest });
  } catch (err) { return errorEnvelope(ctx, err); }
});
