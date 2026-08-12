// Phase 4 RBAC — Entra groups on Bootstrap RG and Key Vault
// Owner: ANALYTICS-101
// Ref: x-biz analytics-governance-platform/security/IDENTITY_MODEL.md, RBAC_MATRIX.md, operations/PHASE4_ENTRA_RBAC_SPEC.md

// Bootstrap RG: Admin Owner, Engineers Contributor
resource "azurerm_role_assignment" "bootstrap_admin_owner" {
  count                = var.entra_admin_group_id != "" ? 1 : 0
  scope                = azurerm_resource_group.bootstrap.id
  role_definition_name  = "Owner"
  principal_id         = var.entra_admin_group_id
}

resource "azurerm_role_assignment" "bootstrap_engineers_contributor" {
  count                = var.entra_engineers_group_id != "" ? 1 : 0
  scope                = azurerm_resource_group.bootstrap.id
  role_definition_name  = "Contributor"
  principal_id         = var.entra_engineers_group_id
}

// Subscription: Admin and Engineers Reader (standing)
resource "azurerm_role_assignment" "sub_admin_reader" {
  count                = var.entra_admin_group_id != "" ? 1 : 0
  scope                = "/subscriptions/${var.subscription_id}"
  role_definition_name  = "Reader"
  principal_id         = var.entra_admin_group_id
}

resource "azurerm_role_assignment" "sub_engineers_reader" {
  count                = var.entra_engineers_group_id != "" ? 1 : 0
  scope                = "/subscriptions/${var.subscription_id}"
  role_definition_name  = "Reader"
  principal_id         = var.entra_engineers_group_id
}

// Key Vault: Admin KV Administrator, Engineers Secrets User
resource "azurerm_role_assignment" "kv_admin" {
  count                = var.enable_key_vault && var.entra_admin_group_id != "" ? 1 : 0
  scope                = azurerm_key_vault.main[0].id
  role_definition_name = "Key Vault Administrator"
  principal_id         = var.entra_admin_group_id
}

resource "azurerm_role_assignment" "kv_engineers_secrets_user" {
  count                = var.enable_key_vault && var.entra_engineers_group_id != "" ? 1 : 0
  scope                = azurerm_key_vault.main[0].id
  role_definition_name  = "Key Vault Secrets User"
  principal_id         = var.entra_engineers_group_id
}
