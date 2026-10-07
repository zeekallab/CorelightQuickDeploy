// Azure provider. Wraps the existing Azure device-code sign-in + service-principal auth and
// the Azure terraform module. Behavior is identical to the pre-refactor inline Azure path —
// the code here was extracted verbatim from runner.js / index.js.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { provisionServicePrincipal } from "../azureauth.js";
import { checkAzure } from "../preflight.js";
import { moduleDirFor } from "./tfpaths.js";

// Human-friendly base for resource names (VMs, NICs, …) → corelight-fleet, corelight-sensor-1.
const RESOURCE_PREFIX = "corelight";

// The first /24 inside a VNet CIDR (the sensor subnet). 10.50.0.0/16 → 10.50.0.0/24.
// Returns null on anything that isn't a plain dotted-quad CIDR so callers fall back to the default.
function firstSlash24(cidr) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}\/\d{1,2}$/.exec((cidr || "").trim());
  return m ? `${m[1]}.${m[2]}.${m[3]}.0/24` : null;
}

export default {
  id: "azure",

  moduleDir() {
    return moduleDirFor("azure");
  },

  // Azure-specific POST /api/deploy validation (cloud-neutral checks stay in index.js).
  validateForm(form) {
    if (!form.subscriptionId) return "subscriptionId is required";
    if (form.useExistingRg && !form.existingRgName) {
      return "Select an existing resource group, or switch to creating a new one.";
    }
    return null;
  },

  // Build the tfvars object the Azure module expects from the validated form.
  toTfvars(form, publicKey, ctx = {}) {
    const cidrs = (form.adminSourceCidrs && form.adminSourceCidrs.length)
      ? form.adminSourceCidrs
      : (form.publicIp ? [`${form.publicIp}/32`] : []);
    return {
      subscription_id: form.subscriptionId,
      location: form.region,
      // Readable resource names from the customer-chosen base: corelight-fleet, corelight-sensor-1, …
      name_prefix: ctx.namePrefix || RESOURCE_PREFIX,
      // Base managed-by tag + any optional tag the customer added.
      tags: { "managed-by": "corelight-quick-deploy", ...(ctx.extraTags || {}) },
      use_existing_rg: !!form.useExistingRg,
      existing_rg_name: form.useExistingRg ? (form.existingRgName || "") : "",
      admin_username: form.adminUsername || "azureuser",
      ssh_public_key: publicKey,
      admin_source_cidrs: cidrs,
      vnet_cidr: form.vnetCidr || "10.50.0.0/16",
      // Keep the sensor subnet inside whatever VNet CIDR the operator chose: the first /24 of
      // that range (e.g. 10.50.0.0/16 → 10.50.0.0/24). An explicit subnetCidr still wins.
      subnet_cidr: form.subnetCidr || firstSlash24(form.vnetCidr) || "10.50.0.0/24",
      fleet_vm_size: form.fleetVmSize || "Standard_D4s_v3",
      sensor_vm_size: form.sensorVmSize || "Standard_D4s_v3",
      deploy_fleet: form.deployFleet !== false,
      sensor_count: Number(form.sensorCount || 1),
      // The public FQDN must be globally unique, so it (unlike the VM names) keeps the run id.
      fleet_dns_label: form.deployFleet !== false ? `${form.uniqueName || form.namePrefix}-fleet` : "",
    };
  },

  // SSH bring-up profile: on Azure the FIRST NIC (eth0) is management, the second (eth1) monitoring.
  bringUpProfile(form) {
    return { username: form.adminUsername || "azureuser", mgmtIface: "eth0", monitorIface: "eth1" };
  },

  // Resolve Azure credentials for Terraform (ARM_* env). A browser sign-in yields a *user* token,
  // which the azurerm provider can't consume — so auto-mint a subscription-scoped SP; if the
  // tenant forbids that (common), fall back to the operator's own `az login` session.
  async authenticate(run, emit) {
    if (!run.form.azureSessionId) {
      // No in-app sign-in: rely on an ambient `az login` session (ARM_USE_CLI).
      return { env: { ARM_SUBSCRIPTION_ID: run.form.subscriptionId, ARM_USE_CLI: "true" }, meta: null };
    }
    emit(run, "status", { phase: "azure-auth" });
    emit(run, "log", { level: "info", line: "Authenticating to Azure (creating a scoped service principal)…" });
    try {
      const creds = await provisionServicePrincipal(run.form.azureSessionId, run.form.subscriptionId, {
        displayName: run.uniqueName || run.namePrefix,
        log: (line) => emit(run, "log", { level: "info", line }),
      });
      const env = {
        ARM_CLIENT_ID: creds.clientId,
        ARM_CLIENT_SECRET: creds.clientSecret,
        ARM_TENANT_ID: creds.tenantId,
        ARM_SUBSCRIPTION_ID: creds.subscriptionId,
        ARM_USE_CLI: "false",
      };
      const meta = { sessionId: run.form.azureSessionId, appObjectId: creds.appObjectId, displayName: creds.displayName };
      // Persist creds to the gitignored run workspace so a later manual `terraform destroy`
      // works within the 24h secret lifetime. Never logged.
      writeFileSync(join(run.dir, "azure-creds.env"),
        `ARM_CLIENT_ID=${creds.clientId}\nARM_CLIENT_SECRET=${creds.clientSecret}\nARM_TENANT_ID=${creds.tenantId}\nARM_SUBSCRIPTION_ID=${creds.subscriptionId}\n`);
      emit(run, "log", { level: "success", line: `Azure ready — service principal '${creds.displayName}' (secret expires in 24h).` });
      return { env, meta };
    } catch (e) {
      const msg = String(e?.message || e);
      const az = await checkAzure();
      if (az.installed && az.loggedIn) {
        emit(run, "log", { level: "info", line: `This tenant doesn't allow auto-creating a service principal — using your Azure CLI session instead (az login as ${az.user || "signed-in user"}).` });
        return { env: { ARM_SUBSCRIPTION_ID: run.form.subscriptionId, ARM_USE_CLI: "true" }, meta: null };
      }
      throw new Error(
        `Couldn't authenticate to Azure. Auto-creating a service principal is blocked in this tenant (${msg}), ` +
        `and no Azure CLI session was found. Fix: install the Azure CLI and run \`az login\` with an account that ` +
        `has access to this subscription, then retry.`
      );
    }
  },

  decorateResults(run, results) {
    if (run.providerMeta) {
      results.azure_service_principal = run.providerMeta.displayName;
      results.azure_sp_note = "Auto-created for this deploy; its secret expires in 24h. Delete it in Entra ID → App registrations when done.";
    }
  },

  async cleanup(/* run */) { /* no-op: the SP is left for the 24h destroy window */ },
};
