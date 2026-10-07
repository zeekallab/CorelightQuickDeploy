// AWS auth + discovery — the peer of azureauth.js. v1 uses the standard AWS credential chain:
// the operator pastes temporary STS creds (access key + secret + session token) OR leaves them
// blank to fall through to an ambient ~/.aws profile / environment. We validate the creds via
// STS GetCallerIdentity and discover regions + instance types via EC2 for the UI. Terraform
// itself reads the AWS_* env we set (see writeCredsEnv) — the SDK is only for validate/discovery.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { EC2Client, DescribeRegionsCommand, DescribeInstanceTypeOfferingsCommand, DescribeInstanceTypesCommand } from "@aws-sdk/client-ec2";

const DEFAULT_REGION = "us-east-1";

// Normalize the creds object. Empty/blank fields → undefined so the SDK falls back to its
// default credential chain (~/.aws, env vars). Returns undefined when nothing was supplied.
function normalizeCreds(creds) {
  const accessKeyId = (creds?.accessKeyId || "").trim();
  const secretAccessKey = (creds?.secretAccessKey || "").trim();
  const sessionToken = (creds?.sessionToken || "").trim();
  if (!accessKeyId || !secretAccessKey) return undefined; // rely on ambient chain
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
}

function clientConfig(creds, region) {
  const credentials = normalizeCreds(creds);
  return { region: region || DEFAULT_REGION, ...(credentials ? { credentials } : {}) };
}

// Validate creds by asking who we are. Throws a friendly error on failure.
export async function validateCreds({ creds, region } = {}) {
  const sts = new STSClient(clientConfig(creds, region));
  try {
    const out = await sts.send(new GetCallerIdentityCommand({}));
    return { account: out.Account, arn: out.Arn, userId: out.UserId };
  } catch (e) {
    const msg = String(e?.message || e);
    if (/security token.*expired|ExpiredToken/i.test(msg)) {
      throw new Error("AWS credentials have expired. Refresh your temporary STS credentials (e.g. re-run `aws sso login`) and paste the new ones.");
    }
    if (/could not load credentials|CredentialsProviderError/i.test(msg)) {
      throw new Error("No AWS credentials found. Paste temporary STS credentials, or configure an ~/.aws profile / environment.");
    }
    throw new Error(`AWS credential validation failed: ${msg}`);
  }
}

// List enabled regions for this account (for the region picker).
export async function listRegions(creds) {
  const ec2 = new EC2Client(clientConfig(creds, DEFAULT_REGION));
  const out = await ec2.send(new DescribeRegionsCommand({ AllRegions: false }));
  return (out.Regions || [])
    .map((r) => ({ name: r.RegionName }))
    .filter((r) => r.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// List x86_64 instance types actually OFFERED in a region, restricted to the families that make
// sense for a sensor (compute/general-purpose, non-burstable), with vCPU/memory for the label.
const SENSOR_FAMILIES = /^(c|m)\d+i?\./; // c5/c6i/c7i/c8i, m5/m6i/m7i… (excludes t* burstable)

export async function listInstanceTypes({ creds, region } = {}) {
  if (!region) return [];
  const ec2 = new EC2Client(clientConfig(creds, region));

  // 1. Which types are offered in this region at all?
  const offered = new Set();
  let token;
  do {
    const out = await ec2.send(new DescribeInstanceTypeOfferingsCommand({
      LocationType: "region",
      MaxResults: 100,
      NextToken: token,
    }));
    for (const o of out.InstanceTypeOfferings || []) {
      if (SENSOR_FAMILIES.test(o.InstanceType)) offered.add(o.InstanceType);
    }
    token = out.NextToken;
  } while (token);

  const names = [...offered];
  if (names.length === 0) return [];

  // 2. Fetch vCPU/memory + arch for those types (batched — DescribeInstanceTypes caps at 100).
  const results = [];
  for (let i = 0; i < names.length; i += 100) {
    const batch = names.slice(i, i + 100);
    const out = await ec2.send(new DescribeInstanceTypesCommand({ InstanceTypes: batch }));
    for (const t of out.InstanceTypes || []) {
      const arch = t.ProcessorInfo?.SupportedArchitectures || [];
      if (!arch.includes("x86_64")) continue; // sensor requires x86_64 (no Graviton/ARM)
      const vCPUs = t.VCpuInfo?.DefaultVCpus;
      const memoryGB = t.MemoryInfo?.SizeInMiB ? t.MemoryInfo.SizeInMiB / 1024 : undefined;
      if (!vCPUs || vCPUs < 4) continue; // smallest supported sensor tier is 4 vCPU
      results.push({ name: t.InstanceType, vCPUs, memoryGB });
    }
  }
  // Sort by vCPU then memory so the smallest viable size sorts first (UI default).
  results.sort((a, b) => (a.vCPUs - b.vCPUs) || ((a.memoryGB || 0) - (b.memoryGB || 0)));
  return results;
}

// Write the per-run AWS creds file Terraform reads, and return { env } to merge into every
// terraform spawn. The file lands in the gitignored run workspace; it is NEVER logged. When no
// explicit creds were pasted, only AWS_REGION is set and Terraform uses the ambient chain
// (which flows because runTerraform spreads ...process.env).
export function writeCredsEnv(run, creds, region) {
  const norm = normalizeCreds(creds);
  const env = { AWS_REGION: region || DEFAULT_REGION, AWS_DEFAULT_REGION: region || DEFAULT_REGION };
  if (norm) {
    env.AWS_ACCESS_KEY_ID = norm.accessKeyId;
    env.AWS_SECRET_ACCESS_KEY = norm.secretAccessKey;
    if (norm.sessionToken) env.AWS_SESSION_TOKEN = norm.sessionToken;
    const lines = [
      `AWS_ACCESS_KEY_ID=${norm.accessKeyId}`,
      `AWS_SECRET_ACCESS_KEY=${norm.secretAccessKey}`,
      ...(norm.sessionToken ? [`AWS_SESSION_TOKEN=${norm.sessionToken}`] : []),
      `AWS_REGION=${env.AWS_REGION}`,
      `AWS_DEFAULT_REGION=${env.AWS_REGION}`,
    ];
    writeFileSync(join(run.dir, "aws-creds.env"), lines.join("\n") + "\n", { mode: 0o600 });
  }
  return { env };
}
