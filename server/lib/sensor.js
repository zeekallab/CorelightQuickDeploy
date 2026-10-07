// Sensor bring-up + pairing (M4). For each sensor VM: mint a per-sensor pairing token
// from the Fleet API, then SSH in and add the sensor-stable repo, dnf install
// corelight-sensor (CLI + images as RPMs, so no CCS pull), write corelightctl.yaml
// (license + interfaces + pairing), and `corelightctl sensor deploy` — handling the
// first-deploy "reboot then redeploy" behavior. Sequential for readable logs.
import { readFileSync } from "node:fs";
import { waitForSsh, runScript } from "./ssh.js";
import { login, createSensor } from "./fleetapi.js";

// The sensor-stable dnf repo (token in baseurl, never logged).
function repoFile(token) {
  const base = `https://${token}:@pkgrepos.corelight.cloud/corelight/sensor-stable`;
  return `[corelight_sensor-stable_el_9]
name=corelight_sensor-stable_el_9
baseurl=${base}/el/9/$basearch
repo_gpgcheck=1
gpgcheck=0
enabled=1
gpgkey=${base}/gpgkey https://downloads.corelight.cloud/public/signing/corelight-package-signing-key.asc
sslverify=1
sslcacert=/etc/pki/tls/certs/ca-bundle.crt
metadata_expire=300
[corelight_sensor-stable_any]
name=corelight_sensor-stable_any
baseurl=${base}/rpm_any/rpm_any/$basearch
repo_gpgcheck=1
gpgcheck=0
enabled=1
gpgkey=${base}/gpgkey https://downloads.corelight.cloud/public/signing/corelight-package-signing-key.asc
sslverify=1
sslcacert=/etc/pki/tls/certs/ca-bundle.crt
metadata_expire=300`;
}

// corelightctl.yaml. JSON.stringify each scalar → valid double-quoted YAML (handles any
// characters in the license/token safely).
function corelightctlYaml({ communityString, licenseKey, pairing, mgmtIface = "eth0", monitorIface = "eth1" }) {
  return `sensor:
  api:
    password: ${JSON.stringify(communityString || "corelight")}
  license_key: ${JSON.stringify(licenseKey || "")}
  management_interface:
    - name: ${JSON.stringify(mgmtIface)}
  monitoring_interface:
    name: ${JSON.stringify(monitorIface)}
  pairing:
    token: ${JSON.stringify(pairing.token)}
    server_sslname: ${JSON.stringify(pairing.server_sslname)}
    url: ${JSON.stringify(pairing.url)}
    insecure: false
`;
}

// Run `corelightctl sensor deploy`; if the first run applies OS prereqs and asks for a
// reboot (nonzero exit), reboot the VM, wait for SSH, and deploy once more.
async function deployWithReboot(run, emit, sensor, connectSensor) {
  const phase = "sensor";
  const onLog = (l) => emit(run, "log", l);
  let conn = await connectSensor();
  try {
    emit(run, "log", { level: "info", line: `[${sensor.name}] corelightctl sensor deploy (several min)…`, phase });
    let code = await runScript(conn, "set -uo pipefail\ncorelightctl sensor deploy -v", { onLog, phase });
    if (code === 0) return;

    // First deploy commonly exits nonzero after masking cloud units / sysctl — needs a reboot.
    emit(run, "log", { level: "info", line: `[${sensor.name}] deploy requested a reboot — rebooting and retrying…`, phase });
    await reboot(conn);
    run.activeConns?.delete(conn);
    try { conn.end(); } catch {}

    conn = await connectSensor();
    code = await runScript(conn, "set -uo pipefail\ncorelightctl sensor deploy -v", { onLog, phase });
    if (code !== 0) throw new Error(`[${sensor.name}] sensor deploy failed after reboot (exit ${code})`);
  } finally {
    run.activeConns?.delete(conn);
    try { conn.end(); } catch {}
  }
}

// Issue a reboot; the connection drops, so don't wait on a clean close.
function reboot(conn) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    conn.exec("sudo systemctl reboot", (err, stream) => {
      if (err) return finish();
      stream.on("close", finish);
      stream.on("error", finish);
    });
    setTimeout(finish, 15000); // reboot severs the channel; move on
  });
}

export async function bringUpSensors(run, emit, fleetCtx, profile = {}) {
  const phase = "sensor";
  const onLog = (l) => emit(run, "log", l);
  const sensors = Array.isArray(run.outputs?.sensors) ? run.outputs.sensors : [];
  if (sensors.length === 0) return;

  emit(run, "status", { phase });

  // Fleet context. Two modes:
  //  - mint: log in with admin creds and mint a token per sensor via the Fleet API.
  //  - paste: use operator-supplied pre-minted tokens (+ a fixed server_sslname).
  const { apiBase, adminUser, adminPass, pairingUrl, tokens, serverSslname } = fleetCtx;
  const pasteMode = Array.isArray(tokens) && tokens.length > 0;
  let cookies = null;
  if (pasteMode) {
    emit(run, "log", { level: "info", line: `Using ${tokens.length} operator-supplied pairing token(s).`, phase });
  } else {
    emit(run, "log", { level: "info", line: `Logging in to Fleet API at ${apiBase}…`, phase });
    cookies = await login(apiBase, adminUser, adminPass);
  }

  // Return {uid, server_sslname, tethering_token} for sensor index i.
  const getPairing = async (i, name) => {
    if (pasteMode) {
      if (!tokens[i]) throw new Error(`No pre-minted token for sensor #${i + 1} (${name})`);
      return { uid: null, server_sslname: serverSslname, tethering_token: tokens[i] };
    }
    return createSensor(apiBase, cookies, name);
  };

  const username = profile.username || run.form.adminUsername || "azureuser";
  const mgmtIface = profile.mgmtIface || "eth0";
  const monitorIface = profile.monitorIface || "eth1";
  const sensorRepoToken = run.secrets?.sensorRepoToken;
  if (!sensorRepoToken) throw new Error("Sensor bring-up requires the sensor (BYOL) repo token");
  const licenseKey = run.secrets?.licensePath ? readFileSync(run.secrets.licensePath, "utf8").trim() : "";
  const communityString = run.secrets?.communityString || "corelight";

  run.sensorResults = [];
  for (let i = 0; i < sensors.length; i++) {
    if (run.aborted) throw new Error("Sensor bring-up stopped by user.");
    const sensor = sensors[i];
    emit(run, "log", { level: "info", line: `=== ${sensor.name} (${sensor.public_ip}) ===`, phase });

    // 1. Get the pairing token (mint on the Fleet, or use a supplied one).
    emit(run, "log", { level: "info", line: `[${sensor.name}] ${pasteMode ? "using supplied" : "minting"} pairing token…`, phase });
    const pairing = await getPairing(i, sensor.name);
    const yaml = corelightctlYaml({
      communityString,
      licenseKey,
      pairing: { token: pairing.tethering_token, server_sslname: pairing.server_sslname, url: pairingUrl },
      mgmtIface,
      monitorIface,
    });

    // 2. Connect + install + configure. (deploy uses its own reconnect for the reboot.)
    const connectSensor = async () => {
      const c = await waitForSsh({ host: sensor.public_ip, username, privateKeyPath: run.privateKeyPath, onLog, isAborted: () => run.aborted });
      run.activeConns?.add(c); // so a STOP can force-close this mid-step
      return c;
    };
    const conn = await connectSensor();
    try {
      emit(run, "log", { level: "info", line: `[${sensor.name}] installing corelight-sensor (~6 GB, several min)…`, phase });
      const install = `set -euo pipefail
if [ ! -f /etc/yum.repos.d/corelight_sensor-stable.repo ]; then
  tee /etc/yum.repos.d/corelight_sensor-stable.repo >/dev/null <<'REPO'
${repoFile(sensorRepoToken)}
REPO
fi
# Pre-import the Corelight signing key so repo_gpgcheck can verify repo metadata on a fresh VM.
rpm --import https://downloads.corelight.cloud/public/signing/corelight-package-signing-key.asc </dev/null || true
echo "== dnf makecache =="
dnf -y makecache </dev/null
echo "== dnf install corelight-sensor =="
# stdin from /dev/null: the script is piped to bash on stdin, so keep dnf's prompts off it.
dnf install -y corelight-sensor </dev/null
rpm -q corelight-sensor
corelightctl version || true
mkdir -p /etc/corelight
cat > /etc/corelight/corelightctl.yaml <<'YAML'
${yaml}YAML
chmod 0600 /etc/corelight/corelightctl.yaml
echo "corelightctl.yaml written"`;
      const code = await runScript(conn, install, { onLog, phase });
      if (code !== 0) throw new Error(`[${sensor.name}] install/config exited ${code}`);
    } finally {
      run.activeConns?.delete(conn);
      try { conn.end(); } catch {}
    }

    // 3. Deploy (with the first-run reboot handling).
    await deployWithReboot(run, emit, sensor, connectSensor);

    // 4. Verify status.
    const vconn = await connectSensor();
    try {
      emit(run, "log", { level: "info", line: `[${sensor.name}] sensor status…`, phase });
      await runScript(vconn, "corelightctl sensor status || true", { onLog, phase });
    } finally {
      run.activeConns?.delete(vconn);
      try { vconn.end(); } catch {}
    }

    run.sensorResults.push({ name: sensor.name, public_ip: sensor.public_ip, uid: pairing.uid, paired: true });
    emit(run, "log", { level: "success", line: `[${sensor.name}] deployed and paired (uid ${pairing.uid}).`, phase });
  }
}
