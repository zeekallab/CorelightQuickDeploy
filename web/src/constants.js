// Dropdown option lists. Each starts with a SINGLE option by design (per product decision);
// adding more later = append entries here. `mlWarn` flags sizes that can't run ML/Anomaly.
// Target clouds. Both Azure and AWS are live (Fleet + sensor bring-up wired for each).
export const CLOUD_PROVIDERS = [
  { value: "azure", label: "Microsoft Azure", enabled: true },
  { value: "aws", label: "Amazon Web Services", enabled: true },
];

export const REGIONS = [
  { value: "centralus", label: "Central US" },
  // more regions added here later
];

export const VM_SIZES = [
  { value: "Standard_D4s_v3", label: "Standard_D4s_v3 (4 vCPU / 16 GiB)", mlWarn: true },
  { value: "Standard_D8s_v4", label: "Standard_D8s_v4 (8 vCPU / 32 GiB)", mlWarn: false },
  { value: "Standard_D8s_v7", label: "Standard_D8s_v7 (8 vCPU / 32 GiB)", mlWarn: false },
  { value: "Standard_D16s_v7", label: "Standard_D16s_v7 (16 vCPU / 64 GiB)", mlWarn: false },
];

export const DEFAULTS = {
  cloud: "azure",
  // Base for readable resource names (→ corelight-fleet, corelight-sensor-1); customer-editable.
  namePrefix: "corelight",
  region: "centralus",
  // Pre-load fallback only — once Azure sizes are polled, both default to the smallest available.
  fleetVmSize: "Standard_D4s_v3",
  sensorVmSize: "Standard_D4s_v3",
  sensorCount: 1,
  deployFleet: true,
  communityString: "corelight",
  vnetCidr: "10.50.0.0/16",
};

// --- AWS ---
// Fallback region list shown before (or if) the live DescribeRegions call returns.
export const AWS_REGIONS = [
  { value: "us-east-1", label: "US East (N. Virginia) — us-east-1" },
  { value: "us-east-2", label: "US East (Ohio) — us-east-2" },
  { value: "us-west-2", label: "US West (Oregon) — us-west-2" },
  { value: "eu-west-1", label: "EU (Ireland) — eu-west-1" },
  { value: "eu-central-1", label: "EU (Frankfurt) — eu-central-1" },
];

// Fallback instance types (x86_64, ≥4 vCPU) shown before the live per-region lookup returns.
export const AWS_INSTANCE_TYPES = [
  { value: "m5.xlarge", label: "m5.xlarge (4 vCPU / 16 GiB)" },
  { value: "m5.2xlarge", label: "m5.2xlarge (8 vCPU / 32 GiB)" },
  { value: "c5.2xlarge", label: "c5.2xlarge (8 vCPU / 16 GiB)" },
  { value: "m5.4xlarge", label: "m5.4xlarge (16 vCPU / 64 GiB)" },
];

export const AWS_DEFAULTS = {
  region: "us-east-1",
  ssoRegion: "us-east-1", // where the IAM Identity Center instance is homed
  fleetVmSize: "m5.xlarge",
  sensorVmSize: "m5.xlarge",
  vpcCidr: "10.50.0.0/16",
};
