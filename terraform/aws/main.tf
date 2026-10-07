locals {
  fleet_count = var.deploy_fleet ? 1 : 0
  # First usable address in the management subnet is the AWS subnet router (used as the sensor's
  # default gateway via the management ENI — see the user_data routing fixup).
  mgmt_gateway = cidrhost(var.mgmt_subnet_cidr, 1)
  ami_id       = var.ami_id != "" ? var.ami_id : data.aws_ami.almalinux[0].id
}

# --- AlmaLinux 9 x86_64 AMI (BYO-OS: dnf install corelight-*). ami_id overrides the lookup. ---
data "aws_ami" "almalinux" {
  count       = var.ami_id == "" ? 1 : 0
  most_recent = true
  owners      = [var.almalinux_owner_id]

  filter {
    name   = "name"
    values = ["AlmaLinux OS 9*"]
  }
  filter {
    name   = "architecture"
    values = ["x86_64"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
  filter {
    name   = "root-device-type"
    values = ["ebs"]
  }
}

# ============================ Network ============================
resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(var.tags, { Name = "${var.name_prefix}-vpc" })
}

# Public MANAGEMENT subnet: SSH, Fleet UI/API, and sensor egress (dnf) all ride here.
resource "aws_subnet" "mgmt" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.mgmt_subnet_cidr
  availability_zone = data.aws_availability_zones.available.names[0]
  tags              = merge(var.tags, { Name = "${var.name_prefix}-mgmt-subnet" })
}

# Private MONITORING subnet: the sensor's monitoring ENI (eth0) sits here — no internet route,
# receives mirrored traffic in a future phase.
resource "aws_subnet" "monitor" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.monitor_subnet_cidr
  availability_zone = data.aws_availability_zones.available.names[0]
  tags              = merge(var.tags, { Name = "${var.name_prefix}-monitor-subnet" })
}

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.main.id
  tags   = merge(var.tags, { Name = "${var.name_prefix}-igw" })
}

# Public route table → IGW, associated with the management subnet only. The monitoring subnet
# is left on the VPC main route table (local routes only = no internet).
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }
  tags = merge(var.tags, { Name = "${var.name_prefix}-public-rt" })
}

resource "aws_route_table_association" "mgmt" {
  subnet_id      = aws_subnet.mgmt.id
  route_table_id = aws_route_table.public.id
}

# ============================ Security groups ============================
# Management SG: SSH (+ optional Fleet UI) from the operator, and all intra-VPC traffic so
# sensors reach the Fleet on 1443. Egress open (dnf, package repos).
resource "aws_security_group" "mgmt" {
  name        = "${var.name_prefix}-mgmt-sg"
  description = "Management: SSH, Fleet UI, intra-VPC (sensor to Fleet 1443)"
  vpc_id      = aws_vpc.main.id
  tags        = merge(var.tags, { Name = "${var.name_prefix}-mgmt-sg" })

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = var.admin_source_cidrs
  }

  ingress {
    description = "Fleet Manager UI/API"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.admin_source_cidrs
  }

  # Intra-VPC: sensors tether to the Fleet on 1443 (and any other in-VPC service traffic).
  ingress {
    description = "Intra-VPC"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# Monitoring SG: mirror-traffic ingress (provisioned now, unused until a mirroring phase).
resource "aws_security_group" "monitor" {
  name        = "${var.name_prefix}-monitor-sg"
  description = "Monitoring: mirror traffic (VXLAN/GENEVE/health) from within the VPC"
  vpc_id      = aws_vpc.main.id
  tags        = merge(var.tags, { Name = "${var.name_prefix}-monitor-sg" })

  ingress {
    description = "VXLAN mirror"
    from_port   = 4789
    to_port     = 4789
    protocol    = "udp"
    cidr_blocks = [var.vpc_cidr]
  }
  ingress {
    description = "GENEVE / Gateway Load Balancer"
    from_port   = 6081
    to_port     = 6081
    protocol    = "udp"
    cidr_blocks = [var.vpc_cidr]
  }
  ingress {
    description = "GWLB health check"
    from_port   = 41080
    to_port     = 41080
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# Per-run SSH key (the backend generates the keypair). The key pair name must be unique per
# account/region, so it carries the run-id suffix even though other resource names stay clean.
resource "aws_key_pair" "deploy" {
  key_name   = var.name_suffix != "" ? "${var.name_prefix}-${var.name_suffix}-key" : "${var.name_prefix}-key"
  public_key = var.ssh_public_key
  tags       = var.tags
}

# ============================ Fleet Manager ============================
# Single ENI in the public management subnet + an Elastic IP. Single-NIC, so the default route
# works natively — no user_data routing fixup needed.
resource "aws_network_interface" "fleet" {
  count           = local.fleet_count
  subnet_id       = aws_subnet.mgmt.id
  security_groups = [aws_security_group.mgmt.id]
  tags            = merge(var.tags, { Name = "${var.name_prefix}-fleet-eni" })
}

resource "aws_eip" "fleet" {
  count  = local.fleet_count
  domain = "vpc"
  tags   = merge(var.tags, { Name = "${var.name_prefix}-fleet-eip" })
}

resource "aws_eip_association" "fleet" {
  count                = local.fleet_count
  allocation_id        = aws_eip.fleet[0].id
  network_interface_id = aws_network_interface.fleet[0].id
}

resource "aws_instance" "fleet" {
  count         = local.fleet_count
  ami           = local.ami_id
  instance_type = var.fleet_instance_type
  key_name      = aws_key_pair.deploy.key_name
  tags          = merge(var.tags, { Name = "${var.name_prefix}-fleet" })

  network_interface {
    network_interface_id = aws_network_interface.fleet[0].id
    device_index         = 0
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = var.root_volume_gb
    tags        = merge(var.tags, { Name = "${var.name_prefix}-fleet-root" })
  }
}

# ============================ Sensors ============================
# eth0 = monitoring (primary, private subnet, no public IP, source/dest check off for mirroring).
resource "aws_network_interface" "sensor_monitor" {
  count             = var.sensor_count
  subnet_id         = aws_subnet.monitor.id
  security_groups   = [aws_security_group.monitor.id]
  source_dest_check = false
  tags              = merge(var.tags, { Name = "${var.name_prefix}-sensor-${count.index + 1}-monitor-eni" })
}

# eth1 = management (secondary, public subnet, carries the Elastic IP = SSH target).
resource "aws_network_interface" "sensor_mgmt" {
  count           = var.sensor_count
  subnet_id       = aws_subnet.mgmt.id
  security_groups = [aws_security_group.mgmt.id]
  tags            = merge(var.tags, { Name = "${var.name_prefix}-sensor-${count.index + 1}-mgmt-eni" })
}

resource "aws_eip" "sensor_mgmt" {
  count  = var.sensor_count
  domain = "vpc"
  tags   = merge(var.tags, { Name = "${var.name_prefix}-sensor-${count.index + 1}-eip" })
}

resource "aws_eip_association" "sensor_mgmt" {
  count                = var.sensor_count
  allocation_id        = aws_eip.sensor_mgmt[count.index].id
  network_interface_id = aws_network_interface.sensor_mgmt[count.index].id
}

resource "aws_instance" "sensor" {
  count         = var.sensor_count
  ami           = local.ami_id
  instance_type = var.sensor_instance_type
  key_name      = aws_key_pair.deploy.key_name
  tags          = merge(var.tags, { Name = "${var.name_prefix}-sensor-${count.index + 1}" })

  # Device index sets the ethN order: 0 = monitoring (eth0), 1 = management (eth1).
  network_interface {
    network_interface_id = aws_network_interface.sensor_monitor[count.index].id
    device_index         = 0
  }
  network_interface {
    network_interface_id = aws_network_interface.sensor_mgmt[count.index].id
    device_index         = 1
  }

  # Routing fixup: make the management ENI the default route (internet + symmetric SSH) and keep
  # the monitoring ENI off the default route. Keyed on MAC so it survives the eth0/eth1 rename.
  user_data = templatefile("${path.module}/templates/sensor_user_data.sh.tpl", {
    mgmt_mac    = aws_network_interface.sensor_mgmt[count.index].mac_address
    monitor_mac = aws_network_interface.sensor_monitor[count.index].mac_address
    mgmt_gw     = local.mgmt_gateway
    mgmt_cidr   = var.mgmt_subnet_cidr
  })

  root_block_device {
    volume_type = "gp3"
    volume_size = var.root_volume_gb
    tags        = merge(var.tags, { Name = "${var.name_prefix}-sensor-${count.index + 1}-root" })
  }
}
