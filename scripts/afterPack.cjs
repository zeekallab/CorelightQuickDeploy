// electron-builder afterPack hook.
//
// Electron ships a default Info.plist that declares camera, microphone, and Bluetooth usage
// descriptions so apps that need those features work out of the box. Corelight Quick Deploy
// uses NONE of them (it's a form that shells out to Terraform + SSH), so those inherited
// declarations are pure noise — and they make the app trip every "looks like spyware"
// heuristic (an unsigned tool asking for camera/mic access). Strip them from the packaged
// app so the build declares only what it actually uses.
//
// macOS only; a no-op on other platforms. Failures here are non-fatal (the app still runs) —
// we log and continue rather than break the whole build over a cosmetic plist cleanup.
"use strict";

const { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

// Keys inherited from Electron's default Info.plist that this app never uses.
const KEYS_TO_STRIP = [
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription",
  "NSBluetoothAlwaysUsageDescription",
  "NSBluetoothPeripheralUsageDescription",
];

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const productName = context.packager.appInfo.productFilename;
  const plist = join(context.appOutDir, `${productName}.app`, "Contents", "Info.plist");
  if (!existsSync(plist)) {
    console.warn(`[afterPack] Info.plist not found at ${plist} — skipping permission strip.`);
    return;
  }

  for (const key of KEYS_TO_STRIP) {
    try {
      // Delete only if present; PlistBuddy errors on a missing key, which we treat as "already gone".
      execFileSync("/usr/libexec/PlistBuddy", ["-c", `Delete :${key}`, plist], { stdio: "pipe" });
      console.log(`[afterPack] removed ${key} from Info.plist`);
    } catch {
      /* key absent — nothing to remove */
    }
  }
};
