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
and press **Deploy**. 
