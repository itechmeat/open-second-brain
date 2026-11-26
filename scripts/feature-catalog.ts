#!/usr/bin/env bun
/**
 * Feature catalog tooling for Open Second Brain.
 *
 * The catalog (`docs/catalog/`) names what the product does by feature.
 * This script reads the product's public surfaces from CODE, never from
 * the docs, so the catalog can be checked against what actually exists.
 *
 * Usage:
 *   bun run scripts/feature-catalog.ts dump              # every surface as JSON
 *   bun run catalog:build                                # write docs/catalog/INDEX.md
 *   bun run catalog:check                                # exit 1 on any problem
 *
 * The area files (`docs/catalog/<area>.json`) are edited by hand and follow
 * `docs/catalog/feature-catalog.schema.json`; `INDEX.md` is generated from them.
 * The check holds them to the code: every coverable CLI verb, MCP tool,
 * hook script and skill belongs to exactly one feature, every declared
 * setting to at least one, and nothing listed is missing or removed. The
 * collectors below are the only place that knows where a surface is
 * declared; `dump`, the check and its tests all read through them.
 *
 * Every section states how it was collected (`source` and `method`):
 *   - `import`: the declaration is imported and read as data;
 *   - `parse`: a structured file (JSON, YAML front matter) is parsed;
 *   - `scan`: no single declaration exists, so names are collected from
 *     source text by pattern. Such lists say where a name was seen; they
 *     are evidence, not a manifest.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLI_COMMAND_MANIFEST,
  type CliCommandManifest,
  type CliFlagManifest,
} from "../src/cli/command-manifest.ts";
import { BOOTSTRAP_TARGETS } from "../src/cli/bootstrap/targets.ts";
import {
  DREAM_EXECUTOR_SERVER_NAME,
  DREAM_EXECUTOR_TOOLS,
} from "../src/core/brain/dream-queue/dream-session.ts";
import { BRAIN_YAML_KEYS } from "../src/core/brain/policy/settings-keys.ts";
import { STORE_NATIVE_SETTINGS } from "../src/core/brain/policy/settings-names.ts";
import { brainConfigKnownKeys } from "../src/core/brain/policy/validate.ts";
import { HOST_KINDS } from "../src/core/install/host-kinds.ts";
import { REMOVED_TOOLS } from "../src/core/removed-surfaces.ts";
import {
  INSTALL_TARGET_IDS,
  RUNTIME_FACTS,
  SESSION_RUNTIME_IDS,
} from "../src/core/runtime/host-facts.ts";
import { firstLine, surfaceGroup } from "../src/core/surface/descriptor.ts";
import { evaluateToolCapabilities } from "../src/mcp/capabilities.ts";
import { TOOL_SURFACE_PROFILES, resolveToolSurface } from "../src/mcp/profiles.ts";
import { listResourceTemplates, listResources } from "../src/mcp/resources.ts";
import type { ToolDefinition, ToolScope } from "../src/mcp/tool-contract.ts";
import { buildToolTable } from "../src/mcp/tools.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The two MCP servers a plugin registers, by the scope `o2b mcp` gives each. */
const SERVER_BY_SCOPE: Readonly<Record<"full" | "writer", string>> = Object.freeze({
  full: "open-second-brain",
  writer: "open-second-brain-writer",
});

function rel(path: string): string {
  return relative(ROOT, path).split("\\").join("/");
}

function readText(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

/** Order by UTF-16 code units, the same on every host whatever its locale. */
export function byCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------- CLI ----------

interface CliVerb {
  /** Full verb path without the `o2b` root, e.g. `brain writes list`. */
  readonly path: string;
  readonly summary: string;
  /**
   * `leaf`: no modelled subcommands. `runnable-group`: subcommands, and the
   * manifest marks it `runnable` because it also runs by itself (`o2b
   * mcp`). `group`: subcommands and no `runnable`, a namespace.
   */
  readonly kind: "leaf" | "group" | "runnable-group";
  readonly flags: ReadonlyArray<string>;
  /**
   * Positional operations the verb's usage string names, such as `scan`
   * and `apply` for `brain hygiene`. The manifest does not model them, so
   * they come from a scan of `usage: o2b ...` strings in `src/cli/`.
   */
  readonly positional_operations: ReadonlyArray<string>;
}

function flagNames(flags: ReadonlyArray<CliFlagManifest> | undefined): string[] {
  return (flags ?? []).map((f) => f.name);
}

function walkCli(
  commands: ReadonlyArray<CliCommandManifest>,
  prefix: ReadonlyArray<string>,
  out: CliVerb[],
): void {
  for (const c of commands) {
    const parts = [...prefix, c.name];
    const hasChildren = (c.commands?.length ?? 0) > 0;
    const ownFlags = flagNames(c.flags);
    out.push({
      path: parts.join(" "),
      summary: c.summary,
      kind: hasChildren ? (c.runnable === true ? "runnable-group" : "group") : "leaf",
      flags: ownFlags,
      positional_operations: [],
    });
    if (c.commands) walkCli(c.commands, parts, out);
  }
}

function listFiles(dir: string, ext: string): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  const visit = (d: string): void => {
    for (const name of readdirSync(d).toSorted()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) visit(p);
      else if (p.endsWith(ext)) out.push(p);
    }
  };
  visit(abs);
  return out;
}

/**
 * `usage: o2b brain hygiene <scan|apply>` names two operations of the
 * manifest verb `brain hygiene`; `usage: o2b brain tune run --dataset`
 * names one (`run`). Only `<a|b>` alternatives of plain words count, so a
 * placeholder such as `<file|->` or `<id>` is not mistaken for one.
 */
function scanPositionalOperations(verbPaths: ReadonlySet<string>): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const usage = /usage: o2b ([a-z][a-z0-9 |<>-]*)/g;
  const word = /^[a-z][a-z0-9-]*$/;
  for (const file of listFiles("src/cli", ".ts")) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(usage)) {
      const tokens = (m[1] ?? "").trim().split(/\s+/);
      // The longest prefix that is a manifest verb.
      let cut = 0;
      for (let i = tokens.length; i > 0; i--) {
        if (verbPaths.has(tokens.slice(0, i).join(" "))) {
          cut = i;
          break;
        }
      }
      if (cut === 0) continue;
      const verb = tokens.slice(0, cut).join(" ");
      const next = tokens[cut];
      if (next === undefined) continue;
      let ops: string[] = [];
      const alt = /^<([^>]+)>$/.exec(next);
      if (alt !== null) {
        const parts = (alt[1] ?? "").split("|");
        if (parts.length >= 2 && parts.every((p) => word.test(p))) ops = parts;
        // `<verb>` is the namespace placeholder, not an operation.
      } else if (word.test(next)) {
        ops = [next];
      }
      if (ops.length === 0) continue;
      const set = found.get(verb) ?? new Set<string>();
      for (const op of ops) set.add(op);
      found.set(verb, set);
    }
  }
  return found;
}

function collectCli() {
  const walked: CliVerb[] = [];
  walkCli(CLI_COMMAND_MANIFEST.commands, [], walked);
  const operations = scanPositionalOperations(new Set(walked.map((v) => v.path)));
  const verbs = walked.map((v) => ({
    ...v,
    positional_operations: [...(operations.get(v.path) ?? [])].toSorted(),
  }));
  const count = (kind: CliVerb["kind"]): number => verbs.filter((v) => v.kind === kind).length;
  return {
    source: "src/cli/command-manifest.ts (CLI_COMMAND_MANIFEST)",
    method: "import; positional_operations by scan of usage strings in src/cli/",
    root: CLI_COMMAND_MANIFEST.command,
    root_flags: flagNames(CLI_COMMAND_MANIFEST.flags),
    counts: {
      all_nodes: verbs.length,
      leaf: count("leaf"),
      group: count("group"),
      runnable_group: count("runnable-group"),
      /** Leaves plus runnable groups: what the catalog must cover. */
      coverable: count("leaf") + count("runnable-group"),
      top_level: CLI_COMMAND_MANIFEST.commands.length,
      with_positional_operations: verbs.filter((v) => v.positional_operations.length > 0).length,
    },
    verbs,
  };
}

// ---------- MCP ----------

interface ProfileSurface {
  readonly name: string;
  readonly description: string;
  readonly scope: ToolScope;
  /** Listed by `tools/list`. */
  readonly advertised: ReadonlyArray<string>;
  /** Callable through `tools/call`, absent from `tools/list`. */
  readonly hidden: ReadonlyArray<string>;
  /** Not callable on this profile: the capability window withholds them. */
  readonly withheld: ReadonlyArray<string>;
}

function toolNames(tools: ReadonlyArray<ToolDefinition>): string[] {
  return tools.map((t) => t.name).toSorted();
}

function profileSurface(name: string): ProfileSurface {
  const profile = TOOL_SURFACE_PROFILES[name];
  if (profile === undefined) throw new Error(`unknown tool profile: ${name}`);
  const resolved = resolveToolSurface({ profileName: name });
  const scope = resolved.scope;
  const serverName = scope === "writer" ? SERVER_BY_SCOPE.writer : SERVER_BY_SCOPE.full;
  const evaluated = evaluateToolCapabilities(buildToolTable(scope), {
    scope,
    serverName,
    ...(resolved.window !== undefined ? { window: resolved.window } : {}),
  });
  return {
    name,
    description: profile.description,
    scope,
    advertised: toolNames(evaluated.tools.filter((t) => t.hidden !== true)),
    hidden: toolNames(evaluated.tools.filter((t) => t.hidden === true)),
    withheld: evaluated.report.withheld.map((w) => w.name).toSorted(),
  };
}

/**
 * The source files whose code answers `tools/list`: every MCP server of the
 * product. The catalog reads the tools of each one below; a new server is a
 * check failure until its registry is read here too.
 */
export const TOOL_SERVER_FILES: ReadonlyArray<string> = Object.freeze([
  "src/mcp/server.ts",
  "src/mcp/dream-executor.ts",
]);

/** Files under `src/` with a `tools/list` handler (`case "tools/list"` or `=== "tools/list"`). */
export function scanToolServerFiles(root: string = ROOT): string[] {
  const out: string[] = [];
  const handler = /(?:case\s+|method\s*===\s*)"tools\/list"/;
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir).toSorted(byCodeUnits)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) visit(p);
      else if (p.endsWith(".ts") && handler.test(readFileSync(p, "utf8"))) {
        out.push(relative(root, p).split("\\").join("/"));
      }
    }
  };
  visit(join(root, "src"));
  return out;
}

/** The tools OpenClaw's native plugin registers by name (`src/openclaw/index.ts`). */
export function openclawNativeTools(root: string = ROOT): string[] {
  const text = readFileSync(join(root, "src/openclaw/index.ts"), "utf8");
  return [...text.matchAll(/registerTool\(\{\s*name: "([a-z_]+)"/g)].map((m) => m[1] ?? "");
}

function collectMcp() {
  // The full registry: every tool any scope can serve. The full scope is a
  // superset of the writer scope and holds the same definitions as the
  // catalog scope (which only re-marks them hidden).
  const registry = buildToolTable("full");
  const profiles = Object.keys(TOOL_SURFACE_PROFILES).map(profileSurface);
  const fullServer = profiles.find((p) => p.name === "full");
  const writerServer = profiles.find((p) => p.name === "writer");
  if (fullServer === undefined || writerServer === undefined) {
    throw new Error("the full and writer profiles must exist");
  }
  const servers = [
    {
      name: SERVER_BY_SCOPE.full,
      scope: "full",
      registered_as: "default plugin registration (`o2b mcp`)",
      advertised: fullServer.advertised,
      hidden: fullServer.hidden,
    },
    {
      name: SERVER_BY_SCOPE.writer,
      scope: "writer",
      registered_as: "always-loaded plugin registration (`o2b mcp --scope writer`)",
      advertised: writerServer.advertised,
      hidden: writerServer.hidden,
    },
    {
      name: DREAM_EXECUTOR_SERVER_NAME,
      scope: "dream-executor",
      registered_as: "a dream session's own server (`o2b mcp --tool-profile dream-executor`)",
      advertised: [...DREAM_EXECUTOR_TOOLS].toSorted(byCodeUnits),
      hidden: [] as string[],
    },
  ];
  const tools = registry.map((t) => {
    const on = (pick: (p: ProfileSurface) => ReadonlyArray<string>): string[] =>
      profiles.filter((p) => pick(p).includes(t.name)).map((p) => p.name);
    return {
      name: t.name,
      kind: t.kind,
      group: surfaceGroup(t.name),
      description: firstLine(t.description),
      advertised_by: servers.filter((s) => s.advertised.includes(t.name)).map((s) => s.name),
      hidden_on_profiles: on((p) => p.hidden),
      withheld_on_profiles: on((p) => p.withheld),
      has_output_schema: t.outputSchema !== undefined,
    };
  });
  for (const name of DREAM_EXECUTOR_TOOLS) {
    tools.push({
      name,
      kind: "write",
      group: "dream-executor",
      description: "A tool of the dream executor server; see src/mcp/dream-executor.ts.",
      advertised_by: [DREAM_EXECUTOR_SERVER_NAME],
      hidden_on_profiles: [],
      withheld_on_profiles: [],
      has_output_schema: false,
    });
  }
  const hiddenAnywhere = tools.filter((t) => t.hidden_on_profiles.length > 0).length;
  return {
    source:
      "src/mcp/tools.ts (buildToolTable), src/mcp/profiles.ts (TOOL_SURFACE_PROFILES), src/mcp/capabilities.ts (evaluateToolCapabilities), src/core/brain/dream-queue/dream-session.ts (DREAM_EXECUTOR_TOOLS)",
    method: "import",
    tool_server_files: scanToolServerFiles(),
    counts: {
      registry: tools.length,
      advertised_by_full_server: fullServer.advertised.length,
      hidden_on_full_server: fullServer.hidden.length,
      advertised_by_writer_server: writerServer.advertised.length,
      hidden_on_some_profile: hiddenAnywhere,
      read: tools.filter((t) => t.kind === "read").length,
      write: tools.filter((t) => t.kind !== "read").length,
    },
    servers,
    profiles,
    tools,
  };
}

function collectResources() {
  return {
    source: "src/mcp/resources.ts (listResources, listResourceTemplates)",
    method: "import",
    resources: listResources().map((r) => ({
      uri: r.uri,
      name: r.name,
      description: firstLine(r.description ?? ""),
    })),
    templates: listResourceTemplates().map((r) => ({
      uri_template: r.uriTemplate,
      name: r.name,
      description: firstLine(r.description ?? ""),
    })),
  };
}

function collectRemoved() {
  return {
    source: "src/core/removed-surfaces.ts (REMOVED_TOOLS)",
    method: "import",
    note: "Excluded from coverage: calling one answers an INVALID_PARAMS tombstone naming the replacement. The file declares no removed CLI verbs.",
    mcp_tools: Object.entries(REMOVED_TOOLS)
      .map(([name, r]) => ({
        name,
        removed_in: r.removedIn,
        replacement: r.target,
        view: r.view,
      }))
      .toSorted((a, b) => byCodeUnits(a.name, b.name)),
    cli_verbs: [] as string[],
  };
}

// ---------- Hooks ----------

interface HookCommand {
  readonly type?: string;
  readonly command?: string;
  readonly timeout?: number;
  readonly statusMessage?: string;
}

interface HookMatcher {
  readonly matcher?: string;
  readonly hooks?: ReadonlyArray<HookCommand>;
}

function collectHooks() {
  const manifest = JSON.parse(readText("hooks/hooks.json")) as {
    hooks: Record<string, ReadonlyArray<HookMatcher>>;
  };
  const name = /o2b-hook"? ([a-z0-9-]+)/;
  const registrations: Array<{
    hook: string;
    event: string;
    matcher: string | null;
    status_message: string | null;
  }> = [];
  for (const [event, matchers] of Object.entries(manifest.hooks)) {
    for (const m of matchers) {
      for (const h of m.hooks ?? []) {
        const hook = name.exec(h.command ?? "")?.[1];
        if (hook === undefined) continue;
        registrations.push({
          hook,
          event,
          matcher: m.matcher ?? null,
          status_message: h.statusMessage ?? null,
        });
      }
    }
  }
  const scripts = readdirSync(join(ROOT, "hooks"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => f.replace(/\.ts$/, ""))
    .toSorted();
  const byHook = scripts.map((hook) => {
    const regs = registrations.filter((r) => r.hook === hook);
    return {
      name: hook,
      script: `hooks/${hook}.ts`,
      registered: regs.length > 0,
      events: [...new Set(regs.map((r) => r.event))],
      status_messages: [...new Set(regs.map((r) => r.status_message).filter((s) => s !== null))],
    };
  });
  const unknownRegistrations = [...new Set(registrations.map((r) => r.hook))].filter(
    (h) => !scripts.includes(h),
  );
  return {
    source: "hooks/hooks.json (the lifecycle hooks the plugin registers), hooks/*.ts",
    method: "parse",
    counts: {
      scripts: scripts.length,
      registrations: registrations.length,
      events: Object.keys(manifest.hooks).length,
      unregistered_scripts: byHook.filter((h) => !h.registered).length,
    },
    events: Object.keys(manifest.hooks),
    hooks: byHook,
    registrations_without_script: unknownRegistrations,
    host_native_hook_points: collectHostNativeHooks(),
  };
}

/** Lifecycle points the non-hooks.json host plugins attach to. */
function collectHostNativeHooks() {
  const hermesYaml = readText("plugins/hermes/plugin.yaml");
  const hermes: string[] = [];
  let inHooks = false;
  for (const line of hermesYaml.split("\n")) {
    if (/^hooks:\s*$/.test(line)) {
      inHooks = true;
      continue;
    }
    if (inHooks) {
      const item = /^\s+-\s+([a-z_]+)\s*$/.exec(line);
      if (item?.[1] !== undefined) hermes.push(item[1]);
      else if (/^\S/.test(line)) inHooks = false;
    }
  }
  const openclawSrc = readText("src/openclaw/index.ts");
  const openclaw = [...openclawSrc.matchAll(/api\.on\("([a-z_]+)"/g)].map((m) => m[1] ?? "");
  const openclawTools = [...openclawSrc.matchAll(/registerTool\(\{\s*name: "([a-z_]+)"/g)].map(
    (m) => m[1] ?? "",
  );
  const opencodeSrc = readText("plugins/opencode/open-second-brain.ts");
  const opencode = [
    ...new Set(
      [...opencodeSrc.matchAll(/^\s{4}"?([a-z][a-zA-Z.]*)"?: async/gm)].map((m) => m[1] ?? ""),
    ),
  ];
  const opencodeShims = [
    ...new Set([...opencodeSrc.matchAll(/spawnHookShim\("([a-z-]+)"/g)].map((m) => m[1] ?? "")),
  ];
  return {
    method: "parse (plugin.yaml) and scan (plugin sources)",
    hermes: { source: "plugins/hermes/plugin.yaml", hooks: hermes },
    openclaw: {
      source: "src/openclaw/index.ts",
      hooks: openclaw,
      native_tools: openclawTools,
    },
    opencode: {
      source: "plugins/opencode/open-second-brain.ts",
      hooks: opencode,
      hook_scripts_spawned: opencodeShims,
    },
  };
}

// ---------- Skills ----------

function frontMatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out: Record<string, string> = {};
  if (m === null) return out;
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const kv = /^([a-z_-]+):\s*(.*)$/.exec(line);
    if (kv?.[1] !== undefined) out[kv[1]] = (kv[2] ?? "").trim();
  }
  return out;
}

function firstSentence(text: string): string {
  const m = /^(.+?[.])(\s|$)/.exec(text);
  return (m?.[1] ?? text).trim();
}

function collectSkills() {
  const dir = join(ROOT, "skills");
  const skills = readdirSync(dir)
    .filter((d) => existsSync(join(dir, d, "SKILL.md")))
    .toSorted()
    .map((d) => {
      const fm = frontMatter(readFileSync(join(dir, d, "SKILL.md"), "utf8"));
      return {
        name: fm["name"] ?? d,
        path: `skills/${d}/SKILL.md`,
        description: firstSentence(fm["description"] ?? ""),
        mirrored_for_codex: existsSync(join(ROOT, "plugins/codex/skills", d, "SKILL.md")),
      };
    });
  return { source: "skills/*/SKILL.md", method: "parse", count: skills.length, skills };
}

// ---------- Hosts ----------

function jsonIfExists(path: string): Record<string, unknown> | null {
  const abs = join(ROOT, path);
  if (!existsSync(abs)) return null;
  return JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>;
}

function collectHosts() {
  const setup = Object.entries(HOST_KINDS)
    .map(([id, kind]) => ({
      id,
      kind: kind.kind,
      guide: kind.kind === "plugin" ? kind.guide : null,
      install_adapter: (INSTALL_TARGET_IDS as ReadonlyArray<string>).includes(id),
      tool_ceiling:
        (INSTALL_TARGET_IDS as ReadonlyArray<string>).includes(id) && id in RUNTIME_FACTS
          ? RUNTIME_FACTS[id as keyof typeof RUNTIME_FACTS].toolCeiling.kind
          : null,
    }))
    .toSorted((a, b) => byCodeUnits(a.id, b.id));
  const claude = jsonIfExists(".claude-plugin/plugin.json");
  const codex = jsonIfExists(".codex-plugin/plugin.json");
  const codexMirror = jsonIfExists("plugins/codex/.codex-plugin/plugin.json");
  const openclaw = jsonIfExists("openclaw.plugin.json");
  const contracts = (openclaw?.["contracts"] ?? {}) as { tools?: string[] };
  const pkg = JSON.parse(readText("package.json")) as { bin?: Record<string, string> };
  return {
    source:
      "src/core/install/host-kinds.ts (HOST_KINDS), src/core/runtime/host-facts.ts (INSTALL_TARGET_IDS, SESSION_RUNTIME_IDS), src/cli/bootstrap/targets.ts (BOOTSTRAP_TARGETS), plugin manifests",
    method: "import; plugin manifests by parse",
    counts: {
      setup_hosts: setup.length,
      install_adapters: INSTALL_TARGET_IDS.length,
      plugin_hosts: setup.filter((s) => s.kind === "plugin").length,
      bootstrap_targets: BOOTSTRAP_TARGETS.length,
      session_import_runtimes: SESSION_RUNTIME_IDS.length,
    },
    setup_hosts: setup,
    install_targets: [...INSTALL_TARGET_IDS],
    bootstrap_targets: BOOTSTRAP_TARGETS.map((t) => ({ target: t.target, mode: t.mode })),
    session_import_runtimes: [...SESSION_RUNTIME_IDS],
    plugin_manifests: [
      {
        host: "claude-code",
        path: ".claude-plugin/plugin.json",
        mcp_servers: Object.keys((claude?.["mcpServers"] ?? {}) as object),
      },
      {
        host: "codex",
        path: ".codex-plugin/plugin.json",
        present: codex !== null,
      },
      {
        host: "codex",
        path: "plugins/codex/.codex-plugin/plugin.json",
        present: codexMirror !== null,
      },
      {
        host: "openclaw",
        path: "openclaw.plugin.json",
        declared_tools: contracts.tools ?? [],
      },
      { host: "hermes", path: "plugins/hermes/plugin.yaml", present: true },
      { host: "opencode", path: "plugins/opencode/open-second-brain.ts", present: true },
    ],
    install_guides: readdirSync(join(ROOT, "install"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => `install/${f}`)
      .toSorted(),
    executables: Object.keys(pkg.bin ?? {}).toSorted(),
  };
}

// ---------- Configuration ----------

interface ScanHit {
  readonly name: string;
  readonly files: string[];
}

function addHit(map: Map<string, Set<string>>, name: string, file: string): void {
  const set = map.get(name) ?? new Set<string>();
  set.add(file);
  map.set(name, set);
}

function hits(map: Map<string, Set<string>>): ScanHit[] {
  return [...map]
    .map(([name, files]) => ({ name, files: [...files].toSorted() }))
    .toSorted((a, b) => byCodeUnits(a.name, b.name));
}

/**
 * Config modules (`config.ts`, `*-config.ts`), where a bare `*_KEY`
 * constant names a machine config key.
 */
const CONFIG_MODULE = /(^|[/-])config\.ts$/;

const ENV_NAME = /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/;
const CONFIG_KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

/**
 * Machine config keys (`config.yaml`) and environment variables. There is
 * no single declaration of either, so they are collected from the read
 * sites by pattern:
 *   - an env name literal directly followed by a config key literal, the
 *     argument shape of `envOrConfig`, `resolveWithOrigin`, `readSetting`
 *     and `resolveConfigFlag`;
 *   - `discoverConfig(...).data["key"]` and `cfg["key"]` reads;
 *   - `*_KEY = "key"` and `*_ENV = "NAME"` constants;
 *   - `process.env` reads and product-prefixed env literals.
 */
function scanConfigAndEnv() {
  const files = [
    ...listFiles("src", ".ts"),
    ...listFiles("hooks", ".ts"),
    ...listFiles("plugins/opencode", ".ts"),
  ];
  const keys = new Map<string, Set<string>>();
  const envs = new Map<string, Set<string>>();
  const pairs = new Map<string, Set<string>>();
  const pairRe = /"([A-Z][A-Z0-9_]{2,})"\s*,\s*"([a-z][a-z0-9_.]*)"/g;
  const dataRe =
    /(?:discoverConfig\([^)]*\)|discovery|discovered|machineConfig|configData)\.data\[\s*"([a-z][a-z0-9_.]*)"\s*\]/g;
  const cfgRe = /\b(?:cfg|config)\[\s*"([a-z][a-z0-9_.]*)"\s*\]/g;
  // `*_CONFIG_KEY` anywhere; a bare `*_KEY` only in config modules,
  // because elsewhere it names front matter and record fields as often.
  const keyConstRe = /\bconst [A-Z0-9_]*CONFIG_KEY\s*=\s*"([a-z][a-z0-9_.]*)"/g;
  const configModuleKeyRe = /\bconst [A-Z0-9_]*_KEY\s*=\s*"([a-z][a-z0-9_.]*)"/g;
  const envConstRe = /\bconst [A-Z0-9_]*_ENV(?:_KEY)?\s*=\s*"([A-Z][A-Z0-9_]+)"/g;
  const envLitRe = /"((?:OPEN_SECOND_BRAIN|O2B|VAULT)_[A-Z0-9_]+)"/g;
  const processEnvRe = /process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[\s*"([A-Z_][A-Z0-9_]*)"\s*\])/g;
  for (const abs of files) {
    const file = rel(abs);
    const text = readFileSync(abs, "utf8");
    for (const m of text.matchAll(pairRe)) {
      const env = m[1] ?? "";
      const key = m[2] ?? "";
      if (!ENV_NAME.test(env) || !CONFIG_KEY.test(key)) continue;
      addHit(envs, env, file);
      addHit(keys, key, file);
      addHit(pairs, `${key}=${env}`, file);
    }
    const keyPatterns = CONFIG_MODULE.test(file)
      ? [dataRe, cfgRe, keyConstRe, configModuleKeyRe]
      : [dataRe, cfgRe, keyConstRe];
    for (const re of keyPatterns) {
      for (const m of text.matchAll(re)) {
        const key = m[1] ?? "";
        if (CONFIG_KEY.test(key)) addHit(keys, key, file);
      }
    }
    // The decision-model keys are built from a suffix:
    // `setting(env, config, "base_url")` reads `decision_model_base_url`
    // and `OPEN_SECOND_BRAIN_DECISION_MODEL_BASE_URL`.
    if (file === "src/core/decision-model/config.ts") {
      for (const m of text.matchAll(/\bsetting\(\s*env\s*,\s*\w+\s*,\s*"([a-z][a-z0-9_]*)"/g)) {
        const suffix = m[1] ?? "";
        addHit(keys, `decision_model_${suffix}`, file);
        addHit(envs, `OPEN_SECOND_BRAIN_DECISION_MODEL_${suffix.toUpperCase()}`, file);
        addHit(
          pairs,
          `decision_model_${suffix}=OPEN_SECOND_BRAIN_DECISION_MODEL_${suffix.toUpperCase()}`,
          file,
        );
      }
    }
    for (const re of [envConstRe, envLitRe]) {
      for (const m of text.matchAll(re)) {
        const env = m[1] ?? "";
        if (ENV_NAME.test(env)) addHit(envs, env, file);
      }
    }
    for (const m of text.matchAll(processEnvRe)) {
      const env = m[1] ?? m[2] ?? "";
      if (env !== "") addHit(envs, env, file);
    }
  }
  const pairList = hits(pairs).map((p) => {
    const [key, env] = p.name.split("=");
    return { key: key ?? "", env: env ?? "", files: p.files };
  });
  return { keys: hits(keys), envs: hits(envs), pairs: pairList };
}

function collectConfig() {
  const known = brainConfigKnownKeys();
  const brainYaml = [...known.topLevel].toSorted().map((key) => ({
    key,
    home: BRAIN_YAML_KEYS[key]?.home ?? "unclassified",
    fields: [...(known.subKeys.get(key) ?? [])].toSorted(),
    field_homes: BRAIN_YAML_KEYS[key]?.fields ?? {},
  }));
  const scanned = scanConfigAndEnv();
  return {
    vault_settings: {
      source:
        "src/core/brain/policy/validate.ts (brainConfigKnownKeys), src/core/brain/policy/settings-keys.ts (BRAIN_YAML_KEYS)",
      method: "import",
      note: "`_brain.yaml` blocks and fields, known by construction to the validator. `shared` keys are brain settings (`o2b brain settings`), `device` keys live in the machine config.",
      count_blocks: brainYaml.length,
      count_fields: brainYaml.reduce((n, b) => n + b.fields.length, 0),
      blocks: brainYaml,
    },
    store_native_settings: {
      source: "src/core/brain/policy/settings-names.ts (STORE_NATIVE_SETTINGS)",
      method: "import",
      keys: Object.keys(STORE_NATIVE_SETTINGS).toSorted(),
    },
    machine_config: {
      source: "src/, hooks/, plugins/opencode/",
      method: "scan",
      note: "No single declaration of machine config keys exists; names come from their read sites.",
      count: scanned.keys.length,
      keys: scanned.keys,
      env_mirrors: scanned.pairs,
    },
    environment: {
      source: "src/, hooks/, plugins/opencode/",
      method: "scan",
      note: "No single declaration of environment variables exists; names come from process.env reads, env/config read pairs and product-prefixed literals. Includes variables the product only reads (HOME, PATH, host variables).",
      count: scanned.envs.length,
      count_product_prefixed: scanned.envs.filter((e) =>
        /^(OPEN_SECOND_BRAIN|O2B|VAULT)_/.test(e.name),
      ).length,
      variables: scanned.envs,
    },
  };
}

// ---------- Assembly ----------

export function collectSurfaces() {
  const pkg = JSON.parse(readText("package.json")) as { version: string };
  return {
    schema: "o2b.feature-catalog.surfaces.v1",
    product: "Open Second Brain",
    version: pkg.version,
    cli: collectCli(),
    mcp: collectMcp(),
    mcp_resources: collectResources(),
    removed: collectRemoved(),
    hooks: collectHooks(),
    skills: collectSkills(),
    hosts: collectHosts(),
    config: collectConfig(),
  };
}

export type Surfaces = ReturnType<typeof collectSurfaces>;

// ---------- The catalog ----------

/** Repository-relative folder of the catalog. */
export const CATALOG_DIR = "docs/catalog";
/** Catalog-relative names of the generated index, the removed-features file and the schema. */
export const INDEX_FILE = "INDEX.md";
export const REMOVED_FILE = "_removed.json";
export const SCHEMA_NAME = "feature-catalog.schema.json";
/** Repository-relative location of the contract the catalog files follow. */
export const SCHEMA_FILE = `${CATALOG_DIR}/${SCHEMA_NAME}`;
/** The index is read whole before any area file, so it stays small. */
export const INDEX_MAX_BYTES = 22_000;
/** The reference that must name every MCP tool, in backticks. */
export const MCP_DOC = "docs/mcp.md";
/** An index line shows the first keywords only; writers put the most useful first. */
export const INDEX_KEYWORDS = 5;
/** A tracker id: no catalog file may carry one. */
export const FORBIDDEN_ID = /\bosb-[0-9a-z]{4,}\b/;
export const SURFACE_KINDS = ["cli", "mcp", "hooks", "skills", "config"] as const;
export type SurfaceKind = (typeof SURFACE_KINDS)[number];

export interface CatalogFeature {
  readonly slug: string;
  readonly name: string;
  readonly summary: string;
  readonly status: "stable" | "experimental" | "optional" | "deprecated";
  readonly aliases?: ReadonlyArray<string>;
  readonly capabilities: ReadonlyArray<string>;
  readonly limits: ReadonlyArray<string>;
  readonly surfaces: Readonly<Partial<Record<SurfaceKind, ReadonlyArray<string>>>>;
  readonly docs: ReadonlyArray<string>;
  readonly code: ReadonlyArray<string>;
  readonly keywords: ReadonlyArray<string>;
}

export interface CatalogArea {
  readonly area: string;
  readonly name: string;
  readonly summary: string;
  readonly features: ReadonlyArray<CatalogFeature>;
}

/** One file of the catalog folder: its catalog-relative path and its text. */
export interface CatalogFile {
  readonly file: string;
  readonly text: string;
}

/**
 * What the catalog must agree with, read from code. `verbs` is every node
 * of the CLI manifest; `coverableVerbs` the ones a feature must claim
 * (leaves and groups that run by themselves). `configKeys` are the
 * declared settings; `requiredConfigKeys` the ones some feature must name.
 */
export interface CodeFacts {
  readonly verbs: ReadonlySet<string>;
  readonly coverableVerbs: ReadonlySet<string>;
  readonly tools: ReadonlySet<string>;
  readonly removedTools: ReadonlySet<string>;
  readonly hooks: ReadonlySet<string>;
  readonly skills: ReadonlySet<string>;
  readonly configKeys: ReadonlySet<string>;
  readonly requiredConfigKeys: ReadonlySet<string>;
  /** Source files that answer `tools/list` (see {@link TOOL_SERVER_FILES}). */
  readonly toolServerFiles: ReadonlySet<string>;
  /** Tools a host plugin registers natively; each must be a tool of {@link CodeFacts.tools}. */
  readonly hostNativeTools: ReadonlySet<string>;
}

/**
 * The surfaces of this checkout. Settings are the two single declarations
 * of the code: the top-level `_brain.yaml` keys and the store-native
 * settings. A top-level key classified `drop` (the file's own format
 * version) is not a setting, so no feature has to name it. Machine config
 * keys and environment variables have no declaration and are not gated.
 */
export function codeFacts(): CodeFacts {
  const walked: CliVerb[] = [];
  walkCli(CLI_COMMAND_MANIFEST.commands, [], walked);
  const known = brainConfigKnownKeys();
  const storeSettings = Object.keys(STORE_NATIVE_SETTINGS);
  const topLevel = [...known.topLevel];
  return {
    verbs: new Set(walked.map((v) => v.path)),
    coverableVerbs: new Set(walked.filter((v) => v.kind !== "group").map((v) => v.path)),
    // Every tool any server can serve: the full registry (every profile of
    // the main server is a subset of it) and the dream executor's server.
    tools: new Set([...buildToolTable("full").map((t) => t.name), ...DREAM_EXECUTOR_TOOLS]),
    removedTools: new Set(Object.keys(REMOVED_TOOLS)),
    hooks: new Set(
      readdirSync(join(ROOT, "hooks"))
        .filter((f) => f.endsWith(".ts"))
        .map((f) => f.replace(/\.ts$/, "")),
    ),
    skills: new Set(collectSkills().skills.map((s) => s.name)),
    configKeys: new Set([...topLevel, ...storeSettings]),
    requiredConfigKeys: new Set([
      ...topLevel.filter((key) => BRAIN_YAML_KEYS[key]?.home !== "drop"),
      ...storeSettings,
    ]),
    toolServerFiles: new Set(scanToolServerFiles()),
    hostNativeTools: new Set(openclawNativeTools()),
  };
}

/** Every file under the catalog folder of `root`, sorted by path. */
export function readCatalog(root: string = ROOT): CatalogFile[] {
  const dir = join(root, CATALOG_DIR);
  if (!existsSync(dir)) return [];
  const out: CatalogFile[] = [];
  const visit = (d: string): void => {
    for (const name of readdirSync(d).toSorted(byCodeUnits)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) visit(p);
      else
        out.push({ file: relative(dir, p).split("\\").join("/"), text: readFileSync(p, "utf8") });
    }
  };
  visit(dir);
  return out;
}

// ---------- A JSON Schema subset ----------

/**
 * The keywords `docs/catalog/feature-catalog.schema.json` uses, and no more. A
 * keyword outside this list is refused when the schema is loaded, so the
 * check never claims a rule it does not apply.
 */
const SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  "$schema",
  "$id",
  "$defs",
  "$ref",
  "title",
  "description",
  "type",
  "enum",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "pattern",
]);

export type SchemaNode = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Throws on a schema node that uses a keyword the validator does not apply. */
export function assertSupportedSchema(node: unknown, path = "<root>"): void {
  if (!isRecord(node)) throw new Error(`${SCHEMA_FILE}: ${path}: a schema node must be an object`);
  for (const key of Object.keys(node)) {
    if (!SCHEMA_KEYWORDS.has(key)) {
      throw new Error(`${SCHEMA_FILE}: ${path}: unsupported keyword ${JSON.stringify(key)}`);
    }
  }
  for (const group of ["properties", "$defs"] as const) {
    const children = node[group];
    if (children === undefined) continue;
    if (!isRecord(children)) throw new Error(`${SCHEMA_FILE}: ${path}.${group} must be an object`);
    for (const [name, child] of Object.entries(children)) {
      assertSupportedSchema(child, `${path}.${name}`);
    }
  }
  if (node["items"] !== undefined) assertSupportedSchema(node["items"], `${path}[]`);
}

/** The catalog schema of `root`, checked for keywords the validator applies. */
export function loadSchema(root: string = ROOT): SchemaNode {
  const schema = JSON.parse(readFileSync(join(root, SCHEMA_FILE), "utf8")) as unknown;
  assertSupportedSchema(schema);
  return schema as SchemaNode;
}

interface SchemaError {
  readonly path: ReadonlyArray<string | number>;
  readonly message: string;
}

function resolveRef(root: SchemaNode, ref: string): SchemaNode {
  const m = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(ref);
  const defs = root["$defs"];
  const target = m !== null && isRecord(defs) ? defs[m[1] ?? ""] : undefined;
  if (!isRecord(target)) throw new Error(`${SCHEMA_FILE}: unresolvable $ref ${ref}`);
  return target;
}

function typeMatches(type: unknown, value: unknown): boolean {
  switch (type) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    default:
      return false;
  }
}

function validateNode(
  root: SchemaNode,
  node: SchemaNode,
  value: unknown,
  path: ReadonlyArray<string | number>,
  out: SchemaError[],
): void {
  if (typeof node["$ref"] === "string") {
    validateNode(root, resolveRef(root, node["$ref"]), value, path, out);
    return;
  }
  if (node["type"] !== undefined && !typeMatches(node["type"], value)) {
    out.push({ path, message: `must be ${String(node["type"])}` });
    return;
  }
  const allowed = node["enum"];
  if (Array.isArray(allowed) && !allowed.includes(value)) {
    out.push({ path, message: `must be one of ${allowed.join(", ")}` });
    return;
  }
  if (typeof value === "string") {
    const min = node["minLength"];
    const max = node["maxLength"];
    if (typeof min === "number" && value.length < min) {
      out.push({ path, message: `must be at least ${min} characters` });
    }
    if (typeof max === "number" && value.length > max) {
      out.push({ path, message: `must be at most ${max} characters (is ${value.length})` });
    }
    const pattern = node["pattern"];
    if (typeof pattern === "string" && !new RegExp(pattern, "u").test(value)) {
      out.push({ path, message: `${JSON.stringify(value)} does not match ${pattern}` });
    }
  }
  if (Array.isArray(value)) {
    const min = node["minItems"];
    const max = node["maxItems"];
    if (typeof min === "number" && value.length < min) {
      out.push({ path, message: `must have at least ${min} item(s)` });
    }
    if (typeof max === "number" && value.length > max) {
      out.push({ path, message: `must have at most ${max} item(s) (has ${value.length})` });
    }
    if (node["uniqueItems"] === true) {
      const seen = new Set<string>();
      for (const item of value) {
        const key = JSON.stringify(item);
        if (seen.has(key)) out.push({ path, message: `repeats ${key}` });
        seen.add(key);
      }
    }
    const items = node["items"];
    if (isRecord(items)) {
      value.forEach((item, i) => validateNode(root, items, item, [...path, i], out));
    }
  }
  if (isRecord(value)) {
    const properties = isRecord(node["properties"]) ? node["properties"] : {};
    const required = Array.isArray(node["required"]) ? node["required"] : [];
    for (const key of required) {
      if (typeof key === "string" && !(key in value)) {
        out.push({ path, message: `misses the required field ${key}` });
      }
    }
    for (const [key, child] of Object.entries(value)) {
      const sub = properties[key];
      if (isRecord(sub)) validateNode(root, sub, child, [...path, key], out);
      else if (node["additionalProperties"] === false) {
        out.push({ path, message: `has the unknown field ${key}` });
      }
    }
  }
}

/** Errors of `value` against `schema` (or one of its `$defs`, by name). */
export function validateAgainst(schema: SchemaNode, value: unknown, def?: string): SchemaError[] {
  const out: SchemaError[] = [];
  const node = def === undefined ? schema : resolveRef(schema, `#/$defs/${def}`);
  validateNode(schema, node, value, [], out);
  return out;
}

// ---------- Rendering the index ----------

const INDEX_HEADER = [
  "# Open Second Brain feature catalog",
  "",
  "Every feature of Open Second Brain in one line, grouped by area; `kw:` lists the words outsiders use for it.",
  "Generated by `bun run catalog:build` from the area files in this folder; never edit this file by hand.",
  "The area file named in each heading holds a feature's capabilities, limits, surfaces, docs and code.",
];

function indexLine(f: CatalogFeature): string {
  const status = f.status === "stable" ? "" : ` [${f.status}]`;
  const shown = f.keywords.slice(0, INDEX_KEYWORDS);
  const keywords = shown.length > 0 ? ` | kw: ${shown.join(", ")}` : "";
  return `- \`${f.slug}\`${status} — ${f.summary}${keywords}`;
}

/** The index for `areas`, in the order given (the build reads them in file-name order). */
export function renderIndex(areas: ReadonlyArray<CatalogArea>): string {
  const lines = [...INDEX_HEADER];
  for (const a of areas) {
    lines.push("", `## ${a.area} - ${a.name} (${a.area}.json)`, "");
    for (const f of a.features) lines.push(indexLine(f));
  }
  return `${lines.join("\n")}\n`;
}

// ---------- Checking the catalog ----------

export interface CheckEnv {
  readonly schema: SchemaNode;
  /** Whether a repository-relative path exists. */
  readonly exists: (path: string) => boolean;
  /** Whether a repository-relative path resolves to a place inside the repository. */
  readonly inRepository: (path: string) => boolean;
  /** The anchors of a repository-relative Markdown file, or `null` when it cannot be read. */
  readonly anchors: (path: string) => ReadonlySet<string> | null;
  /** The text of a repository-relative file, or `null` when it cannot be read. */
  readonly docText: (path: string) => string | null;
}

/** GitHub-style heading anchors of a Markdown text, plus explicit `id="..."` anchors. */
export function markdownAnchors(text: string): Set<string> {
  const out = new Set<string>();
  const counts = new Map<string, number>();
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    for (const m of line.matchAll(/\b(?:id|name)="([^"]+)"/g)) out.add(m[1] ?? "");
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading === null) continue;
    const base = (heading[1] ?? "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[`*]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

/** The check environment of a checkout: real files, real anchors. */
export function repositoryEnv(root: string = ROOT): CheckEnv {
  const inRepository = (path: string): boolean => {
    const inside = relative(root, resolve(root, path));
    return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
  };
  return {
    schema: loadSchema(root),
    inRepository,
    exists: (path) => inRepository(path) && existsSync(join(root, path)),
    anchors: (path) => {
      try {
        return markdownAnchors(readFileSync(join(root, path), "utf8"));
      } catch {
        return null;
      }
    },
    docText: (path) => {
      try {
        return readFileSync(join(root, path), "utf8");
      } catch {
        return null;
      }
    },
  };
}

interface Located {
  readonly file: string;
  readonly slug: string;
}

function at(file: string, slug?: string): string {
  return slug === undefined ? `${CATALOG_DIR}/${file}` : `${CATALOG_DIR}/${file}: ${slug}`;
}

function formatSchemaError(file: string, data: unknown, e: SchemaError): string {
  const [head, index, ...rest] = e.path;
  if (head === "features" && typeof index === "number" && isRecord(data)) {
    const features = data["features"];
    const feature = Array.isArray(features) ? features[index] : undefined;
    const slug =
      isRecord(feature) && typeof feature["slug"] === "string"
        ? feature["slug"]
        : `features[${index}]`;
    const field = rest.length > 0 ? `${rest.join(".")} ` : "";
    return `${at(file, slug)}: ${field}${e.message}`;
  }
  const field = e.path.length > 0 ? `${e.path.join(".")} ` : "";
  return `${at(file)}: ${field}${e.message}`;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** A feature read defensively, so one malformed field does not hide the rest. */
function readFeature(value: unknown): CatalogFeature | null {
  if (!isRecord(value) || typeof value["slug"] !== "string") return null;
  const surfaces = isRecord(value["surfaces"]) ? value["surfaces"] : {};
  const text = (key: string): string => (typeof value[key] === "string" ? value[key] : "");
  return {
    slug: value["slug"],
    name: text("name"),
    summary: text("summary"),
    status: text("status") as CatalogFeature["status"],
    aliases: stringList(value["aliases"]),
    capabilities: stringList(value["capabilities"]),
    limits: stringList(value["limits"]),
    surfaces: Object.fromEntries(SURFACE_KINDS.map((k) => [k, stringList(surfaces[k])])),
    docs: stringList(value["docs"]),
    code: stringList(value["code"]),
    keywords: stringList(value["keywords"]),
  };
}

interface ParsedCatalog {
  readonly areas: Array<CatalogArea & { readonly file: string }>;
  readonly removed: Array<{ readonly slug: string; readonly replacedBy: string[] }>;
  readonly errors: string[];
  /** Parse or schema errors: the index is not compared while there are any. */
  readonly malformed: boolean;
}

function parseCatalog(files: ReadonlyArray<CatalogFile>, schema: SchemaNode): ParsedCatalog {
  const errors: string[] = [];
  const areas: Array<CatalogArea & { readonly file: string }> = [];
  const removed: Array<{ readonly slug: string; readonly replacedBy: string[] }> = [];
  let malformed = false;
  let sawRemoved = false;
  const parse = (f: CatalogFile): unknown => {
    try {
      return JSON.parse(f.text) as unknown;
    } catch (err) {
      errors.push(`${at(f.file)}: not valid JSON: ${(err as Error).message}`);
      malformed = true;
      return undefined;
    }
  };
  // File-name order whatever order the caller passed the files in, so the
  // index never depends on it.
  for (const f of files.toSorted((x, y) => byCodeUnits(x.file, y.file))) {
    if (f.file.includes("/") && f.file.endsWith(".json")) {
      errors.push(`${at(f.file)}: a JSON file in a subfolder is not part of the catalog`);
      continue;
    }
    if (f.file.includes("/") || !f.file.endsWith(".json") || f.file === SCHEMA_NAME) continue;
    if (f.file === REMOVED_FILE) {
      sawRemoved = true;
      const data = parse(f);
      if (data === undefined) continue;
      const problems = validateAgainst(schema, data, "removed_file");
      for (const e of problems) errors.push(formatSchemaError(f.file, data, e));
      if (problems.length > 0) malformed = true;
      const list = isRecord(data) && Array.isArray(data["features"]) ? data["features"] : [];
      for (const r of list) {
        if (isRecord(r) && typeof r["slug"] === "string") {
          removed.push({ slug: r["slug"], replacedBy: stringList(r["replaced_by"]) });
        }
      }
      continue;
    }
    if (f.file.startsWith("_")) {
      errors.push(`${at(f.file)}: unknown catalog file; area files are named <area>.json`);
      continue;
    }
    const data = parse(f);
    if (data === undefined) continue;
    const problems = validateAgainst(schema, data);
    for (const e of problems) errors.push(formatSchemaError(f.file, data, e));
    if (problems.length > 0) malformed = true;
    if (!isRecord(data)) continue;
    const area = typeof data["area"] === "string" ? data["area"] : "";
    if (`${area}.json` !== f.file) {
      errors.push(`${at(f.file)}: area ${JSON.stringify(area)} does not match the file name`);
    }
    const features = Array.isArray(data["features"]) ? data["features"] : [];
    areas.push({
      file: f.file,
      area,
      name: typeof data["name"] === "string" ? data["name"] : "",
      summary: typeof data["summary"] === "string" ? data["summary"] : "",
      features: features.map(readFeature).filter((x): x is CatalogFeature => x !== null),
    });
  }
  if (areas.length === 0) errors.push(`${CATALOG_DIR}: no area files`);
  if (!sawRemoved)
    errors.push(`${at(REMOVED_FILE)}: missing; it holds removed and merged features`);
  return { areas, removed, errors, malformed };
}

/** What each kind of surface must be, and the message when it is not. */
function surfaceProblem(kind: SurfaceKind, name: string, facts: CodeFacts): string | null {
  switch (kind) {
    case "cli":
      if (!facts.verbs.has(name)) return "is not a verb of the CLI manifest";
      if (!facts.coverableVerbs.has(name)) return "is a namespace; list its verbs instead";
      return null;
    case "mcp":
      if (facts.removedTools.has(name)) return "was removed and cannot be listed";
      return facts.tools.has(name) ? null : "is not a tool of the MCP registry";
    case "hooks":
      return facts.hooks.has(name) ? null : "is not a hook script in hooks/";
    case "skills":
      return facts.skills.has(name) ? null : "is not a skill in skills/";
    case "config":
      return facts.configKeys.has(name)
        ? null
        : "is not a declared setting (a top-level _brain.yaml key or a store-native setting)";
  }
}

const COVERAGE: ReadonlyArray<{
  readonly kind: SurfaceKind;
  readonly label: string;
  readonly universe: (facts: CodeFacts) => ReadonlySet<string>;
  readonly once: boolean;
}> = [
  { kind: "cli", label: "cli verb", universe: (f) => f.coverableVerbs, once: true },
  { kind: "mcp", label: "mcp tool", universe: (f) => f.tools, once: true },
  { kind: "hooks", label: "hook", universe: (f) => f.hooks, once: true },
  { kind: "skills", label: "skill", universe: (f) => f.skills, once: true },
  { kind: "config", label: "setting", universe: (f) => f.requiredConfigKeys, once: false },
];

/**
 * Every problem of the catalog against the code, one line each. An empty
 * list is a pass. `files` is every file of the catalog folder.
 */
export function checkCatalog(
  files: ReadonlyArray<CatalogFile>,
  facts: CodeFacts,
  env: CheckEnv,
): string[] {
  const parsed = parseCatalog(files, env.schema);
  const errors = [...parsed.errors];

  // Slugs: unique across every area file, never one a removed feature had.
  const owners = new Map<string, Located>();
  for (const a of parsed.areas) {
    for (const f of a.features) {
      const first = owners.get(f.slug);
      if (first !== undefined) {
        errors.push(`${at(a.file, f.slug)}: slug repeats the feature in ${at(first.file)}`);
      } else owners.set(f.slug, { file: a.file, slug: f.slug });
    }
  }
  for (const r of parsed.removed) {
    const live = owners.get(r.slug);
    if (live !== undefined) {
      errors.push(`${at(live.file, r.slug)}: slug was used by a feature in ${at(REMOVED_FILE)}`);
    }
    for (const target of r.replacedBy) {
      if (!owners.has(target)) {
        errors.push(`${at(REMOVED_FILE, r.slug)}: replaced_by ${target} is no feature`);
      }
    }
  }
  for (const a of parsed.areas) {
    for (const f of a.features) {
      for (const alias of f.aliases ?? []) {
        const other = owners.get(alias);
        if (other !== undefined && other.slug !== f.slug) {
          errors.push(`${at(a.file, f.slug)}: alias ${alias} is the slug of a live feature`);
        }
      }
    }
  }

  // Surfaces: each must exist, and every coverable one belongs to a feature.
  for (const rule of COVERAGE) {
    const claims = new Map<string, Located[]>();
    for (const a of parsed.areas) {
      for (const f of a.features) {
        for (const name of f.surfaces[rule.kind] ?? []) {
          const problem = surfaceProblem(rule.kind, name, facts);
          if (problem !== null) {
            errors.push(`${at(a.file, f.slug)}: ${rule.kind} ${JSON.stringify(name)} ${problem}`);
            continue;
          }
          claims.set(name, [...(claims.get(name) ?? []), { file: a.file, slug: f.slug }]);
        }
      }
    }
    for (const [name, where] of claims) {
      if (!rule.once || where.length < 2) continue;
      const [first, ...rest] = where;
      for (const w of rest) {
        errors.push(
          `${at(w.file, w.slug)}: ${rule.kind} ${JSON.stringify(name)} is also assigned to ${first?.slug} (${at(first?.file ?? "")})`,
        );
      }
    }
    for (const name of [...rule.universe(facts)].toSorted()) {
      if (!claims.has(name)) {
        errors.push(
          `${CATALOG_DIR}: ${rule.label} ${JSON.stringify(name)} is assigned to no feature`,
        );
      }
    }
  }

  // Paths: docs (with their anchor) and code entries exist.
  for (const a of parsed.areas) {
    for (const f of a.features) {
      for (const ref of f.docs) {
        const [path = "", anchor] = ref.split("#");
        const where = `${at(a.file, f.slug)}: docs ${JSON.stringify(ref)}`;
        if (!env.inRepository(path)) {
          errors.push(`${where} leaves the repository`);
        } else if (!env.exists(path)) {
          errors.push(`${where} names no file`);
        } else if (anchor !== undefined) {
          // An anchor that cannot be checked is refused, not passed.
          const anchors = path.toLowerCase().endsWith(".md") ? env.anchors(path) : null;
          if (anchors === null) {
            errors.push(`${where} has an anchor in a file whose headings cannot be read`);
          } else if (!anchors.has(anchor)) {
            errors.push(`${where} names no heading`);
          }
        }
      }
      for (const path of f.code) {
        const where = `${at(a.file, f.slug)}: code ${JSON.stringify(path)}`;
        if (!env.inRepository(path)) errors.push(`${where} leaves the repository`);
        else if (!env.exists(path)) errors.push(`${where} names no file`);
      }
    }
  }

  // The MCP reference names every tool of the registry, in backticks. The
  // CLI half of the rule is not checked: the CLI reference writes related
  // verbs in grouped forms (`a|b`, operations in prose) a literal match
  // cannot read.
  // A name counts when a backtick opens right before it and no name
  // character follows it (`` `dream_work_take {}` `` names a tool too).
  const mcpDoc = env.docText(MCP_DOC);
  if (mcpDoc === null) {
    errors.push(`${MCP_DOC}: missing; it must name every MCP tool`);
  } else {
    for (const tool of [...facts.tools].toSorted(byCodeUnits)) {
      if (!new RegExp(`\`${tool}(?![A-Za-z0-9_])`).test(mcpDoc)) {
        errors.push(`${MCP_DOC}: mcp tool ${JSON.stringify(tool)} is not named there in backticks`);
      }
    }
  }

  // Every server's tools are read: a server the catalog does not know of
  // would serve tools no feature claims.
  const servers = new Set(TOOL_SERVER_FILES);
  for (const file of [...facts.toolServerFiles].toSorted(byCodeUnits)) {
    if (!servers.has(file)) {
      errors.push(`${file}: answers tools/list, but the catalog reads no tool registry from it`);
    }
  }
  for (const file of TOOL_SERVER_FILES) {
    if (!facts.toolServerFiles.has(file)) {
      errors.push(`${file}: listed as a tool server, but it no longer answers tools/list`);
    }
  }
  for (const tool of [...facts.hostNativeTools].toSorted(byCodeUnits)) {
    if (!facts.tools.has(tool)) {
      errors.push(
        `src/openclaw/index.ts: native tool ${JSON.stringify(tool)} is no MCP tool, so no feature claims it`,
      );
    }
  }

  // The index: what the build writes, within its size.
  const index = files.find((f) => f.file === INDEX_FILE);
  if (parsed.malformed) {
    errors.push(`${at(INDEX_FILE)}: not compared until the area files are valid`);
  } else {
    const expected = renderIndex(parsed.areas);
    const size = Buffer.byteLength(expected, "utf8");
    if (size > INDEX_MAX_BYTES) {
      errors.push(
        `${at(INDEX_FILE)}: would be ${size} bytes, over the ${INDEX_MAX_BYTES}-byte limit`,
      );
    }
    if (index === undefined) {
      errors.push(`${at(INDEX_FILE)}: missing; run bun run catalog:build`);
    } else if (index.text !== expected) {
      errors.push(`${at(INDEX_FILE)}: stale; run bun run catalog:build`);
    }
  }

  // No tracker ids anywhere in the folder.
  for (const f of files) {
    const hit = FORBIDDEN_ID.exec(f.text);
    if (hit !== null) errors.push(`${at(f.file)}: carries a tracker id (${hit[0]})`);
  }
  return errors;
}

// ---------- Subcommands ----------

function cmdDump(): number {
  process.stdout.write(`${JSON.stringify(collectSurfaces(), null, 2)}\n`);
  return 0;
}

/** Writes the index from the area files; refuses while they are malformed. */
export function buildIndex(root: string = ROOT): {
  readonly errors: string[];
  readonly bytes: number;
} {
  const parsed = parseCatalog(readCatalog(root), loadSchema(root));
  // Any problem of the files themselves (a mismatched file name, a stray
  // file, a missing `_removed.json`) refuses the build: an index written
  // from them would name files that are not there.
  if (parsed.errors.length > 0) return { errors: parsed.errors, bytes: 0 };
  const text = renderIndex(parsed.areas);
  writeFileSync(join(root, CATALOG_DIR, INDEX_FILE), text);
  const bytes = Buffer.byteLength(text, "utf8");
  const errors =
    bytes > INDEX_MAX_BYTES
      ? [`${at(INDEX_FILE)}: ${bytes} bytes, over the ${INDEX_MAX_BYTES}-byte limit`]
      : [];
  return { errors, bytes };
}

function cmdBuild(): number {
  const { errors, bytes } = buildIndex();
  for (const e of errors) process.stderr.write(`${e}\n`);
  if (bytes > 0) process.stdout.write(`wrote ${CATALOG_DIR}/${INDEX_FILE} (${bytes} bytes)\n`);
  return errors.length === 0 ? 0 : 1;
}

function cmdCheck(): number {
  const errors = checkCatalog(readCatalog(), codeFacts(), repositoryEnv(ROOT));
  if (errors.length > 0) {
    for (const e of errors) process.stderr.write(`${e}\n`);
    process.stderr.write(
      `feature catalog check: ${errors.length} problem(s); edit the area files, then run bun run catalog:build\n`,
    );
    return 1;
  }
  process.stdout.write("feature catalog check: ok\n");
  return 0;
}

const USAGE = "usage: bun run scripts/feature-catalog.ts <dump | build | check>";

export function main(argv: ReadonlyArray<string>): number {
  const [verb, ...rest] = argv;
  if (rest.length > 0) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  // `--check` is the gate form every other repository script takes.
  if (verb === "check" || verb === "--check") return cmdCheck();
  if (verb === "dump") return cmdDump();
  if (verb === "build") return cmdBuild();
  process.stderr.write(`${USAGE}\n`);
  return 2;
}

// The exit code, not `process.exit`: an exit straight after `dump` wrote
// cut its output short in a pipe, and nothing here keeps the process alive.
if (import.meta.main) process.exitCode = main(process.argv.slice(2));
