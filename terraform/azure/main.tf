# --- Resource group: create a dedicated new one, OR reuse an existing one. ---
# Creating a new RG needs subscription-level write; reusing one only needs Contributor on
# that RG. Exactly one of these is active based on var.use_existing_rg.
resource "azurerm_resource_group" "rg" {
  count    = var.use_existing_rg ? 0 : 1
  name     = "${var.name_prefix}-rg"
  location = var.location
  tags     = var.tags
}

data "azurerm_resource_group" "existing" {
  count = var.use_existing_rg ? 1 : 0
  name  = var.existing_rg_name
}

locals {
  # Sensors need two NICs: eth0 = management, eth1 = monitoring.
  fleet_count = var.deploy_fleet ? 1 : 0

  # Resolve the RG name/location from whichever branch is active. When reusing an existing
  # RG, place resources in that RG's own region (ignore var.location) to avoid a mismatch.
  rg_name     = var.use_existing_rg ? data.azurerm_resource_group.existing[0].name : azurerm_resource_group.rg[0].name
  rg_location = var.use_existing_rg ? data.azurerm_resource_group.existing[0].location : azurerm_resource_group.rg[0].location
}

# --- Network: one VNet, one subnet, one NSG on the subnet ---
resource "azurerm_virtual_network" "vnet" {
  name                = "${var.name_prefix}-vnet"
  location            = local.rg_location
  resource_group_name = local.rg_name
  address_space       = [var.vnet_cidr]
  tags                = var.tags
}

resource "azurerm_subnet" "subnet" {
  name                 = "${var.name_prefix}-subnet"
  resource_group_name  = local.rg_name
  virtual_network_name = azurerm_virtual_network.vnet.name
  address_prefixes     = [var.subnet_cidr]
}

resource "azurerm_network_security_group" "nsg" {
  name                = "${var.name_prefix}-nsg"
  location            = local.rg_location
  resource_group_name = local.rg_name
  tags                = var.tags

  # SSH for the deployer to install/configure Fleet + sensors.
  security_rule {
    name                       = "allow-ssh"
    priority                   = 1000
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefixes    = var.admin_source_cidrs
    destination_address_prefix = "*"
  }

  # Fleet Manager UI/API (only meaningful when a Fleet VM exists).
  security_rule {
    name                       = "allow-fleet-ui"
    priority                   = 1010
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefixes    = var.admin_source_cidrs
    destination_address_prefix = "*"
  }
  # Sensor<->Fleet tethering on 1443 rides the default AllowVnetInBound rule
  # (intra-VNet traffic), so no explicit rule is needed.
}

resource "azurerm_subnet_network_security_group_association" "assoc" {
  subnet_id                 = azurerm_subnet.subnet.id
  network_security_group_id = azurerm_network_security_group.nsg.id
}

# ============================ Fleet Manager VM ============================
resource "azurerm_public_ip" "fleet" {
  count               = local.fleet_count
  name                = "${var.name_prefix}-fleet-pip"
  location            = local.rg_location
  resource_group_name = local.rg_name
  allocation_method   = "Static"
  sku                 = "Standard"
  domain_name_label   = var.fleet_dns_label != "" ? var.fleet_dns_label : null
  tags                = var.tags
}

resource "azurerm_network_interface" "fleet" {
  count               = local.fleet_count
  name                = "${var.name_prefix}-fleet-nic"
  location            = local.rg_location
  resource_group_name = local.rg_name
  tags                = var.tags

  ip_configuration {
    name                          = "ipconfig1"
    subnet_id                     = azurerm_subnet.subnet.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.fleet[0].id
  }
}

resource "azurerm_linux_virtual_machine" "fleet" {
  count                 = local.fleet_count
  name                  = "${var.name_prefix}-fleet"
  computer_name         = "${var.name_prefix}-fleet"
  location              = local.rg_location
  resource_group_name   = local.rg_name
  size                  = var.fleet_vm_size
  admin_username        = var.admin_username
  network_interface_ids = [azurerm_network_interface.fleet[0].id]
  tags                  = var.tags

  admin_ssh_key {
    username   = var.admin_username
    public_key = var.ssh_public_key
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
    disk_size_gb         = var.os_disk_size_gb
  }

  source_image_reference {
    publisher = var.image_publisher
    offer     = var.image_offer
    sku       = var.image_sku
    version   = var.image_version
  }
}

# ============================ Sensor VMs ============================
resource "azurerm_public_ip" "sensor" {
  count               = var.sensor_count
  name                = "${var.name_prefix}-sensor-${count.index + 1}-pip"
  location            = local.rg_location
  resource_group_name = local.rg_name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = var.tags
}

# eth0 = management (public IP for the deployer to SSH in)
resource "azurerm_network_interface" "sensor_mgmt" {
  count               = var.sensor_count
  name                = "${var.name_prefix}-sensor-${count.index + 1}-mgmt-nic"
  location            = local.rg_location
  resource_group_name = local.rg_name
  tags                = var.tags

  ip_configuration {
    name                          = "ipconfig1"
    subnet_id                     = azurerm_subnet.subnet.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.sensor[count.index].id
  }
}

# eth1 = monitoring (no public IP; receives mirrored traffic)
resource "azurerm_network_interface" "sensor_monitor" {
  count               = var.sensor_count
  name                = "${var.name_prefix}-sensor-${count.index + 1}-monitor-nic"
  location            = local.rg_location
  resource_group_name = local.rg_name
  tags                = var.tags

  ip_configuration {
    name                          = "ipconfig1"
    subnet_id                     = azurerm_subnet.subnet.id
    private_ip_address_allocation = "Dynamic"
  }
}

resource "azurerm_linux_virtual_machine" "sensor" {
  count               = var.sensor_count
  name                = "${var.name_prefix}-sensor-${count.index + 1}"
  computer_name       = "${var.name_prefix}-sensor-${count.index + 1}"
  location            = local.rg_location
  resource_group_name = local.rg_name
  size                = var.sensor_vm_size
  admin_username      = var.admin_username
  tags                = var.tags

  # Order matters: first NIC is primary/eth0 (management).
  network_interface_ids = [
    azurerm_network_interface.sensor_mgmt[count.index].id,
    azurerm_network_interface.sensor_monitor[count.index].id,
  ]

  admin_ssh_key {
    username   = var.admin_username
    public_key = var.ssh_public_key
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
    disk_size_gb         = var.os_disk_size_gb
  }

  source_image_reference {
    publisher = var.image_publisher
    offer     = var.image_offer
    sku       = var.image_sku
    version   = var.image_version
  }
}
