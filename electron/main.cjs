// Electron main process (P4 zero-prereq packaging).
// We keep the existing Express + SSE server exactly as-is and simply run it inside Electron,
// then point a BrowserWindow at http://127.0.0.1:PORT. This reuses the whole app (API, SSE,
// static UI) with no rewrite. Electron carries its own Node runtime, and Terraform + the
// module source ship as unpacked resources — so a packaged build needs nothing preinstalled.
const { app, BrowserWindow, shell, Menu } = require("electron");
const path = require("node:path");
const url = require("node:url");
const http = require("node:http");
const { execSync } = require("node:child_process");

const PORT = Number(process.env.PORT || 8787);
const HOST = "127.0.0.1";

// Safety net: a stray async error (e.g. an SSH socket reset during bring-up) must never crash
// the app or pop Electron's "Uncaught Exception" dialog. Deploy errors are already surfaced in
// the run log; anything that slips past that is logged to the console, not fatal.
process.on("uncaughtException", (err) => {
  console.error("[cqd] uncaughtException (ignored):", err?.stack || err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[cqd] unhandledRejection (ignored):", reason);
});

// A GUI app launched from Finder/Dock inherits a stripped-down PATH (roughly
// /usr/bin:/bin:/usr/sbin:/sbin) that omits Homebrew, /usr/local/bin, pyenv, etc. — so the
// Azure CLI (`az`) the operator installed and `az login`-ed in a terminal is invisible to
// us, and the CLI auth fallback would wrongly report "no Azure CLI session". Load the real
// PATH from the user's login+interactive shell (best effort), and always make sure the
// common install dirs are present. macOS/Linux only; Windows already has a sane PATH.
function fixPath() {
  if (process.platform === "win32") return;
  try {
    const shellBin = process.env.SHELL || "/bin/zsh";
    const out = execSync(`${shellBin} -ilc 'command -p printf "%s" "$PATH"'`, { encoding: "utf8", timeout: 5000 });
    if (out && out.includes("/")) process.env.PATH = out.trim();
  } catch {
    // Interactive shell unavailable or slow — fall through to the common-dirs guarantee.
  }
  const current = (process.env.PATH || "").split(":");
  for (const p of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]) {
    if (!current.includes(p)) { current.push(p); }
  }
  process.env.PATH = current.filter(Boolean).join(":");
}
fixPath();

// Tell the server where its resources and writable workspace live when packaged (the code
// itself is read-only inside app.asar). In dev these stay unset → repo-root paths.
if (app.isPackaged) {
  process.env.CQD_RESOURCES_PATH = process.resourcesPath;
  process.env.CQD_TF_MODULE = path.join(process.resourcesPath, "terraform");
  process.env.CQD_RUNS_DIR = path.join(app.getPath("userData"), "runs");
}
process.env.SERVE_STATIC = "1";
process.env.PORT = String(PORT);

function serverEntry() {
  const base = app.isPackaged ? app.getAppPath() : path.join(__dirname, "..");
  return path.join(base, "server", "index.js");
}

// The server is ESM; import it (its module side-effect starts listening).
function startServer() {
  return import(url.pathToFileURL(serverEntry()).href);
}

function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get({ host: HOST, port: PORT, path: "/api/health" }, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      });
      req.on("error", retry);
    };
    const retry = () => (Date.now() > deadline ? reject(new Error("server did not become healthy")) : setTimeout(tryOnce, 300));
    tryOnce();
  });
}

// A standard application menu. Beyond looking normal, the `editMenu` role is what
// REGISTERS the Cut/Copy/Paste/Select-All keyboard accelerators (Cmd/Ctrl+C/V/X/A) —
// without a menu that carries these roles, paste into form fields silently does nothing.
function buildAppMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Right-click Cut/Copy/Paste/Select-All in editable fields and on selected text.
function attachContextMenu(win) {
  win.webContents.on("context-menu", (_e, params) => {
    const { editFlags, isEditable, selectionText } = params;
    if (!isEditable && !selectionText) return;
    const items = [];
    if (editFlags.canCut) items.push({ role: "cut" });
    if (editFlags.canCopy) items.push({ role: "copy" });
    if (editFlags.canPaste) items.push({ role: "paste" });
    if (items.length) items.push({ type: "separator" });
    items.push({ role: "selectAll" });
    Menu.buildFromTemplate(items).popup({ window: win });
  });
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1240,
    height: 920,
    title: "Corelight Quick Deploy",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  // Open external links (e.g. the Azure device-login page) in the system browser.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: "deny" };
  });
  attachContextMenu(win);
  await win.loadURL(`http://${HOST}:${PORT}/`);
}

app.whenReady().then(async () => {
  buildAppMenu();
  await startServer();
  await waitForHealth();
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
