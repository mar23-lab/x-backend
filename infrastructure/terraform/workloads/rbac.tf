// Phase 4 RBAC — Entra groups on Workloads RG
// Owner: ANALYTICS-101
// Ref: x-biz analytics-governance-platform/security/RBAC_MATRIX.md, operations/PHASE4_ENTRA_RBAC_SPEC.md

resource "azurerm_role_assignment" "workloads_admin_owner" {
  count                = var.entra_admin_group_id != "" ? 1 : 0
  scope                = azurerm_resource_group.workloads.id
  role_definition_name = "Owner"
  principal_id         = var.entra_admin_group_id
}

resource "azurerm_role_assignment" "workloads_engineers_contributor" {
  count                = var.entra_engineers_group_id != "" ? 1 : 0
  scope                = azurerm_resource_group.workloads.id
  role_definition_name = "Contributor"
  principal_id         = var.entra_engineers_group_id
}

resource "azurerm_role_assignment" "workloads_analysts_reader" {
  count                = var.entra_analysts_group_id != "" ? 1 : 0
  scope                = azurerm_resource_group.workloads.id
  role_definition_name = "Reader"
  principal_id         = var.entra_analysts_group_id
}
