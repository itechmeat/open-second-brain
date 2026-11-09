/**
 * Census over the text Open Second Brain hands to agents: no legacy vault
 * path in it (design D12, task 2.11; spec brain-migration "Path discovery
 * for outside readers").
 *
 * ## The defect
 *
 * Once a machine is store-only (design D14 item 1) the brain lives in the
 * store, not under `<vault>/Brain/`. Agents act on what they are told, so
 * a skill, an MCP instruction, a tool description or a hook message that
 * says "read `Brain/preferences/`" or "edit `Brain/_brain.yaml`" sends
 * the agent to a directory that no longer exists, and a writing agent
 * recreates the legacy tree the migration removed (doctor's regeneration
 * check reports exactly that). Agent-facing text names tools and commands
 * instead: `brain_*` MCP tools, `o2b ...` verbs, `o2b store path` and
 * `second_brain_status` for locations.
 *
 * ## The population
 *
 *  1. Every file of the shipped skills, `skills/` and the Codex mirror
 *     `plugins/codex/skills/` (the mirror is checked on its own, so a
 *     stale mirror fails here too, not only in the sync check).
 *  2. The rendered `initialize.instructions` body of every tool scope.
 *  3. Every tool description, and every description inside its input
 *     schema, for every scope, plus every MCP resource description.
 *  4. The string literals of the hook scripts (`hooks/`, comments
 *     excluded by the shared lexer) and of the hook-injected template
 *     modules in {@link HOOK_TEMPLATE_MODULES}.
 *  5. The agent templates: the per-turn identity reminders, the install
 *     context templates in {@link AGENT_TEMPLATE_GLOBS}, and the managed
 *     instruction block the installer writes into AGENTS.md / CLAUDE.md.
 *
 * A legacy path is `Brain/...`, `_brain.yaml`, `_BRAIN.md` or one of the
 * digest files `active.md`, `pinned.md`, `lessons.md`.
 *
 * ## The allowlist
 *
 * A legitimate mention is listed with its reason. An entry that matches
 * nothing fails too, so the list cannot outlive what it excuses.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { CANONICAL_WRITEBACK_BLOCK_BODY } from "../../../src/core/brain/writeback-contract.ts";
import { buildInstructions } from "../../../src/mcp/instructions.ts";
import { evaluateToolCapabilities } from "../../../src/mcp/capabilities.ts";
import { listResources, listResourceTemplates } from "../../../src/mcp/resources.ts";
import { buildToolTable } from "../../../src/mcp/tools.ts";
import { TOOL_SCOPES, type ToolScope } from "../../../src/mcp/tool-contract.ts";
import { lexSource } from "../../helpers/source-lexer.ts";

const REPO = join(import.meta.dir, "..", "..", "..");

/** A path inside the legacy vault tree, or a digest file of it. */
const LEGACY_PATH =
  /\bBrain\/[^\s`'")\]$,;:]*|_brain\.yaml|_BRAIN\.md|\b(?:active|pinned|lessons)\.md\b/g;

const SKILL_ROOTS = ["skills", join("plugins", "codex", "skills")];
const HOOK_ROOT = "hooks";

/** Template files an agent reads verbatim: `[directory, file-name pattern]`. */
const AGENT_TEMPLATE_GLOBS: ReadonlyArray<readonly [string, RegExp]> = [
  ["templates", /^identity-reminder(?:\.[a-z]+)?\.txt$/],
  [join("templates", "install"), /\.tmpl$/],
];

/** Modules outside `hooks/` whose strings a hook injects verbatim. */
const HOOK_TEMPLATE_MODULES = [join("src", "core", "brain", "active-budget.ts")];

interface Hit {
  /** Where: a repo-relative file, `instructions:<scope>`, `tool:<name>` or `resource:<uri>`. */
  readonly site: string;
  readonly match: string;
}

interface AllowEntry {
  readonly site: string;
  /** The exact matched text this entry excuses. */
  readonly match: string;
  readonly reason: string;
}

/** The note-tool walls that refuse the legacy tree (design D14 item 17). */
const NOTE_WALL =
  "note tools refuse the legacy tree in the user's vault until it is removed (design D14 item 17)";

const ALLOWLIST: ReadonlyArray<AllowEntry> = [
  // Code, not text: the injection ledger keys a delivered digest by the
  // legacy relative path so answer-quote-check can match it.
  {
    site: "hooks/lib/injection-ledger.ts",
    match: "Brain/active.md",
    reason: "provenance key, never shown to an agent",
  },
  {
    site: "hooks/lib/injection-ledger.ts",
    match: "Brain/lessons.md",
    reason: "provenance key, never shown to an agent",
  },
  {
    site: "hooks/lib/injection-ledger.ts",
    match: "Brain/preferences/pref-",
    reason: "provenance key, never shown to an agent",
  },
  { site: "tool:brain_write_session", match: "Brain/sources/", reason: NOTE_WALL },
  { site: "tool:brain_write_session", match: "Brain/", reason: NOTE_WALL },
  {
    site: "tool:list_skills",
    match: "Brain/skills/",
    reason: "an operator-authored skill folder in the vault, not brain data",
  },
];

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).toSorted()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

function hitsIn(site: string, text: string): Hit[] {
  // A sentence-ending period is prose, not part of the path.
  return [...text.matchAll(LEGACY_PATH)].map((m) => ({ site, match: m[0].replace(/\.+$/, "") }));
}

function siteOf(file: string): string {
  return relative(REPO, file).split("\\").join("/");
}

function skillHits(): Hit[] {
  return SKILL_ROOTS.flatMap((root) =>
    walkFiles(join(REPO, root)).flatMap((file) => hitsIn(siteOf(file), readFileSync(file, "utf8"))),
  );
}

function sourceLiteralHits(file: string): Hit[] {
  return hitsIn(siteOf(file), lexSource(readFileSync(file, "utf8")).withoutComments);
}

function hookHits(): Hit[] {
  const scripts = walkFiles(join(REPO, HOOK_ROOT)).filter((f) => f.endsWith(".ts"));
  const templates = HOOK_TEMPLATE_MODULES.map((f) => join(REPO, f));
  return [...scripts, ...templates].flatMap(sourceLiteralHits);
}

function templateHits(): Hit[] {
  const files = AGENT_TEMPLATE_GLOBS.flatMap(([dir, pattern]) =>
    readdirSync(join(REPO, dir))
      .filter((name) => pattern.test(name))
      .map((name) => join(REPO, dir, name)),
  );
  return [
    ...files.flatMap((file) => hitsIn(siteOf(file), readFileSync(file, "utf8"))),
    ...hitsIn("managed instruction block", CANONICAL_WRITEBACK_BLOCK_BODY),
  ];
}

function reportFor(scope: ToolScope) {
  return evaluateToolCapabilities(buildToolTable(scope), { scope, serverName: "census" }).report;
}

function instructionHits(): Hit[] {
  return TOOL_SCOPES.flatMap((scope) =>
    hitsIn(
      `instructions:${scope}`,
      buildInstructions({ agent: "census-agent", scope, capabilities: reportFor(scope) }),
    ),
  );
}

/** Every `description` string anywhere inside a JSON-schema-like value. */
function descriptions(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(descriptions);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, inner]) =>
    key === "description" && typeof inner === "string" ? [inner] : descriptions(inner),
  );
}

function toolHits(): Hit[] {
  const seen = new Set<string>();
  const hits: Hit[] = [];
  for (const scope of TOOL_SCOPES) {
    for (const tool of buildToolTable(scope)) {
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);
      const texts = [tool.description, ...descriptions(tool.inputSchema)];
      for (const text of texts) hits.push(...hitsIn(`tool:${tool.name}`, text));
    }
  }
  return hits;
}

function resourceHits(): Hit[] {
  return [
    ...listResources().flatMap((r) => hitsIn(`resource:${r.uri}`, `${r.name} ${r.description}`)),
    ...listResourceTemplates().flatMap((r) =>
      hitsIn(`resource:${r.uriTemplate}`, `${r.name} ${r.description}`),
    ),
  ];
}

function allowed(hit: Hit): boolean {
  return ALLOWLIST.some((entry) => entry.site === hit.site && entry.match === hit.match);
}

function render(hits: ReadonlyArray<Hit>): string[] {
  return [...new Set(hits.map((h) => `${h.site}: ${h.match}`))].toSorted();
}

describe("agent-facing text names tools and commands, never a legacy vault path", () => {
  const populations: ReadonlyArray<readonly [string, () => Hit[]]> = [
    ["shipped skills (skills/ and plugins/codex/skills/)", skillHits],
    ["MCP instruction bodies", instructionHits],
    ["MCP tool descriptions", toolHits],
    ["MCP resource descriptions", resourceHits],
    ["hook messages and templates", hookHits],
    ["agent templates and the managed instruction block", templateHits],
  ];

  for (const [label, collect] of populations) {
    test(label, () => {
      expect(render(collect().filter((hit) => !allowed(hit)))).toEqual([]);
    });
  }

  test("the populations are not empty, so a pass is not a scan of nothing", () => {
    expect(walkFiles(join(REPO, "skills")).length).toBeGreaterThan(3);
    expect(walkFiles(join(REPO, "plugins", "codex", "skills")).length).toBe(
      walkFiles(join(REPO, "skills")).length,
    );
    expect(buildToolTable(TOOL_SCOPES[0]).length).toBeGreaterThan(5);
    expect(listResources().length).toBeGreaterThan(0);
  });

  test("the pattern sees each spelling of a legacy path", () => {
    const sample =
      "read `Brain/preferences/` and Brain/log/<date>.md, edit _brain.yaml, open _BRAIN.md, " +
      "active.md, pinned.md and lessons.md; not inactive.md";
    expect(hitsIn("sample", sample).map((h) => h.match)).toEqual([
      "Brain/preferences/",
      "Brain/log/<date>.md",
      "_brain.yaml",
      "_BRAIN.md",
      "active.md",
      "pinned.md",
      "lessons.md",
    ]);
  });

  test("every allowlist entry still excuses a real mention and gives a reason", () => {
    const every = [
      ...skillHits(),
      ...instructionHits(),
      ...toolHits(),
      ...resourceHits(),
      ...hookHits(),
      ...templateHits(),
    ];
    const stale = ALLOWLIST.filter(
      (entry) => !every.some((hit) => hit.site === entry.site && hit.match === entry.match),
    ).map((entry) => `${entry.site}: ${entry.match}`);
    expect(stale).toEqual([]);
    for (const entry of ALLOWLIST) expect(entry.reason.length).toBeGreaterThan(10);
  });
});
