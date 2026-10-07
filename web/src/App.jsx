import React, { useCallback, useEffect, useRef, useState } from "react";
import Precheck from "./components/Precheck.jsx";
import DeployForm from "./components/DeployForm.jsx";
import LogPanel from "./components/LogPanel.jsx";
import RollbackPrompt from "./components/RollbackPrompt.jsx";
import Results from "./components/Results.jsx";
import { DEFAULTS, AWS_DEFAULTS } from "./constants.js";

const now = () => new Date().toLocaleTimeString();

export default function App() {
  const [pf, setPf] = useState(null);
  const [pfLoading, setPfLoading] = useState(true);
  const [form, setForm] = useState({
    cloud: DEFAULTS.cloud,
    subscriptionId: "",
    // Always deploy into an existing resource group the operator picks (the RBAC-safe path):
    // creating a new RG needs subscription-level write many operators don't have. If they DO
    // have it, they create the RG in Azure and hit Refresh.
    useExistingRg: true,
    existingRgName: "",
    // Shared across clouds: base name for resources + an optional customer tag (Key=Value).
    namePrefix: DEFAULTS.namePrefix,
    resourceTag: "",
    region: DEFAULTS.region,
    vnetCidr: DEFAULTS.vnetCidr,
    fleetVmSize: DEFAULTS.fleetVmSize,
    sensorVmSize: DEFAULTS.sensorVmSize,
    sensorCount: DEFAULTS.sensorCount,
    deployFleet: DEFAULTS.deployFleet,
    communityString: DEFAULTS.communityString,
    fleetRepoToken: "",
    sensorRepoToken: "",
    fleetPem: null,
    sensorLicense: null,
    existingFleetAddr: "",
    existingFleetSslname: "",
    existingFleetUser: "",
    existingFleetPass: "",
    existingFleetTokens: "",
    azureSessionId: "",
    // Azure sensors-only: peer the new sensor VNet to an existing (private) Fleet's VNet.
    peerToFleet: false,
    fleetVnetId: "",
    fleetVnetName: "",
    fleetNsgId: "",
    fleetNsgName: "",
    // --- AWS ---
    awsAuthMode: "sso", // "sso" (IAM Identity Center browser sign-in) | "keys" (paste/ambient)
    awsUseAmbient: false, // (keys mode) use ~/.aws / environment instead of pasted STS creds
    awsAccessKeyId: "",
    awsSecretAccessKey: "",
    awsSessionToken: "",
    // SSO sign-in
    awsSsoStartUrl: "",
    awsSsoRegion: AWS_DEFAULTS.ssoRegion,
    awsSsoSessionId: "",
    awsSsoAccountId: "",
    awsSsoRoleName: "",
    awsRegion: AWS_DEFAULTS.region,
    vpcCidr: AWS_DEFAULTS.vpcCidr,
  });
  const [lines, setLines] = useState([]);
  const [phase, setPhase] = useState("idle");
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false); // STOP clicked: halting + tearing down
  const [results, setResults] = useState(null);
  // Failure-recovery rollback: offered only when a deploy fails after infra was created.
  const [rollback, setRollback] = useState({ available: false, running: false, done: false, error: null, dismissed: false });
  const [lastRunId, setLastRunId] = useState(null);
  // In-app Azure sign-in (device code) — replaces the az CLI dependency.
  const [azure, setAzure] = useState({ status: "idle", sessionId: null, userCode: null, verificationUri: null, message: null, user: null, subscriptions: [], error: null });
  // Existing resource groups the operator can pick from (for RG-scoped Contributor access).
  const [rgs, setRgs] = useState({ loading: false, error: null, list: [] });
  // VM sizes actually deployable in the target region (available + within quota).
  const [vmSizes, setVmSizes] = useState({ loading: false, error: null, list: [] });
  const sizedForRef = useRef(null); // location we last defaulted the size pickers for

  // --- AWS: credential validation + region / instance-type discovery (mirrors the Azure hooks). ---
  const [aws, setAws] = useState({ status: "idle", account: null, arn: null, error: null });
  const [awsRegions, setAwsRegions] = useState({ loading: false, error: null, list: [] });
  const [awsInstanceTypes, setAwsInstanceTypes] = useState({ loading: false, error: null, list: [] });
  const awsSizedForRef = useRef(null); // region we last defaulted the instance-type pickers for
  // AWS IAM Identity Center (SSO) browser sign-in — the analog of the Azure device-code state.
  const [awsSso, setAwsSso] = useState({ status: "idle", sessionId: null, userCode: null, verificationUri: null, verificationUriComplete: null, error: null, accounts: [], accountsLoading: false, selecting: false, selected: null });

  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // Azure "peer to existing Fleet": discover the Fleet's VNet/NSG from its private IP, then let
  // the operator confirm. On confirm we stash the ids in the form; the backend peers on deploy.
  const [fleetPeer, setFleetPeer] = useState({ loading: false, error: null, info: null });
  const discoverFleet = async (fleetIp) => {
    if (!form.azureSessionId) { setFleetPeer({ loading: false, error: "Sign in to Azure first.", info: null }); return; }
    if (!form.subscriptionId) { setFleetPeer({ loading: false, error: "Pick a subscription first.", info: null }); return; }
    setFleetPeer({ loading: true, error: null, info: null });
    try {
      const r = await fetch("/api/azure/fleet/discover", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: form.azureSessionId, subscriptionId: form.subscriptionId, fleetIp }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setFleetPeer({ loading: false, error: null, info: data });
    } catch (e) {
      setFleetPeer({ loading: false, error: String(e.message || e), info: null });
    }
  };
  const confirmPeer = (info) => {
    setForm((f) => ({ ...f, peerToFleet: true, fleetVnetId: info.vnetId, fleetVnetName: info.vnetName, fleetNsgId: info.nsgId || "", fleetNsgName: info.nsgName || "" }));
  };
  const cancelPeer = () => {
    setForm((f) => ({ ...f, peerToFleet: false, fleetVnetId: "", fleetVnetName: "", fleetNsgId: "", fleetNsgName: "" }));
    setFleetPeer({ loading: false, error: null, info: null });
  };

  // The creds identity POSTed to the AWS discovery/validation endpoints. SSO → send the session
  // id (creds are minted server-side); ambient → send nothing (~/.aws / env chain); otherwise
  // send the pasted STS creds.
  const awsCredsBody = useCallback(() => {
    if (form.awsAuthMode === "sso") return form.awsSsoSessionId ? { ssoSessionId: form.awsSsoSessionId } : {};
    return form.awsUseAmbient
      ? {}
      : { accessKeyId: form.awsAccessKeyId, secretAccessKey: form.awsSecretAccessKey, sessionToken: form.awsSessionToken };
  }, [form.awsAuthMode, form.awsSsoSessionId, form.awsUseAmbient, form.awsAccessKeyId, form.awsSecretAccessKey, form.awsSessionToken]);

  // Start an AWS SSO browser sign-in; the polling effect below drives it to completion.
  const startAwsSso = useCallback(async () => {
    setAwsSso((s) => ({ ...s, status: "starting", error: null, accounts: [], selected: null }));
    try {
      const r = await fetch("/api/aws/sso/start", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startUrl: form.awsSsoStartUrl, region: form.awsSsoRegion }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setAwsSso((s) => ({ ...s, status: "pending", sessionId: data.sessionId, userCode: data.userCode, verificationUri: data.verificationUri, verificationUriComplete: data.verificationUriComplete }));
      setForm((f) => ({ ...f, awsSsoSessionId: data.sessionId, awsSsoAccountId: "", awsSsoRoleName: "" }));
    } catch (e) {
      setAwsSso((s) => ({ ...s, status: "error", error: e.message }));
    }
  }, [form.awsSsoStartUrl, form.awsSsoRegion]);

  // Load the accounts + roles this sign-in can use (analog of Azure subscription discovery).
  const loadAwsAccounts = useCallback(async (sessionId) => {
    setAwsSso((s) => ({ ...s, accountsLoading: true }));
    try {
      const r = await fetch(`/api/aws/sso/accounts?sessionId=${encodeURIComponent(sessionId)}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setAwsSso((s) => ({ ...s, accountsLoading: false, accounts: data.accounts || [] }));
    } catch (e) {
      setAwsSso((s) => ({ ...s, accountsLoading: false, error: e.message }));
    }
  }, []);

  // Poll SSO sign-in status; on success, discover accounts.
  useEffect(() => {
    if (awsSso.status !== "pending" || !awsSso.sessionId) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/aws/sso/status?sessionId=${encodeURIComponent(awsSso.sessionId)}`);
        const st = await r.json();
        if (stop) return;
        if (st.status === "authenticated") {
          setAwsSso((s) => ({ ...s, status: "authenticated" }));
          loadAwsAccounts(awsSso.sessionId);
        } else if (st.status === "error" || st.status === "unknown") {
          setAwsSso((s) => ({ ...s, status: "error", error: st.error || "sign-in failed" }));
        }
      } catch { /* transient; keep polling */ }
    };
    const iv = setInterval(tick, 2500);
    tick();
    return () => { stop = true; clearInterval(iv); };
  }, [awsSso.status, awsSso.sessionId, loadAwsAccounts]);

  // Confirm an account+role choice → backend mints role creds and caches them for the deploy.
  const selectAwsRole = useCallback(async (accountId, roleName) => {
    setAwsSso((s) => ({ ...s, selecting: true, error: null }));
    try {
      const r = await fetch("/api/aws/sso/select-role", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: form.awsSsoSessionId, accountId, roleName }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setForm((f) => ({ ...f, awsSsoAccountId: accountId, awsSsoRoleName: roleName }));
      setAwsSso((s) => ({ ...s, selecting: false, selected: { accountId, roleName, expiration: data.expiration } }));
      // Role picked → we now have working creds: validate + discover regions/types.
      validateAws();
    } catch (e) {
      setAwsSso((s) => ({ ...s, selecting: false, error: e.message }));
    }
  }, [form.awsSsoSessionId]);

  // Validate creds via STS GetCallerIdentity → show account/ARN, then load regions.
  const validateAws = useCallback(async () => {
    setAws({ status: "validating", account: null, arn: null, error: null });
    try {
      const r = await fetch("/api/aws/creds/validate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...awsCredsBody(), region: form.awsRegion }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setAws({ status: "valid", account: data.account, arn: data.arn, error: null });
      loadAwsRegions();
    } catch (e) {
      setAws({ status: "error", account: null, arn: null, error: e.message });
    }
  }, [awsCredsBody, form.awsRegion]);

  const loadAwsRegions = useCallback(async () => {
    setAwsRegions({ loading: true, error: null, list: [] });
    try {
      const r = await fetch("/api/aws/regions", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(awsCredsBody()),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setAwsRegions({ loading: false, error: null, list: data.regions || [] });
    } catch (e) {
      setAwsRegions({ loading: false, error: e.message, list: [] });
    }
  }, [awsCredsBody]);

  const loadAwsInstanceTypes = useCallback(async () => {
    if (!form.awsRegion) { setAwsInstanceTypes({ loading: false, error: null, list: [] }); return; }
    setAwsInstanceTypes({ loading: true, error: null, list: [] });
    try {
      const r = await fetch("/api/aws/instance-types", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...awsCredsBody(), region: form.awsRegion }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      const list = data.instanceTypes || [];
      setAwsInstanceTypes({ loading: false, error: null, list });
      // Default both pickers to the smallest available type the first time we see this region.
      if (list.length && awsSizedForRef.current !== form.awsRegion) {
        awsSizedForRef.current = form.awsRegion;
        setForm((f) => ({ ...f, fleetVmSize: list[0].name, sensorVmSize: list[0].name }));
      }
    } catch (e) {
      setAwsInstanceTypes({ loading: false, error: e.message, list: [] });
    }
  }, [awsCredsBody, form.awsRegion]);

  // Once creds validate, (re)load instance types whenever the chosen region changes.
  useEffect(() => {
    if (form.cloud === "aws" && aws.status === "valid" && form.awsRegion) loadAwsInstanceTypes();
  }, [form.cloud, aws.status, form.awsRegion, loadAwsInstanceTypes]);

  // The deploy actually lands in the selected resource group's region — VM availability and
  // quota are per-region, so size discovery keys off that (falling back to the form region).
  const targetLocation = (rgs.list.find((g) => g.name === form.existingRgName)?.location) || form.region;

  // Fetch the resource groups visible in the selected subscription (via sign-in session or az CLI).
  const loadResourceGroups = useCallback(async () => {
    const subscriptionId = form.subscriptionId;
    if (!subscriptionId) { setRgs({ loading: false, error: "Enter or select a subscription first.", list: [] }); return; }
    setRgs({ loading: true, error: null, list: [] });
    try {
      const qs = new URLSearchParams({ subscriptionId, sessionId: form.azureSessionId || "" });
      const r = await fetch(`/api/azure/resourcegroups?${qs}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setRgs({ loading: false, error: null, list: data.resourceGroups || [] });
    } catch (e) {
      setRgs({ loading: false, error: e.message, list: [] });
    }
  }, [form.subscriptionId, form.azureSessionId]);

  // Fetch the deployable VM sizes for the target region (available + within quota).
  const loadVmSizes = useCallback(async () => {
    const subscriptionId = form.subscriptionId;
    if (!subscriptionId || !targetLocation) { setVmSizes({ loading: false, error: null, list: [] }); return; }
    setVmSizes({ loading: true, error: null, list: [] });
    try {
      const qs = new URLSearchParams({ subscriptionId, sessionId: form.azureSessionId || "", location: targetLocation });
      const r = await fetch(`/api/azure/vmsizes?${qs}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      const list = data.vmSizes || [];
      setVmSizes({ loading: false, error: null, list });
      // Default both pickers to the SMALLEST available size the first time we see this region
      // (and whenever the region changes). Later manual choices for the same region are kept.
      if (list.length && sizedForRef.current !== targetLocation) {
        sizedForRef.current = targetLocation;
        setForm((f) => ({ ...f, fleetVmSize: list[0].name, sensorVmSize: list[0].name }));
      }
    } catch (e) {
      setVmSizes({ loading: false, error: e.message, list: [] });
    }
  }, [form.subscriptionId, form.azureSessionId, targetLocation]);

  // Kick off a device-code sign-in; the polling effect below drives it to completion.
  const startAzureLogin = useCallback(async () => {
    setAzure((a) => ({ ...a, status: "starting", error: null }));
    try {
      const r = await fetch("/api/azure/login/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setAzure((a) => ({ ...a, status: "pending", sessionId: data.sessionId, userCode: data.userCode, verificationUri: data.verificationUri, message: data.message }));
    } catch (e) {
      setAzure((a) => ({ ...a, status: "error", error: e.message }));
    }
  }, []);

  // Poll sign-in status while pending; on success, load subscriptions and record the session.
  useEffect(() => {
    if (azure.status !== "pending" || !azure.sessionId) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/azure/login/status?sessionId=${encodeURIComponent(azure.sessionId)}`);
        const st = await r.json();
        if (stop) return;
        if (st.status === "authenticated") {
          const sr = await fetch(`/api/azure/subscriptions?sessionId=${encodeURIComponent(azure.sessionId)}`);
          const sd = await sr.json();
          const subs = sd.subscriptions || [];
          setAzure((a) => ({ ...a, status: "authenticated", user: st.user, subscriptions: subs }));
          setForm((f) => ({ ...f, azureSessionId: azure.sessionId, subscriptionId: f.subscriptionId || subs[0]?.subscriptionId || "" }));
        } else if (st.status === "error" || st.status === "unknown") {
          setAzure((a) => ({ ...a, status: "error", error: st.error || "sign-in failed" }));
        }
      } catch { /* transient; keep polling */ }
    };
    const iv = setInterval(tick, 2500);
    tick();
    return () => { stop = true; clearInterval(iv); };
  }, [azure.status, azure.sessionId]);

  const loadPreflight = useCallback(async () => {
    setPfLoading(true);
    try {
      const r = await fetch("/api/preflight");
      const data = await r.json();
      setPf(data);
      // Prefill subscription from the logged-in az session if the field is empty.
      setForm((f) => (f.subscriptionId || !data?.azure?.subscriptionId ? f : { ...f, subscriptionId: data.azure.subscriptionId }));
    } catch (e) {
      setPf({ ready: false, terraform: { installed: false, error: String(e) }, azure: { loggedIn: false }, publicIp: {} });
    } finally {
      setPfLoading(false);
    }
  }, []);

  useEffect(() => { loadPreflight(); }, [loadPreflight]);

  // Auto-load resource groups whenever a subscription becomes known (from preflight, sign-in,
  // or manual entry) so the picker is populated without an extra click.
  useEffect(() => {
    if (form.subscriptionId) loadResourceGroups();
  }, [form.subscriptionId, form.azureSessionId, loadResourceGroups]);

  // Load deployable VM sizes once we know both the subscription and the target region.
  useEffect(() => {
    if (form.subscriptionId && targetLocation) loadVmSizes();
  }, [form.subscriptionId, targetLocation, loadVmSizes]);

  const addLine = (l) => setLines((prev) => [...prev, { ts: now(), ...l }]);

  // Read a File as base64 (no data: prefix) for JSON upload.
  const fileToB64 = (file) =>
    new Promise((resolve) => {
      if (!file) return resolve(null);
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(",")[1] || null);
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(file);
    });

  // dryRun=true → terraform plan only (safe preview, no resources created).
  const onDeploy = async (dryRun = false) => {
    setLines([]);
    setResults(null);
    setRollback({ available: false, running: false, done: false, error: null, dismissed: false });
    setLastRunId(null);
    setStopping(false);
    setRunning(true);
    setPhase("starting");
    addLine({ level: "info", line: dryRun ? "Starting preview (terraform plan)…" : "Starting deployment…" });

    // 1. POST the form to create a run. Uploads travel as base64 (plan skips them).
    let runId;
    try {
      const [fleetPemB64, sensorLicenseB64] = dryRun
        ? [null, null]
        : await Promise.all([fileToB64(form.fleetPem), fileToB64(form.sensorLicense)]);
      // Fields shared by every cloud (Fleet/sensor bring-up, tokens, licensing).
      const shared = {
        cloud: form.cloud,
        namePrefix: form.namePrefix,
        resourceTag: form.resourceTag,
        fleetVmSize: form.fleetVmSize,
        sensorVmSize: form.sensorVmSize,
        sensorCount: Number(form.sensorCount),
        deployFleet: form.deployFleet,
        communityString: form.communityString,
        fleetRepoToken: form.fleetRepoToken,
        sensorRepoToken: form.sensorRepoToken,
        fleetPemB64,
        sensorLicenseB64,
        existingFleetAddr: form.existingFleetAddr,
        existingFleetSslname: form.existingFleetSslname,
        existingFleetUser: form.existingFleetUser,
        existingFleetPass: form.existingFleetPass,
        existingFleetTokens: form.existingFleetTokens,
        publicIp: pf?.publicIp?.ip || null,
        dryRun,
      };
      const cloudFields = form.cloud === "aws"
        ? {
            region: form.awsRegion,
            vpcCidr: form.vpcCidr,
            // Auth: an SSO sign-in (creds minted server-side from the session) takes precedence;
            // otherwise pasted STS creds, or omit → backend uses the ambient ~/.aws / env chain.
            ...(form.awsAuthMode === "sso"
              ? { awsSsoSessionId: form.awsSsoSessionId }
              : (form.awsUseAmbient ? {} : {
                  awsAccessKeyId: form.awsAccessKeyId,
                  awsSecretAccessKey: form.awsSecretAccessKey,
                  awsSessionToken: form.awsSessionToken,
                })),
          }
        : {
            subscriptionId: form.subscriptionId,
            useExistingRg: form.useExistingRg,
            existingRgName: form.existingRgName,
            region: form.region,
            vnetCidr: form.vnetCidr,
            azureSessionId: form.azureSessionId,
            // Sensors-only peering to an existing (private) Fleet, if the operator set it up.
            peerToFleet: form.peerToFleet,
            fleetVnetId: form.fleetVnetId,
            fleetNsgId: form.fleetNsgId,
          };
      const r = await fetch("/api/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...shared, ...cloudFields }),
      });
      const data = await r.json();
      if (!r.ok) {
        // Pre-deploy freshness check rejected the run: the in-app Azure sign-in expired.
        // Re-arm the "Sign in to Azure" button and show why, instead of proceeding.
        if (data.reauth) setAzure((a) => ({ ...a, status: "idle", error: data.error }));
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      runId = data.runId;
      setLastRunId(runId);
    } catch (e) {
      addLine({ level: "error", line: `Could not start run: ${e.message}` });
      setRunning(false);
      setPhase("error");
      return;
    }

    // 2. Attach to the SSE stream for that run.
    const es = new EventSource(`/api/deploy/stream?runId=${encodeURIComponent(runId)}`);
    es.addEventListener("log", (e) => addLine(JSON.parse(e.data)));
    es.addEventListener("status", (e) => setPhase(JSON.parse(e.data).phase));
    es.addEventListener("results", (e) => setResults(JSON.parse(e.data)));
    es.addEventListener("rollback", (e) => {
      if (JSON.parse(e.data).available) setRollback((r) => ({ ...r, available: true }));
    });
    es.addEventListener("end", () => { es.close(); setRunning(false); setStopping(false); });
    es.onerror = () => { es.close(); setRunning(false); setStopping(false); };
  };

  // STOP: halt the running deploy and delete what it created so far. The destroy logs stream
  // over the SAME deploy EventSource we're already watching, so we just fire the request; the
  // stream's own "end" event flips running/stopping off when the teardown finishes.
  const onStop = async () => {
    if (!lastRunId || stopping) return;
    setStopping(true);
    setPhase("stopping");
    addLine({ level: "warn", line: "Stop requested — halting and cleaning up resources created so far…" });
    try {
      const r = await fetch(`/api/deploy/stop?runId=${encodeURIComponent(lastRunId)}`, { method: "POST" });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${r.status}`);
      }
    } catch (e) {
      addLine({ level: "error", line: `Stop request failed: ${e.message}` });
      setStopping(false);
    }
  };

  // Start a rollback for the failed run: destroy everything it created, streamed to the log.
  const onRollback = () => {
    if (!lastRunId) return;
    setRollback((r) => ({ ...r, running: true, error: null }));
    setPhase("rollback");
    const es = new EventSource(`/api/deploy/rollback/stream?runId=${encodeURIComponent(lastRunId)}`);
    es.addEventListener("log", (e) => addLine(JSON.parse(e.data)));
    es.addEventListener("status", (e) => setPhase(JSON.parse(e.data).phase));
    es.addEventListener("end", (e) => {
      es.close();
      const status = JSON.parse(e.data).status;
      setRollback((r) => ({ ...r, running: false, done: status === "destroyed", error: status === "rollback-error" ? "Teardown failed — see the log." : null }));
    });
    es.onerror = () => { es.close(); setRollback((r) => ({ ...r, running: false })); };
  };

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1><span className="brand">Corelight</span> Quick Deploy</h1>
          <p className="muted">
            One-button Fleet Manager + sensor deployment ·{" "}
            <span className="badge" title={`Built ${new Date(__BUILD_TIME__).toLocaleString()}`}>
              v{__APP_VERSION__} · built {new Date(__BUILD_TIME__).toLocaleDateString()} {new Date(__BUILD_TIME__).toLocaleTimeString()}
            </span>
          </p>
        </div>
      </header>

      <main className="layout">
        <div className="col">
          <Precheck
            cloud={form.cloud}
            pf={pf}
            loading={pfLoading}
            onRefresh={loadPreflight}
            azure={azure}
            aws={aws}
            awsSso={awsSso}
            form={form}
            vmSizes={vmSizes}
            awsInstanceTypes={awsInstanceTypes}
            regionLabel={form.cloud === "aws" ? form.awsRegion : targetLocation}
            subName={(azure.subscriptions.find((s) => s.subscriptionId === form.subscriptionId)?.displayName) || form.subscriptionId}
          />
          <DeployForm form={form} setField={setField} onDeploy={onDeploy} running={running} stopping={stopping} onStop={onStop} azure={azure} onAzureLogin={startAzureLogin} rgs={rgs} onLoadResourceGroups={loadResourceGroups} vmSizes={vmSizes} onLoadVmSizes={loadVmSizes} aws={aws} onValidateAws={validateAws} awsRegions={awsRegions} onLoadAwsRegions={loadAwsRegions} awsInstanceTypes={awsInstanceTypes} onLoadAwsInstanceTypes={loadAwsInstanceTypes} awsSso={awsSso} onAwsSsoLogin={startAwsSso} onSelectAwsRole={selectAwsRole} fleetPeer={fleetPeer} onDiscoverFleet={discoverFleet} onConfirmPeer={confirmPeer} onCancelPeer={cancelPeer} />
        </div>
        <div className="col">
          <LogPanel lines={lines} phase={phase} running={running} />
          {rollback.available && !rollback.dismissed && (
            <RollbackPrompt
              rollback={rollback}
              onRollback={onRollback}
              onDismiss={() => setRollback((r) => ({ ...r, dismissed: true }))}
            />
          )}
          {results && <Results data={results} teardown={rollback} onTeardown={onRollback} />}
        </div>
      </main>
    </div>
  );
}
