// Single source of truth for the bundled ("vendored") Terraform binary.
// P2 of the zero-prereq track: instead of requiring the admin to install Terraform,
// we fetch a pinned binary into vendor/terraform/<os>_<arch>/ (see scripts/fetch-terraform.js)
// and run that. resolveTerraform() falls back to a PATH `terraform` if none is vendored,
// so the app still works for developers who already have it installed.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Pinned Terraform version. Matches what the module was validated against.
export const TERRAFORM_VERSION = "1.15.8";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = dirname(dirname(__dirname)); // server/lib -> server -> repo root

// Root under which vendor/ lives. In a packaged Electron app the binary is shipped as an
// unpacked extraResource under process.resourcesPath (the Electron main sets CQD_RESOURCES_PATH);
// in dev/CLI it's the repo root.
function vendorRoot() {
  return process.env.CQD_RESOURCES_PATH || appRoot;
}

// Map Node's platform/arch onto HashiCorp release naming.
export function platformKey() {
  const os = process.platform === "win32" ? "windows"
    : process.platform === "darwin" ? "darwin"
    : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64"; // Node x64 -> amd64
  return { os, arch };
}

export function vendorDir() {
  const { os, arch } = platformKey();
  return join(vendorRoot(), "vendor", "terraform", `${os}_${arch}`);
}

export function vendorTerraformPath() {
  const bin = process.platform === "win32" ? "terraform.exe" : "terraform";
  return join(vendorDir(), bin);
}

// Which terraform to actually run: explicit override → vendored → PATH.
export function resolveTerraform() {
  if (process.env.TERRAFORM_BIN && existsSync(process.env.TERRAFORM_BIN)) return process.env.TERRAFORM_BIN;
  const vendored = vendorTerraformPath();
  if (existsSync(vendored)) return vendored;
  return "terraform"; // developer fallback: whatever is on PATH
}

export function isVendored() {
  return existsSync(vendorTerraformPath());
}
