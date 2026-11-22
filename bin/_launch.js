import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(realpathSync(fileURLToPath(import.meta.url)));
const root = dirname(here);
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

function minimumBun() {
  const match = String(manifest.engines?.bun ?? "").match(/(\d+\.\d+\.\d+)/);
  if (!match) throw new Error("package.json engines.bun must declare a minimum version");
  return match[1];
}

function versionParts(value) {
  return value.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function olderThan(actual, required) {
  const a = versionParts(actual);
  const b = versionParts(required);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

function macosEnvironment(env, command) {
  if (command !== "o2b" && command !== "o2b-mcp") return env;
  const platform = env.O2B_MACOS_FORCE_PLATFORM || process.platform;
  if (platform !== "Darwin" && platform !== "darwin") return env;
  if (Object.hasOwn(env, "DYLD_LIBRARY_PATH")) return env;
  const candidates = env.O2B_MACOS_SQLITE_PREFIXES_OVERRIDE
    ? env.O2B_MACOS_SQLITE_PREFIXES_OVERRIDE.split(":")
    : ["/opt/homebrew/opt/sqlite/lib", "/usr/local/opt/sqlite/lib"];
  const found = candidates.find((candidate) => {
    try {
      return statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  });
  if (found) env.DYLD_LIBRARY_PATH = found;
  return env;
}

export function launch(command, args = process.argv.slice(2)) {
  const hook = command === "o2b-hook";
  let required;
  try {
    required = minimumBun();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = hook ? 0 : 1;
    return;
  }
  if (olderThan(Bun.version, required)) {
    process.stderr.write(`Open Second Brain requires Bun ${required} or newer\n`);
    process.exitCode = hook ? 0 : 1;
    return;
  }

  let entry;
  let childArgs;
  if (hook) {
    const name = args[0];
    if (!name) {
      process.stderr.write("Open Second Brain hook requires a hook name\n");
      process.exitCode = 0;
      return;
    }
    entry = resolve(root, "hooks", `${name}.ts`);
    const hookRelative = relative(resolve(root, "hooks"), entry);
    if (hookRelative.startsWith("..") || isAbsolute(hookRelative) || !existsSync(entry)) {
      process.stderr.write(`Open Second Brain hook not found: ${name}\n`);
      process.exitCode = 0;
      return;
    }
    childArgs = ["run", entry, ...args.slice(1)];
  } else {
    const commandEntries = {
      o2b: ["src/cli/main.ts"],
      "o2b-mcp": ["src/cli/main.ts", "mcp"],
    };
    const prefix = commandEntries[command];
    if (!prefix) {
      process.stderr.write(`Open Second Brain unknown launcher: ${command}\n`);
      process.exitCode = 1;
      return;
    }
    childArgs = ["run", resolve(root, prefix[0]), ...prefix.slice(1), ...args];
  }

  const env = macosEnvironment({ ...process.env }, command);
  let child;
  try {
    child = Bun.spawn([process.execPath, ...childArgs], {
      env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
  } catch (error) {
    process.stderr.write(
      `Open Second Brain ${hook ? "hook" : "command"} failed to start: ${error.message}\n`,
    );
    process.exitCode = hook ? 0 : 1;
    return;
  }

  let signalStatus;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      signalStatus ??= hook ? 0 : 128 + osConstants.signals[signal];
      process.exitCode = signalStatus;
      try {
        child.kill(signal);
      } catch {
        // The child may have exited while the signal was being delivered.
      }
    });
  }
  child.exited
    .then((code) => {
      if (signalStatus !== undefined) {
        process.exitCode = signalStatus;
      } else if (hook && code !== 0) {
        process.stderr.write(`Open Second Brain hook exited with code ${code}\n`);
        process.exitCode = 0;
      } else {
        process.exitCode = code;
      }
    })
    .catch((error) => {
      process.stderr.write(
        `Open Second Brain ${hook ? "hook" : "command"} failed: ${error.message}\n`,
      );
      process.exitCode = hook ? 0 : 1;
    });
}
