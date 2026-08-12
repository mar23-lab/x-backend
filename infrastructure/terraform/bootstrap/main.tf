// Xlooop Platform Bootstrap — Main Configuration
// Owner: ANALYTICS-101
// Xlooop Alignment: Policy Engine (F-016) — all infrastructure governed through code

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.100"
    }
  }
}

provider "azurerm" {
  features {
    key_vault {
      purge_soft_delete_on_destroy = false
    }
  }

  subscription_id = var.subscription_id
  tenant_id       = var.tenant_id
}

// Resource Group — maps to Xlooop Project scope
resource "azurerm_resource_group" "bootstrap" {
  name     = "rg-${var.project_name}-${var.environment}-bootstrap"
  location = var.location
  tags     = var.default_tags
}

// Virtual Network — maps to Xlooop tenant isolation (F-014)
resource "azurerm_virtual_network" "main" {
  name                = "vnet-${var.project_name}-${var.environment}"
  location            = azurerm_resource_group.bootstrap.location
  resource_group_name = azurerm_resource_group.bootstrap.name
  address_space       = var.vnet_address_space
  tags                = var.default_tags
}

// Subnets
resource "azurerm_subnet" "subnets" {
  count                = length(var.subnet_names)
  name                 = var.subnet_names[count.index]
  resource_group_name  = azurerm_resource_group.bootstrap.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = [var.subnet_prefixes[count.index]]
}

// Log Analytics Workspace — maps to Event Ledger (F-006)
resource "azurerm_log_analytics_workspace" "main" {
  name                = "law-${var.project_name}-${var.environment}"
  location            = azurerm_resource_group.bootstrap.location
  resource_group_name = azurerm_resource_group.bootstrap.name
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = var.default_tags
}

// Application Insights — maps to Event Ledger (F-006) operational telemetry
resource "azurerm_application_insights" "main" {
  name                = "appi-${var.project_name}-${var.environment}"
  location            = azurerm_resource_group.bootstrap.location
  resource_group_name = azurerm_resource_group.bootstrap.name
  workspace_id        = azurerm_log_analytics_workspace.main.id
  application_type    = "web"
  tags                = var.default_tags
}

// Key Vault — governed secret storage
resource "azurerm_key_vault" "main" {
  count               = var.enable_key_vault ? 1 : 0
  name                = "kv-${var.project_name}-${var.environment}"
  location            = azurerm_resource_group.bootstrap.location
  resource_group_name = azurerm_resource_group.bootstrap.name
  tenant_id           = var.tenant_id
  sku_name            = "standard"

  soft_delete_retention_days = 7
  purge_protection_enabled   = false

  enable_rbac_authorization = true

  tags = var.default_tags
}

// Managed Identity — maps to zero-trust identity (Policy Engine F-016)
resource "azurerm_user_assigned_identity" "main" {
  count               = var.enable_managed_identity ? 1 : 0
  name                = "id-${var.project_name}-${var.environment}"
  location            = azurerm_resource_group.bootstrap.location
  resource_group_name = azurerm_resource_group.bootstrap.name
  tags                = var.default_tags
}

// Budget — maps to Intent Object (F-015) financial governance
resource "azurerm_consumption_budget_resource_group" "main" {
  name              = "budget-${var.project_name}-${var.environment}"
  resource_group_id = azurerm_resource_group.bootstrap.id

  amount     = var.monthly_budget_amount
  time_grain = "Monthly"

  time_period {
    start_date = formatdate("YYYY-MM-01'T'00:00:00Z", timestamp())
  }

  notification {
    enabled   = true
    threshold = 80.0
    operator  = "GreaterThanOrEqualTo"

    contact_emails = var.budget_alert_emails
  }

  notification {
    enabled        = true
    threshold      = 100.0
    operator       = "GreaterThanOrEqualTo"
    threshold_type = "Forecasted"

    contact_emails = var.budget_alert_emails
  }

  lifecycle {
    ignore_changes = [time_period]
  }
}
