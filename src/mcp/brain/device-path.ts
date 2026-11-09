/**
 * How a tool result names a path on this machine, at the caller's reach
 * (task 2.10, design D14).
 *
 * Once a machine writes to the brain store only, a tool result can name a
 * path outside the vault: a store shard (an attestation record), the
 * device-local machine state (snapshots, artifacts, payloads, workruns,
 * the digest cache, files restored from the migration backup) or the
 * store and its state directory themselves (`second_brain_status`).
 * {@link vaultRelativeSafe} keeps such a path as it is, and an absolute
 * host path tells a remote caller the home directory, the user name and
 * the layout of this machine.
 *
 * So the one rule, beside `vaultRelativeSafe`:
 *
 *  - a path inside the vault is vault-relative and forward-slash, at
 *    every reach, exactly as `vaultRelativeSafe` answers;
 *  - at local reach (a caller that already holds filesystem-equivalent
 *    access) any other path stays as it is;
 *  - at remote reach a store path is `store:<partition>/<relative path>`,
 *    a device-local path is `local:<relative path>`, and any other
 *    absolute path is {@link REDACTED_DEVICE_PATH}.
 *
 * {@link pathsForCaller} applies the rule to a whole tool result on its
 * way out (`server.ts`), so a field that names a host path as its value
 * (`absolute_path`, `config_path`, a surface list) cannot reach a remote
 * caller even when its tool forgot `toolPath`. It rewrites a string that
 * IS an absolute path under one of this machine's roots (the vault, the
 * store, the device state, the home, the temp, the config and the human
 * view folders), and every such path a longer string mentions (a check
 * message, a warning, error prose, a resource body). A string that is
 * itself JSON text is rewritten parsed and serialized again, so a path it
 * spells with escapes (a Windows path's doubled backslashes) is found too. Only those roots are matched,
 * each as a whole path segment: a path that merely looks like one (a URL
 * path, `/etc/hosts`, another user's home quoted in a note) stays as it
 * is. The operator's
 * `expose_host_paths` keeps every path raw.
 */

import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, posix, relative, resolve } from "node:path";

import { resolveExposeHostPaths } from "../../core/config.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../core/graph/transport-reach.ts";
import { toPosix } from "../../core/path-safety.ts";
import { deviceLocalStateRoot } from "../../core/state/machine-state.ts";
import {
  isPathInside,
  isPathInsideResolved,
  resolveConfiguredStoreRoot,
  storesStateDir,
} from "../../core/store/store-paths.ts";
import { processDirsEnv } from "../../core/platform-dirs.ts";
import { configuredViewTargetDir } from "../../core/view/target.ts";
import { redactErrorForCaller } from "../error-redaction.ts";
import { contextReach, contextVault, type ServerContext } from "../tool-contract.ts";
import { vaultRelativeSafe } from "./shared.ts";

/** Prefix of a path inside the brain store: `store:<partition>/<relative path>`. */
export const STORE_PATH_PREFIX = "store:";

/** Prefix of a path in this machine's device-local state: `local:<relative path>`. */
export const LOCAL_PATH_PREFIX = "local:";

/** What a remote caller is told for an absolute path that is neither. */
export const REDACTED_DEVICE_PATH = "<device-path>";

/** The roots a remote answer is told relative to, most specific first. */
interface DeviceRoot {
  readonly root: string;
  readonly prefix: string;
}

function deviceRoots(configPath: string | undefined): DeviceRoot[] {
  const roots: DeviceRoot[] = [];
  // Each root is best effort: a config that cannot be read names no
  // store, and the path it would have matched is redacted instead.
  try {
    roots.push({ root: resolveConfiguredStoreRoot(configPath).root, prefix: STORE_PATH_PREFIX });
  } catch {
    // See above.
  }
  try {
    roots.push({ root: deviceLocalStateRoot(configPath), prefix: LOCAL_PATH_PREFIX });
  } catch {
    // See above.
  }
  roots.push({ root: storesStateDir(processDirsEnv()), prefix: LOCAL_PATH_PREFIX });
  return roots;
}

function relativePosix(root: string, target: string): string {
  const rel = toPosix(relative(resolve(root), resolve(target)));
  return rel === "" ? "." : posix.normalize(rel);
}

/**
 * The path `target` as a tool result at `reach` names it. `vault` is the
 * vault the tool serves (`null`: none); `configPath` the machine config
 * the store root comes from (default: the resolved one).
 */
export function reportedPath(
  vault: string | null,
  target: string,
  reach: TransportReach,
  configPath?: string,
): string {
  if (!isAbsolute(target)) return target;
  if (vault !== null && isPathInsideResolved(target, vault, process.platform)) {
    return vaultRelativeSafe(vault, target);
  }
  if (reach === TRANSPORT_REACH.local) return target;
  for (const { root, prefix } of deviceRoots(configPath)) {
    if (isPathInsideResolved(target, root, process.platform)) {
      return `${prefix}${relativePosix(root, target)}`;
    }
  }
  return REDACTED_DEVICE_PATH;
}

/** {@link reportedPath} for the vault, reach and config of a tool's context. */
export function toolPath(ctx: ServerContext, target: string): string {
  return reportedPath(contextVault(ctx), target, contextReach(ctx), ctx.configPath ?? undefined);
}

/**
 * The `store` status block (`second_brain_status`) as a caller at the
 * context's reach may see it: at remote reach the store root, each
 * partition and the device state directory are named by
 * {@link reportedPath}, and the reason of an unusable store is redacted
 * like any error prose. At local reach the block is returned as built.
 */
export function storeStatusForCaller(
  ctx: ServerContext,
  block: Record<string, unknown>,
): Record<string, unknown> {
  const reach = contextReach(ctx);
  if (reach === TRANSPORT_REACH.local) return block;
  const name = (target: unknown): unknown =>
    typeof target === "string" ? toolPath(ctx, target) : target;
  const located = (entry: unknown): unknown =>
    typeof entry === "object" && entry !== null && "path" in entry
      ? { ...entry, path: name((entry as { path: unknown }).path) }
      : entry;
  const out: Record<string, unknown> = { ...block };
  if ("root" in out) out["root"] = located(out["root"]);
  if ("device_state_dir" in out) out["device_state_dir"] = located(out["device_state_dir"]);
  if (Array.isArray(out["partitions"])) out["partitions"] = out["partitions"].map(located);
  if (typeof out["error"] === "string") {
    out["error"] = redactErrorForCaller(out["error"], contextVault(ctx) ?? "", reach);
  }
  return out;
}

/** Every spelling of `path` a value may carry: as given and resolved through links. */
function spellings(path: string): string[] {
  try {
    const real = realpathSync(path);
    return real === path ? [path] : [path, real];
  } catch {
    return [path];
  }
}

/** The roots a host path in a result can sit under, each in every spelling. */
function callerRoots(vault: string | null, configPath: string | undefined): string[] {
  const roots = [homedir(), tmpdir(), ...deviceRoots(configPath).map((r) => r.root)];
  if (vault !== null) roots.push(vault);
  // The human view folder may sit under none of the others; a path in it
  // is redacted like any other device path. Best effort, as above.
  try {
    const view = configuredViewTargetDir(configPath);
    if (view !== null) roots.push(view);
  } catch {
    // An unreadable config names no view folder.
  }
  if (configPath !== undefined) roots.push(dirname(resolve(configPath)));
  // An empty or relative root names no place; a root of `/` (or a drive
  // root) would claim every absolute path.
  return [...new Set(roots.filter((root) => isAbsolute(root)).flatMap(spellings))].filter(
    (root) => resolve(root) !== dirname(resolve(root)),
  );
}

/**
 * Whether the operator asked for raw host paths (`expose_host_paths`, the
 * escape hatch `vault_path` honours too). A config that cannot be read
 * keeps them redacted.
 */
function exposesHostPaths(configPath: string | undefined): boolean {
  try {
    return resolveExposeHostPaths(configPath);
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * `result` with every string that is an absolute path under one of this
 * machine's roots named by {@link reportedPath} at `reach` (see the module
 * header). At local reach the result is returned as it is.
 */
export function pathsForCaller<T>(
  result: T,
  vault: string | null,
  reach: TransportReach,
  configPath?: string,
): T {
  if (reach === TRANSPORT_REACH.local || exposesHostPaths(configPath)) return result;
  let roots: string[] | null = null;
  let mention: RegExp | null = null;
  const named = new Map<string, string>();
  const rootsNow = (): string[] => (roots ??= callerRoots(vault, configPath));
  const report = (path: string): string => {
    const known = named.get(path);
    if (known !== undefined) return known;
    const out = reportedPath(vault, path, reach, configPath);
    named.set(path, out);
    return out;
  };
  const name = (value: string): string => {
    const json = jsonText(value);
    if (json !== null) return json;
    if (isAbsolute(value) && !/[\r\n]/.test(value)) {
      if (rootsNow().some((root) => isPathInside(value, root, process.platform))) {
        // The vault root itself: a field never reads as missing.
        const reported = report(value);
        return reported === "" ? VAULT_IN_PROSE : reported;
      }
    }
    const folded = foldCase(value);
    if (!rootsNow().some((root) => folded.includes(foldCase(root)))) return value;
    mention ??= mentionPattern(rootsNow());
    return value.replace(mention, (token: string) => {
      // Sentence punctuation after a path is not part of it.
      const path = token.replace(/[.:!?]+$/, "");
      const reported = report(path);
      return `${reported === "" ? VAULT_IN_PROSE : reported}${token.slice(path.length)}`;
    });
  };
  // A string that is itself JSON text (a resource body) spells a path with
  // escapes: every backslash of a Windows path doubled, a forward slash
  // possibly as `\/`. Its strings are rewritten parsed, then serialized
  // again in the layout the text had.
  const jsonText = (value: string): string | null => {
    const head = value.trimStart()[0];
    if (head !== "{" && head !== "[") return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
    const walked = walk(parsed);
    if (JSON.stringify(walked) === JSON.stringify(parsed)) return value;
    const trailing = /\r?\n$/.exec(value)?.[0] ?? "";
    return `${JSON.stringify(walked, null, jsonIndent(value))}${trailing}`;
  };
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return name(value);
    if (Array.isArray(value)) return value.map(walk);
    if (!isPlainObject(value)) return value;
    // `Object.fromEntries` defines own properties, so a `__proto__` key a
    // parsed JSON body carries stays a key and never sets a prototype.
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
  };
  return walk(result) as T;
}

/** The indent of a JSON text: the whitespace that opens its second line, if any. */
function jsonIndent(text: string): string | undefined {
  return /^\s*[[{]\r?\n([ \t]+)/.exec(text)?.[1];
}

/** How prose names the vault root itself (its vault-relative form is empty). */
const VAULT_IN_PROSE = "<vault>";

/** Whether paths on this platform's default filesystems ignore case. */
const CASE_FOLDS = process.platform === "win32" || process.platform === "darwin";

/** `text` case folded where the filesystem folds case, as `isPathInside` compares. */
function foldCase(text: string): string {
  return CASE_FOLDS ? text.toLowerCase() : text;
}

/**
 * A path under one of `roots` where it sits in prose: the root as a whole
 * path segment on both sides (so `/home/al` never matches inside
 * `/home/alice`, and `/tmp` never inside `/var/tmp` or a URL path: the
 * root starts the text or follows whitespace, a quote, a bracket, one of
 * `=,;` or a `file://` scheme), then the rest of the path up to whitespace, a quote or a
 * bracket. A backslash continues a path on Windows only; on POSIX it is a
 * character of the text. Case folded where the filesystem folds it.
 * Longest root first, so the most specific one names it.
 */
function mentionPattern(roots: ReadonlyArray<string>): RegExp {
  const win = process.platform === "win32";
  const spelled = new Set<string>();
  for (const root of roots) {
    const trimmed = root.replace(/[\\/]+$/, "");
    spelled.add(trimmed);
    if (win) spelled.add(trimmed.replaceAll("\\", "/"));
  }
  const alternatives = [...spelled]
    .toSorted((a, b) => b.length - a.length)
    .map((root) => root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const sep = win ? "[\\\\/]" : "/";
  const rest = win ? "[^\\s'\"`<>|,;()\\[\\]{}]*" : "[^\\s'\"`<>|,;()\\[\\]{}\\\\]*";
  return new RegExp(
    `(?:(?<=file://)|(?<=file:///)|(?<![^\\s'"\`(\\[{<=,;]))(?:${alternatives.join("|")})(?=$|${sep}|[\\s'"\`:,;()\\[\\]<>{}.!?])(?:${sep}${rest})?`,
    CASE_FOLDS ? "gi" : "g",
  );
}
