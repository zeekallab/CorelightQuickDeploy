// Minimal Corelight Fleet REST client. Cookie-based auth (login sets __Host-Authorization),
// TLS verification off because the Fleet cert's CN is the server_sslname, not the IP/FQDN we
// reach it on (same as the proven `curl -sk` recipe). Used to mint per-sensor pairing tokens.
import https from "node:https";
import { URL } from "node:url";

const agent = new https.Agent({ rejectUnauthorized: false });

function request(baseUrl, path, { method = "GET", body, cookies } = {}) {
  const u = new URL(path, baseUrl);
  const payload = body ? JSON.stringify(body) : null;
  const headers = { Accept: "application/json" };
  if (payload) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(payload);
  }
  if (cookies) headers["Cookie"] = cookies;

  return new Promise((resolve, reject) => {
    const req = https.request(
      u,
      { method, agent, headers, timeout: 30000 },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          const setCookie = res.headers["set-cookie"] || [];
          resolve({ status: res.statusCode, body: data, setCookie });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error(`Fleet API timeout: ${method} ${path}`)); });
    if (payload) req.write(payload);
    req.end();
  });
}

// Collapse Set-Cookie headers to a single "name=value; name2=value2" Cookie string.
function cookieHeader(setCookie) {
  return setCookie.map((c) => c.split(";")[0]).join("; ");
}

export async function login(baseUrl, username, password) {
  const r = await request(baseUrl, "/fleet/v1/login", { method: "POST", body: { username, password } });
  if (r.status !== 200) throw new Error(`Fleet login failed (HTTP ${r.status})`);
  const cookies = cookieHeader(r.setCookie);
  if (!cookies) throw new Error("Fleet login returned no auth cookie");
  return cookies;
}

// Mint a TETHERED sensor + pairing token. Returns { uid, server_sslname, tethering_token }.
export async function createSensor(baseUrl, cookies, name) {
  const r = await request(baseUrl, "/fleet/v1/sensor/catalog", {
    method: "POST",
    cookies,
    body: { name, provider: "TETHERED" },
  });
  if (r.status < 200 || r.status >= 300) throw new Error(`create sensor "${name}" failed (HTTP ${r.status}): ${r.body.slice(0, 200)}`);
  let d;
  try { d = JSON.parse(r.body); } catch { throw new Error(`create sensor "${name}": bad JSON response`); }
  if (!d.tethering_token) throw new Error(`create sensor "${name}": no tethering_token in response`);
  return { uid: d.uid, server_sslname: d.server_sslname, tethering_token: d.tethering_token };
}
