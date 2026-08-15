/**
 * Health checks for vault, config, and plugin manifests.
 *
 * Mirrors `src/open_second_brain/doctor.py`. Each `check*` returns a
 * `CheckResult` so callers can aggregate them or surface them through MCP /
 * Hermes / OpenClaw without taking on doctor's logic themselves.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
  closeSync,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";

import { defaultConfigPath, resolveVault } from "./config.ts";
import { statOrAbsent } from "./fs-utils.ts";
import { checkCodegraph } from "./partner/codegraph.ts";
import type { CheckResult } from "./types.ts";

/**
 * Shipped plugin manifests are generated artifacts, not hand-edited files, so
 * a missing / malformed / schema-invalid manifest is repaired by re-syncing
 * the plugin checkout rather than a bespoke per-file edit.
 */
const MANIFEST_FIX = "o2b update";

export function checkVaultWriteable(vault: string): CheckResult {
  if (!existsSync(vault)) {
    return {
      name: "vault_writeable",
      ok: false,
      message: `vault directory missing: ${vault}`,
      fix: `mkdir -p "${vault}"`,
    };
  }
  const probe = join(vault, ".open-second-brain-doctor-test");
  try {
    const fd = openSync(probe, "w");
    closeSync(fd);
    rmSync(probe);
  } catch (exc) {
    return {
      name: "vault_writeable",
      ok: false,
      message: `cannot write to vault: ${(exc as Error).message ?? exc}`,
      fix: `chmod u+rwx "${vault}"`,
    };
  }
  return { name: "vault_writeable", ok: true, message: `vault exists and is writable: ${vault}` };
}

export function checkConfigWriteable(config: string): CheckResult {
  let createdForCheck = false;
  try {
    mkdirSync(dirname(config), { recursive: true });
    if (!existsSync(config)) createdForCheck = true;
    const fd = openSync(config, "a");
    writeSync(fd, "");
    closeSync(fd);
    if (createdForCheck) rmSync(config);
  } catch (exc) {
    return {
      name: "config_writeable",
      ok: false,
      message: `cannot write config ${config}: ${(exc as Error).message ?? exc}`,
      fix: `mkdir -p "${dirname(config)}" && chmod u+rwx "${dirname(config)}"`,
    };
  }
  return { name: "config_writeable", ok: true, message: `config writable: ${config}` };
}

interface ManifestFileProblem {
  /** True when the path was examined and holds no usable file. */
  readonly absent: boolean;
  readonly message: string;
  readonly fix: string;
}

/**
 * Why `path` does not hold a readable manifest file, or null when it does.
 *
 * Doctor's whole output is the difference between a file that is not there
 * and a file that is there and wrong, so it is the one caller that must
 * not ask `isFile`: that probe answers `false` for an absent file AND for
 * one this process cannot stat at all - a parent directory without the
 * execute bit, a symlink loop - so a manifest sitting behind a permission
 * problem was reported as one that had never been generated, under a
 * `o2b update` remedy that regenerates it and changes nothing. The two
 * conditions carry different messages and different fixes.
 */
function manifestFileProblem(path: string): ManifestFileProblem | null {
  let stat: Stats | undefined;
  try {
    stat = statOrAbsent(path);
  } catch (exc) {
    return {
      absent: false,
      message: `unreadable: ${path} (${(exc as Error).message ?? exc})`,
      fix: `chmod u+r "${path}"`,
    };
  }
  if (stat?.isFile() === true) return null;
  return { absent: true, message: `missing: ${path}`, fix: MANIFEST_FIX };
}

interface JsonLoadResult {
  readonly result: CheckResult;
  readonly data: Record<string, unknown> | null;
}

function loadJsonManifest(path: string, name: string): JsonLoadResult {
  const problem = manifestFileProblem(path);
  if (problem !== null) {
    return {
      result: { name, ok: false, message: problem.message, fix: problem.fix },
      data: null,
    };
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (exc) {
    return {
      result: {
        name,
        ok: false,
        message: `invalid JSON: ${path} (${(exc as Error).message})`,
        fix: MANIFEST_FIX,
      },
      data: null,
    };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {
      result: { name, ok: false, message: `invalid manifest object: ${path}`, fix: MANIFEST_FIX },
      data: null,
    };
  }
  return {
    result: { name, ok: true, message: `valid: ${path}` },
    data: data as Record<string, unknown>,
  };
}

export function checkJsonManifest(path: string, name: string): CheckResult {
  return loadJsonManifest(path, name).result;
}

type FieldType = "string" | "list" | ["string", "list"];

function validateRequired(
  data: Record<string, unknown>,
  required: ReadonlyArray<readonly [string, FieldType]>,
): string[] {
  const problems: string[] = [];
  for (const [field, expected] of required) {
    if (!(field in data)) {
      problems.push(`missing ${field}`);
      continue;
    }
    const v = data[field];
    const ok = isOfType(v, expected);
    if (!ok) {
      problems.push(`${field} must be ${typeName(expected)}`);
      continue;
    }
    if (typeof v === "string" && v.trim() === "") {
      problems.push(`${field} must not be empty`);
    } else if (Array.isArray(v) && v.length === 0) {
      problems.push(`${field} must not be empty`);
    }
  }
  return problems;
}

function isOfType(v: unknown, expected: FieldType): boolean {
  if (expected === "string") return typeof v === "string";
  if (expected === "list") return Array.isArray(v);
  return typeof v === "string" || Array.isArray(v);
}

function typeName(expected: FieldType): string {
  if (expected === "string") return "str";
  if (expected === "list") return "list";
  return expected.map((t) => (t === "string" ? "str" : "list")).join("/");
}

export function checkCodexManifest(path: string): CheckResult {
  const { result, data } = loadJsonManifest(path, "codex_manifest");
  if (!data) return result;
  const problems = validateRequired(data, [
    ["name", "string"],
    ["version", "string"],
    ["description", "string"],
    ["skills", "string"],
    ["keywords", "list"],
  ]);
  if (problems.length > 0) {
    return {
      name: "codex_manifest",
      ok: false,
      message: `schema invalid: ${path} (${problems.join("; ")})`,
      fix: MANIFEST_FIX,
    };
  }
  return { name: "codex_manifest", ok: true, message: `valid Codex manifest: ${path}` };
}

export function checkClaudeManifest(path: string): CheckResult {
  const { result, data } = loadJsonManifest(path, "claude_manifest");
  if (!data) return result;
  const problems = validateRequired(data, [
    ["name", "string"],
    ["version", "string"],
    ["description", "string"],
  ]);
  for (const field of ["license", "repository", "homepage"]) {
    if (field in data && typeof data[field] !== "string") {
      problems.push(`${field} must be string`);
    }
  }
  if ("keywords" in data) {
    const kw = data["keywords"];
    if (!Array.isArray(kw) || !kw.every((k) => typeof k === "string")) {
      problems.push("keywords must be list of strings");
    }
  }
  if ("author" in data) {
    const author = data["author"];
    const authorName =
      typeof author === "object" && author !== null
        ? (author as Record<string, unknown>)["name"]
        : null;
    if (
      typeof author !== "object" ||
      author === null ||
      typeof authorName !== "string" ||
      authorName.trim() === ""
    ) {
      problems.push(
        "author must be an object with a non-empty 'name' field " +
          "(legacy string form is rejected by Claude 2.x)",
      );
    }
  }
  if ("commands" in data) {
    problems.push(
      "embedded 'commands' array is deprecated — author slash commands " +
        "as Markdown files under commands/ at plugin root instead",
    );
  }
  if (problems.length > 0) {
    return {
      name: "claude_manifest",
      ok: false,
      message: `schema invalid: ${path} (${problems.join("; ")})`,
      fix: MANIFEST_FIX,
    };
  }
  return { name: "claude_manifest", ok: true, message: `valid Claude manifest: ${path}` };
}

export function checkHermesManifest(path: string): CheckResult {
  const problem = manifestFileProblem(path);
  if (problem !== null) {
    return { name: "hermes_manifest", ok: false, message: problem.message, fix: problem.fix };
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (exc) {
    return {
      name: "hermes_manifest",
      ok: false,
      message: `invalid text: ${path} (${(exc as Error).message ?? exc})`,
      fix: MANIFEST_FIX,
    };
  }
  const required = ["name", "version", "description"];
  const missing: string[] = [];
  for (const field of required) {
    if (!new RegExp(`^${field}\\s*:`, "m").test(text)) missing.push(field);
  }
  if (missing.length > 0) {
    return {
      name: "hermes_manifest",
      ok: false,
      message: `schema invalid: ${path} (missing ${missing.join(", ")})`,
      fix: MANIFEST_FIX,
    };
  }
  return { name: "hermes_manifest", ok: true, message: `readable Hermes manifest: ${path}` };
}

export function checkOpenclawManifest(path: string): CheckResult {
  const { result, data } = loadJsonManifest(path, "openclaw_manifest");
  if (!data) return result;
  const problems: string[] = [];
  if (typeof data["id"] !== "string" || (data["id"] as string).trim() === "") {
    problems.push("missing or empty field 'id'");
  }
  const schema = data["configSchema"];
  if (typeof schema !== "object" || schema === null || Object.keys(schema).length === 0) {
    problems.push("missing or empty field 'configSchema'");
  }
  if (problems.length > 0) {
    return {
      name: "openclaw_manifest",
      ok: false,
      message: `schema invalid: ${path} (${problems.join("; ")})`,
      fix: MANIFEST_FIX,
    };
  }
  return { name: "openclaw_manifest", ok: true, message: `valid OpenClaw manifest: ${path}` };
}

/**
 * Validate the OpenClaw native packaging: a `package.json` with an
 * `openclaw.extensions` array of files that exist on disk.
 */
export function checkOpenclawInstallability(repoRoot: string): CheckResult[] {
  const results: CheckResult[] = [];
  const pkgPath = join(repoRoot, "package.json");
  const { result, data } = loadJsonManifest(pkgPath, "openclaw_package_json");
  results.push(result);
  if (!data) return results;

  const oc = (data["openclaw"] as Record<string, unknown> | undefined) ?? {};
  const extensions = oc["extensions"];
  if (!Array.isArray(extensions) || extensions.length === 0) {
    results.push({
      name: "openclaw_package_json_extensions",
      ok: false,
      message: "package.json missing or empty openclaw.extensions array",
      fix: MANIFEST_FIX,
    });
    return results;
  }
  results.push({
    name: "openclaw_package_json_extensions",
    ok: true,
    message: `package.json declares ${extensions.length} extension(s)`,
  });

  for (const entry of extensions) {
    if (typeof entry !== "string") {
      results.push({
        name: `openclaw_entry_invalid_${typeof entry}`,
        ok: false,
        message: `extension entry must be a string, got: ${typeof entry}`,
        fix: MANIFEST_FIX,
      });
      continue;
    }
    const entryPath = join(repoRoot, entry);
    const problem = manifestFileProblem(entryPath);
    if (problem === null) {
      results.push({
        name: `openclaw_entry_${entry}`,
        ok: true,
        message: `extension entry exists: ${entry}`,
      });
    } else {
      results.push({
        name: `openclaw_entry_${entry}`,
        ok: false,
        message: problem.absent
          ? `missing extension entry: ${entry}`
          : `extension entry ${entry} ${problem.message}`,
        fix: problem.fix,
      });
    }
  }
  return results;
}
// ── Hermes resolver parity ──────────────────────────────────────────────────

const RESOLVER_PARITY = "hermes_resolver_parity";

/**
 * Interpreters tried, in order, to run the plugin's own resolver. Named rather
 * than discovered: `python` is ambiguous on installs that still ship a 2.x
 * under that name, so the versioned name is asked for first.
 */
const PYTHON_CANDIDATES: ReadonlyArray<string> = Object.freeze(["python3", "python"]);

/**
 * Wall-clock budget for the plugin-side probe. The driver reads at most a few
 * small files, so anything near this is a hang, and a doctor that hangs is
 * worse than one that reports it could not measure.
 */
const PLUGIN_RESOLVER_TIMEOUT_MS = 10_000;

/**
 * Runs the PLUGIN's resolver - not a second copy of the core's - and prints
 * one JSON line. Loading `config.py` by file location rather than importing
 * `plugins.hermes` keeps the probe to the module under comparison: a broken
 * bridge or a missing Hermes ABC must not be reported as a resolver
 * disagreement.
 */
const PLUGIN_RESOLVER_DRIVER = [
  "import importlib.util, json, sys",
  "spec = importlib.util.spec_from_file_location('o2b_hermes_config', sys.argv[1])",
  "mod = importlib.util.module_from_spec(spec)",
  "spec.loader.exec_module(mod)",
  "out = {'vault': None, 'error': None}",
  "try:",
  "    out['vault'] = mod.resolve_vault()",
  "except Exception as exc:",
  "    out['error'] = '%s: %s' % (type(exc).__name__, exc)",
  "sys.stdout.write(json.dumps(out))",
].join("\n");

export interface ResolverParityOptions {
  /** Config file both resolvers are pointed at. */
  readonly config?: string | null;
  /** Directory the project-pointer walk-up starts from. */
  readonly cwd?: string;
  /** Checkout that ships `plugins/hermes/`; defaults to this module's own. */
  readonly repoRoot?: string | null;
}

/** Either side's answer: a vault, or the reason there is no answer. */
interface ResolvedSide {
  readonly vault: string | null;
  /** Why this side could not answer; null when it did. */
  readonly undetermined: string | null;
}

/**
 * `<root>/plugins/hermes/config.py`, from an explicit checkout or from this
 * module's own position (`plugins/` ships in the npm package alongside
 * `src/`). Inside the bundled OpenClaw build `import.meta.dir` points at the
 * bundle instead, so the path does not exist and the check reports itself as
 * not applicable - which is correct there: OpenClaw hosts do not load the
 * Hermes plugin.
 */
function pluginResolverPath(repoRoot: string | null | undefined): string {
  const root = repoRoot ?? join(import.meta.dir, "..", "..");
  return join(root, "plugins", "hermes", "config.py");
}

function resolveCoreSide(configPath: string, cwd: string): ResolvedSide {
  try {
    return { vault: resolveVault(configPath, { cwd }), undetermined: null };
  } catch (exc) {
    return { vault: null, undetermined: (exc as Error).message ?? String(exc) };
  }
}

function resolvePluginSide(resolver: string, configPath: string, cwd: string): ResolvedSide {
  const env = { ...process.env, OPEN_SECOND_BRAIN_CONFIG: configPath };
  let lastFailure = "no interpreter was tried";
  for (const bin of PYTHON_CANDIDATES) {
    const proc = spawnSync(bin, ["-c", PLUGIN_RESOLVER_DRIVER, resolver], {
      cwd,
      env,
      encoding: "utf8",
      timeout: PLUGIN_RESOLVER_TIMEOUT_MS,
    });
    if (proc.error !== undefined) {
      // Only "this interpreter is not here" is worth trying the next name
      // for. Anything else - a hang killed by the timeout, a spawn refused -
      // is an answer about the interpreter that IS here.
      if ((proc.error as NodeJS.ErrnoException).code === "ENOENT") {
        lastFailure = `${bin}: ${proc.error.message}`;
        continue;
      }
      return { vault: null, undetermined: `${bin}: ${proc.error.message}` };
    }
    if (proc.status !== 0) {
      const detail = (proc.stderr ?? "").trim().split("\n").at(-1) ?? "";
      return { vault: null, undetermined: `${bin} exited ${proc.status}: ${detail}` };
    }
    let parsed: { vault?: unknown; error?: unknown };
    try {
      parsed = JSON.parse(proc.stdout ?? "") as { vault?: unknown; error?: unknown };
    } catch {
      return { vault: null, undetermined: `${bin} printed no usable answer` };
    }
    if (typeof parsed.error === "string") {
      return { vault: null, undetermined: parsed.error };
    }
    return { vault: typeof parsed.vault === "string" ? parsed.vault : null, undetermined: null };
  }
  return { vault: null, undetermined: `no Python interpreter available (${lastFailure})` };
}

/**
 * Do the two vault resolvers - the TypeScript core's and the Hermes plugin's -
 * agree about this install?
 *
 * The whole of GitHub #130 was that they did not, and that nothing anywhere
 * compared them: `o2b doctor` validated the path IT resolved, the plugin
 * reported the path IT resolved, and a clean doctor coexisted with a "Needs
 * Setup" badge for five weeks without contradiction. This check exists to make
 * that disagreement impossible to hide.
 *
 * Three outcomes, never two. Agreement passes. Disagreement fails and prints
 * both answers. And a side that could not be MEASURED - no Python on the
 * machine, an interpreter that crashed, a config the core refuses to read -
 * fails with that reason, because reporting "clean" on an unmeasured half is
 * the same false confidence the check was written to remove.
 *
 * Returns null - the check does not apply - only when the plugin is not part
 * of this installation at all.
 */
export function checkHermesResolverParity(opts: ResolverParityOptions = {}): CheckResult | null {
  const resolver = pluginResolverPath(opts.repoRoot);
  if (!existsSync(resolver)) return null;

  const configPath = opts.config ?? defaultConfigPath();
  const cwd = opts.cwd ?? process.cwd();
  const core = resolveCoreSide(configPath, cwd);
  const plugin = resolvePluginSide(resolver, configPath, cwd);

  if (core.undetermined !== null && plugin.undetermined !== null) {
    return {
      name: RESOLVER_PARITY,
      ok: false,
      message:
        `neither resolver could answer for ${configPath}: ` +
        `core says ${core.undetermined}; plugin says ${plugin.undetermined}`,
      fix: `o2b doctor --config "${configPath}"`,
    };
  }
  if (core.undetermined !== null) {
    return {
      name: RESOLVER_PARITY,
      ok: false,
      message:
        `the core resolver could not determine a vault (${core.undetermined}), ` +
        `while the Hermes plugin resolved ${plugin.vault ?? "no vault"}`,
      fix: `chmod u+r "${configPath}"`,
    };
  }
  if (plugin.undetermined !== null) {
    return {
      name: RESOLVER_PARITY,
      ok: false,
      message:
        `the Hermes plugin resolver could not be measured (${plugin.undetermined}), ` +
        `so its agreement with the core (${core.vault ?? "no vault"}) is unknown`,
      fix: "install Python 3.11+ so the Hermes plugin resolver can be compared",
    };
  }
  if (core.vault !== plugin.vault) {
    return {
      name: RESOLVER_PARITY,
      ok: false,
      message:
        `vault resolvers disagree for ${configPath}: core resolves ` +
        `${core.vault ?? "no vault"}, Hermes plugin resolves ${plugin.vault ?? "no vault"}`,
      fix: "hermes open-second-brain config",
    };
  }
  return {
    name: RESOLVER_PARITY,
    ok: true,
    message:
      core.vault === null
        ? `both resolvers agree no vault is configured in ${configPath}`
        : `both resolvers agree on the vault: ${core.vault}`,
  };
}

export interface DoctorOptions {
  readonly vault: string;
  readonly config?: string | null;
  readonly repoRoot?: string | null;
  readonly cwd?: string;
  readonly partner?: {
    readonly codegraph?: {
      readonly disabled?: boolean;
      readonly scanExtraPaths?: ReadonlyArray<string>;
    };
  };
}

export function doctor(opts: DoctorOptions): CheckResult[] {
  const results: CheckResult[] = [];
  results.push(checkVaultWriteable(opts.vault));
  if (opts.config) results.push(checkConfigWriteable(opts.config));
  if (opts.repoRoot) {
    const root = opts.repoRoot;
    results.push(checkClaudeManifest(join(root, ".claude-plugin", "plugin.json")));
    results.push(checkCodexManifest(join(root, ".codex-plugin", "plugin.json")));
    results.push(checkHermesManifest(join(root, "plugins", "hermes", "plugin.yaml")));
    results.push(checkOpenclawManifest(join(root, "openclaw.plugin.json")));
    results.push(...checkOpenclawInstallability(root));
  }
  const parity = checkHermesResolverParity({
    config: opts.config,
    cwd: opts.cwd,
    repoRoot: opts.repoRoot,
  });
  if (parity) results.push(parity);
  const cg = checkCodegraph({
    cwd: opts.cwd ?? process.cwd(),
    vault: opts.vault,
    scanExtraPaths: opts.partner?.codegraph?.scanExtraPaths,
    disabled: opts.partner?.codegraph?.disabled,
  });
  if (cg) results.push(cg);
  return results;
}
