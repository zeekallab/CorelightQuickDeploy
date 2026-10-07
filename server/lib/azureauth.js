// In-app Azure authentication (P3 zero-prereq) — replaces the `az login` dependency.
//
// Flow:
//   1. startDeviceLogin() → begins a device-code sign-in and returns the code + URL to show
//      the operator. Token acquisition runs in the background and blocks until they finish.
//   2. getLoginStatus() / listSubscriptions() → the UI polls until authenticated, then lists
//      the subscriptions the signed-in user can see so they can pick one.
//   3. provisionServicePrincipal() → at deploy time, creates a short-lived service principal
//      scoped (Contributor) to the chosen subscription and returns ARM_* credentials. Terraform
//      can't consume a user's browser token, but it CAN use a service principal — so we mint one.
//
// Graph + ARM are called with plain fetch using tokens from @azure/identity (no heavy SDKs).
import { DeviceCodeCredential, ClientSecretCredential } from "@azure/identity";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";

const ARM = "https://management.azure.com";
const ARM_SCOPE = `${ARM}/.default`;
const GRAPH = "https://graph.microsoft.com/v1.0";
const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
// Azure CLI's well-known public client id: pre-consented for ARM + Graph delegated perms and
// supports device-code flow. Piggybacking on it avoids registering our own app up front.
const AZ_CLI_CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46";
// Built-in "Contributor" role — enough to create the RG, network, and VMs.
const CONTRIBUTOR_ROLE_ID = "b24988ac-6180-42a0-ab88-46d3f6a3f11a";

const sessions = new Map(); // sessionId -> session

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeJwt(token) {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
  } catch {
    return {};
  }
}

function requireAuthed(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error("Azure session not found (sign in again).");
  if (s.status !== "authenticated" || !s.credential) throw new Error("Azure sign-in not complete.");
  return s;
}

// Start a device-code sign-in. Returns { sessionId, userCode, verificationUri, message, expiresOn }.
export async function startDeviceLogin({ tenantId } = {}) {
  const id = randomUUID();
  const session = {
    id, status: "pending", createdAt: Date.now(),
    deviceInfo: null, credential: null, subscriptions: null,
    user: null, tenantId: null, error: null,
  };
  sessions.set(id, session);

  const credential = new DeviceCodeCredential({
    tenantId: tenantId || process.env.AZURE_TENANT_ID || "organizations",
    clientId: process.env.AZURE_CLIENT_ID || AZ_CLI_CLIENT_ID,
    userPromptCallback: (info) => {
      session.deviceInfo = {
        userCode: info.userCode, verificationUri: info.verificationUri,
        message: info.message, expiresOn: info.expiresOn,
      };
    },
  });

  // getToken blocks until the operator completes the browser step; run it in the background.
  (async () => {
    try {
      const token = await credential.getToken(ARM_SCOPE);
      const claims = decodeJwt(token?.token || "");
      session.credential = credential;
      session.user = claims.upn || claims.preferred_username || claims.unique_name || null;
      session.tenantId = claims.tid || null;
      session.status = "authenticated";
    } catch (e) {
      session.status = "error";
      session.error = String(e?.message || e);
    }
  })();

  // Wait briefly for the SDK to hand us the device code (or fail fast).
  for (let i = 0; i < 100 && !session.deviceInfo && session.status === "pending"; i++) await sleep(100);
  if (session.error) throw new Error(session.error);
  if (!session.deviceInfo) throw new Error("Timed out obtaining a device code from Azure.");
  return { sessionId: id, ...session.deviceInfo };
}

export function getLoginStatus(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return { status: "unknown" };
  return { status: s.status, user: s.user, tenantId: s.tenantId, error: s.error, hasSubscriptions: !!s.subscriptions };
}

// Pre-deploy freshness check: is this in-app sign-in still usable RIGHT NOW? Actually acquires
// an ARM token (which silently refreshes if the refresh token is still valid), so it catches an
// expired sign-in BEFORE we start a long deploy — instead of failing 30 min in or silently
// falling back to `az`. Returns { fresh, reason, message, user?, expiresOn? }.
export async function checkSession(sessionId) {
  const s = sessionId ? sessions.get(sessionId) : null;
  if (!s) {
    return { fresh: false, reason: "not-found", message: "No Azure sign-in found — sign in with your browser, then deploy." };
  }
  if (s.status !== "authenticated" || !s.credential) {
    return { fresh: false, reason: "incomplete", message: "Azure sign-in isn't finished — complete the browser sign-in, then deploy." };
  }
  try {
    const tok = await s.credential.getToken(ARM_SCOPE);
    return { fresh: true, user: s.user, expiresOn: tok?.expiresOnTimestamp || null };
  } catch (e) {
    return {
      fresh: false,
      reason: "expired",
      message: "Your Azure sign-in expired — click Sign in to Azure to re-authenticate, then deploy.",
      detail: String(e?.message || e),
    };
  }
}

// List subscriptions the signed-in user can access.
export async function listSubscriptions(sessionId) {
  const s = requireAuthed(sessionId);
  const token = (await s.credential.getToken(ARM_SCOPE)).token;
  const r = await fetch(`${ARM}/subscriptions?api-version=2020-01-01`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Listing subscriptions failed: HTTP ${r.status} ${await r.text()}`);
  const j = await r.json();
  s.subscriptions = (j.value || [])
    .filter((x) => x.state === "Enabled")
    .map((x) => ({ subscriptionId: x.subscriptionId, displayName: x.displayName, tenantId: x.tenantId }));
  return s.subscriptions;
}

// List the resource groups the operator can see in a subscription, so they can pick an
// EXISTING one to deploy into (needed when they only have Contributor on a specific RG, not
// the whole subscription — creating a new RG would 403). Works for both auth paths: if an
// in-app sign-in session is present we use its ARM token; otherwise we fall back to the
// operator's `az login` session via the CLI (the same session Terraform's fallback uses).
export async function listResourceGroups({ sessionId, subscriptionId } = {}) {
  if (!subscriptionId) throw new Error("subscriptionId is required to list resource groups.");
  const s = sessionId ? sessions.get(sessionId) : null;
  if (s?.status === "authenticated" && s.credential) {
    const token = (await s.credential.getToken(ARM_SCOPE)).token;
    const r = await fetch(`${ARM}/subscriptions/${subscriptionId}/resourcegroups?api-version=2021-04-01`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`Listing resource groups failed: HTTP ${r.status} ${await r.text()}`);
    const j = await r.json();
    return (j.value || []).map((x) => ({ name: x.name, location: x.location })).sort((a, b) => a.name.localeCompare(b.name));
  }
  // No sign-in session → use the Azure CLI session.
  return listResourceGroupsViaCli(subscriptionId);
}

function listResourceGroupsViaCli(subscriptionId) {
  return new Promise((resolve, reject) => {
    execFile("az", ["group", "list", "--subscription", subscriptionId, "-o", "json"],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          return reject(new Error("Couldn't list resource groups via the Azure CLI. Sign in with your browser above, or run `az login` and retry."));
        }
        try {
          const arr = JSON.parse(stdout || "[]");
          resolve(arr.map((x) => ({ name: x.name, location: x.location })).sort((a, b) => a.name.localeCompare(b.name)));
        } catch (e) {
          reject(new Error(`Couldn't parse resource groups: ${e?.message || e}`));
        }
      });
  });
}

// --- VM size discovery -----------------------------------------------------------------
// List the VM sizes that can ACTUALLY be deployed into a given location for this subscription:
// real SKUs, x86 + premium-storage capable (our image + Premium_LRS os disk), not restricted,
// and — crucially — within the family's remaining vCPU quota so we never offer a size that
// would 409 on "exceeding approved … Cores quota". Sorted smallest-first so the UI can default
// to the lowest. Works via the sign-in ARM token, or falls back to the `az` CLI session.
export async function listVmSizes({ sessionId, subscriptionId, location } = {}) {
  if (!subscriptionId) throw new Error("subscriptionId is required to list VM sizes.");
  if (!location) throw new Error("location is required to list VM sizes.");
  const s = sessionId ? sessions.get(sessionId) : null;
  if (s?.status === "authenticated" && s.credential) {
    const token = (await s.credential.getToken(ARM_SCOPE)).token;
    const filter = encodeURIComponent(`location eq '${location}'`);
    const skus = await armGetAll(token, `${ARM}/subscriptions/${subscriptionId}/providers/Microsoft.Compute/skus?api-version=2021-07-01&$filter=${filter}`);
    const usage = await armGet(token, `${ARM}/subscriptions/${subscriptionId}/providers/Microsoft.Compute/locations/${location}/usages?api-version=2021-07-01`);
    return buildVmSizes(skus, usage.value || []);
  }
  return listVmSizesViaCli(subscriptionId, location);
}

async function armGet(token, url) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Azure GET failed: HTTP ${r.status} ${await r.text()}`);
  return r.json();
}

// Follow @odata.nextLink so we get every SKU page, not just the first.
async function armGetAll(token, url) {
  const items = [];
  let next = url;
  while (next) {
    const j = await armGet(token, next);
    for (const v of j.value || []) items.push(v);
    next = j.nextLink || j["@odata.nextLink"] || null;
  }
  return items;
}

// Shared filter/sort used by both the ARM and CLI paths.
function buildVmSizes(skus, usages) {
  // family (lowercased) -> remaining cores; plus the total regional vCPU headroom.
  const famRemaining = new Map();
  let totalRemaining = Infinity;
  for (const u of usages || []) {
    const key = String(u.name?.value || "").toLowerCase();
    const remaining = (Number(u.limit) || 0) - (Number(u.currentValue) || 0);
    if (key === "cores") totalRemaining = remaining; // "Total Regional vCPUs"
    else famRemaining.set(key, remaining);
  }
  const seen = new Set();
  const out = [];
  for (const sku of skus || []) {
    if (sku.resourceType !== "virtualMachines") continue;
    // Plain general-purpose D_s family only (e.g. Standard_D4s_v3): 4 GiB/core + premium storage,
    // the standard Corelight recommendation. Excludes the l/a/d low-mem, AMD, and local-disk
    // variants and the huge zoo of other families that would bury the dropdown.
    if (!/^Standard_D\d+s_v\d+$/.test(sku.name || "")) continue;
    if (seen.has(sku.name)) continue; // SKUs repeat per zone
    const caps = Object.fromEntries((sku.capabilities || []).map((c) => [c.name, c.value]));
    if (String(caps.PremiumIO) !== "True") continue; // os_disk = Premium_LRS
    if (caps.CpuArchitectureType && caps.CpuArchitectureType !== "x64") continue; // almalinux x86_64
    const vCPUs = Number(caps.vCPUs || 0);
    const memoryGB = Number(caps.MemoryGB || 0);
    if (!vCPUs || vCPUs < 2 || vCPUs > 64) continue;
    // Availability: drop SKUs restricted for this subscription/location.
    if ((sku.restrictions || []).some((r) => /NotAvailableForSubscription/i.test(r.reasonCode || ""))) continue;
    // Quota: must fit in the family's remaining cores AND the total regional headroom.
    const fam = String(sku.family || "").toLowerCase();
    const remaining = famRemaining.has(fam) ? famRemaining.get(fam) : Infinity;
    if (vCPUs > remaining || vCPUs > totalRemaining) continue;
    seen.add(sku.name);
    out.push({ name: sku.name, vCPUs, memoryGB, family: sku.family, familyRemaining: Number.isFinite(remaining) ? remaining : null });
  }
  out.sort((a, b) => a.vCPUs - b.vCPUs || a.memoryGB - b.memoryGB || a.name.localeCompare(b.name));
  return out;
}

function listVmSizesViaCli(subscriptionId, location) {
  const run = (args, maxBuffer) => new Promise((resolve, reject) => {
    execFile("az", args, { windowsHide: true, maxBuffer }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout || "[]")); } catch (e) { reject(e); }
    });
  });
  return (async () => {
    let skus;
    try {
      skus = await run(["vm", "list-skus", "--subscription", subscriptionId, "--location", location, "--resource-type", "virtualMachines", "-o", "json"], 48 * 1024 * 1024);
    } catch {
      throw new Error("Couldn't list VM sizes via the Azure CLI. Sign in with your browser above, or run `az login` and retry.");
    }
    let usages = [];
    try { usages = await run(["vm", "list-usage", "--subscription", subscriptionId, "--location", location, "-o", "json"], 8 * 1024 * 1024); } catch { /* quota best-effort */ }
    return buildVmSizes(skus, usages);
  })();
}

async function graph(session, method, path, body) {
  const token = (await session.credential.getToken(GRAPH_SCOPE)).token;
  const r = await fetch(`${GRAPH}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) {
    let msg = text;
    try { msg = JSON.parse(text)?.error?.message || text; } catch {}
    throw new Error(`Graph ${method} ${path} → HTTP ${r.status}: ${msg}`);
  }
  return text ? JSON.parse(text) : {};
}

// Wait until Contributor role can be PUT for the freshly-created SP (AAD replication lag).
async function assignContributor(session, subscriptionId, principalId, log) {
  const token = (await session.credential.getToken(ARM_SCOPE)).token;
  const guid = randomUUID();
  const url = `${ARM}/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleAssignments/${guid}?api-version=2022-04-01`;
  const body = {
    properties: {
      roleDefinitionId: `/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${CONTRIBUTOR_ROLE_ID}`,
      principalId,
      principalType: "ServicePrincipal",
    },
  };
  const deadline = Date.now() + 120000; // up to 2 min for the principal to propagate
  let attempt = 0;
  while (true) {
    attempt++;
    const r = await fetch(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) return;
    const text = await r.text();
    if (/RoleAssignmentExists/i.test(text)) return; // already there
    const retryable = /PrincipalNotFound|does not exist in the directory/i.test(text) || r.status === 404;
    if (!retryable || Date.now() > deadline) {
      throw new Error(`Role assignment failed: HTTP ${r.status}: ${text}`);
    }
    log?.(`Waiting for the service principal to propagate (attempt ${attempt})…`);
    await sleep(5000);
  }
}

// Confirm the SP credentials actually work before handing them to Terraform (AAD lag).
async function waitForSpToken(tenantId, clientId, clientSecret, log) {
  const cred = new ClientSecretCredential(tenantId, clientId, clientSecret);
  const deadline = Date.now() + 120000;
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      await cred.getToken(ARM_SCOPE);
      return;
    } catch (e) {
      if (Date.now() > deadline) throw new Error(`Service principal credentials never became usable: ${e?.message || e}`);
      log?.(`Waiting for the new credentials to activate (attempt ${attempt})…`);
      await sleep(5000);
    }
  }
}

// Create a short-lived service principal scoped (Contributor) to the subscription.
// Returns { clientId, clientSecret, tenantId, subscriptionId, appObjectId, spObjectId, displayName }.
export async function provisionServicePrincipal(sessionId, subscriptionId, { displayName, log } = {}) {
  const s = requireAuthed(sessionId);
  const name = displayName || `cqd-${Date.now().toString(36)}`;
  // Tenant for the SP creds = the subscription's tenant (fall back to the user's home tenant).
  const subTenant = s.subscriptions?.find((x) => x.subscriptionId === subscriptionId)?.tenantId;
  const tenantId = subTenant || s.tenantId;
  if (!tenantId) throw new Error("Could not determine the tenant for this subscription.");

  log?.(`Creating a service principal '${name}' for Terraform…`);
  const app = await graph(s, "POST", "/applications", { displayName: name, signInAudience: "AzureADMyOrg" });
  const appObjectId = app.id;
  const clientId = app.appId;

  const endDateTime = new Date(Date.now() + 24 * 3600 * 1000).toISOString(); // 24h secret
  const pw = await graph(s, "POST", `/applications/${appObjectId}/addPassword`, {
    passwordCredential: { displayName: "cqd-terraform", endDateTime },
  });
  const clientSecret = pw.secretText;

  const sp = await graph(s, "POST", "/servicePrincipals", { appId: clientId });
  const spObjectId = sp.id;

  log?.("Granting Contributor on the subscription…");
  await assignContributor(s, subscriptionId, spObjectId, log);
  await waitForSpToken(tenantId, clientId, clientSecret, log);
  log?.("Service principal ready.");

  return { clientId, clientSecret, tenantId, subscriptionId, appObjectId, spObjectId, displayName: name };
}

// Best-effort cleanup: delete the app registration (removes the SP too). Never throws.
export async function deleteApplication(sessionId, appObjectId) {
  try {
    const s = sessions.get(sessionId);
    if (!s?.credential || !appObjectId) return false;
    await graph(s, "DELETE", `/applications/${appObjectId}`);
    return true;
  } catch {
    return false;
  }
}

// --- VNet peering to an existing Fleet (sensors-only path) -------------------------------
// When the operator points sensors at an existing Fleet reachable only on its PRIVATE IP,
// the sensor VNet this run creates can't reach it. These helpers auto-discover the Fleet's
// VNet + NIC NSG from just its private IP, then peer the two VNets and open the Fleet NSG
// for :1443 from the sensor CIDR — the proven manual recipe, done in-app and reversible.
const NET_API = "2023-05-01";

async function armPut(token, url, body) {
  const r = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Azure PUT failed: HTTP ${r.status} ${await r.text()}`);
  return r.json().catch(() => ({}));
}

async function armDelete(token, url) {
  const r = await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok && r.status !== 404 && r.status !== 204) throw new Error(`Azure DELETE failed: HTTP ${r.status} ${await r.text()}`);
}

const rgOf = (id) => /resourceGroups\/([^/]+)/i.exec(id || "")?.[1] || null;

// Find the Fleet's VNet + NSG given its private IP, mirroring
// `az network nic list --query "[?ipConfigurations[?privateIPAddress=='<ip>']]"`.
// Returns the VNet id/name/CIDR + the NSG (NIC-level, else subnet-level) for operator confirm.
export async function discoverFleetNetwork({ sessionId, subscriptionId, fleetIp } = {}) {
  const s = requireAuthed(sessionId);
  if (!subscriptionId) throw new Error("subscriptionId is required.");
  const ip = String(fleetIp || "").trim();
  if (!ip) throw new Error("Fleet private IP is required.");
  const token = (await s.credential.getToken(ARM_SCOPE)).token;
  const nics = await armGetAll(token, `${ARM}/subscriptions/${subscriptionId}/providers/Microsoft.Network/networkInterfaces?api-version=${NET_API}`);
  let ipc = null;
  let nic = null;
  for (const n of nics) {
    const hit = (n.properties?.ipConfigurations || []).find((c) => c.properties?.privateIPAddress === ip);
    if (hit) { ipc = hit; nic = n; break; }
  }
  if (!nic) throw new Error(`No network interface with private IP ${ip} found in this subscription. Is the Fleet in this subscription?`);
  const subnetId = ipc.properties?.subnet?.id;
  if (!subnetId) throw new Error(`Interface for ${ip} has no subnet — cannot determine its VNet.`);
  const vnetId = subnetId.replace(/\/subnets\/[^/]+$/i, "");
  const vnetName = vnetId.split("/").pop();
  const vnet = await armGet(token, `${ARM}${vnetId}?api-version=${NET_API}`);
  const vnetCidr = vnet.properties?.addressSpace?.addressPrefixes || [];
  // NSG: prefer the one bound to the Fleet NIC; fall back to the subnet's.
  let nsgId = nic.properties?.networkSecurityGroup?.id || null;
  if (!nsgId) {
    const subnet = await armGet(token, `${ARM}${subnetId}?api-version=${NET_API}`);
    nsgId = subnet.properties?.networkSecurityGroup?.id || null;
  }
  return {
    fleetIp: ip,
    nicName: nic.name,
    vnetId,
    vnetName,
    vnetRg: rgOf(vnetId),
    vnetCidr,
    location: vnet.location || null,
    subnetId,
    nsgId,
    nsgName: nsgId ? nsgId.split("/").pop() : null,
    nsgRg: nsgId ? rgOf(nsgId) : null,
  };
}

// Peer the run's sensor VNet to the Fleet's VNet (both directions) and ensure the Fleet NSG
// admits TCP 1443 from the sensor CIDR. Idempotent. Returns the FLEET-side artifacts to remove
// on rollback — the sensor-side peering is a child of the sensor VNet and dies with it.
export async function peerSensorToFleet({ sessionId, sensorVnetId, sensorCidr, fleet, log } = {}) {
  const s = requireAuthed(sessionId);
  const token = async () => (await s.credential.getToken(ARM_SCOPE)).token;
  if (!sensorVnetId) throw new Error("sensor VNet id is required for peering.");
  if (!fleet?.vnetId) throw new Error("Fleet VNet id is required for peering.");
  const sensorVnetName = sensorVnetId.split("/").pop();
  const sensorRg = rgOf(sensorVnetId);

  // 1. sensor VNet → Fleet VNet
  const p1 = "cqd-to-fleet";
  await armPut(await token(), `${ARM}${sensorVnetId}/virtualNetworkPeerings/${p1}?api-version=${NET_API}`, {
    properties: { remoteVirtualNetwork: { id: fleet.vnetId }, allowVirtualNetworkAccess: true },
  });
  log?.("Peered sensor VNet → Fleet VNet.");

  // 2. Fleet VNet → sensor VNet (uniquely named so multiple runs can coexist)
  const p2 = `cqd-${sensorRg}-${sensorVnetName}`.toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 78);
  await armPut(await token(), `${ARM}${fleet.vnetId}/virtualNetworkPeerings/${p2}?api-version=${NET_API}`, {
    properties: { remoteVirtualNetwork: { id: sensorVnetId }, allowVirtualNetworkAccess: true },
  });
  log?.("Peered Fleet VNet → sensor VNet.");

  // 3. Fleet NSG: allow inbound 1443 from the sensor CIDR, if not already permitted.
  let nsgRule = null;
  if (fleet.nsgId && sensorCidr) {
    const nsg = await armGet(await token(), `${ARM}${fleet.nsgId}?api-version=${NET_API}`);
    const rules = nsg.properties?.securityRules || [];
    const admits = rules.some((r) => {
      const p = r.properties || {};
      if (p.direction !== "Inbound" || p.access !== "Allow" || (p.protocol !== "Tcp" && p.protocol !== "*")) return false;
      const ports = [p.destinationPortRange, ...(p.destinationPortRanges || [])].filter(Boolean);
      const srcs = [p.sourceAddressPrefix, ...(p.sourceAddressPrefixes || [])].filter(Boolean);
      const hasPort = ports.some((x) => x === "1443" || x === "*");
      const hasSrc = srcs.some((x) => x === sensorCidr || x === "*");
      return hasPort && hasSrc;
    });
    if (admits) {
      log?.("Fleet NSG already admits 1443 from the sensor network — no rule added.");
    } else {
      const used = new Set(rules.map((r) => r.properties?.priority).filter(Boolean));
      let prio = 110;
      while (used.has(prio)) prio += 1;
      const ruleName = `cqd-allow-1443-${sensorRg}`.toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 78);
      await armPut(await token(), `${ARM}${fleet.nsgId}/securityRules/${ruleName}?api-version=${NET_API}`, {
        properties: {
          priority: prio, direction: "Inbound", access: "Allow", protocol: "Tcp",
          sourceAddressPrefix: sensorCidr, sourcePortRange: "*",
          destinationAddressPrefix: "*", destinationPortRange: "1443",
          description: "Corelight Quick Deploy: softsensor pairing (1443) from sensor VNet",
        },
      });
      nsgRule = { nsgId: fleet.nsgId, ruleName };
      log?.(`Opened Fleet NSG for 1443 from ${sensorCidr} (priority ${prio}).`);
    }
  } else if (!fleet.nsgId) {
    log?.("No NSG found on the Fleet interface — skipping the 1443 rule (assuming it's already open).");
  }
  return { fleetPeering: { vnetId: fleet.vnetId, name: p2 }, nsgRule };
}

// Reverse peerSensorToFleet's FLEET-side changes on rollback. Best-effort; never throws.
export async function unpeerFleet({ sessionId, created, log } = {}) {
  const s = sessions.get(sessionId);
  if (!s?.credential || !created) return;
  const token = async () => (await s.credential.getToken(ARM_SCOPE)).token;
  if (created.fleetPeering) {
    try {
      await armDelete(await token(), `${ARM}${created.fleetPeering.vnetId}/virtualNetworkPeerings/${created.fleetPeering.name}?api-version=${NET_API}`);
      log?.("Removed Fleet→sensor VNet peering.");
    } catch (e) { log?.(`(cleanup) peering delete: ${String(e?.message || e)}`); }
  }
  if (created.nsgRule) {
    try {
      await armDelete(await token(), `${ARM}${created.nsgRule.nsgId}/securityRules/${created.nsgRule.ruleName}?api-version=${NET_API}`);
      log?.("Removed Fleet NSG 1443 rule.");
    } catch (e) { log?.(`(cleanup) nsg rule delete: ${String(e?.message || e)}`); }
  }
}
