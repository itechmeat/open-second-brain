/**
 * Whether this checkout's dependency tree is present, by the launcher's
 * own rule: `scripts/_bun-precheck.sh` stats one probe file under
 * `node_modules` and, when it is missing, runs `bun install
 * --frozen-lockfile` in the checkout (a marketplace replacement can bring
 * the tree without `node_modules`). The probe is read out of that script,
 * so the launcher and a direct self-spawn (`o2b-command.ts`) decide alike;
 * `O2B_SKIP_DEP_BOOTSTRAP` opts out, as there.
 *
 * Node builtins only: the bootstrap entry imports this module before the
 * dependency tree exists.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The launcher's precheck, relative to the checkout. */
export const PRECHECK_SCRIPT = join("scripts", "_bun-precheck.sh");

/** What the precheck runs in the checkout when the tree is missing, after `bun`. */
export const DEPENDENCY_INSTALL_ARGS = Object.freeze(["install", "--frozen-lockfile"]);

/** The probe file the precheck stats, relative to the checkout (`/`-separated), or null. */
export function dependencyProbeOf(precheck: string): string | null {
  const match = /\}\/(node_modules\/[^"\s]+\/package\.json)"/.exec(precheck);
  return match === null ? null : match[1]!;
}

const probes = new Map<string, string | null>();

function probeFor(root: string): string | null {
  if (!probes.has(root)) {
    let text: string;
    try {
      text = readFileSync(join(root, PRECHECK_SCRIPT), "utf8");
    } catch {
      text = "";
    }
    probes.set(root, dependencyProbeOf(text));
  }
  return probes.get(root)!;
}

/**
 * Whether the checkout at `root` lacks its dependency tree: the precheck's
 * probe file is absent and the opt-out is not set. A checkout whose
 * precheck names no probe is taken as present.
 */
export function dependencyTreeMissing(root: string, env: NodeJS.ProcessEnv): boolean {
  if ((env["O2B_SKIP_DEP_BOOTSTRAP"] ?? "") !== "") return false;
  const probe = probeFor(root);
  return probe !== null && !existsSync(join(root, ...probe.split("/")));
}

/** Runs `argv` in `cwd` and answers its exit code. */
export type InstallRunner = (argv: string[], cwd: string) => number;

const runInstall: InstallRunner = (argv, cwd) =>
  spawnSync(argv[0]!, argv.slice(1), {
    cwd,
    // Never stdout: an MCP child serves JSON-RPC there.
    stdio: ["ignore", 2, 2],
    windowsHide: true,
  }).status ?? 1;

/**
 * Install the dependency tree of `root` when it is missing, the way the
 * precheck does, with the runtime of this process (never Bun from PATH).
 * Throws, naming the manual command, when the install fails.
 */
export function ensureDependencyTree(
  root: string,
  env: NodeJS.ProcessEnv,
  run: InstallRunner = runInstall,
): void {
  if (!dependencyTreeMissing(root, env)) return;
  process.stderr.write(
    `o2b: dependency tree missing in this checkout; running 'bun ${DEPENDENCY_INSTALL_ARGS.join(" ")}'...\n`,
  );
  const code = run([process.execPath, ...DEPENDENCY_INSTALL_ARGS], root);
  probes.delete(root);
  if (code !== 0) {
    throw new Error(
      `the Open Second Brain checkout at ${root} has no dependency tree and the automatic ` +
        `'bun ${DEPENDENCY_INSTALL_ARGS.join(" ")}' failed (exit ${code}); run it inside the ` +
        "checkout yourself, then retry",
    );
  }
}
