// Precheck — three compact, cloud-aware readiness chips: Auth · Access · Capacity.
// Replaces the old wordy checklist. Each chip is one glanceable line when green; only a
// broken chip grows a second line carrying the FIX. "Warn but allow" — nothing here disables
// Deploy, it just tells the operator what to expect. Access + Capacity stay dim until Auth is
// green (they can't be meaningfully evaluated before sign-in).
import React from "react";

const ICON = { ok: "●", warn: "▲", todo: "○", checking: "◌" };

function Chip({ state, title, line1, line2 }) {
  return (
    <div className={`chip ${state}`}>
      <div className="chip-head">
        <span className="chip-ico">{ICON[state] || "○"}</span>
        <span className="chip-title">{title}</span>
      </div>
      {line1 && <div className="chip-line">{line1}</div>}
      {line2 && <div className="chip-fix">{line2}</div>}
    </div>
  );
}

// --- Chip content, derived per cloud from state App already holds. ---

function authChip({ cloud, azure, aws, awsSso, pf, subName, rgName }) {
  if (cloud === "aws") {
    if (aws.status === "valid") {
      const role = awsSso?.selected?.roleName;
      return { state: "ok", title: "Signed in",
        line1: `AWS · ${aws.account || "account"}`, line2: role ? `${role} role` : null };
    }
    if (aws.status === "validating") return { state: "checking", title: "Signing in", line1: "validating credentials…" };
    if (aws.status === "error") return { state: "warn", title: "Sign in", line1: "sign-in failed", line2: aws.error || "check credentials / start URL" };
    return { state: "todo", title: "Sign in", line1: "→ Sign in to AWS" };
  }
  // Azure — either the in-app device-code sign-in or a pre-existing `az login`.
  if (azure.status === "authenticated") {
    return { state: "ok", title: "Signed in",
      line1: `Azure · ${subName || "subscription"}`, line2: rgName ? `resource group ${rgName}` : null };
  }
  if (azure.status === "starting" || azure.status === "pending") return { state: "checking", title: "Signing in", line1: "waiting for browser approval…" };
  if (pf?.azure?.loggedIn) {
    return { state: "ok", title: "Signed in",
      line1: `Azure · ${pf.azure.subscriptionName || subName || "subscription"}`, line2: rgName ? `resource group ${rgName}` : "via az login" };
  }
  if (azure.status === "error") return { state: "warn", title: "Sign in", line1: "sign-in failed", line2: azure.error || "try again" };
  return { state: "todo", title: "Sign in", line1: "→ Sign in to Azure" };
}

function accessChip({ authOk, pf }) {
  if (!authOk) return { state: "todo", title: "Access", line1: "waiting on sign-in" };
  const ip = pf?.publicIp?.ip;
  if (ip) return { state: "ok", title: "Access", line1: `Locked to ${ip}`, line2: "(your IP)" };
  return { state: "warn", title: "Access", line1: "couldn't detect your IP",
    line2: "SSH/UI rule may be left open — Re-check" };
}

function capacityChip({ authOk, cloud, form, vmSizes, awsInstanceTypes, regionLabel }) {
  if (!authOk) return { state: "todo", title: "Capacity", line1: "waiting on sign-in" };
  const n = Number(form.sensorCount) || 0;
  const withFleet = form.deployFleet !== false;

  if (cloud === "aws") {
    // Each Fleet + each sensor gets one Elastic IP; the default per-region EIP quota is 5.
    const needed = n + (withFleet ? 1 : 0);
    const DEFAULT_EIP = 5;
    if (needed > DEFAULT_EIP) {
      return { state: "warn", title: "Capacity",
        line1: `Needs ${needed} Elastic IPs`,
        line2: `default limit is ${DEFAULT_EIP} — raise the quota or lower the count` };
    }
    return { state: "ok", title: "Capacity",
      line1: needed ? `Room for ${needed} public IP${needed === 1 ? "" : "s"}` : "Nothing to deploy",
      line2: `${needed} of ${DEFAULT_EIP} default EIPs` };
  }

  // Azure — vmSizes is already filtered to sizes that are available AND within quota in-region.
  if (vmSizes?.loading) return { state: "checking", title: "Capacity", line1: "checking quota…" };
  const list = vmSizes?.list || [];
  if (!list.length) return { state: "todo", title: "Capacity", line1: "pick a resource group / region" };
  const has = (sz) => list.some((s) => s.name === sz);
  const missing = [];
  if (withFleet && form.fleetVmSize && !has(form.fleetVmSize)) missing.push(form.fleetVmSize);
  if (n > 0 && form.sensorVmSize && !has(form.sensorVmSize)) missing.push(form.sensorVmSize);
  if (missing.length) {
    return { state: "warn", title: "Capacity",
      line1: `${missing[0]} not available`,
      line2: `no quota in ${regionLabel || "region"} — pick another size` };
  }
  return { state: "ok", title: "Capacity",
    line1: `Sizes available in ${regionLabel || "region"}`,
    line2: withFleet || n ? "within your quota" : null };
}

export default function Precheck({ cloud, pf, loading, onRefresh, azure, aws, awsSso, form, vmSizes, awsInstanceTypes, regionLabel, subName }) {
  const authOk = cloud === "aws"
    ? aws.status === "valid"
    : (azure.status === "authenticated" || !!pf?.azure?.loggedIn);
  const rgName = cloud === "azure" && form.useExistingRg ? form.existingRgName : "";

  const chips = [
    authChip({ cloud, azure, aws, awsSso, pf, subName, rgName }),
    accessChip({ authOk, pf }),
    capacityChip({ authOk, cloud, form, vmSizes, awsInstanceTypes, regionLabel }),
  ];

  return (
    <div className="card precheck">
      <div className="precheck-head">
        <span className="precheck-title">Readiness</span>
        <button className="btn ghost" onClick={onRefresh} disabled={loading}>
          {loading ? "Checking…" : "Re-check"}
        </button>
      </div>
      <div className="chips">
        {chips.map((c, i) => <Chip key={i} {...c} />)}
      </div>
    </div>
  );
}
