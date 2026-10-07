// Cloud-provider registry. Each provider module exports a common interface so the runner and
// routes can dispatch on form.cloud without knowing the cloud's specifics. Adding a cloud =
// write a providers/<cloud>.js implementing the interface and register it here.
//
// Interface (see azure.js / aws.js):
//   id                                  — "azure" | "aws"
//   moduleDir()                         — absolute path to this cloud's terraform module
//   validateForm(form)                  — cloud-specific form validation → error string | null
//   toTfvars(form, publicKey, ctx)      — build the terraform.tfvars.json object
//   authenticate(run, emit) -> {env,meta} — resolve creds into TF env; may write a per-run
//                                           secret file into run.dir and emit progress
//   bringUpProfile(form)                — { username, mgmtIface, monitorIface } for SSH bring-up
//   decorateResults(run, results)       — (optional) annotate the results object in place
//   cleanup(run)                        — (optional) best-effort post-run credential cleanup
import azure from "./azure.js";
import aws from "./aws.js";

const REGISTRY = { azure, aws };

export function getProvider(cloud) {
  const p = REGISTRY[cloud || "azure"];
  if (!p) throw new Error(`Cloud '${cloud}' is not supported — choose one of: ${providerIds().join(", ")}.`);
  return p;
}

export function providerIds() {
  return Object.keys(REGISTRY);
}
