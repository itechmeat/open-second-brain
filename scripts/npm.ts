import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export function spawnNpmSync(
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
) {
  let command: string[];
  if (process.platform === "win32") {
    const node = Bun.which("node");
    const npm = Bun.which("npm");
    if (!node || !npm) throw new Error("node and npm are required on PATH");
    const npmCli = join(dirname(npm), "node_modules", "npm", "bin", "npm-cli.js");
    if (!existsSync(npmCli)) throw new Error(`npm JavaScript entry point not found: ${npmCli}`);
    command = [node, npmCli, ...args];
  } else {
    const npm = Bun.which("npm");
    if (!npm) throw new Error("npm is not available on PATH");
    command = [npm, ...args];
  }
  return Bun.spawnSync(command, {
    ...options,
    stdout: "pipe",
    stderr: "pipe",
  });
}
