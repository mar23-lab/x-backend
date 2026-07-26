export const GRAPH_CENSUS_SQL = `
SELECT
  (SELECT count(*)::int FROM graph_nodes) AS persisted_graph_nodes,
  (SELECT count(*)::int FROM graph_edges) AS persisted_graph_edges,
  (SELECT count(*)::int FROM operation_events) AS operation_events,
  (SELECT count(*)::int FROM operations_unified) AS operations_unified,
  (SELECT count(*)::int FROM task_packets) AS task_packets,
  (SELECT count(*)::int FROM projects) AS projects,
  (SELECT count(*)::int FROM workspaces) AS workspaces,
  (SELECT count(*)::int FROM synthetic_domains) AS synthetic_domains,
  (SELECT count(*)::int FROM synthetic_domain_membership) AS synthetic_domain_membership,
  (SELECT count(*)::int FROM intents) AS intents,
  (SELECT count(*)::int FROM project_source_bindings) AS project_source_bindings,
  (SELECT count(*)::int FROM audit_logs WHERE causation_id IS NOT NULL) AS audit_logs_with_causation_id,
  (
    SELECT count(*)::int
    FROM graph_edges e
    WHERE (
      NOT EXISTS (
        SELECT 1 FROM graph_nodes own
        WHERE own.workspace_id = e.workspace_id AND own.id = e.edge_from
      )
      AND EXISTS (
        SELECT 1 FROM graph_nodes foreign_node
        WHERE foreign_node.workspace_id <> e.workspace_id AND foreign_node.id = e.edge_from
      )
    ) OR (
      NOT EXISTS (
        SELECT 1 FROM graph_nodes own
        WHERE own.workspace_id = e.workspace_id AND own.id = e.edge_to
      )
      AND EXISTS (
        SELECT 1 FROM graph_nodes foreign_node
        WHERE foreign_node.workspace_id <> e.workspace_id AND foreign_node.id = e.edge_to
      )
    )
  ) AS cross_tenant_edge_refs,
  (
    SELECT count(*)::int
    FROM graph_edges e
    WHERE NOT EXISTS (
      SELECT 1 FROM graph_nodes own
      WHERE own.workspace_id = e.workspace_id AND own.id = e.edge_from
    ) OR NOT EXISTS (
      SELECT 1 FROM graph_nodes own
      WHERE own.workspace_id = e.workspace_id AND own.id = e.edge_to
    )
  ) AS dangling_graph_edge_refs,
  (SELECT max(updated_at) FROM graph_nodes) AS latest_graph_node_at,
  (SELECT count(*)::int FROM model_execution_receipts) AS model_execution_receipts,
  (SELECT count(*)::int FROM skill_invocation_receipts) AS skill_invocation_receipts,
  (SELECT count(*)::int FROM closing_attestations) AS closing_attestations;
`.trim();

export function graphCensusQueryMatchesSchema() {
  return GRAPH_CENSUS_SQL.includes('e.workspace_id') &&
    GRAPH_CENSUS_SQL.includes('e.edge_from') &&
    GRAPH_CENSUS_SQL.includes('e.edge_to') &&
    GRAPH_CENSUS_SQL.includes('max(updated_at)') &&
    !GRAPH_CENSUS_SQL.includes('from_workspace_id') &&
    !GRAPH_CENSUS_SQL.includes('to_workspace_id') &&
    !GRAPH_CENSUS_SQL.includes('max(created_at)');
}
