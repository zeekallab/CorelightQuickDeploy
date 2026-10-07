# Corelight Quick Deploy

A **local, one-button web app** for Corelight SEs to deploy a Fleet Manager + N Software
Sensors into the cloud — **Azure or AWS**. Runs entirely on your machine (bound to `127.0.0.1`),
signs in to your cloud from the browser (Azure device code / AWS IAM Identity Center — no CLI),
and streams live progress. Ships either as source you run with Node, or as a
**double-clickable desktop app** (macOS `.dmg` / Windows `.exe`) that bundles
Node + Terraform and needs nothing preinstalled.

## Download & install

**Most users want this — no Node, Terraform or cloud CLI needed.** Grab the latest installer from the
[**Releases page**](../../releases/latest):

- **macOS (Apple Silicon)** — download the `.dmg`, open it, and drag **Corelight Quick Deploy** to
  Applications. The build is unsigned, so macOS blocks the first launch (sometimes calling it
  "damaged"). Fix it once in Terminal:
  ```bash
  xattr -dr com.apple.quarantine "/Applications/Corelight Quick Deploy.app"
  ```
  then open it normally.
- **Windows** — download the `Setup .exe` and run it. SmartScreen may warn on an unsigned build:
  **More info → Run anyway**.

Then launch the app, pick **Azure** or **AWS**, sign in from the browser prompt, fill in the form,
and press **Deploy**. Check the version badge in the app header against the Releases page to be
sure you're on the latest build.

> Want to run from source or build the installer yourself? See [Run from source](#run-from-source-developers) below.

> **Status: feature-complete on both clouds, live-proven end-to-end.** One button provisions the
> infra (new VNet/VPC, subnets, NSG/security groups, optional Fleet VM + N sensor VMs), brings up
> the Fleet Manager (install → PEM → start → admin), then for each sensor mints a pairing token,
> installs `corelight-sensor`, writes `corelightctl.yaml`, and deploys + pairs it — all streamed
> live, with a STOP-and-destroy button and failure rollback. Unchecking **Deploy Fleet** pairs
> sensors to an **existing** Fleet instead: supply its pairing address + admin creds (auto-mints a
> token per sensor), or paste pre-minted tokens + `server_sslname`.
>
> *Both the **Azure** and **AWS** paths have been run end-to-end against live VMs — Fleet up,
> sensor installed and paired. On AWS the interface mapping is the reverse of Azure
> (monitoring = `eth0` primary ENI, management = `eth1` secondary ENI + Elastic IP), with a
> dual-ENI policy-routing fix applied via `user_data`.*

## Run from source (developers)
Only needed if you're developing the app or building the installer yourself.

**Prerequisites (any OS: Windows, macOS, Linux)**
- **Node.js** LTS (18+) — *only needed to run from source. The packaged desktop app (`.dmg` /
  `.exe` / `.AppImage`) bundles its own Node runtime and needs nothing preinstalled.*

> The per-run SSH keypair is generated **in-process** (RSA 4096, via `ssh2`) — no `ssh-keygen`
> on your `PATH` required.

> **Azure CLI is optional.** Sign in from the app with your browser (device code) — it mints a
> short-lived, subscription-scoped service principal for Terraform automatically. If you already
> have `az login` active, you can just enter a subscription ID instead. (Browser sign-in requires
> that your account can create app registrations in the tenant.)

> **Terraform is bundled** — `npm run setup` (and `npm start` as a fallback) downloads a pinned,
> checksum-verified Terraform binary into `vendor/terraform/<os>_<arch>/`, so you don't need to
> install it. If you already have `terraform` on your `PATH` it'll be used as a fallback. Override
> with `TERRAFORM_BIN=/path/to/terraform`.

## Setup & run
```bash
npm run setup     # installs root + server + web deps
npm run dev       # dev mode: Vite UI (5173) + backend (8787), hot reload
# or
npm start         # builds the UI, serves it from the backend, opens the browser
```
Dev mode: open http://127.0.0.1:5173  ·  `npm start`: open http://127.0.0.1:8787

## Build a standalone desktop app (zero prerequisites for the end user)
```bash
npm run app:dev     # build the UI + launch the Electron app locally (dev smoke test)
npm run app:build   # produce a packaged installer for THIS OS in dist/
```
`app:build` bundles the Node runtime (via Electron) and a pinned, checksum-verified Terraform
binary, so the resulting artifact runs on a machine with **nothing** preinstalled — no Node, no
Terraform, no Azure CLI. Output per OS:
- **macOS** → `dist/*.dmg`
- **Windows** → `dist/*.exe` (NSIS installer)
- **Linux** → `dist/*.AppImage`

Each OS artifact must be built on that OS (or its CI runner) — a Windows `.exe` can't be produced
from macOS. Builds are unsigned by default; add a signing identity for distribution.

## What it does today (M2)
- **Preflight**: verifies `az login`, Terraform, and detects your public IP (used to scope the
  NSG SSH/UI rules). Prefills the subscription ID from your Azure session.
- **Deploy form**: subscription, region (dropdown), VM size (dropdown), sensor count,
  "Deploy Fleet" toggle, repo tokens, PEM/license uploads, community string.
- **Preview**: runs `terraform plan` and streams it — safe, creates nothing.
- **Deploy**: creates a per-run workspace under `runs/<id>/`, generates an SSH keypair, renders
  tfvars from the form, and runs `terraform init` + `apply -auto-approve`, streaming output live.
  On success a results card shows the Fleet UI URL, the sensor list, and ready-to-copy SSH commands.

## Tearing down
After a successful deploy, the results card offers **Accept or tear down**: keep the deployment, or
press **Tear down deployment… → Confirm** to run `terraform destroy` on exactly what that run
created (your existing resource group and Fleet are left alone). The **STOP** button halts a running
deploy and destroys whatever it created, and a failed run offers the same rollback.

The teardown button only covers runs from the current app session. For an older run, run
`terraform destroy` inside its workspace (`runs/<id>/tf/`), or delete the resources it created in
the Azure Portal / AWS console (they're tagged `managed-by = corelight-quick-deploy`).

## Design (see also the plan in project memory)
- **Frontend**: React + Vite. **Backend**: Node/Express, localhost-only, SSE for progress.
- **Azure auth**: reuses `az login` — only the subscription ID is requested.
- **Terraform module** (`terraform/`): new resource group, VNet (`10.50.0.0/16`), subnet, NSG
  (SSH/UI scoped to your public IP; sensor↔Fleet 1443 rides the default intra-VNet rule), an
  optional Fleet VM, and N sensor VMs (each with an eth0 management NIC + eth1 monitoring NIC),
  all AlmaLinux 9 / DHCP.
- **Cross-platform**: SSH/SCP via the `ssh2` Node lib (M3+), secret cleanup via Node `fs`
  overwrite, `path` for all paths — no reliance on Unix shell tools locally. Target VMs are
  AlmaLinux, so remote commands are consistent regardless of your OS.
- **Secrets**: tokens/PEM/license stay local, written to a gitignored per-run `runs/`
  workspace. Nothing is baked into the repo — each SE brings their own credentials.

## Roadmap
- **M1** ✅ scaffold + preflight + UI shell + live-log channel
- **M2** ✅ Terraform module (new VNet + optional Fleet + N sensors) driven from the form, per-run
  workspace, live `terraform` streaming, results card
- **M3** ✅ Fleet bring-up: install → PEM → start → create admin
- **M4** ✅ per-sensor token minting + pairing + verify → **end-to-end one button** (deploy-Fleet path)
- **M5** ✅ existing-Fleet path (operator-supplied Fleet address + admin creds, or pasted tokens)
- **AWS** ✅ full parity: provider abstraction, AWS IAM Identity Center (SSO) browser sign-in,
  `terraform/aws/` module (new VPC, dual-ENI sensors, Elastic IPs, eth1 policy-routing `user_data`),
  interface flip (monitoring `eth0` / management `eth1`) — **live-proven end-to-end**

*Next: Windows verification; AWS "peer to an existing Fleet" (VPC peering + route-table entries).*
