/**
 * A preference the dream pass drafts keeps the strictest visibility of the
 * records it is drafted from.
 *
 * The pass copies a signal's principle into a new unconfirmed preference
 * and, when it supersedes or rebuts a record, quotes that record's
 * principle in the `supersedes` link. The new page must therefore be no
 * more visible than any of them: drafted from a reserved signal it is
 * reserved, from signals sharing a scope token it carries that token, and
 * from default pages only it stays byte-identical to before (no
 * `visibility` line). The last block runs the pass through the real
 * MCPServer at local reach and then asks for the drafted preference at
 * remote reach.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dream } from "../../../src/core/brain/dream.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { brainConfigPath, preferencePath } from "../../../src/core/brain/paths.ts";
import { moveToRetired, writePreference } from "../../../src/core/brain/preference.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { BRAIN_RETIRED_REASON } from "../../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import {
  pageVisibility,
  REMOTE_DENY_VISIBILITY_TOKEN,
} from "../../../src/core/graph/visibility.ts";
import { parseFrontmatter } from "../../../src/core/vault.ts";
import { MCPServer } from "../../../src/mcp/server.ts";

const NOW = new Date("2026-06-05T12:00:00Z");
const SIGNAL_STAMP = "2026-06-01T10:00:00Z";
const TOPIC = "release-notes";
const PRINCIPLE = "Quote the private budget figure in every release note.";
const TEAM = "team";

let tmp: string;
const savedConfig = process.env["OPEN_SECOND_BRAIN_CONFIG"];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-dream-visibility-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfig;
});

interface Vault {
  readonly vault: string;
  readonly configPath: string;
}

function newVault(name: string): Vault {
  const vault = join(tmp, name);
  const configPath = join(tmp, `${name}.yaml`);
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  // Three agreeing signals draft a preference.
  const yaml = readFileSync(brainConfigPath(vault), "utf8").replace(
    /^ {2}candidate_threshold: \d+$/m,
    "  candidate_threshold: 3",
  );
  atomicWriteFileSync(brainConfigPath(vault), yaml);
  return { vault, configPath };
}

/** Insert a `visibility:` line as the first frontmatter field of `path`. */
function stampVisibility(path: string, tokens: ReadonlyArray<string>): void {
  const text = readFileSync(path, "utf8");
  atomicWriteFileSync(path, text.replace(/^---\n/, `---\nvisibility: [${tokens.join(", ")}]\n`));
}

function seed(
  vault: string,
  slug: string,
  tokens: ReadonlyArray<string> = [],
  stamp: string = SIGNAL_STAMP,
): void {
  const { path } = writeSignal(vault, {
    topic: TOPIC,
    signal: "positive",
    agent: "claude",
    principle: PRINCIPLE,
    created_at: stamp,
    date: stamp.slice(0, 10),
    slug,
  });
  if (tokens.length > 0) stampVisibility(path, tokens);
}

function seedPreference(vault: string, slug: string): string {
  const { path } = writePreference(vault, {
    slug,
    topic: TOPIC,
    principle: "The rule of record for release notes.",
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-15T00:00:00Z",
    confirmed_at: "2026-05-08T00:00:00Z",
    status: "confirmed",
    evidenced_by: [],
    applied_count: 2,
    violated_count: 0,
    last_evidence_at: "2026-06-01T00:00:00Z",
    confidence: "medium",
  });
  return path;
}

/** Run a real pass and return the visibility tokens of the one drafted preference. */
function draftedVisibility(vault: string): ReadonlyArray<string> {
  const report = dream(vault, { now: NOW, agentName: "claude" });
  expect(report.new_unconfirmed).toHaveLength(1);
  const id = report.new_unconfirmed[0]!;
  const path = preferencePath(vault, id.slice("pref-".length));
  expect(readFileSync(path, "utf8")).toContain(PRINCIPLE);
  return pageVisibility(parseFrontmatter(path)[0]);
}

describe("a drafted preference keeps its sources' strictest visibility", () => {
  test("drafted from reserved signals, it is reserved", () => {
    const { vault } = newVault("reserved");
    for (const s of ["a", "b", "c"]) seed(vault, s, [REMOTE_DENY_VISIBILITY_TOKEN]);
    expect(draftedVisibility(vault)).toEqual([REMOTE_DENY_VISIBILITY_TOKEN]);
  });

  test("one reserved signal in a mixed cluster reserves it", () => {
    const { vault } = newVault("mixed");
    seed(vault, "a");
    seed(vault, "b", [TEAM]);
    seed(vault, "c", [REMOTE_DENY_VISIBILITY_TOKEN]);
    expect(draftedVisibility(vault)).toEqual([REMOTE_DENY_VISIBILITY_TOKEN]);
  });

  test("a scope token on one signal carries over beside default ones", () => {
    const { vault } = newVault("scoped");
    seed(vault, "a");
    seed(vault, "b", [TEAM]);
    seed(vault, "c");
    expect(draftedVisibility(vault)).toEqual([TEAM]);
  });

  test("drafted from default signals only, it carries no visibility line", () => {
    const { vault } = newVault("default");
    for (const s of ["a", "b", "c"]) seed(vault, s);
    const report = dream(vault, { now: NOW, agentName: "claude" });
    const path = preferencePath(vault, report.new_unconfirmed[0]!.slice("pref-".length));
    expect(readFileSync(path, "utf8")).not.toContain("visibility");
  });

  test("superseding a reserved retired record, it is reserved", () => {
    const { vault } = newVault("supersede");
    stampVisibility(seedPreference(vault, "old-notes"), [REMOTE_DENY_VISIBILITY_TOKEN]);
    moveToRetired(vault, preferencePath(vault, "old-notes"), BRAIN_RETIRED_REASON.rebutted, {
      now: new Date("2026-05-20T00:00:00Z"),
      retired_by: "test",
      evidenceApplied: [],
      evidenceViolated: [],
    });
    for (const s of ["a", "b", "c"]) seed(vault, s);
    expect(draftedVisibility(vault)).toEqual([REMOTE_DENY_VISIBILITY_TOKEN]);
  });

  test("rebutting a reserved preference, the drafted one is reserved", () => {
    const { vault } = newVault("rebut");
    stampVisibility(seedPreference(vault, "notes-rule"), [REMOTE_DENY_VISIBILITY_TOKEN]);
    // No evidence resolves the active sign, so a unanimous batch reads as
    // a rebuttal and drafts a `-rebut` preference that quotes the old one.
    for (const s of ["a", "b", "c"]) seed(vault, s);
    expect(draftedVisibility(vault)).toEqual([REMOTE_DENY_VISIBILITY_TOKEN]);
  });
});

describe("through the MCP server", () => {
  async function draftedOverMcp(tokens: ReadonlyArray<string>): Promise<{
    readonly id: string;
    readonly remote: string;
  }> {
    const v = newVault(tokens.length > 0 ? "mcp-reserved" : "mcp-default");
    // The server's pass runs on the wall clock, so the signals are fresh.
    const stamp = `${new Date().toISOString().slice(0, 19)}Z`;
    for (const s of ["a", "b", "c"]) seed(v.vault, s, tokens, stamp);
    process.env["OPEN_SECOND_BRAIN_CONFIG"] = v.configPath;
    const config = { vault: v.vault, configPath: v.configPath };
    const local = new MCPServer(config, { reach: TRANSPORT_REACH.local });
    const run = await local.callTool("brain_dream", { action: "run" });
    const drafted = (run["structuredContent"] ?? run) as { new_unconfirmed?: string[] };
    const id = JSON.stringify(drafted).match(/pref-[a-z0-9-]+/)?.[0];
    if (id === undefined) throw new Error(`the local pass drafted nothing: ${JSON.stringify(run)}`);
    const remote = new MCPServer(config);
    let answer: string;
    try {
      answer = JSON.stringify(await remote.callTool("brain_query", { preference: id }));
    } catch (error) {
      answer = (error as Error).message;
    }
    return { id, remote: answer };
  }

  test("a preference drafted locally from reserved signals is absent at remote reach", async () => {
    const { id, remote } = await draftedOverMcp([REMOTE_DENY_VISIBILITY_TOKEN]);
    expect(remote).not.toContain(PRINCIPLE);
    expect(remote).toContain(`no preference or retired entry found for id '${id}'`);
  });

  test("control: drafted from default signals, a remote caller reads it", async () => {
    const { remote } = await draftedOverMcp([]);
    expect(remote).toContain(PRINCIPLE);
  });
});
