// Resolve the terraform module directory for a given provider id.
// The module source ships read-only (Electron: resourcesPath/terraform); dev = repo root.
// CQD_TF_MODULE points at the PARENT dir holding per-provider subdirs (azure/, aws/).
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url)); // server/lib/providers
const appRoot = dirname(dirname(dirname(__dirname)));       // repo root
const TF_MODULE_ROOT = process.env.CQD_TF_MODULE || join(appRoot, "terraform");

export function moduleDirFor(id) {
  return join(TF_MODULE_ROOT, id);
}
