// The single deploy form. Kept intentionally short — most settings are defaulted.
import React from "react";
import { CLOUD_PROVIDERS, VM_SIZES, AWS_REGIONS, AWS_INSTANCE_TYPES } from "../constants.js";

function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export default function DeployForm({
  form, setField, onDeploy, running, stopping = false, onStop,
  azure = { status: "idle" }, onAzureLogin,
  rgs = { loading: false, error: null, list: [] }, onLoadResourceGroups,
  vmSizes = { loading: false, error: null, list: [] }, onLoadVmSizes,
  aws = { status: "idle" }, onValidateAws,
  awsRegions = { loading: false, error: null, list: [] }, onLoadAwsRegions,
  awsInstanceTypes = { loading: false, error: null, list: [] }, onLoadAwsInstanceTypes,
  awsSso = { status: "idle", accounts: [] }, onAwsSsoLogin, onSelectAwsRole,
  fleetPeer = { loading: false, error: null, info: null }, onDiscoverFleet, onConfirmPeer, onCancelPeer,
}) {
  const set = (k) => (e) => setField(k, e.target.type === "checkbox" ? e.target.checked : e.target.value);
  const setFile = (k) => (e) => setField(k, e.target.files?.[0] || null);
  const cloud = form.cloud || "azure";
  const isAzure = cloud === "azure";
  const isAws = cloud === "aws";

  // Size/instance-type picker source: live-polled sizes when we have them (only ones that are
  // available + within quota / offered in the region), otherwise the built-in fallback list.
  // SENSOR HARD FLOOR: the sensor's RKE2 + workload stack cannot schedule on <4 vCPU (deploy fails
  // with "Insufficient cpu" → corelightctl exit 6 → rollback), so sub-4-vCPU sizes are dropped from
  // the SENSOR picker. The Fleet is lighter — 2 vCPU is acceptable — so its picker keeps them.
  const MIN_SENSOR_VCPU = 4;
  const liveSizes = isAws ? awsInstanceTypes : vmSizes;
  const fallbackSizes = isAws ? AWS_INSTANCE_TYPES : VM_SIZES;
  const mapSize = (s) => ({ value: s.name, label: `${s.name} — ${s.vCPUs} vCPU / ${Math.round(s.memoryGB)} GiB` });
  const haveLive = liveSizes.list && liveSizes.list.length;
  const fleetSizeOptions = haveLive ? liveSizes.list.map(mapSize) : fallbackSizes;
  const sensorSizeOptions = haveLive
    ? liveSizes.list.filter((s) => (s.vCPUs ?? MIN_SENSOR_VCPU) >= MIN_SENSOR_VCPU).map(mapSize)
    : fallbackSizes;
  // A picked size might not be in the given list — surface it so the <select> still shows it.
  const withCurrent = (val, options) =>
    options.some((o) => o.value === val) || !val ? options : [{ value: val, label: `${val} (not offered here)` }, ...options];

  // Warn when the existing-Fleet pairing address is a private/RFC1918 (or loopback/link-local) IP.
  // Sensors deploy into a brand-new, isolated VNet/VPC, so a private Fleet address is almost never
  // routable from them — unless the operator has set up VNet/VPC peering or a VPN to the Fleet's
  // network. (This is exactly the 172.19.0.x "Fleet's internal Docker IP" pairing trap.)
  const fleetHost = String(form.existingFleetAddr || "").trim().replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  const isPrivateHost = (h) =>
    /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^169\.254\./.test(h) || /^127\./.test(h) || h === "localhost";
  const fleetAddrPrivate = form.deployFleet === false && !!fleetHost && isPrivateHost(fleetHost);
  const onRetrySizes = () => (isAws ? onLoadAwsInstanceTypes?.() : onLoadVmSizes?.());
  const sizesNote = liveSizes.loading
    ? <p className="muted small">Checking which sizes are available in this region…</p>
    : liveSizes.error
      ? <p className="warn small">⚠ Couldn’t load live sizes ({liveSizes.error}). Showing defaults. <button className="btn ghost" type="button" onClick={onRetrySizes}>Retry</button></p>
      : liveSizes.list && liveSizes.list.length
        ? <p className="muted small">Showing only sizes available in this region — smallest is selected by default.</p>
        : null;

  // Deploy is allowed for any enabled cloud.
  const canSubmit = CLOUD_PROVIDERS.find((c) => c.value === cloud)?.enabled;
  const awsCredsMissing = !form.awsUseAmbient && !(form.awsAccessKeyId && form.awsSecretAccessKey);

  return (
    <form className="card" onSubmit={(e) => { e.preventDefault(); if (canSubmit) onDeploy(); }}>
      <h2>Deploy</h2>

      <Field label="Cloud provider" hint="Where the Fleet Manager and sensors will be deployed.">
        <div className="cloud-tabs">
          {CLOUD_PROVIDERS.map((c) => (
            <button
              key={c.value}
              type="button"
              className={`cloud-tab${cloud === c.value ? " active" : ""}${c.enabled ? "" : " disabled"}`}
              aria-pressed={cloud === c.value}
              onClick={() => setField("cloud", c.value)}
            >
              {c.label}
              {c.badge && <span className="pill">{c.badge}</span>}
            </button>
          ))}
        </div>
      </Field>

      {/* ---------------- Cloud-specific: auth + placement ---------------- */}
      {isAzure && (
        <>
          <div className="subpanel">
            <span className="field-label">Azure sign-in</span>
            {azure.status === "authenticated" ? (
              <>
                <p className="muted small">✓ Signed in{azure.user ? <> as <strong>{azure.user}</strong></> : null}. A short-lived service principal is created automatically at deploy time — no Azure CLI needed.</p>
                <Field label="Subscription" hint="Where the Fleet + sensors will be deployed.">
                  <select value={form.subscriptionId} onChange={set("subscriptionId")}>
                    {(azure.subscriptions || []).map((s) => (
                      <option key={s.subscriptionId} value={s.subscriptionId}>{s.displayName} ({s.subscriptionId})</option>
                    ))}
                  </select>
                </Field>
              </>
            ) : azure.status === "pending" ? (
              <p className="muted small">
                Open <a href={azure.verificationUri} target="_blank" rel="noreferrer">{azure.verificationUri}</a> and enter code <code>{azure.userCode}</code>, then finish signing in. Waiting…
              </p>
            ) : (
              <>
                <p className="muted small">Sign in with your browser (no <code>az</code> CLI required), or enter a subscription ID below if you already have <code>az login</code> active.</p>
                <button className="btn" type="button" disabled={azure.status === "starting"} onClick={() => onAzureLogin?.()}>
                  {azure.status === "starting" ? "Starting…" : "Sign in to Azure"}
                </button>
                {azure.status === "error" && <p className="warn small">⚠ {azure.error}</p>}
                <Field label="Azure subscription ID" hint="Only needed if you're relying on an existing `az login` session.">
                  <input value={form.subscriptionId} onChange={set("subscriptionId")} placeholder="00000000-0000-0000-0000-000000000000" />
                </Field>
              </>
            )}
          </div>

          <Field label="Resource group" hint="Deployed into this resource group, in its region. Don't see yours? Create it in Azure, then Refresh.">
            <div className="row-inline">
              <select value={form.existingRgName} onChange={set("existingRgName")} disabled={rgs.loading}>
                <option value="">{rgs.loading ? "Loading…" : "— select a resource group —"}</option>
                {rgs.list.map((g) => <option key={g.name} value={g.name}>{g.name} ({g.location})</option>)}
              </select>
              <button className="btn ghost" type="button" disabled={rgs.loading} onClick={() => onLoadResourceGroups?.()}>Refresh</button>
            </div>
          </Field>
          {rgs.error && <p className="warn small">⚠ {rgs.error}</p>}
          {!rgs.loading && !rgs.error && rgs.list.length === 0 && <p className="muted small">No resource groups found — check the subscription, or sign in / <code>az login</code>, then Refresh.</p>}
        </>
      )}

      {isAws && (
        <>
          <div className="subpanel">
            <span className="field-label">AWS credentials</span>
            {/* Auth mode: browser sign-in (IAM Identity Center / SSO) vs. access keys. */}
            <div className="row-inline" style={{ gap: "1rem" }}>
              <label className="check">
                <input type="radio" name="awsAuthMode" checked={form.awsAuthMode === "sso"} onChange={() => set("awsAuthMode")({ target: { value: "sso" } })} />
                <span>Sign in with browser (IAM Identity Center)</span>
              </label>
              <label className="check">
                <input type="radio" name="awsAuthMode" checked={form.awsAuthMode === "keys"} onChange={() => set("awsAuthMode")({ target: { value: "keys" } })} />
                <span>Access keys</span>
              </label>
            </div>

            {form.awsAuthMode === "sso" ? (
              <>
                <p className="muted small">Sign in once — the app discovers the AWS accounts and roles you can use, then requests short-lived credentials on your behalf. Nothing is stored; your keys never leave AWS.</p>
                <Field label="IAM Identity Center start URL" hint="Your org’s SSO portal, e.g. https://your-org.awsapps.com/start">
                  <input value={form.awsSsoStartUrl} onChange={set("awsSsoStartUrl")} autoComplete="off" placeholder="https://your-org.awsapps.com/start" />
                </Field>
                <Field label="SSO region" hint="Where your Identity Center instance is homed (often us-east-1).">
                  <input value={form.awsSsoRegion} onChange={set("awsSsoRegion")} autoComplete="off" placeholder="us-east-1" />
                </Field>
                <button className="btn" type="button" disabled={!form.awsSsoStartUrl || awsSso.status === "starting" || awsSso.status === "pending"} onClick={() => onAwsSsoLogin?.()}>
                  {awsSso.status === "starting" ? "Starting…" : awsSso.status === "pending" ? "Waiting for approval…" : "Sign in"}
                </button>

                {awsSso.status === "pending" && awsSso.userCode && (
                  <p className="muted small">
                    Approve in your browser: {" "}
                    <a href={awsSso.verificationUriComplete || awsSso.verificationUri} target="_blank" rel="noreferrer">{awsSso.verificationUri || "open sign-in page"}</a>
                    {" "}— confirm the code <strong>{awsSso.userCode}</strong>.
                  </p>
                )}
                {awsSso.status === "error" && <p className="warn small">⚠ {awsSso.error}</p>}

                {awsSso.status === "authenticated" && (
                  <>
                    {awsSso.accountsLoading && <p className="muted small">Discovering accounts…</p>}
                    {!awsSso.accountsLoading && awsSso.accounts.length > 0 && (
                      <>
                        <Field label="Account">
                          <select value={form.awsSsoAccountId} onChange={set("awsSsoAccountId")}>
                            <option value="">Select an account…</option>
                            {awsSso.accounts.map((a) => (
                              <option key={a.accountId} value={a.accountId}>{a.accountName ? `${a.accountName} (${a.accountId})` : a.accountId}</option>
                            ))}
                          </select>
                        </Field>
                        {form.awsSsoAccountId && (() => {
                          const acct = awsSso.accounts.find((a) => a.accountId === form.awsSsoAccountId);
                          const roles = acct?.roles || [];
                          return (
                            <Field label="Role">
                              <div className="row-inline">
                                <select value={form.awsSsoRoleName} onChange={set("awsSsoRoleName")}>
                                  <option value="">Select a role…</option>
                                  {roles.map((r) => <option key={r} value={r}>{r}</option>)}
                                </select>
                                <button className="btn" type="button" disabled={!form.awsSsoRoleName || awsSso.selecting} onClick={() => onSelectAwsRole?.(form.awsSsoAccountId, form.awsSsoRoleName)}>
                                  {awsSso.selecting ? "Selecting…" : "Use this role"}
                                </button>
                              </div>
                            </Field>
                          );
                        })()}
                        {awsSso.selected && <p className="muted small">✓ Using <strong>{awsSso.selected.roleName}</strong> in account {awsSso.selected.accountId}.</p>}
                      </>
                    )}
                  </>
                )}
              </>
            ) : (
              <>
                <label className="check">
                  <input type="checkbox" checked={form.awsUseAmbient} onChange={set("awsUseAmbient")} />
                  <span>Use my existing AWS profile / environment (<code>~/.aws</code>, <code>AWS_*</code> env)</span>
                </label>
                {!form.awsUseAmbient && (
                  <>
                    <p className="muted small">Paste temporary STS credentials (e.g. from <code>aws sso login</code> / the Identity Center portal). They’re used only for this deploy and are never committed or logged.</p>
                    <Field label="Access key ID"><input value={form.awsAccessKeyId} onChange={set("awsAccessKeyId")} autoComplete="off" placeholder="ASIA…" /></Field>
                    <Field label="Secret access key"><input value={form.awsSecretAccessKey} onChange={set("awsSecretAccessKey")} type="password" autoComplete="off" /></Field>
                    <Field label="Session token" hint="Required for temporary (STS) credentials."><textarea rows="2" value={form.awsSessionToken} onChange={set("awsSessionToken")} /></Field>
                  </>
                )}
              </>
            )}

            {form.awsAuthMode !== "sso" && (
              <button className="btn" type="button" disabled={aws.status === "validating" || awsCredsMissing} onClick={() => onValidateAws?.()}>
                {aws.status === "validating" ? "Validating…" : "Validate credentials"}
              </button>
            )}
            {aws.status === "valid" && <p className="muted small">✓ Valid — account <strong>{aws.account}</strong> ({aws.arn}).</p>}
            {aws.status === "error" && <p className="warn small">⚠ {aws.error}</p>}
          </div>

          <Field label="Region" hint="AWS region for the new VPC, Fleet, and sensors.">
            <div className="row-inline">
              <select value={form.awsRegion} onChange={set("awsRegion")} disabled={awsRegions.loading}>
                {(awsRegions.list && awsRegions.list.length
                  ? awsRegions.list.map((r) => ({ value: r.name, label: r.name }))
                  : AWS_REGIONS
                ).map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
              <button className="btn ghost" type="button" disabled={awsRegions.loading} onClick={() => onLoadAwsRegions?.()}>Refresh</button>
            </div>
          </Field>
          {awsRegions.error && <p className="warn small">⚠ {awsRegions.error}</p>}

          <Field label="VPC CIDR" hint="Address space for the new VPC (management + monitoring subnets are carved from it).">
            <input value={form.vpcCidr} onChange={set("vpcCidr")} placeholder="10.50.0.0/16" />
          </Field>
        </>
      )}

      {/* ---------------- Shared: sizing, Fleet, sensors ---------------- */}
      <Field label={isAws ? "Sensor instance type" : "Sensor VM size"}>
        <select value={form.sensorVmSize} onChange={set("sensorVmSize")} disabled={liveSizes.loading}>
          {withCurrent(form.sensorVmSize, sensorSizeOptions).map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </Field>
      {sizesNote}

      <Field label="Number of sensors">
        <input type="number" min="0" max="20" value={form.sensorCount} onChange={set("sensorCount")} />
      </Field>

      {/* Resource naming + optional tag — kept on one row so it stays compact. */}
      <div className="grid2">
        <Field label="Virtual instance names" hint="What each machine name begins with.">
          <input value={form.namePrefix} onChange={set("namePrefix")} placeholder="corelight" />
        </Field>
        <Field label="Tag (optional)" hint="Tags every resource, e.g. owner=jsmith. Leave empty to skip.">
          <input value={form.resourceTag} onChange={set("resourceTag")} placeholder="Key=Value" />
        </Field>
      </div>
      <p className="muted small" style={{ marginTop: "-6px" }}>
        {(() => {
          const p = (form.namePrefix || "corelight").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "") || "corelight";
          return <>Instances will be named <code>{p}-fleet</code>, <code>{p}-sensor-1</code>, …</>;
        })()}
      </p>
      {isAzure && (
        <Field label="VNet CIDR" hint="Address space for the new sensor VNet — sensors land in the first /24 (e.g. 10.50.0.0/24). Change it if it overlaps your existing networks.">
          <input value={form.vnetCidr} onChange={set("vnetCidr")} placeholder="10.50.0.0/16" />
        </Field>
      )}

      <label className="check">
        <input type="checkbox" checked={form.deployFleet} onChange={set("deployFleet")} />
        <span>Deploy a Fleet Manager server (uncheck to pair sensors to an existing Fleet)</span>
      </label>

      {form.deployFleet ? (
        <>
          <Field label={isAws ? "Fleet instance type" : "Fleet VM size"} hint="Larger is better for Fleet; only sizes available in this region are listed.">
            <select value={form.fleetVmSize} onChange={set("fleetVmSize")} disabled={liveSizes.loading}>
              {withCurrent(form.fleetVmSize, fleetSizeOptions).map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </Field>
          <Field label="Fleet repo token" hint="Your Corelight fleet-stable pull token.">
            <input value={form.fleetRepoToken} onChange={set("fleetRepoToken")} type="password" autoComplete="off" />
          </Field>
          <Field label="Fleet PEM (cert + license)" hint="Combined PEM. Installed on the Fleet server; never leaves your machine except onto your cloud instance.">
            <input type="file" accept=".pem,.crt,.cer" onChange={setFile("fleetPem")} />
          </Field>
          <Field label="Community string">
            <input value={form.communityString} onChange={set("communityString")} />
          </Field>
        </>
      ) : (
        <div className="subpanel">
          <p className="muted small">Existing Fleet — sensors will pair to it. The pairing address is what the sensors reach (its <code>:1443</code>); the REST API is that host on <code>:443</code>.</p>
          <Field label="Fleet pairing address (host:port)" hint="Must be reachable from the new sensor network — a public FQDN/IP, or a private one if routing (peering/VPN) is already in place."><input value={form.existingFleetAddr} onChange={set("existingFleetAddr")} placeholder="fleet.example.com:1443" /></Field>
          {fleetAddrPrivate && !form.peerToFleet && (
            <p className="warn small">
              ⚠ <strong>{fleetHost}</strong> is a private address. Sensors deploy into a new, isolated {isAws ? "VPC" : "VNet"}, so they usually can’t route to a private Fleet IP
              (this is the classic “Fleet’s internal Docker IP” trap). Use the Fleet’s public FQDN/IP on <code>:1443</code> — {isAws ? "or set up VPC peering / a VPN to the Fleet’s network first." : "or let this app peer the two VNets for you (below)."}
            </p>
          )}
          {/* Azure sensors-only: offer to auto-discover the Fleet's VNet/NSG from its private IP and
              peer the new sensor VNet to it (+ open :1443), so pairing works without a public Fleet. */}
          {fleetAddrPrivate && isAzure && (
            <div className="subpanel" style={{ marginTop: 8 }}>
              {!form.peerToFleet ? (
                <>
                  <p className="muted small">
                    <strong>Reach this private Fleet via VNet peering.</strong> Discover the Fleet’s VNet + NSG from <code>{fleetHost}</code>, confirm, and this app will peer the new sensor VNet to it and open the Fleet NSG for <code>:1443</code>. Reversed automatically on rollback.
                  </p>
                  {azure.status !== "authenticated" ? (
                    <p className="warn small">Sign in to Azure (above) to enable peering discovery.</p>
                  ) : (
                    <>
                      <button type="button" className="btn ghost" disabled={fleetPeer.loading} onClick={() => onDiscoverFleet?.(fleetHost)}>
                        {fleetPeer.loading ? "Discovering…" : "Discover Fleet network"}
                      </button>
                      {fleetPeer.error && <p className="warn small">{fleetPeer.error}</p>}
                      {fleetPeer.info && (
                        <div style={{ marginTop: 8 }}>
                          <p className="muted small">
                            Found: VNet <strong>{fleetPeer.info.vnetName}</strong> ({(fleetPeer.info.vnetCidr || []).join(", ") || "—"}) in RG <strong>{fleetPeer.info.vnetRg}</strong>
                            {fleetPeer.info.nsgName ? <> · NSG <strong>{fleetPeer.info.nsgName}</strong></> : <> · <em>no NSG on the Fleet interface</em></>}.
                          </p>
                          <button type="button" className="btn ghost" onClick={() => onConfirmPeer?.(fleetPeer.info)}>Peer to this Fleet on deploy</button>
                        </div>
                      )}
                    </>
                  )}
                </>
              ) : (
                <p className="ok small">
                  ✓ Will peer the sensor VNet to Fleet VNet <strong>{form.fleetVnetName}</strong>{form.fleetNsgName ? <> and open NSG <strong>{form.fleetNsgName}</strong> for :1443</> : null} on deploy.{" "}
                  <button type="button" className="btn ghost" onClick={() => onCancelPeer?.()}>Cancel</button>
                </p>
              )}
            </div>
          )}
          <div className="grid2">
            <Field label="Fleet admin user" hint="Auto-mints a token per sensor."><input value={form.existingFleetUser} onChange={set("existingFleetUser")} autoComplete="off" /></Field>
            <Field label="Fleet admin password"><input value={form.existingFleetPass} onChange={set("existingFleetPass")} type="password" autoComplete="off" /></Field>
          </div>
          <p className="muted small">— or, if you can’t share admin creds, paste pre-minted tokens instead —</p>
          <Field label="server_sslname" hint="Required only when pasting tokens."><input value={form.existingFleetSslname} onChange={set("existingFleetSslname")} placeholder="internal.<...>.corelight.io" /></Field>
          <Field label="Pre-minted pairing tokens" hint="One per sensor (newline/comma separated).">
            <textarea rows="3" value={form.existingFleetTokens} onChange={set("existingFleetTokens")} placeholder="token1&#10;token2" />
          </Field>
        </div>
      )}

      <Field label="Sensor BYOL repo token" hint="Your Corelight sensor-stable pull token.">
        <input value={form.sensorRepoToken} onChange={set("sensorRepoToken")} type="password" autoComplete="off" />
      </Field>
      <Field label="Sensor license" hint="Applied to each sensor.">
        <input type="file" accept=".lic,.license,.txt,.json" onChange={setFile("sensorLicense")} />
      </Field>

      <div className="grid2">
        <button className="btn" type="button" disabled={running} onClick={() => onDeploy(true)}>
          Preview (plan)
        </button>
        {running ? (
          // Live deploy → the primary button becomes a red STOP that halts and tears down
          // everything created so far. Small print keeps showing it's still working.
          <button className="btn stop" type="button" onClick={() => onStop?.()} disabled={stopping} title="Stop the deployment and delete the resources it has created so far">
            <span className="stop-main">{stopping ? "STOPPING…" : "STOP"}</span>
            <span className="stop-sub">{stopping ? "cleaning up resources…" : "working… — click to stop & delete"}</span>
          </button>
        ) : (
          <button className="btn primary" type="submit" disabled={!canSubmit}>Deploy</button>
        )}
      </div>
      <p className="muted small">
        <strong>Preview</strong> runs <code>terraform plan</code> (safe, no resources). <strong>Deploy</strong> builds the {isAws ? "VPC, subnets, security groups, Elastic IPs," : "VNet, NSG,"} Fleet + sensor instances, brings up the Fleet Manager (install → PEM → start → admin), then for each sensor mints a pairing token, installs corelight-sensor, writes <code>corelightctl.yaml</code>, and deploys + pairs it. Results show the Fleet login and each sensor’s pairing status.
      </p>
    </form>
  );
}
