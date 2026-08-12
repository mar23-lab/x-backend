// Xlooop Platform Workloads — Outputs
// Owner: ANALYTICS-101

output "workloads_resource_group_name" {
  value       = azurerm_resource_group.workloads.name
  description = "Workloads resource group name"
}

output "container_app_environment_id" {
  value       = var.enable_container_apps ? azurerm_container_app_environment.main[0].id : null
  description = "Container Apps environment ID (null if disabled)"
}

output "container_app_environment_fqdn" {
  value       = var.enable_container_apps ? azurerm_container_app_environment.main[0].default_domain : null
  description = "Container Apps environment default domain"
}

output "postgres_fqdn" {
  value       = var.enable_postgres ? azurerm_postgresql_flexible_server.main[0].fqdn : null
  description = "Postgres server FQDN (null if disabled)"
}

output "storage_account_name" {
  value       = var.enable_storage ? azurerm_storage_account.main[0].name : null
  description = "Storage account name (null if disabled)"
}

output "storage_account_primary_connection_string" {
  value       = var.enable_storage ? azurerm_storage_account.main[0].primary_connection_string : null
  description = "Storage account connection string"
  sensitive   = true
}
