output "resource_group_name" {
  description = "The resource group holding this deployment."
  value       = local.rg_name
}

output "fleet_deployed" {
  value = var.deploy_fleet
}

output "vnet_id" {
  description = "Resource ID of the VNet this run created (used to peer to an existing Fleet's VNet)."
  value       = azurerm_virtual_network.vnet.id
}

output "vnet_cidr" {
  description = "Address space of the VNet this run created."
  value       = var.vnet_cidr
}

output "fleet_public_ip" {
  description = "Public IP of the Fleet VM (empty when no Fleet was deployed)."
  value       = var.deploy_fleet ? azurerm_public_ip.fleet[0].ip_address : ""
}

output "fleet_fqdn" {
  description = "DNS name of the Fleet VM, when a DNS label was set."
  value       = var.deploy_fleet ? azurerm_public_ip.fleet[0].fqdn : ""
}

output "fleet_private_ip" {
  description = "Private IP of the Fleet VM; sensors tether to this on :1443."
  value       = var.deploy_fleet ? azurerm_network_interface.fleet[0].private_ip_address : ""
}

output "fleet_ui_url" {
  description = "Fleet Manager UI URL."
  value       = var.deploy_fleet ? "https://${azurerm_public_ip.fleet[0].fqdn != "" ? azurerm_public_ip.fleet[0].fqdn : azurerm_public_ip.fleet[0].ip_address}/" : ""
}

output "sensors" {
  description = "Per-sensor connection details."
  value = [
    for i in range(var.sensor_count) : {
      name               = azurerm_linux_virtual_machine.sensor[i].name
      public_ip          = azurerm_public_ip.sensor[i].ip_address
      mgmt_private_ip    = azurerm_network_interface.sensor_mgmt[i].private_ip_address
      monitor_private_ip = azurerm_network_interface.sensor_monitor[i].private_ip_address
    }
  ]
}

output "admin_username" {
  value = var.admin_username
}
