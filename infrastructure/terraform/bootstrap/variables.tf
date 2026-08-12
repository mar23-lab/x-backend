// Xlooop Platform Bootstrap — Variables
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
  description = "Tags applied to all resources (non-negotiable: app, env, owner, cost_center)"

  validation {
    condition = alltrue([
      contains(keys(var.default_tags), "app"),
      contains(keys(var.default_tags), "env"),
      contains(keys(var.default_tags), "owner"),
      contains(keys(var.default_tags), "cost_center"),
    ])
    error_message = "Tags must include: app, env, owner, cost_center."
  }
}

variable "vnet_address_space" {
  type        = list(string)
  default     = ["10.0.0.0/16"]
  description = "Address space for the virtual network"
}

variable "subnet_names" {
  type        = list(string)
  default     = ["snet-apps", "snet-data"]
  description = "Names for subnets"
}

variable "subnet_prefixes" {
  type        = list(string)
  default     = ["10.0.1.0/24", "10.0.2.0/24"]
  description = "CIDR prefixes for subnets (must match subnet_names count)"
}

variable "enable_key_vault" {
  type        = bool
  default     = true
  description = "Whether to create a Key Vault"
}

variable "enable_managed_identity" {
  type        = bool
  default     = true
  description = "Whether to create a User Assigned Managed Identity"
}

variable "monthly_budget_amount" {
  type        = number
  default     = 50
  description = "Monthly budget amount in USD"
}

variable "budget_alert_emails" {
  type        = list(string)
  default     = []
  description = "Email addresses for budget alerts"
}

// Phase 4: Entra group object IDs for RBAC (create groups per x-biz analytics-governance-platform/operations/PHASE4_ENTRA_RBAC_SPEC.md)
variable "entra_admin_group_id" {
  type        = string
  default     = ""
  description = "Entra ID object ID for grp-xlooop-admin (optional; set to enable RBAC)"
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

variable "entra_consumers_group_id" {
  type        = string
  default     = ""
  description = "Entra ID object ID for grp-xlooop-consumers"
}
