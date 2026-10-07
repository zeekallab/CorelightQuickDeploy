output "fleet_deployed" {
  value = var.deploy_fleet
}

output "fleet_public_ip" {
  description = "Elastic IP of the Fleet instance (empty when no Fleet was deployed)."
  value       = var.deploy_fleet ? aws_eip.fleet[0].public_ip : ""
}

output "fleet_private_ip" {
  description = "Private IP of the Fleet instance; sensors tether to this on :1443."
  value       = var.deploy_fleet ? aws_network_interface.fleet[0].private_ip : ""
}

output "fleet_ui_url" {
  description = "Fleet Manager UI URL."
  value       = var.deploy_fleet ? "https://${aws_eip.fleet[0].public_ip}/" : ""
}

output "sensors" {
  description = "Per-sensor connection details. public_ip is the management Elastic IP (SSH target)."
  value = [
    for i in range(var.sensor_count) : {
      name               = "${var.name_prefix}-sensor-${i + 1}"
      public_ip          = aws_eip.sensor_mgmt[i].public_ip
      mgmt_private_ip    = aws_network_interface.sensor_mgmt[i].private_ip
      monitor_private_ip = aws_network_interface.sensor_monitor[i].private_ip
    }
  ]
}

output "admin_username" {
  value = var.admin_username
}

output "vpc_id" {
  value = aws_vpc.main.id
}
