// Cross-platform SSH via the ssh2 lib (no shelled ssh/scp — works the same on Windows).
// Used by the orchestrator to bring up Fleet and sensors over the per-run keypair.
import { Client } from "ssh2";
import { readFileSync } from "node:fs";

// Open a connection, retrying until sshd answers (VMs need time to boot + cloud-init).
export function waitForSsh({ host, username, privateKeyPath, onLog, timeoutMs = 300000, intervalMs = 8000, isAborted }) {
  const privateKey = readFileSync(privateKeyPath);
  const deadline = Date.now() + timeoutMs;
  const attempt = () =>
    new Promise((resolve, reject) => {
      const conn = new Client();
      const onReady = () => {
        cleanup();
        // The live connection outlives this attempt. Keep a listener on `error` so a mid-session
        // socket reset (e.g. `corelightctl sensor deploy` reconfiguring networking, or a reboot
        // severing the channel) is absorbed here instead of surfacing as an uncaught exception
        // that crashes the Electron main process. Callers detect the drop via exec results.
        conn.on("error", () => {});
        resolve(conn);
      };
      const onError = (err) => {
        cleanup();
        try { conn.end(); } catch {}
        reject(err);
      };
      const cleanup = () => {
        conn.removeListener("ready", onReady);
        conn.removeListener("error", onError);
      };
      conn.on("ready", onReady);
      conn.on("error", onError);
      conn.connect({ host, port: 22, username, privateKey, readyTimeout: intervalMs - 1000 });
    });

  return (async () => {
    let lastErr;
    let n = 0;
    while (Date.now() < deadline) {
      // Bail immediately if a STOP landed — don't keep retrying a VM that's about to be destroyed.
      if (isAborted?.()) throw new Error("SSH wait aborted — stop requested.");
      try {
        return await attempt();
      } catch (e) {
        if (isAborted?.()) throw new Error("SSH wait aborted — stop requested.");
        lastErr = e;
        n += 1;
        onLog?.({ level: "info", line: `Waiting for SSH on ${host}… (attempt ${n})` });
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }
    throw new Error(`SSH to ${host} not reachable within ${Math.round(timeoutMs / 1000)}s: ${lastErr?.message || "timeout"}`);
  })();
}

// Run a bash script over SSH by feeding it to `sudo bash -s` on stdin, streaming output.
// `input` (optional) is written to stdin AFTER the script — used for secrets we don't want
// on the command line (e.g. piping a password). Resolves the remote exit code.
export function runScript(conn, script, { onLog, phase, input = "" } = {}) {
  return new Promise((resolve, reject) => {
    conn.exec("sudo bash -s", (err, stream) => {
      if (err) return reject(err);
      let buf = "";
      let ebuf = "";
      let settled = false;
      const flush = (chunk, level, isErr) => {
        let s = (isErr ? (ebuf += chunk) : (buf += chunk));
        const parts = s.split("\n");
        const rest = parts.pop();
        for (const line of parts) onLog?.({ level, line, phase });
        if (isErr) ebuf = rest; else buf = rest;
      };
      const finish = (code) => {
        if (settled) return;
        settled = true;
        if (buf) onLog?.({ level: "info", line: buf, phase });
        if (ebuf) onLog?.({ level: "warn", line: ebuf, phase });
        resolve(code ?? 1);
      };
      stream.on("close", (code) => finish(code));
      // A dropped connection mid-command (e.g. the sensor deploy severs networking, or a
      // reboot) fires `error` on the stream. Treat it as a nonzero exit instead of letting the
      // event go unhandled and crash the process — callers already handle a nonzero result.
      stream.on("error", (e) => {
        onLog?.({ level: "warn", line: `SSH stream ended early: ${e?.message || e}`, phase });
        finish(1);
      });
      stream.stderr.on("error", () => {});
      stream.on("data", (d) => flush(d.toString(), "info", false));
      stream.stderr.on("data", (d) => flush(d.toString(), "warn", true));
      stream.end(script + "\n" + (input || ""));
    });
  });
}

// Upload a local file to a remote path via SFTP.
export function putFile(conn, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.fastPut(localPath, remotePath, (e) => {
        if (e) return reject(e);
        resolve();
      });
    });
  });
}
