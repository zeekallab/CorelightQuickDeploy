// Fleet Manager bring-up (M3). After Terraform creates the Fleet VM, SSH in and:
//   1. add the corelight fleet-stable dnf repo
//   2. dnf install corelight-fleet
//   3. set messaging.community-string
//   4. upload + install the product PEM (cert + license) — Fleet won't start without it
//   5. systemctl enable --now corelight-fleetd
//   6. create the admin user and set a known password
// Mirrors the proven manual flow (fleet-manager-tf finish-fleet.sh + repo stanza).
import { randomBytes } from "node:crypto";
import { waitForSsh, runScript, putFile } from "./ssh.js";

// Strong-ish password with mixed case + digits, no shell-special characters.
function genPassword() {
  return `Cqd${randomBytes(6).toString("hex")}Aa9`;
}

// The dnf repo file, token injected into the baseurl (never logged — we only stream
// command output, not the script text).
function repoFile(token) {
  const base = `https://${token}:@pkgrepos.corelight.cloud/corelight/fleet-stable`;
  // Matches the official Corelight Fleet Manager stable-repo instructions exactly: a single
  // rpm_any stanza (the el/9 stanza we used before was the source of the repomd GPG error).
  return `[corelight_fleet-stable_any]
name=corelight_fleet-stable_any
baseurl=${base}/rpm_any/rpm_any/$basearch
repo_gpgcheck=1
gpgcheck=0
enabled=1
gpgkey=${base}/gpgkey https://downloads.corelight.cloud/public/signing/corelight-package-signing-key.asc
sslverify=1
sslcacert=/etc/pki/tls/certs/ca-bundle.crt
metadata_expire=300`;
}

export async function bringUpFleet(run, emit, profile = {}) {
  const host = run.outputs?.fleet_public_ip;
  const username = profile.username || run.form.adminUsername || "azureuser";
  const { fleetRepoToken, communityString, pemPath } = run.secrets || {};
  const onLog = (l) => emit(run, "log", l);
  const phase = "fleet";

  emit(run, "status", { phase });
  if (!host) throw new Error("Fleet bring-up: no fleet_public_ip in outputs");
  if (!pemPath) throw new Error("Fleet bring-up: no Fleet PEM was provided (required to start Fleet)");
  if (!fleetRepoToken) throw new Error("Fleet bring-up: no Fleet repo token was provided");

  emit(run, "log", { level: "info", line: `Connecting to Fleet VM ${host}…`, phase });
  const conn = await waitForSsh({ host, username, privateKeyPath: run.privateKeyPath, onLog, isAborted: () => run.aborted });
  run.activeConns?.add(conn); // so a STOP can force-close this mid-step

  try {
    // 1–3: repo + install + community-string. `enabled` disabled here; start after PEM.
    emit(run, "log", { level: "info", line: "Installing corelight-fleet (repo + dnf, ~a few min)…", phase });
    const community = JSON.stringify(communityString || "corelight");
    const install = `set -euo pipefail
if [ ! -f /etc/yum.repos.d/corelight_fleet-stable.repo ]; then
  tee /etc/yum.repos.d/corelight_fleet-stable.repo >/dev/null <<'REPO'
${repoFile(fleetRepoToken)}
REPO
fi
# Pre-import the Corelight package signing key so repo_gpgcheck can verify the repo metadata
# on a fresh VM — otherwise dnf reports "repomd.xml GPG signature verification error".
rpm --import https://downloads.corelight.cloud/public/signing/corelight-package-signing-key.asc </dev/null || true
echo "== dnf makecache =="
dnf -y makecache </dev/null
echo "== dnf install corelight-fleet =="
# stdin from /dev/null: this script is itself piped to bash on stdin, so without this dnf's
# key-import prompt would read leftover script bytes as answers (the "Is this ok [y/N]" spam).
dnf install -y corelight-fleet </dev/null
# Fail loudly if the package didn't actually land — do NOT press on to PEM/start.
rpm -q corelight-fleet
id corelight-fleetd
python3 - <<PY
import json
p='/etc/corelight-fleetd.conf'
d=json.load(open(p))
d.setdefault('messaging',{})['community-string']=${community}
json.dump(d,open(p,'w'),indent=2)
print('community-string set')
PY`;
    let code = await runScript(conn, install, { onLog, phase });
    if (code !== 0) throw new Error(`Fleet package install exited ${code}`);

    // 4: upload + install PEM (owner corelight-fleetd, mode 400).
    emit(run, "log", { level: "info", line: "Uploading product PEM…", phase });
    await putFile(conn, pemPath, "/tmp/corelight-fleetd.pem");
    code = await runScript(
      conn,
      `set -euo pipefail
install -o corelight-fleetd -g corelight-fleetd -m 400 /tmp/corelight-fleetd.pem /etc/corelight-fleetd.pem
rm -f /tmp/corelight-fleetd.pem
ls -l /etc/corelight-fleetd.pem`,
      { onLog, phase }
    );
    if (code !== 0) throw new Error(`PEM install exited ${code}`);

    // 5: start the service.
    emit(run, "log", { level: "info", line: "Starting corelight-fleetd…", phase });
    code = await runScript(
      conn,
      `set -euo pipefail
systemctl enable --now corelight-fleetd
sleep 4
systemctl is-active corelight-fleetd`,
      { onLog, phase }
    );
    if (code !== 0) throw new Error(`corelight-fleetd failed to start (exit ${code})`);

    // 6: create admin + set a known password (clears the require-password-change flag).
    const adminPw = genPassword();
    emit(run, "log", { level: "info", line: "Creating admin user…", phase });
    const fleetd = "/usr/bin/corelight-fleetd -c /etc/corelight-fleetd.conf";
    // The password is piped into reset-password on its OWN stdin (printf | cmd). This isolates
    // it from the bash-script stdin — otherwise leftover input leaks back to bash and runs as a
    // command (the "command not found" / exit 127 bug). printf is a shell builtin, so the
    // password is never visible in `ps`, and the script text itself is delivered over SSH stdin
    // (never logged). Two lines cover a build that asks to confirm; extras are discarded.
    code = await runScript(
      conn,
      `set -uo pipefail
NEWPW='${adminPw}'
# create-user is idempotent-ish: if admin exists it fails, which is fine — we reset next.
sudo -u corelight-fleetd ${fleetd} create-user -a admin || echo "NOTE: admin may already exist; resetting password."
printf '%s\\n%s\\n' "$NEWPW" "$NEWPW" | ${fleetd} reset-password -p admin`,
      { onLog, phase }
    );
    if (code !== 0) throw new Error(`admin user setup exited ${code}`);

    // Surface credentials in the results (user authorized storing Fleet admin passwords).
    run.fleetAdmin = { user: "admin", password: adminPw };
    emit(run, "log", { level: "success", line: "Fleet Manager is up — admin user ready.", phase });
  } finally {
    run.activeConns?.delete(conn);
    try { conn.end(); } catch {}
  }
}
