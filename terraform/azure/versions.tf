terraform {
  required_version = ">= 1.5"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }
}

provider "azurerm" {
  features {}
  # The operator authenticates with `az login`; the provider uses that CLI session.
  # SEs are typically not subscription owners, so don't try to auto-register providers.
  resource_provider_registrations = "none"
  subscription_id                 = var.subscription_id
}
