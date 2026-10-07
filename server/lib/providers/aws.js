// AWS provider. New VPC + dual-ENI sensors (monitoring=eth0, management=eth1 — the REVERSE of
// Azure, per the Corelight Cloud Sensor guide). BYO-OS: AlmaLinux 9 + dnf install, so the SSH
// bring-up bodies (fleet.js/sensor.js) are reused; only the interface names + SSH username differ.
import { validateCreds, writeCredsEnv } from "../awsauth.js";
import { credsFromSso } from "../awssso.js";
import { moduleDirFor } from "./tfpaths.js";

const RESOURCE_PREFIX = "corelight";

// Pull the creds object off the form regardless of exact field names the UI sent.
function credsFromForm(form) {
  const c = form.awsCreds || {};
  return {
    accessKeyId: c.accessKeyId || form.awsAccessKeyId || "",
    secretAccessKey: c.secretAccessKey || form.awsSecretAccessKey || "",
    sessionToken: c.sessionToken || form.awsSessionToken || "",
  };
}

export default {
  id: "aws",

  moduleDir() {
    return moduleDirFor("aws");
  },

  validateForm(form) {
    if (!form.region) return "An AWS region is required.";
    return null;
  },

  toTfvars(form, publicKey, ctx = {}) {
    const cidrs = (form.adminSourceCidrs && form.adminSourceCidrs.length)
      ? form.adminSourceCidrs
      : (form.publicIp ? [`${form.publicIp}/32`] : []);
    return {
      region: form.region,
      // Readable resource names from the customer-chosen base: corelight-fleet, corelight-sensor-1.
      name_prefix: ctx.namePrefix || RESOURCE_PREFIX,
      // AWS has no resource-group isolation, so the one name that MUST be unique per account/region
      // — the EC2 key pair — carries the run id as a suffix (the rest stay clean/readable).
      name_suffix: ctx.nameSuffix || "",
      // Base managed-by tag + any optional tag the customer added.
      tags: { "managed-by": "corelight-quick-deploy", ...(ctx.extraTags || {}) },
      admin_username: form.adminUsername || "ec2-user",
      ssh_public_key: publicKey,
      admin_source_cidrs: cidrs,
      vpc_cidr: form.vpcCidr || "10.50.0.0/16",
      mgmt_subnet_cidr: form.mgmtSubnetCidr || "10.50.0.0/24",
      monitor_subnet_cidr: form.monitorSubnetCidr || "10.50.1.0/24",
      fleet_instance_type: form.fleetVmSize || "m5.xlarge",
      sensor_instance_type: form.sensorVmSize || "m5.xlarge",
      deploy_fleet: form.deployFleet !== false,
      sensor_count: Number(form.sensorCount || 1),
      // Optional AlmaLinux AMI override (escape hatch if the owner-filter lookup is flaky).
      ami_id: form.amiId || "",
    };
  },

  // On AWS the FIRST/primary ENI (eth0) is monitoring; the second (eth1) is management. SSH
  // reaches the management ENI's Elastic IP. Default AlmaLinux AMI user on AWS is ec2-user.
  bringUpProfile(form) {
    return { username: form.adminUsername || "ec2-user", mgmtIface: "eth1", monitorIface: "eth0" };
  },

  async authenticate(run, emit) {
    emit(run, "status", { phase: "aws-auth" });
    const region = run.form.region;
    // Credentials come from a signed-in SSO session (minted fresh here, never seen by the browser)
    // or from pasted/ambient creds. SSO is preferred when the operator signed in.
    let creds;
    if (run.form.awsSsoSessionId) {
      emit(run, "log", { level: "info", line: "Getting short-lived AWS credentials from your SSO sign-in…" });
      creds = await credsFromSso(run.form.awsSsoSessionId);
    } else {
      emit(run, "log", { level: "info", line: "Validating AWS credentials…" });
      creds = credsFromForm(run.form);
    }
    const who = await validateCreds({ creds, region }); // throws with a friendly message on failure
    const { env } = writeCredsEnv(run, creds, region);
    emit(run, "log", { level: "success", line: `AWS ready — account ${who.account} (${who.arn}).` });
    return { env, meta: { account: who.account, arn: who.arn } };
  },

  decorateResults(run, results) {
    if (run.providerMeta) {
      results.aws_account = run.providerMeta.account;
      results.aws_creds_note = "If you pasted temporary STS credentials, they must remain valid for any later STOP/rollback (terraform destroy). Refresh them before tearing down if they expire.";
    }
  },

  async cleanup(/* run */) { /* no-op: nothing to revoke (creds are the operator's own) */ },
};
