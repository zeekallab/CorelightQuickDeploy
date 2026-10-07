// Deploy runner — owns a per-run workspace and streams Terraform output.
// M2 scope: create a runs/<id>/ workspace, copy the Terraform module in, generate a
// per-run SSH keypair, render tfvars from the form, then run `terraform init` + apply
// (or plan, when dryRun) and stream every line to attached SSE listeners.
// The Corelight-specific bring-up (Fleet install, token minting, sensor pairing) lands
// in M3/M4 and will hook into the same run lifecycle after apply succeeds.
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, cpSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import readline from "node:readline";
import ssh2 from "ssh2"; // CJS module — default-import then read .utils (named ESM export is unreliable under Electron's loader)
const sshUtils = ssh2.utils;
import { bringUpFleet } from "./fleet.js";
import { bringUpSensors } from "./sensor.js";
import { resolveTerraform } from "./tfbin.js";
import { getProvider } from "./providers/index.js";
import { peerSensorToFleet, unpeerFleet } from "./azureauth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverRoot = dirname(__dirname);
const appRoot = dirname(serverRoot);
// Packaged (Electron) overrides: run workspaces must live in a writable location (userData),
// not inside the asar. Dev = repo root. (The terraform module dir is resolved per-provider.)
const RUNS_DIR = process.env.CQD_RUNS_DIR || join(appRoot, "runs");
// Human-friendly base for the Azure resource names (VMs, NICs, etc.) → corelight-fleet,
// corelight-sensor-1, … The globally-unique run id is kept only where uniqueness is required
// (the Fleet DNS label + the service-principal name), not in the readable resource names.
const RESOURCE_PREFIX = "corelight";

// The customer can choose what resource names begin with (default "corelight"), yielding
// corelight-fleet / corelight-sensor-1. Sanitize to a DNS/cloud-safe token: lowercase,
// [a-z0-9-] only, no leading/trailing/repeated dashes. Falls back to the default if empty.
function sanitizePrefix(raw) {
  const s = String(raw || "").trim().toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || RESOURCE_PREFIX;
}

// Optional single free-form tag the customer may add, entered as "Key=Value" (or "Key:Value").
// Returns {} when blank or unparseable, so a bad entry never blocks a deploy.
function parseResourceTag(raw) {
  const m = /^\s*([^=:]+?)\s*[=:]\s*(.+?)\s*$/.exec(String(raw || ""));
  if (!m) return {};
  const key = m[1].trim();
  const val = m[2].trim();
  return key ? { [key]: val } : {};
}

// In-memory registry of runs for this process. A run outlives the POST that creates it;
// the SSE GET attaches to it and triggers execution.
const runs = new Map();

function newId() {
  return randomBytes(4).toString("hex"); // 8 hex chars → cqd-xxxxxxxx
}

// Generate the per-run SSH keypair in-process (no external ssh-keygen — one less prereq,
// and works identically in a packaged Electron app). RSA 4096 is the key type Azure
// documents for Linux VM admin_ssh_key.
function generateKeypair(dir) {
  const keyPath = join(dir, "id_rsa");
  const { private: privateKey, public: publicKey } = sshUtils.generateKeyPairSync("rsa", {
    bits: 4096,
    comment: "corelight-quick-deploy",
  });
  writeFileSync(keyPath, privateKey, { mode: 0o600 });
  writeFileSync(`${keyPath}.pub`, publicKey);
  return { privateKeyPath: keyPath, publicKey: publicKey.trim() };
}

// Parse comma/space/newline-separated pre-minted tokens.
function parseTokens(s) {
  return String(s || "").split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
}

// Build the Fleet context for the existing-Fleet path from the form. The operator gives a
// pairing address host:port (sensors reach it on :1443); the REST API is that host on :443.
function existingFleetCtx(form) {
  const addr = String(form.existingFleetAddr || "").trim();
  const host = addr.replace(/:\d+$/, ""); // strip :port for the API base
  const pairingUrl = `https://${addr}/fleet/v1/internal/softsensor/websocket`;
  const tokens = parseTokens(form.existingFleetTokens);
  if (form.existingFleetUser && form.existingFleetPass) {
    return { apiBase: `https://${host}`, adminUser: form.existingFleetUser, adminPass: form.existingFleetPass, pairingUrl };
  }
  return { pairingUrl, tokens, serverSslname: String(form.existingFleetSslname || "").trim() };
}

export function createRun(form) {
  const id = newId();
  const provider = getProvider(form.cloud); // throws on an unknown cloud
  // Customer-chosen base for readable resource names (corelight-fleet, corelight-sensor-1).
  const namePrefix = sanitizePrefix(form.namePrefix);
  // Run-scoped unique name kept only where uniqueness is required (Azure SP name + Fleet DNS
  // label, AWS key pair) — never in the readable resource names the operator sees.
  const uniqueName = `${namePrefix}-${id}`;
  const extraTags = parseResourceTag(form.resourceTag);
  const dir = join(RUNS_DIR, id);
  const tfDir = join(dir, "tf");
  const sshDir = join(dir, "ssh");
  mkdirSync(tfDir, { recursive: true });
  mkdirSync(sshDir, { recursive: true });

  // Secrets go to the gitignored run dir, never into logs. PEM (base64) → fleet.pem.
  const secrets = {
    fleetRepoToken: form.fleetRepoToken || "",
    communityString: form.communityString || "corelight",
    sensorRepoToken: form.sensorRepoToken || "",
    pemPath: null,
    licensePath: null,
  };
  if (form.fleetPemB64) {
    secrets.pemPath = join(dir, "fleet.pem");
    writeFileSync(secrets.pemPath, Buffer.from(form.fleetPemB64, "base64"));
  }
  if (form.sensorLicenseB64) {
    secrets.licensePath = join(dir, "sensor.license");
    writeFileSync(secrets.licensePath, Buffer.from(form.sensorLicenseB64, "base64"));
  }

  // Keep the base64 blobs out of the retained form (large + sensitive).
  const { fleetPemB64, sensorLicenseB64, ...formRest } = form;
  const run = {
    id,
    provider,
    namePrefix,
    uniqueName,
    extraTags,
    dir,
    tfDir,
    sshDir,
    secrets,
    form: { ...formRest, namePrefix, uniqueName },
    dryRun: !!form.dryRun,
    status: "created",
    started: false,
    buffer: [], // replay for late subscribers
    listeners: new Set(),
    outputs: null,
    // Stop/rollback plumbing: the live terraform child + open SSH connections so a STOP can
    // interrupt whatever is in flight, and flags the deploy flow checks to unwind cooperatively.
    currentChild: null,
    activeConns: new Set(),
    aborted: false,
    stopRequested: false,
    executePromise: null,
  };
  runs.set(id, run);
  return { id, namePrefix, uniqueName };
}

export function getRun(id) {
  return runs.get(id);
}

function emit(run, event, data) {
  const rec = { event, data };
  run.buffer.push(rec);
  for (const res of run.listeners) {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      // listener gone; will be cleaned up on close
    }
  }
}

// Run one terraform subcommand, streaming stdout+stderr line-by-line. Resolves exit code.
function runTerraform(run, args, phase) {
  return new Promise((resolve) => {
    // Don't launch a new terraform op once a stop has been requested (e.g. abort landed
    // between phases). 130 = the conventional "terminated by Ctrl-C" exit code.
    if (run.aborted && args[0] !== "destroy") {
      emit(run, "log", { level: "warn", line: `Skipping terraform ${args[0]} — stop requested.` });
      return resolve(130);
    }
    const tfBin = resolveTerraform();
    emit(run, "log", { level: "info", line: `$ terraform ${args.join(" ")}` });
    const child = spawn(tfBin, args, {
      cwd: run.tfDir,
      shell: false, // terraform is a real exe on every OS; no shell = spaces in the vendored path are safe
      windowsHide: true,
      env: { ...process.env, TF_IN_AUTOMATION: "1", ...(run.tfEnv || {}) },
    });
    run.currentChild = child; // so a STOP can interrupt a long apply
    const pipe = (stream, level) => {
      const rl = readline.createInterface({ input: stream });
      rl.on("line", (line) => emit(run, "log", { level, line, phase }));
    };
    pipe(child.stdout, "info");
    pipe(child.stderr, "warn");
    child.on("error", (err) => {
      if (run.currentChild === child) run.currentChild = null;
      emit(run, "log", { level: "error", line: `failed to launch terraform: ${err.message}` });
      resolve(1);
    });
    child.on("close", (code) => {
      if (run.currentChild === child) run.currentChild = null;
      resolve(code ?? 1);
    });
  });
}

// Throw to unwind the deploy flow at the next checkpoint after a STOP (used between phases and
// around the SSH bring-up, where there's no child process to signal).
function throwIfAborted(run) {
  if (run.aborted) throw new Error("Deployment stopped by user.");
}

async function execute(run) {
  try {
    run.status = "running";

    // 1. Materialize the workspace: copy module + generate keypair + render tfvars.
    emit(run, "status", { phase: "prepare" });
    emit(run, "log", { level: "info", line: `Preparing workspace runs/${run.id}/ ...` });
    // Copy only the module source — never a stray .terraform/ (provider binaries) or state.
    cpSync(run.provider.moduleDir(), run.tfDir, {
      recursive: true,
      filter: (src) => !/[\\/](\.terraform|\.terraform\.lock\.hcl|terraform\.tfstate.*)$/.test(src),
    });

    emit(run, "log", { level: "info", line: "Generating per-run SSH keypair (RSA 4096, in-process)..." });
    const { publicKey, privateKeyPath } = generateKeypair(run.sshDir);
    run.privateKeyPath = privateKeyPath;

    const tfvars = run.provider.toTfvars(run.form, publicKey, { namePrefix: run.namePrefix, uniqueName: run.uniqueName, nameSuffix: run.id, extraTags: run.extraTags, resourcePrefix: RESOURCE_PREFIX });
    writeFileSync(join(run.tfDir, "terraform.tfvars.json"), JSON.stringify(tfvars, null, 2));
    emit(run, "log", {
      level: "info",
      line: `Plan (${run.provider.id}): ${tfvars.deploy_fleet ? "1 Fleet + " : "no Fleet, "}${tfvars.sensor_count} sensor(s) in a new network.`,
    });

    // 1b. Resolve cloud credentials into the env Terraform needs (provider-specific). For Azure
    // this mints a scoped service principal (or falls back to `az login`); for AWS it validates
    // the pasted/ambient credentials and writes a per-run aws-creds.env. Never logged.
    const { env, meta } = await run.provider.authenticate(run, emit);
    run.tfEnv = env;
    run.providerMeta = meta;

    // 2. terraform init
    throwIfAborted(run);
    emit(run, "status", { phase: "init" });
    let code = await runTerraform(run, ["init", "-no-color", "-input=false"], "init");
    if (code !== 0) throw new Error(`terraform init exited ${code}`);

    // 3. plan or apply
    if (run.dryRun) {
      emit(run, "status", { phase: "plan" });
      code = await runTerraform(run, ["plan", "-no-color", "-input=false"], "plan");
      if (code !== 0) throw new Error(`terraform plan exited ${code}`);
      emit(run, "log", { level: "success", line: "Dry run complete — plan only, no resources created." });
      run.status = "complete";
      emit(run, "status", { phase: "complete" });
      return;
    }

    throwIfAborted(run);
    emit(run, "status", { phase: "apply" });
    emit(run, "log", { level: "info", line: `Applying — this creates real ${run.provider.id.toUpperCase()} resources and can take 10–30 min.` });
    // From here on, resources may exist even if a later step fails — so rollback is offered.
    run.applyStarted = true;
    code = await runTerraform(run, ["apply", "-no-color", "-input=false", "-auto-approve"], "apply");
    if (code !== 0) throw new Error(`terraform apply exited ${code}`);

    // 4. capture outputs
    run.outputs = await readOutputs(run);
    emit(run, "log", { level: "success", line: "Infrastructure ready." });

    // 4b. Peer to an existing Fleet (Azure, sensors-only path). When the operator points sensors
    // at a Fleet reachable only on its private IP, the VNet this run just created can't reach it.
    // Peer the two VNets and open the Fleet NSG for :1443 from the sensor CIDR — so pairing works
    // without a public Fleet endpoint or a VPN. Fleet-side changes are recorded for rollback.
    await maybePeerToFleet(run);

    // Per-cloud SSH bring-up profile (SSH username + which ethN is mgmt vs monitoring).
    const profile = run.provider.bringUpProfile(run.form);

    // 5. Fleet bring-up (M3): install + PEM + start + admin, over SSH.
    throwIfAborted(run);
    if (run.form.deployFleet !== false) {
      await bringUpFleet(run, emit, profile);
    } else {
      emit(run, "log", { level: "info", line: "Skipping Fleet bring-up (using an existing Fleet)." });
    }

    // 6. Sensor bring-up + pairing (M4). Only the deploy-Fleet path is wired here; the
    // existing-Fleet path (operator-supplied address + creds) lands in M5.
    throwIfAborted(run);
    const sensorCount = Array.isArray(run.outputs?.sensors) ? run.outputs.sensors.length : 0;
    if (sensorCount > 0) {
      if (run.form.deployFleet !== false && run.fleetAdmin) {
        // Deploy-Fleet path: pair to the Fleet we just brought up (API on public IP:443,
        // sensors tether to its private IP:1443 inside the VNet).
        await bringUpSensors(run, emit, {
          apiBase: `https://${run.outputs.fleet_public_ip}`,
          adminUser: run.fleetAdmin.user,
          adminPass: run.fleetAdmin.password,
          pairingUrl: `https://${run.outputs.fleet_private_ip}:1443/fleet/v1/internal/softsensor/websocket`,
        }, profile);
      } else {
        await bringUpSensors(run, emit, existingFleetCtx(run.form), profile);
      }
    }

    // Build results: outputs + Fleet admin creds + per-sensor pairing status.
    const results = { ...(run.outputs || {}) };
    run.provider.decorateResults(run, results);
    if (run.fleetAdmin) {
      results.fleet_admin_user = run.fleetAdmin.user;
      results.fleet_admin_password = run.fleetAdmin.password;
    }
    if (Array.isArray(run.sensorResults) && Array.isArray(results.sensors)) {
      const byName = new Map(run.sensorResults.map((s) => [s.name, s]));
      results.sensors = results.sensors.map((s) => ({ ...s, ...(byName.get(s.name) || {}) }));
    }
    emit(run, "results", results);
    run.status = "complete";
    // Allow a post-success teardown: the operator can tear the whole deployment back down
    // from the Results card. Reuses the same rollback stream/`terraform destroy` path — the
    // rollback route gates on `canRollback`, so opt this run in now that apply succeeded.
    run.canRollback = true;
    emit(run, "status", { phase: "complete" });
  } catch (e) {
    run.status = "error";
    emit(run, "log", { level: run.aborted ? "warn" : "error", line: String(e?.message || e) });
    emit(run, "status", { phase: "error" });
    // If Terraform apply had started, resources may already exist (and cost money). Offer a
    // one-click rollback that destroys everything this run created. Not offered for failures
    // before apply (init/auth/plan), where nothing was provisioned — nor when the operator hit
    // STOP, since stop() drives the destroy itself.
    if (run.applyStarted && !run.rolledBack && !run.aborted) {
      run.canRollback = true;
      emit(run, "log", { level: "warn", line: `Some ${run.provider.id.toUpperCase()} resources may have been created before the failure. You can roll back (delete them) to avoid ongoing charges.` });
      emit(run, "rollback", { available: true });
    }
  } finally {
    // When a STOP is in progress, stop() owns the end-of-stream + destroy lifecycle — leave the
    // listeners open so they receive the rollback logs. Otherwise close out normally.
    if (!run.stopRequested) {
      emit(run, "end", { status: run.status });
      for (const res of run.listeners) {
        try { res.end(); } catch {}
      }
      run.listeners.clear();
    }
  }
}

// Peer this run's sensor VNet to an existing Fleet's VNet (Azure, sensors-only path), when the
// operator enabled it and confirmed the discovered Fleet VNet/NSG. Idempotent; records the
// Fleet-side artifacts on run.peeringCreated so rollback can remove them.
async function maybePeerToFleet(run) {
  const f = run.form;
  if (f.cloud !== "azure" || f.deployFleet !== false || !f.peerToFleet) return;
  if (!f.azureSessionId) {
    emit(run, "log", { level: "warn", line: "VNet peering was requested but there's no Azure sign-in session — skipping. Pair manually or peer the VNets yourself." });
    return;
  }
  const sensorVnetId = run.outputs?.vnet_id;
  if (!sensorVnetId) {
    emit(run, "log", { level: "warn", line: "Could not determine the sensor VNet id from Terraform outputs — skipping peering." });
    return;
  }
  emit(run, "status", { phase: "peering" });
  emit(run, "log", { level: "info", line: "Peering the sensor VNet to the existing Fleet's VNet…" });
  run.peeringCreated = await peerSensorToFleet({
    sessionId: f.azureSessionId,
    sensorVnetId,
    sensorCidr: run.outputs?.vnet_cidr || f.vnetCidr || "10.50.0.0/16",
    fleet: { vnetId: f.fleetVnetId, nsgId: f.fleetNsgId },
    log: (line) => emit(run, "log", { level: "info", line }),
  });
  try { writeFileSync(join(run.dir, "peering.json"), JSON.stringify(run.peeringCreated, null, 2)); } catch {}
  emit(run, "log", { level: "success", line: "VNet peering in place — sensors can now reach the Fleet on its private IP:1443." });
}

function readOutputs(run) {
  return new Promise((resolve) => {
    execFile(resolveTerraform(), ["output", "-json"], { cwd: run.tfDir, shell: false, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...(run.tfEnv || {}) } }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const raw = JSON.parse(stdout);
        const flat = {};
        for (const [k, v] of Object.entries(raw)) flat[k] = v.value;
        resolve(flat);
      } catch {
        resolve(null);
      }
    });
  });
}

// Roll back a failed run: `terraform destroy` the workspace, deleting every resource this
// run created. The existing resource group is a data source, so it is never destroyed.
async function executeRollback(run, { force = false } = {}) {
  try {
    run.status = "rolling-back";
    emit(run, "status", { phase: "rollback" });
    emit(run, "log", { level: "info", line: "Rolling back — destroying the resources this run created…" });
    // `-lock=false` on a stop-triggered destroy: a STOP may SIGKILL terraform mid-apply, which
    // can leave a stale state lock. This workspace is owned by this single run, so bypassing the
    // lock is safe here and avoids a deadlock. A normal (post-failure) rollback keeps the lock.
    const args = ["destroy", "-no-color", "-input=false", "-auto-approve"];
    if (force) args.push("-lock=false");
    const code = await runTerraform(run, args, "rollback");
    if (code !== 0) throw new Error(`terraform destroy exited ${code}`);
    // The sensor VNet (and its side of the peering) is gone with the destroy; remove the
    // Fleet-side peering + the 1443 NSG rule we added to the operator's existing Fleet.
    if (run.peeringCreated) {
      emit(run, "log", { level: "info", line: "Removing the VNet peering + NSG rule added to the existing Fleet…" });
      await unpeerFleet({ sessionId: run.form.azureSessionId, created: run.peeringCreated, log: (line) => emit(run, "log", { level: "info", line }) });
      run.peeringCreated = null;
    }
    run.status = "destroyed";
    run.rolledBack = true;
    run.canRollback = false;
    emit(run, "log", { level: "success", line: "Rollback complete — all resources created by this run were deleted. Your resource group was left untouched." });
    emit(run, "status", { phase: "destroyed" });
  } catch (e) {
    run.status = "rollback-error";
    emit(run, "log", { level: "error", line: `Rollback failed: ${String(e?.message || e)}. You can retry the rollback, or run \`terraform destroy\` manually in the run workspace (${run.tfDir}).` });
    emit(run, "status", { phase: "rollback-error" });
  } finally {
    emit(run, "end", { status: run.status });
    for (const res of run.listeners) { try { res.end(); } catch {} }
    run.listeners.clear();
  }
}

// Interrupt the currently-running terraform op (graceful SIGINT, then SIGKILL if it ignores it).
function killChild(run) {
  const child = run.currentChild;
  if (!child) return;
  try { child.kill("SIGINT"); } catch {}
  // Terraform's first Ctrl-C is graceful (finishes the in-flight resource, releases the lock).
  // If it's wedged, force it — the stop-triggered destroy runs with -lock=false to recover.
  setTimeout(() => { try { if (run.currentChild === child) child.kill("SIGKILL"); } catch {} }, 10000);
}

// Force-close any open SSH connections so an in-flight bring-up step unblocks immediately
// (its runScript resolves on the dropped stream; the next step hits an abort checkpoint).
function closeConns(run) {
  for (const c of run.activeConns) {
    try { c.end(); } catch {}
    try { c.destroy?.(); } catch {}
  }
  run.activeConns.clear();
}

// STOP: halt the deploy and delete whatever it created so far. Returns immediately; the abort
// + destroy run in the background and stream to the run's already-open SSE listeners (the
// deploy log the operator is watching). Safe to call once; repeat calls are no-ops.
export function stop(run) {
  if (run.stopRequested) return { ok: true, already: true };
  run.stopRequested = true;
  run.aborted = true;
  emit(run, "log", { level: "warn", line: "Stop requested — halting the deployment and cleaning up any resources created so far…" });
  emit(run, "status", { phase: "stopping" });
  killChild(run);
  closeConns(run);
  (async () => {
    // Let the deploy flow unwind (execute() never rejects — it records status in its catch).
    try { await run.executePromise; } catch {}
    if (run.applyStarted && !run.rolledBack) {
      await executeRollback(run, { force: true });
    } else {
      run.status = "stopped";
      emit(run, "log", { level: "info", line: "Stopped before any resources were created — nothing to delete." });
      emit(run, "status", { phase: "stopped" });
      emit(run, "end", { status: run.status });
      for (const res of run.listeners) { try { res.end(); } catch {} }
      run.listeners.clear();
    }
  })();
  return { ok: true };
}

// Attach an SSE response for a rollback and kick it off on the first attach.
export function rollback(run, res) {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.flushHeaders?.();
  run.listeners.add(res);
  res.on("close", () => run.listeners.delete(res));
  if (!run.rollbackStarted) {
    run.rollbackStarted = true;
    executeRollback(run); // fire and forget; streams via emit()
  } else if (run.status === "destroyed" || run.status === "rollback-error") {
    try { res.end(); } catch {}
  }
}

// Attach an SSE response to a run. Starts execution on first attach.
export function attach(run, res) {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.flushHeaders?.();
  res.write(`event: log\ndata: ${JSON.stringify({ level: "info", line: `Attached to run ${run.id}.` })}\n\n`);

  // Replay anything already emitted (covers reconnects and the POST→GET gap).
  for (const rec of run.buffer) {
    res.write(`event: ${rec.event}\ndata: ${JSON.stringify(rec.data)}\n\n`);
  }
  run.listeners.add(res);
  res.on("close", () => run.listeners.delete(res));

  if (!run.started) {
    run.started = true;
    run.executePromise = execute(run); // fire and forget; streams via emit(). stop() awaits this.
  } else if (run.status === "complete" || run.status === "error") {
    try { res.end(); } catch {}
  }
}
