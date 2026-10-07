// Results card — rendered after a successful apply from terraform outputs.
import React, { useState } from "react";

export default function Results({ data, teardown, onTeardown }) {
  if (!data) return null;
  const sensors = Array.isArray(data.sensors) ? data.sensors : [];
  // Post-success teardown: reuses the failure-rollback stream (`terraform destroy` on this
  // run's workspace). Confirm-gated so a stray click can't nuke a live deployment.
  const [confirming, setConfirming] = useState(false);
  const t = teardown || {};
  const canTeardown = typeof onTeardown === "function" && !t.done;
  return (
    <section className="card">
      <h2>Deployed</h2>
      <p className="muted small">Resource group <code>{data.resource_group_name}</code> — keep it, or tear the whole deployment back down below.</p>
      {data.azure_service_principal && (
        <p className="muted small">Azure service principal <code>{data.azure_service_principal}</code> — {data.azure_sp_note}</p>
      )}

      {data.fleet_deployed && (
        <div className="result-block">
          <h3>Fleet Manager</h3>
          <ul className="kv">
            {data.fleet_ui_url && <li><span>UI</span><a href={data.fleet_ui_url} target="_blank" rel="noreferrer">{data.fleet_ui_url}</a></li>}
            <li><span>Public IP</span><code>{data.fleet_public_ip}</code></li>
            <li><span>Private IP</span><code>{data.fleet_private_ip}</code></li>
            {data.fleet_admin_user && <li><span>Admin user</span><code>{data.fleet_admin_user}</code></li>}
            {data.fleet_admin_password && <li><span>Admin password</span><code>{data.fleet_admin_password}</code></li>}
          </ul>
        </div>
      )}

      {sensors.length > 0 && (
        <div className="result-block">
          <h3>Sensors ({sensors.length})</h3>
          {sensors.map((s) => (
            <ul className="kv" key={s.name}>
              <li><span>{s.name}{s.paired ? " ✓ paired" : ""}</span><code>ssh {data.admin_username}@{s.public_ip}</code></li>
              <li><span>mgmt / monitor</span><code>{s.mgmt_private_ip} / {s.monitor_private_ip}</code></li>
              {s.uid && <li><span>Fleet uid</span><code>{s.uid}</code></li>}
            </ul>
          ))}
        </div>
      )}

      <div className="result-block">
        <h3>Accept or tear down</h3>
        {t.done ? (
          <p className="muted small">Torn down — every resource this run created was deleted. Your resource group was left untouched.</p>
        ) : (
          <>
            <p className="muted small">
              Keep this deployment, or tear it all back down. Teardown runs <code>terraform destroy</code> on
              exactly what this run created (and removes the Fleet VNet peering it added) — your existing
              resource group and Fleet are left untouched.
            </p>
            {t.error && <p className="error small">{t.error}</p>}
            {canTeardown && !confirming && (
              <div className="grid2">
                <button className="btn" type="button" disabled>Keep — nothing to do</button>
                <button className="btn danger" type="button" disabled={t.running} onClick={() => setConfirming(true)}>
                  Tear down deployment…
                </button>
              </div>
            )}
            {canTeardown && confirming && (
              <div className="grid2">
                <button className="btn" type="button" disabled={t.running} onClick={() => setConfirming(false)}>Cancel</button>
                <button className="btn danger" type="button" disabled={t.running} onClick={onTeardown}>
                  {t.running ? "Tearing down…" : t.error ? "Retry teardown" : "Confirm — destroy everything"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
