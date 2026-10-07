// Corelight Quick Deploy — backend.
// Binds to 127.0.0.1 ONLY (never exposed). Serves the API and, in production, the built UI.
// M2 scope: preflight + a real deploy pipeline. POST /api/deploy creates a per-run
// workspace from the form; GET /api/deploy/stream?runId attaches an SSE channel that
// runs `terraform init` + apply (or plan on dryRun) and streams output live. The
// Corelight bring-up (Fleet install, token minting, sensor pairing) lands in M3/M4.
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { runPreflight } from "./lib/preflight.js";
import { createRun, getRun, attach, rollback, stop } from "./lib/runner.js";
import { startDeviceLogin, getLoginStatus, listSubscriptions, listResourceGroups, listVmSizes, checkSession, discoverFleetNetwork } from "./lib/azureauth.js";
import { validateCreds as validateAwsCreds, listRegions as listAwsRegions, listInstanceTypes as listAwsInstanceTypes } from "./lib/awsauth.js";
import { startSsoLogin, getSsoStatus, listSsoAccounts, selectSsoRole, credsFromSso } from "./lib/awssso.js";
import { getProvider } from "./lib/providers/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = dirname(__dirname);
// Single-source the version from the root package.json (same value the UI badge shows).
let VERSION = "0.0.0";
try { VERSION = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version || VERSION; } catch { /* keep default */ }
const PORT = Number(process.env.PORT || 8787);
const HOST = "127.0.0.1"; // localhost only — security requirement.

const app = express();
app.use(express.json({ limit: "10mb" })); // room for base64 PEM / license uploads

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "corelightquickdeploy", version: VERSION }));

app.get("/api/preflight", async (_req, res) => {
  try {
    res.json(await runPreflight());
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// --- In-app Azure sign-in (device code) — retires the `az login` prerequisite. ---
app.post("/api/azure/login/start", async (req, res) => {
  try {
    res.json(await startDeviceLogin({ tenantId: req.body?.tenantId }));
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get("/api/azure/login/status", (req, res) => {
  res.json(getLoginStatus(String(req.query.sessionId || "")));
});

app.get("/api/azure/subscriptions", async (req, res) => {
  try {
    res.json({ subscriptions: await listSubscriptions(String(req.query.sessionId || "")) });
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

// List existing resource groups in a subscription so the operator can deploy into one they
// already have rights to (instead of creating a new RG, which needs subscription-level write).
app.get("/api/azure/resourcegroups", async (req, res) => {
  try {
    const groups = await listResourceGroups({
      sessionId: String(req.query.sessionId || ""),
      subscriptionId: String(req.query.subscriptionId || ""),
    });
    res.json({ resourceGroups: groups });
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

// List the VM sizes actually deployable in a location (available + within quota), so the UI
// only offers sizes that won't 409 on a cores-quota conflict.
app.get("/api/azure/vmsizes", async (req, res) => {
  try {
    const vmSizes = await listVmSizes({
      sessionId: String(req.query.sessionId || ""),
      subscriptionId: String(req.query.subscriptionId || ""),
      location: String(req.query.location || ""),
    });
    res.json({ vmSizes });
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

// Auto-discover the VNet + NSG hosting an existing Fleet from its private IP, so the operator
// can confirm and let the app peer the sensor VNet to it (sensors-only path on a private Fleet).
app.post("/api/azure/fleet/discover", async (req, res) => {
  try {
    const info = await discoverFleetNetwork({
      sessionId: req.body?.sessionId,
      subscriptionId: req.body?.subscriptionId,
      fleetIp: req.body?.fleetIp,
    });
    res.json(info);
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

// --- AWS discovery (SDK v3). Creds come in the POST body or fall through to the ambient
// chain (~/.aws / env). Creds are used only to talk to STS/EC2 here; they are never logged
// and never persisted outside the gitignored per-run workspace (see awsauth.writeCredsEnv). ---
function awsCredsFromBody(body) {
  return {
    accessKeyId: body?.accessKeyId || "",
    secretAccessKey: body?.secretAccessKey || "",
    sessionToken: body?.sessionToken || "",
  };
}

// Resolve the credentials for a discovery/validation request: a signed-in SSO session (creds
// minted server-side, never sent by the browser) takes precedence over pasted/ambient creds.
async function resolveAwsCreds(body) {
  if (body?.ssoSessionId) return await credsFromSso(body.ssoSessionId);
  return awsCredsFromBody(body);
}

// Validate AWS credentials (pasted, ambient, or from an SSO role) → { account, arn, userId }.
app.post("/api/aws/creds/validate", async (req, res) => {
  try {
    const who = await validateAwsCreds({ creds: await resolveAwsCreds(req.body), region: req.body?.region });
    res.json(who);
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

// List the regions enabled for this account (region picker).
app.post("/api/aws/regions", async (req, res) => {
  try {
    res.json({ regions: await listAwsRegions(await resolveAwsCreds(req.body)) });
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

// List x86_64 sensor-capable instance types offered in a region.
app.post("/api/aws/instance-types", async (req, res) => {
  try {
    const instanceTypes = await listAwsInstanceTypes({ creds: await resolveAwsCreds(req.body), region: req.body?.region });
    res.json({ instanceTypes });
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

// --- AWS IAM Identity Center (SSO) browser sign-in — the analog of the Azure device-code flow.
// Sign in once, discover accounts/roles, then role credentials are minted server-side on demand
// (never exposed to the browser). ---
app.post("/api/aws/sso/start", async (req, res) => {
  try {
    res.json(await startSsoLogin({ startUrl: req.body?.startUrl, region: req.body?.region }));
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

app.get("/api/aws/sso/status", (req, res) => {
  res.json(getSsoStatus(String(req.query.sessionId || "")));
});

app.get("/api/aws/sso/accounts", async (req, res) => {
  try {
    res.json({ accounts: await listSsoAccounts(String(req.query.sessionId || "")) });
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

app.post("/api/aws/sso/select-role", async (req, res) => {
  try {
    res.json(await selectSsoRole(req.body?.sessionId, req.body?.accountId, req.body?.roleName));
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

// Create a deploy run from the submitted form. Returns a runId; the client then opens
// the SSE stream below to drive and watch it. `dryRun: true` runs `terraform plan` only.
app.post("/api/deploy", async (req, res) => {
  const form = req.body || {};
  // Dispatch cloud-specific validation to the selected provider (Azure or AWS).
  let provider;
  try {
    provider = getProvider(form.cloud);
  } catch (e) {
    return res.status(400).json({ error: String(e?.message || e) });
  }
  const providerErr = provider.validateForm(form);
  if (providerErr) return res.status(400).json({ error: providerErr });
  // Pre-deploy Azure sign-in freshness check. If the operator used the in-app browser sign-in,
  // verify the token is still usable NOW — so an expired sign-in is caught here (asking them to
  // re-authenticate) rather than failing deep into a deploy or silently falling back to `az`.
  if (form.cloud === "azure" && form.azureSessionId) {
    const fresh = await checkSession(form.azureSessionId);
    if (!fresh.fresh) {
      return res.status(401).json({ error: fresh.message, reason: fresh.reason, reauth: true });
    }
  }
  const n = Number(form.sensorCount);
  if (!Number.isInteger(n) || n < 0 || n > 50) return res.status(400).json({ error: "sensorCount must be 0–50" });
  if (form.deployFleet === false && n === 0) return res.status(400).json({ error: "Nothing to deploy: no Fleet and 0 sensors" });
  // A real Fleet bring-up needs the product PEM + repo token; catch it before creating infra.
  if (!form.dryRun && form.deployFleet !== false) {
    if (!form.fleetPemB64) return res.status(400).json({ error: "Deploy Fleet requires the Fleet PEM (cert + license)" });
    if (!form.fleetRepoToken) return res.status(400).json({ error: "Deploy Fleet requires the Fleet repo token" });
  }
  // Any sensor install needs the BYOL repo token.
  if (!form.dryRun && n > 0 && !form.sensorRepoToken) {
    return res.status(400).json({ error: "Deploying sensors requires the sensor (BYOL) repo token" });
  }
  // Existing-Fleet path: need a pairing address + a way to get tokens (admin creds or pasted).
  if (!form.dryRun && n > 0 && form.deployFleet === false) {
    if (!form.existingFleetAddr) return res.status(400).json({ error: "Existing Fleet requires its pairing address (host:port)" });
    const hasCreds = !!(form.existingFleetUser && form.existingFleetPass);
    const pasted = String(form.existingFleetTokens || "").split(/[\s,]+/).filter(Boolean);
    if (!hasCreds) {
      if (pasted.length < n) return res.status(400).json({ error: "Provide Fleet admin credentials, or paste at least one pairing token per sensor" });
      if (!form.existingFleetSslname) return res.status(400).json({ error: "Pasted tokens also need the Fleet server_sslname" });
    }
  }
  try {
    const { id, namePrefix } = createRun(form);
    res.json({ runId: id, namePrefix });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// SSE deploy stream. Attaching starts (or resumes watching) the run's terraform execution.
app.get("/api/deploy/stream", (req, res) => {
  const run = getRun(String(req.query.runId || ""));
  if (!run) {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.write(`event: log\ndata: ${JSON.stringify({ level: "error", line: "Unknown or expired runId." })}\n\n`);
    res.write(`event: end\ndata: ${JSON.stringify({ status: "error" })}\n\n`);
    return res.end();
  }
  attach(run, res);
});

// STOP a running deploy and delete whatever it created so far. Returns immediately; the halt +
// destroy stream over the run's existing deploy SSE (the log the operator is already watching).
app.post("/api/deploy/stop", (req, res) => {
  const run = getRun(String(req.query.runId || ""));
  if (!run) return res.status(404).json({ error: "Unknown or expired runId — nothing to stop." });
  try {
    res.json(stop(run));
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Roll back a failed run: SSE stream that runs `terraform destroy` on the run workspace,
// deleting the resources it created. Only available after a failure where apply had started.
app.get("/api/deploy/rollback/stream", (req, res) => {
  const run = getRun(String(req.query.runId || ""));
  const fail = (line) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.write(`event: log\ndata: ${JSON.stringify({ level: "error", line })}\n\n`);
    res.write(`event: end\ndata: ${JSON.stringify({ status: "error" })}\n\n`);
    res.end();
  };
  if (!run) return fail("Unknown or expired runId — nothing to roll back.");
  if (!run.canRollback && !run.rollbackStarted) return fail("Nothing to roll back for this run.");
  rollback(run, res);
});

// Serve the built UI in production (npm start sets SERVE_STATIC=1).
if (process.env.SERVE_STATIC === "1") {
  const dist = join(root, "web", "dist");
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get("*", (_req, res) => res.sendFile(join(dist, "index.html")));
  } else {
    app.get("*", (_req, res) => res.status(503).send("UI not built yet. Run `npm run build`."));
  }
}

app.listen(PORT, HOST, () => {
  console.log(`[corelightquickdeploy] API listening on http://${HOST}:${PORT}`);
  if (process.env.SERVE_STATIC !== "1") console.log("[dev] UI served by Vite on http://127.0.0.1:5173 (proxying /api here)");
});
