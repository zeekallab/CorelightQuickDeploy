variable "region" {
  type        = string
  description = "AWS region to deploy into (e.g. us-east-1)."
}

variable "name_prefix" {
  type        = string
  description = "Short prefix for all resource names/tags (e.g. corelight)."
  default     = "corelight"
}

variable "name_suffix" {
  type        = string
  description = "Optional run-id suffix appended only to the EC2 key pair name (which must be unique per account/region)."
  default     = ""
}

variable "ssh_public_key" {
  type        = string
  description = "OpenSSH public key material authorized on every instance (the deployer generates a per-run keypair)."
}

variable "admin_username" {
  type        = string
  description = "Login user on the AlmaLinux AMI (informational; the AMI's cloud user is used for SSH)."
  default     = "ec2-user"
}

variable "admin_source_cidrs" {
  type        = list(string)
  description = "Source CIDRs allowed inbound to SSH (22) and the Fleet UI (443). Defaults to the operator's detected public IP."
  default     = []
}

variable "vpc_cidr" {
  type        = string
  description = "Address space for the new VPC."
  default     = "10.50.0.0/16"
}

# The MANAGEMENT subnet is public (has an IGW route). SSH + Fleet + the sensors' egress for
# dnf installs ride the management ENI, which lives here and carries an Elastic IP.
variable "mgmt_subnet_cidr" {
  type        = string
  description = "CIDR for the public management subnet (SSH, Fleet, sensor egress)."
  default     = "10.50.0.0/24"
}

# The MONITORING subnet is private. The sensor's monitoring ENI (eth0/primary) lives here and
# has no public IP; it only receives mirrored traffic in a future phase.
variable "monitor_subnet_cidr" {
  type        = string
  description = "CIDR for the private monitoring subnet (mirrored traffic; no egress)."
  default     = "10.50.1.0/24"
}

variable "fleet_instance_type" {
  type        = string
  description = "EC2 instance type for the Fleet Manager."
  default     = "m5.xlarge"
}

variable "sensor_instance_type" {
  type        = string
  description = "EC2 instance type for each sensor."
  default     = "m5.xlarge"
}

variable "root_volume_gb" {
  type        = number
  description = "gp3 root volume size (GB). Sensor images + Fleet need headroom over the tiny AMI default."
  default     = 128
}

variable "deploy_fleet" {
  type        = bool
  description = "Whether to create a Fleet Manager instance. If false, the operator supplies an existing Fleet out-of-band."
  default     = true
}

variable "sensor_count" {
  type        = number
  description = "Number of Software Sensor instances to create."
  default     = 1
}

# AlmaLinux 9 x86_64 AMI. Resolved by owner+name filter unless ami_id overrides it.
variable "ami_id" {
  type        = string
  description = "Explicit AMI id override. When empty, the newest AlmaLinux 9 x86_64 AMI is looked up."
  default     = ""
}

variable "almalinux_owner_id" {
  type        = string
  description = "AWS account id that owns the official AlmaLinux AMIs."
  default     = "764336703387" # AlmaLinux OS Foundation
}

variable "tags" {
  type        = map(string)
  description = "Tags applied to every resource."
  default = {
    managed-by = "corelight-quick-deploy"
  }
}
