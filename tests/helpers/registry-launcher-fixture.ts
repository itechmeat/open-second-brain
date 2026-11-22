import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");

export function makeLauncherRoot(requiredBun = Bun.version): string {
  const root = mkdtempSync(join(tmpdir(), "o2b-registry-launcher-"));
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "src", "cli"), { recursive: true });
  mkdirSync(join(root, "hooks"), { recursive: true });
  try {
    for (const name of ["_launch.js", "o2b.js", "o2b-mcp.js", "o2b-hook.js"]) {
      cpSync(join(REPO, "bin", name), join(root, "bin", name));
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ engines: { bun: `>=${requiredBun}` } }),
  );
  const fixture = `
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.REGISTRY_ARGS_FILE) fs.writeFileSync(process.env.REGISTRY_ARGS_FILE, JSON.stringify(args));
if (process.env.REGISTRY_DYLD_FILE) fs.writeFileSync(process.env.REGISTRY_DYLD_FILE, JSON.stringify(process.env.DYLD_LIBRARY_PATH ?? null));
if (process.env.REGISTRY_HANG === "1") {
  if (process.env.REGISTRY_PID_FILE) fs.writeFileSync(process.env.REGISTRY_PID_FILE, String(process.pid));
  if (process.env.REGISTRY_READY_FILE) fs.writeFileSync(process.env.REGISTRY_READY_FILE, "ready");
  process.on("SIGTERM", () => {
    if (process.env.REGISTRY_SIGNAL_FILE) fs.writeFileSync(process.env.REGISTRY_SIGNAL_FILE, "SIGTERM");
    process.exit(0);
  });
  setInterval(() => {}, 1000);
} else {
  process.exit(Number(process.env.REGISTRY_EXIT_CODE || 0));
}
`;
  writeFileSync(join(root, "src", "cli", "main.ts"), fixture);
  writeFileSync(join(root, "hooks", "session-start.ts"), fixture);
  writeFileSync(join(root, "hooks", "exit-two.ts"), `process.exit(2);\n`);
  return root;
}

export function removeLauncherRoot(root: string): void {
  rmSync(root, { recursive: true, force: true });
}
