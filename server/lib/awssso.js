// AWS IAM Identity Center (SSO) browser sign-in — the AWS analog of the Azure device-code flow
// in azureauth.js. Mirrors that UX: the operator clicks "Sign in", approves in the browser, and
// the app discovers which AWS ACCOUNTS + ROLES they can use (the analog of Azure subscriptions),
// then mints SHORT-LIVED role credentials on demand. Secrets never leave the backend — the
// frontend only ever sees account/role names + an expiry.
//
// Flow (OIDC device authorization grant):
//   RegisterClient → StartDeviceAuthorization → (user approves) → CreateToken (poll)
//   → ListAccounts / ListAccountRoles → GetRoleCredentials.
//
// This works for any customer whose AWS is on IAM Identity Center (AWS's recommended path). For
// customers on classic IAM users, the paste-STS / ambient path in awsauth.js remains the fallback.
import { randomUUID } from "node:crypto";
import {
  SSOOIDCClient, RegisterClientCommand, StartDeviceAuthorizationCommand, CreateTokenCommand,
} from "@aws-sdk/client-sso-oidc";
import {
  SSOClient, ListAccountsCommand, ListAccountRolesCommand, GetRoleCredentialsCommand,
} from "@aws-sdk/client-sso";

const DEFAULT_SSO_REGION = "us-east-1"; // where most Identity Center instances are homed
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

// sessionId → { startUrl, region, clientId, clientSecret, deviceCode, interval, expiresAt,
//               status: "pending"|"authenticated"|"error", error, accessToken, tokenExpiresAt,
//               roleCreds: { accountId, roleName, creds, expiration } }
const sessions = new Map();

// Begin a browser sign-in. Returns the user code + verification URL for the UI to display, and
// kicks off background polling (CreateToken) that flips the session to "authenticated".
export async function startSsoLogin({ startUrl, region } = {}) {
  if (!startUrl) throw new Error("An IAM Identity Center start URL is required (e.g. https://your-org.awsapps.com/start).");
  const ssoRegion = region || DEFAULT_SSO_REGION;
  const oidc = new SSOOIDCClient({ region: ssoRegion });

  const reg = await oidc.send(new RegisterClientCommand({
    clientName: "corelight-quick-deploy",
    clientType: "public",
  }));

  let auth;
  try {
    auth = await oidc.send(new StartDeviceAuthorizationCommand({
      clientId: reg.clientId,
      clientSecret: reg.clientSecret,
      startUrl,
    }));
  } catch (e) {
    throw new Error(`Couldn't start AWS SSO sign-in: ${friendly(e)} (check the start URL and SSO region).`);
  }

  const sessionId = randomUUID();
  const now = Date.now();
  sessions.set(sessionId, {
    startUrl,
    region: ssoRegion,
    clientId: reg.clientId,
    clientSecret: reg.clientSecret,
    deviceCode: auth.deviceCode,
    interval: Math.max(1, auth.interval || 5),
    expiresAt: now + (auth.expiresIn || 600) * 1000,
    status: "pending",
    error: null,
    accessToken: null,
    tokenExpiresAt: 0,
    roleCreds: null,
  });

  pollForToken(sessionId, oidc); // background; updates the session

  return {
    sessionId,
    userCode: auth.userCode,
    verificationUri: auth.verificationUri,
    verificationUriComplete: auth.verificationUriComplete,
    interval: auth.interval || 5,
    expiresIn: auth.expiresIn || 600,
  };
}

// Poll CreateToken until the user approves (or the code expires). AuthorizationPending = keep
// waiting; SlowDown = back off; anything else = terminal.
function pollForToken(sessionId, oidc) {
  const s = sessions.get(sessionId);
  if (!s || s.status !== "pending") return;
  if (Date.now() > s.expiresAt) {
    s.status = "error";
    s.error = "Sign-in code expired before it was approved. Start over.";
    return;
  }
  const attempt = async () => {
    const sess = sessions.get(sessionId);
    if (!sess || sess.status !== "pending") return;
    try {
      const tok = await oidc.send(new CreateTokenCommand({
        clientId: sess.clientId,
        clientSecret: sess.clientSecret,
        grantType: DEVICE_GRANT,
        deviceCode: sess.deviceCode,
      }));
      sess.accessToken = tok.accessToken;
      sess.tokenExpiresAt = Date.now() + (tok.expiresIn || 3600) * 1000;
      sess.status = "authenticated";
    } catch (e) {
      const name = e?.name || "";
      if (name === "AuthorizationPendingException") {
        setTimeout(() => pollForToken(sessionId, oidc), sess.interval * 1000);
      } else if (name === "SlowDownException") {
        sess.interval += 5;
        setTimeout(() => pollForToken(sessionId, oidc), sess.interval * 1000);
      } else if (name === "ExpiredTokenException") {
        sess.status = "error";
        sess.error = "Sign-in code expired before it was approved. Start over.";
      } else {
        sess.status = "error";
        sess.error = friendly(e);
      }
    }
  };
  setTimeout(attempt, s.interval * 1000);
}

export function getSsoStatus(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return { status: "unknown", error: "Unknown or expired sign-in session." };
  return { status: s.status, error: s.error || null };
}

// Discover the accounts + roles this sign-in can assume (the analog of Azure subscriptions).
export async function listSsoAccounts(sessionId) {
  const s = requireAuthed(sessionId);
  const sso = new SSOClient({ region: s.region });

  const accounts = [];
  let nextToken;
  do {
    const out = await sso.send(new ListAccountsCommand({ accessToken: s.accessToken, nextToken }));
    accounts.push(...(out.accountList || []));
    nextToken = out.nextToken;
  } while (nextToken);

  // For each account, list the roles the user can assume.
  const result = [];
  for (const a of accounts) {
    const roles = [];
    let rt;
    do {
      const out = await sso.send(new ListAccountRolesCommand({ accessToken: s.accessToken, accountId: a.accountId, nextToken: rt }));
      roles.push(...((out.roleList || []).map((r) => r.roleName)));
      rt = out.nextToken;
    } while (rt);
    result.push({ accountId: a.accountId, accountName: a.accountName, emailAddress: a.emailAddress, roles });
  }
  result.sort((x, y) => (x.accountName || "").localeCompare(y.accountName || ""));
  return result;
}

// Record the operator's account+role choice and mint the first set of role credentials (proves
// the choice works and warms the cache). Returns only non-secret metadata for the UI.
export async function selectSsoRole(sessionId, accountId, roleName) {
  requireAuthed(sessionId);
  if (!accountId || !roleName) throw new Error("Pick both an account and a role.");
  const creds = await mintRoleCreds(sessionId, accountId, roleName);
  return { accountId, roleName, expiration: creds.expiration };
}

// Resolve usable STS credentials for a signed-in SSO session, minting/refreshing as needed.
// Returns { accessKeyId, secretAccessKey, sessionToken } — the shape awsauth.js expects.
export async function credsFromSso(sessionId) {
  const s = requireAuthed(sessionId);
  if (!s.roleCreds) throw new Error("No AWS account/role selected yet for this sign-in.");
  const { accountId, roleName, creds, expiration } = s.roleCreds;
  // Refresh a bit before expiry so a deploy doesn't lose creds mid-run.
  if (!creds || (expiration && expiration - Date.now() < 5 * 60 * 1000)) {
    return await mintRoleCreds(sessionId, accountId, roleName);
  }
  return creds;
}

async function mintRoleCreds(sessionId, accountId, roleName) {
  const s = requireAuthed(sessionId);
  const sso = new SSOClient({ region: s.region });
  let out;
  try {
    out = await sso.send(new GetRoleCredentialsCommand({ accessToken: s.accessToken, accountId, roleName }));
  } catch (e) {
    throw new Error(`Couldn't get credentials for ${roleName} in ${accountId}: ${friendly(e)}`);
  }
  const rc = out.roleCredentials || {};
  const creds = { accessKeyId: rc.accessKeyId, secretAccessKey: rc.secretAccessKey, sessionToken: rc.sessionToken };
  s.roleCreds = { accountId, roleName, creds, expiration: rc.expiration || 0 };
  return creds;
}

function requireAuthed(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error("Unknown or expired AWS SSO session — sign in again.");
  if (s.status !== "authenticated") throw new Error("AWS SSO sign-in isn't complete yet.");
  if (s.tokenExpiresAt && Date.now() > s.tokenExpiresAt) {
    s.status = "error";
    s.error = "AWS SSO session expired.";
    throw new Error("Your AWS SSO session expired — sign in again.");
  }
  return s;
}

function friendly(e) {
  return String(e?.message || e?.name || e);
}
