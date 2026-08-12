// Xlooop Platform Workloads — Variables
// Owner: ANALYTICS-101

variable "subscription_id" {
  type        = string
  description = "Azure subscription ID"
}

variable "tenant_id" {
  type        = string
  description = "Azure tenant ID"
}

variable "project_name" {
  type        = string
  default     = "xlooop"
  description = "Project name used in resource naming"
}

variable "environment" {
  type        = string
  default     = "dev"
  description = "Environment name (dev, stage, prod)"

  validation {
    condition     = contains(["dev", "stage", "prod"], var.environment)
    error_message = "Environment must be dev, stage, or prod."
  }
}

variable "location" {
  type        = string
  default     = "australiaeast"
  description = "Azure region for all resources"
}

variable "default_tags" {
  type        = map(string)
  description = "Tags applied to all resources"
}

variable "log_analytics_workspace_id" {
  type        = string
  description = "Log Analytics workspace ID from bootstrap module"
}

variable "enable_container_apps" {
  type        = bool
  default     = true
  description = "Whether to create Container Apps environment"
}

variable "enable_postgres" {
  type        = bool
  default     = false
  description = "Whether to create Postgres Flexible Server"
}

variable "postgres_sku" {
  type        = string
  default     = "B_Standard_B1ms"
  description = "Postgres SKU (burstable for dev)"
}

variable "postgres_storage_mb" {
  type        = number
  default     = 32768
  description = "Postgres storage in MB"
}

variable "postgres_admin_login" {
  type        = string
  default     = "xlooopadmin"
  description = "Postgres administrator login"
}

variable "postgres_admin_password" {
  type        = string
  default     = ""
  description = "Postgres administrator password (store in Key Vault)"
  sensitive   = true
}

variable "enable_storage" {
  type        = bool
  default     = true
  description = "Whether to create a Storage Account"
}

// Phase 4: Entra group object IDs for RBAC on workloads RG (see x-biz PHASE4_ENTRA_RBAC_SPEC.md)
variable "entra_admin_group_id" {
  type        = string
  default     = ""
  description = "Entra ID object ID for grp-xlooop-admin"
}

variable "entra_engineers_group_id" {
  type        = string
  default     = ""
  description = "Entra ID object ID for grp-xlooop-engineers"
}

variable "entra_analysts_group_id" {
  type        = string
  default     = ""
  description = "Entra ID object ID for grp-xlooop-analysts"
}
