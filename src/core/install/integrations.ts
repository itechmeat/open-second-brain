import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { readManifest } from "./manifest.ts";

/** Integrations recorded for this vault or present in the Hermes plugin home. */
export function installedIntegrations(vault: string | null): ReadonlySet<string> {
  const installed = new Set<string>();
  if (vault !== null) {
    try {
      for (const target of Object.keys(readManifest(vault).installs)) installed.add(target);
    } catch {
      // A broken sidecar cannot make the read-only uninstall plan fail.
    }
  }
  const hermesHome = process.env["HERMES_HOME"] || join(homedir(), ".hermes");
  const plugin = join(hermesHome, "plugins", "open-second-brain");
  try {
    if (existsSync(plugin) && statSync(plugin).isDirectory()) installed.add("hermes");
  } catch {
    // Missing, unreadable, and non-directory plugin paths mean not installed.
  }
  return installed;
}
