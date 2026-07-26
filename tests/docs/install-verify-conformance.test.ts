/**
 * Conformance: the expected-output block in every per-runtime install
 * document must match what the adapter's `verify()` actually prints.
 *
 * The Verify section of each `install/<runtime>.md` used to say "run
 * this" and never "this is what success looks like", so an agent
 * following the document had nothing to pattern-match against. Each
 * document now carries a block introduced by
 *
 *     <!-- expected-output: o2b install --check --target <t> -->
 *
 * and this suite renders the real thing: it installs the target into an
 * injected environment (temp home, temp vault - no adapter reads the
 * real one), calls `verify()`, renders it through the same
 * `renderVerifyTable` the CLI uses, and compares. Machine-specific
 * absolute paths are replaced by the placeholders the documents use.
 *
 * When this fails, the message names the document to edit.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Writable } from "node:stream";

import { registerAllAdapters } from "../../src/core/install/adapters/all.ts";
import {
  resetCopilotRunner,
  setCopilotRunner,
  type CopilotRunner,
} from "../../src/core/install/adapters/copilot-cli.ts";
import { buildPayload } from "../../src/core/install/payload.ts";
import { renderVerifyTable } from "../../src/cli/install/render.ts";
import type {
  ApplyOpts,
  InstallAdapter,
  InstallEnv,
  McpPayload,
} from "../../src/core/install/types.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const INSTALL_DOCS_DIR = join(REPO_ROOT, "install");

/** Placeholders the documents use in place of machine-specific paths. */
const HOME_PLACEHOLDER = "$HOME";
const VAULT_PLACEHOLDER = "<vault>";
const PLUGIN_PLACEHOLDER = "<plugin>";

/** Marker that introduces a documented expected-output block. */
const EXPECTED_OUTPUT_MARKER = "<!-- expected-output:";

const AGENT_NAME = "claude-vps";
const TIMEZONE = "UTC";

/**
 * Install documents with no registered adapter: their Verify step runs a
 * third-party command (`claude mcp list`, `hermes memory status`, …),
 * not `o2b install --check`, so there is nothing in this codebase to
 * assert their output against. Listed rather than skipped so a NEW
 * adapter-backed document cannot quietly avoid the binding.
 */
const PIPELINE_HOSTED_DOCS: Readonly<Record<string, string>> = Object.freeze({
  "claudecode.md": "plugin-hosted; verified with `claude mcp list`, not an OSB adapter",
  "codex.md": "plugin-hosted; verified with `codex mcp list`, not an OSB adapter",
  "hermes.md": "provider-hosted; verified with `hermes memory status`, not an OSB adapter",
  "openclaw.md": "plugin-hosted; verified with `openclaw plugins inspect`, not an OSB adapter",
  "prerequisites.md": "shared setup, not a runtime document",
});

interface Harness {
  readonly vault: string;
  readonly home: string;
  readonly opts: ApplyOpts;
  readonly env: InstallEnv;
  readonly payload: McpPayload;
}

let vault: string;
let home: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-doc-v-"));
  home = mkdtempSync(join(tmpdir(), "osb-doc-h-"));
});

afterEach(() => {
  resetCopilotRunner();
  for (const dir of [vault, home]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // temp cleanup is best-effort
    }
  }
});

function sink(): NodeJS.WriteStream {
  return new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
}

function harness(overrides: Partial<ApplyOpts> = {}): Harness {
  return {
    vault,
    home,
    env: {
      vault,
      home,
      cwd: home,
      env: { VAULT_AGENT_NAME: AGENT_NAME, VAULT_TIMEZONE: TIMEZONE },
      now: new Date("2026-05-20T12:00:00.000Z"),
    },
    // Built from the SAME vault the adapter verifies against: several
    // adapters recompute the expected payload from `env.vault`, so a
    // payload for any other vault would (correctly) verify as drift.
    payload: buildPayload({ vault, agent_name: AGENT_NAME, timezone: TIMEZONE }),
    opts: { dryRun: false, force: false, stdout: sink(), stderr: sink(), ...overrides },
  };
}

/**
 * Per-target setup that puts the adapter into its INSTALLED state. Every
 * entry performs a real apply against the injected environment; nothing
 * here fabricates a manifest.
 */
const INSTALLERS: Readonly<Record<string, (adapter: InstallAdapter) => Harness>> = Object.freeze({
  generic: (adapter) => {
    const h = harness({ outPath: join(home, "osb-mcp.json") });
    return applyInto(adapter, h);
  },
  pi: (adapter) => {
    const h = harness({ piSkillSource: join(REPO_ROOT, "skills", "brain-memory") });
    return applyInto(adapter, h);
  },
  "copilot-cli": (adapter) => {
    // The copilot CLI is not present in a test environment; inject a
    // runner that behaves like a working one so the document shows the
    // subprocess path an operator with the CLI installed will see.
    const registered: string[] = [];
    const runner: CopilotRunner = {
      available: () => true,
      list: () => ({ ok: true, names: [...registered] }),
      run: (args: ReadonlyArray<string>) => {
        if (args[0] === "mcp" && args[1] === "add" && typeof args[2] === "string") {
          registered.push(args[2]);
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    setCopilotRunner(runner);
    return applyInto(adapter, harness());
  },
});

function defaultInstaller(adapter: InstallAdapter): Harness {
  return applyInto(adapter, harness());
}

/** Run the adapter's real plan+apply against the injected environment. */
function applyInto(adapter: InstallAdapter, h: Harness): Harness {
  adapter.apply(adapter.plan(h.payload, h.env), h.payload, h.env, h.opts);
  return h;
}

/** Replace machine-specific absolute paths with the documented placeholders. */
function placeholders(text: string, h: Harness): string {
  return text
    .split(h.vault)
    .join(VAULT_PLACEHOLDER)
    .split(h.home)
    .join(HOME_PLACEHOLDER)
    .split(REPO_ROOT)
    .join(PLUGIN_PLACEHOLDER);
}

/**
 * Trailing whitespace is not comparable across editors (the table pads
 * its status column, and a detail-less row ends in spaces), so both
 * sides are compared line-trimmed.
 */
function comparable(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

interface DocumentedBlock {
  readonly command: string;
  readonly body: string;
  readonly line: number;
}

/** Extract the single expected-output block from an install document. */
function readDocumentedBlock(docPath: string): DocumentedBlock | null {
  const lines = readFileSync(docPath, "utf8").split("\n");
  const markerIdx = lines.findIndex((line) => line.trimStart().startsWith(EXPECTED_OUTPUT_MARKER));
  if (markerIdx < 0) return null;
  const marker = lines[markerIdx]!.trim();
  const command = marker.slice(EXPECTED_OUTPUT_MARKER.length, marker.lastIndexOf("-->")).trim();
  let cursor = markerIdx + 1;
  while (cursor < lines.length && lines[cursor]!.trim() === "") cursor++;
  if (cursor >= lines.length || !lines[cursor]!.startsWith("```")) return null;
  const bodyStart = cursor + 1;
  const bodyEnd = lines.findIndex((line, idx) => idx >= bodyStart && line.startsWith("```"));
  if (bodyEnd < 0) return null;
  return {
    command,
    body: lines.slice(bodyStart, bodyEnd).join("\n"),
    line: markerIdx + 1,
  };
}

const adapters = registerAllAdapters().list();

describe("install documents — expected output matches verify()", () => {
  for (const adapter of adapters) {
    const docRel = `install/${adapter.target}.md`;
    const docPath = join(REPO_ROOT, docRel);

    test(`${docRel} documents what a successful check prints`, () => {
      const documented = readDocumentedBlock(docPath);
      expect(`${docRel}: expected-output block present = ${documented !== null}`).toBe(
        `${docRel}: expected-output block present = true`,
      );
      const install = INSTALLERS[adapter.target] ?? defaultInstaller;
      const h = install(adapter);
      const actual = placeholders(renderVerifyTable([adapter.verify(h.env)]), h);
      // Naming the document inside the compared value puts it in the
      // failure diff, not only in the test title.
      expect(`${docRel}:${documented!.line}\n${comparable(actual)}`).toBe(
        `${docRel}:${documented!.line}\n${comparable(documented!.body)}`,
      );
    });

    test(`${docRel} documents the command the block came from`, () => {
      const documented = readDocumentedBlock(docPath);
      expect(documented?.command).toBe(`o2b install --check --target ${adapter.target}`);
    });
  }
});

describe("install documents — completeness", () => {
  test("every runtime document is either adapter-bound or listed as pipeline-hosted", () => {
    const targets = new Set(adapters.map((a) => `${a.target}.md`));
    const unbound = readdirSyncSorted(INSTALL_DOCS_DIR).filter(
      (name) => !targets.has(name) && !(name in PIPELINE_HOSTED_DOCS),
    );
    expect(unbound).toEqual([]);
  });

  test("every pipeline-hosted document carries a written reason and still exists", () => {
    for (const [name, reason] of Object.entries(PIPELINE_HOSTED_DOCS)) {
      expect(reason.trim().length).toBeGreaterThan(0);
      expect(readdirSyncSorted(INSTALL_DOCS_DIR)).toContain(name);
    }
  });
});

function readdirSyncSorted(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .toSorted();
}
