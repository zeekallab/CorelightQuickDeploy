// Preflight checks — all cross-platform, no shell built-ins.
// Verifies the operator's machine is ready: Azure CLI logged in, Terraform present,
// and detects the operator's public IP (used later to scope the NSG allow rules).
import { execFile } from "node:child_process";
import https from "node:https";
import { resolveTerraform, isVendored } from "./tfbin.js";

const WIN = process.platform === "win32";

// execFile wrapper. On Windows, `az` is a .cmd batch file, so it needs a shell to
// resolve; on POSIX we avoid the shell. Returns {ok, stdout, stderr}.
function exec(cmd, args, { timeout = 15000, shell = WIN } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, shell, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: (stdout || "").trim(), stderr: (stderr || "").trim() });
    });
  });
}

export async function checkTerraform() {
  // Prefer the vendored binary (P2 zero-prereq); fall back to a `terraform` on PATH.
  const bin = resolveTerraform();
  const bundled = isVendored();
  const r = await exec(bin, ["version", "-json"], { shell: false });
  if (!r.ok) return { installed: false, bundled: false, error: "terraform not found (no vendored binary and none on PATH)" };
  try {
    const j = JSON.parse(r.stdout);
    return { installed: true, bundled, version: j.terraform_version };
  } catch {
    // Older terraform without -json: fall back to first line.
    const line = r.stdout.split("\n")[0] || "";
    return { installed: true, bundled, version: line.replace(/^Terraform\s+/i, "") };
  }
}

export async function checkAzure() {
  const r = await exec("az", ["account", "show", "--output", "json"]);
  if (!r.ok) {
    const notLoggedIn = /az login|not logged in|please run/i.test(r.stderr);
    return { installed: !/not found|ENOENT|recognized/i.test(r.stderr), loggedIn: false,
      error: notLoggedIn ? "Not logged in — run `az login`" : (r.stderr || "az account show failed") };
  }
  try {
    const a = JSON.parse(r.stdout);
    return { installed: true, loggedIn: true,
      subscriptionId: a.id, subscriptionName: a.name, tenantId: a.tenantId, user: a.user?.name };
  } catch {
    return { installed: true, loggedIn: false, error: "could not parse az output" };
  }
}

export function detectPublicIp() {
  return new Promise((resolve) => {
    const req = https.get("https://api.ipify.org", { timeout: 8000 }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        const ip = data.trim();
        resolve(/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? { ip } : { ip: null, error: "unexpected response" });
      });
    });
    req.on("error", (e) => resolve({ ip: null, error: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ ip: null, error: "timeout" }); });
  });
}

export async function runPreflight() {
  const [terraform, azure, publicIp] = await Promise.all([
    checkTerraform(),
    checkAzure(),
    detectPublicIp(),
  ]);
  // Azure CLI is now OPTIONAL — the app can sign in via device code (see azureauth.js).
  // If az happens to be logged in we still surface it (handy for prefilling the subscription).
  const ready = terraform.installed && !!publicIp.ip;
  return { ready, terraform, azure, publicIp, platform: process.platform, checkedAt: new Date().toISOString() };
}
