// Downloads the pinned Terraform binary for THIS platform into vendor/terraform/<os>_<arch>/,
// verifying the official SHA256 checksum before extracting. Idempotent: skips if already present
// (pass --force to re-download). Runs during `npm run setup` and again (as a safety net) from
// scripts/start.js. Uses Node's global fetch (Node 18+) and adm-zip for cross-platform unzip.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import AdmZip from "adm-zip";
import { TERRAFORM_VERSION, platformKey, vendorDir, vendorTerraformPath } from "../server/lib/tfbin.js";

const V = TERRAFORM_VERSION;
const BASE = `https://releases.hashicorp.com/terraform/${V}`;

async function download(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} → HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function main() {
  const dest = vendorTerraformPath();
  if (existsSync(dest) && !process.argv.includes("--force")) {
    console.log(`Terraform ${V} already vendored at ${dest}`);
    return;
  }

  const { os, arch } = platformKey();
  const zipName = `terraform_${V}_${os}_${arch}.zip`;
  console.log(`Fetching ${zipName} (Terraform ${V}) ...`);

  const [zipBuf, sumsBuf] = await Promise.all([
    download(`${BASE}/${zipName}`),
    download(`${BASE}/terraform_${V}_SHA256SUMS`),
  ]);

  // Verify the official checksum before trusting the zip.
  const want = sumsBuf.toString("utf8")
    .split("\n").map((l) => l.trim().split(/\s+/))
    .find(([, name]) => name === zipName)?.[0];
  if (!want) throw new Error(`no checksum entry for ${zipName}`);
  const got = createHash("sha256").update(zipBuf).digest("hex");
  if (got !== want) throw new Error(`checksum mismatch for ${zipName}: got ${got}, want ${want}`);

  // Extract the single terraform binary from the zip.
  const binName = os === "windows" ? "terraform.exe" : "terraform";
  const entry = new AdmZip(zipBuf).getEntry(binName);
  if (!entry) throw new Error(`${binName} not found inside ${zipName}`);

  mkdirSync(vendorDir(), { recursive: true });
  writeFileSync(dest, entry.getData());
  if (os !== "windows") chmodSync(dest, 0o755);
  console.log(`Terraform ${V} → ${dest} (sha256 verified)`);
}

main().catch((e) => {
  console.error(`fetch-terraform failed: ${e.message}`);
  console.error("The app will fall back to a `terraform` on PATH if one exists.");
  process.exit(1);
});
