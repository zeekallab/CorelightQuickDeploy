// Launch the Electron app with a clean environment.
// Some setups (e.g. an MCP/tooling shell) export ELECTRON_RUN_AS_NODE=1 globally, which
// forces the Electron binary to behave like plain Node — `require("electron")` then returns
// a path string instead of the API and the app can't start. We strip that (and the related
// ELECTRON_NO_ATTACH_CONSOLE) before spawning, so `npm run app:dev` works regardless of the
// ambient environment, on any OS.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electronPath = require("electron"); // the npm wrapper exports the binary path as a string

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const child = spawn(electronPath, [".", ...process.argv.slice(2)], { stdio: "inherit", env });
child.on("close", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error("Failed to launch Electron:", err.message);
  process.exit(1);
});
