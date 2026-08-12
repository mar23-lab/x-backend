// Xlooop Platform Workloads — Main Configuration
// Owner: ANALYTICS-101
// Xlooop Alignment: Product hosting preparation; Container Apps = future Xlooop runtime

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
  features {}

  subscription_id = var.subscription_id
  tenant_id       = var.tenant_id
}

// Workloads Resource Group
resource "azurerm_resource_group" "workloads" {
  name     = "rg-${var.project_name}-${var.environment}-workloads"
  location = var.location
  tags     = var.default_tags
}

// Container Apps Environment — future Xlooop product runtime
resource "azurerm_container_app_environment" "main" {
  count               = var.enable_container_apps ? 1 : 0
  name                = "cae-${var.project_name}-${var.environment}"
  location            = azurerm_resource_group.workloads.location
  resource_group_name = azurerm_resource_group.workloads.name

  log_analytics_workspace_id = var.log_analytics_workspace_id

  tags = var.default_tags
}

// Postgres Flexible Server — application database
resource "azurerm_postgresql_flexible_server" "main" {
  count               = var.enable_postgres ? 1 : 0
  name                = "psql-${var.project_name}-${var.environment}"
  location            = azurerm_resource_group.workloads.location
  resource_group_name = azurerm_resource_group.workloads.name

  sku_name   = var.postgres_sku
  version    = "16"
  storage_mb = var.postgres_storage_mb

  administrator_login    = var.postgres_admin_login
  administrator_password = var.postgres_admin_password

  zone = "1"

  tags = var.default_tags

  lifecycle {
    ignore_changes = [administrator_password]
  }
}

// Storage Account — for data, backups, and blob storage
resource "azurerm_storage_account" "main" {
  count                    = var.enable_storage ? 1 : 0
  name                     = "st${var.project_name}${var.environment}"
  location                 = azurerm_resource_group.workloads.location
  resource_group_name      = azurerm_resource_group.workloads.name
  account_tier             = "Standard"
  account_replication_type = "LRS"
  min_tls_version          = "TLS1_2"

  tags = var.default_tags
}
