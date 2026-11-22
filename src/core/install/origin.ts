import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type InstallOriginKind = "runner-cache" | "plugin-cache" | "registry" | "checkout";

export interface InstallOrigin {
  readonly kind: InstallOriginKind;
  readonly root: string;
  readonly version: string;
}

export const PERMANENT_INSTALL_COMMAND = "bun add -g open-second-brain";

export function assertNotRunnerCache(origin: InstallOrigin | undefined): void {
  if (origin?.kind === "runner-cache") {
    throw new Error(
      `Open Second Brain is running from a temporary package-runner cache. Install it permanently with \`${PERMANENT_INSTALL_COMMAND}\`, then retry.`,
    );
  }
}

const RUNNER_CACHE_PATHS = [["_npx"], ["install", "cache"]] as const;

function pathSegments(root: string): string[] {
  return root
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .map((part) => part.toLowerCase());
}

function hasSequence(parts: readonly string[], sequence: readonly string[]): boolean {
  return parts.some((part, index) =>
    sequence.every((value, offset) => parts[index + offset] === value),
  );
}

export function underPluginCache(root: string): boolean {
  return hasSequence(pathSegments(root), ["plugins", "cache"]);
}

export function classifyOrigin(root: string): InstallOriginKind {
  const parts = pathSegments(root);
  if (RUNNER_CACHE_PATHS.some((sequence) => hasSequence(parts, sequence))) return "runner-cache";
  if (underPluginCache(root)) return "plugin-cache";
  if (parts.at(-2) === "node_modules") return "registry";
  return "checkout";
}

function packageRootFrom(start: string): string {
  let current = resolve(start);
  while (true) {
    try {
      const manifest = JSON.parse(readFileSync(join(current, "package.json"), "utf8")) as {
        name?: unknown;
      };
      if (manifest.name === "open-second-brain") return realpathSync(current);
    } catch {
      // Keep looking above directories without a readable package manifest.
    }
    const parent = dirname(current);
    if (parent === current) throw new Error("Could not locate the Open Second Brain package root");
    current = parent;
  }
}

export function installOrigin(): InstallOrigin {
  const root = packageRootFrom(dirname(fileURLToPath(import.meta.url)));
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof manifest.version !== "string")
    throw new Error("Open Second Brain package version is missing");
  return { kind: classifyOrigin(root), root, version: manifest.version };
}
