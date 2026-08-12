// Xlooop Platform Bootstrap — Outputs
// Owner: ANALYTICS-101

output "resource_group_name" {
  value       = azurerm_resource_group.bootstrap.name
  description = "Bootstrap resource group name"
}

output "resource_group_id" {
  value       = azurerm_resource_group.bootstrap.id
  description = "Bootstrap resource group ID"
}

output "vnet_name" {
  value       = azurerm_virtual_network.main.name
  description = "Virtual network name"
}

output "vnet_id" {
  value       = azurerm_virtual_network.main.id
  description = "Virtual network ID"
}

output "subnet_ids" {
  value       = azurerm_subnet.subnets[*].id
  description = "List of subnet IDs"
}

output "log_analytics_workspace_id" {
  value       = azurerm_log_analytics_workspace.main.id
  description = "Log Analytics workspace ID (Event Ledger store)"
}

output "log_analytics_workspace_name" {
  value       = azurerm_log_analytics_workspace.main.name
  description = "Log Analytics workspace name"
}

output "application_insights_connection_string" {
  value       = azurerm_application_insights.main.connection_string
  description = "Application Insights connection string"
  sensitive   = true
}

output "application_insights_instrumentation_key" {
  value       = azurerm_application_insights.main.instrumentation_key
  description = "Application Insights instrumentation key"
  sensitive   = true
}

output "key_vault_id" {
  value       = var.enable_key_vault ? azurerm_key_vault.main[0].id : null
  description = "Key Vault ID (null if disabled)"
}

output "key_vault_uri" {
  value       = var.enable_key_vault ? azurerm_key_vault.main[0].vault_uri : null
  description = "Key Vault URI (null if disabled)"
}

output "managed_identity_id" {
  value       = var.enable_managed_identity ? azurerm_user_assigned_identity.main[0].id : null
  description = "Managed Identity ID (null if disabled)"
}

output "managed_identity_client_id" {
  value       = var.enable_managed_identity ? azurerm_user_assigned_identity.main[0].client_id : null
  description = "Managed Identity Client ID (null if disabled)"
}

output "managed_identity_principal_id" {
  value       = var.enable_managed_identity ? azurerm_user_assigned_identity.main[0].principal_id : null
  description = "Managed Identity Principal ID (null if disabled)"
}
