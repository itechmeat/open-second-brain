/**
 * A page the caller may not read at its reach answers exactly as an
 * absent page would.
 *
 * Every case builds two vaults through the same local-reach setup: vault
 * A keeps `Notes/secret.md` (`visibility: private`), vault B deletes it
 * once the setup has run. The same call through a real `MCPServer` with
 * no reach minted (so remote, fail closed) must then answer identically
 * in both, once run ids, timestamps and the vault paths are normalised.
 * A local-reach control shows the page is still there for a caller that
 * may read it, so an identical pair is not an empty surface.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { dream } from "../../src/core/brain/dream.ts";
import { brainConfigPath } from "../../src/core/brain/paths.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { BRAIN_PREFERENCE_STATUS } from "../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { MCPServer } from "../../src/mcp/index.ts";
import { readableAtContextReach } from "../../src/mcp/brain/reach-readable.ts";

const SECRET_REL = "Notes/secret.md";
const PRIVATE_BODY =
  "---\nvisibility: private\ntitle: Secret plan\n---\n# Secret plan\nThe PIN is 4711. See [[open]].\n";
const OPEN = "---\ntitle: Open page\n---\n# Open page\nLinks to [[secret]] and [[Notes/secret]].\n";

type Call = readonly [string, Record<string, unknown>];

interface Fixture {
  readonly base: string;
  readonly vault: string;
  readonly configPath: string;
}

const made: string[] = [];
const savedConfig = process.env["OPEN_SECOND_BRAIN_CONFIG"];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfig;
});

async function fixture(
  setup: ReadonlyArray<Call>,
  dropSecret: boolean,
  prepare?: (vault: string) => void,
): Promise<Fixture> {
  const base = mkdtempSync(join(tmpdir(), "o2b-reach-absent-"));
  made.push(base);
  const vault = join(base, "vault");
  mkdirSync(join(vault, "Notes"), { recursive: true });
  const configPath = join(base, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  writeFileSync(join(vault, SECRET_REL), PRIVATE_BODY);
  writeFileSync(join(vault, "Notes/open.md"), OPEN);
  const local = new MCPServer({ vault, configPath }, { reach: TRANSPORT_REACH.local });
  // Setup calls build on each other, so they run in order.
  // eslint-disable-next-line no-await-in-loop
  for (const [name, args] of setup) await local.callTool(name, args);
  prepare?.(vault);
  if (dropSecret) rmSync(join(vault, SECRET_REL));
  return { base, vault, configPath };
}

function normalise(text: string, fx: Fixture): string {
  return text
    .split(fx.vault)
    .join("<V>")
    .split(fx.base)
    .join("<B>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?([+-]\d{2}:?\d{2})?/g, "<TS>")
    .replace(/"(\w*_ms|duration\w*|elapsed\w*|took\w*)":\s*[\d.]+/g, '"$1":<N>')
    .replace(/run-\d+-[a-z0-9]+/g, "<RUN>")
    .replace(/vault:\/\/[0-9a-f]{32}/g, "vault://<H>");
}

async function answer(
  fx: Fixture,
  call: Call,
  reach?: (typeof TRANSPORT_REACH)[keyof typeof TRANSPORT_REACH],
): Promise<string> {
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = fx.configPath;
  const server = new MCPServer(
    { vault: fx.vault, configPath: fx.configPath },
    reach !== undefined ? { reach } : {},
  );
  try {
    const res = (await server.callTool(call[0], call[1])) as Record<string, unknown>;
    return normalise(JSON.stringify(res["structuredContent"] ?? res), fx);
  } catch (err) {
    return normalise(`ERR ${(err as Error).message}`, fx);
  }
}

const CREATE_SECRET: Call = [
  "brain_create_note",
  { path: "Notes/private-write.md", frontmatter: { visibility: "private" }, content: "x\n" },
];

/** The remote answer with the page kept, the remote answer with it deleted, and the local answer. */
async function pair(
  setup: ReadonlyArray<Call>,
  call: Call,
  prepare?: (vault: string) => void,
): Promise<{ withheld: string; absent: string; local: string }> {
  const a = await fixture(setup, false, prepare);
  const b = await fixture(setup, true, prepare);
  return {
    withheld: await answer(a, call),
    absent: await answer(b, call),
    local: await answer(a, call, TRANSPORT_REACH.local),
  };
}

/** The remote answer with a privately written page kept, then deleted, and the local answer. */
async function writePair(call: Call): Promise<{ withheld: string; absent: string; local: string }> {
  const a = await fixture([CREATE_SECRET], false);
  const b = await fixture([CREATE_SECRET], false);
  rmSync(join(b.vault, "Notes/private-write.md"));
  return {
    withheld: await answer(a, call),
    absent: await answer(b, call),
    local: await answer(a, call, TRANSPORT_REACH.local),
  };
}

describe("write events name a withheld page as they name an absent one", () => {
  test("brain_event_trace", async () => {
    const r = await writePair(["brain_event_trace", { kind: "note-write" }]);
    expect(r.withheld).toBe(r.absent);
    expect(r.withheld).not.toContain("private-write");
    expect(r.local).toContain("Notes/private-write.md");
  });

  test("brain_agent_query", async () => {
    const r = await writePair(["brain_agent_query", { kind: "note" }]);
    expect(r.withheld).toBe(r.absent);
    expect(r.withheld).not.toContain("private-write");
    expect(r.local).toContain("Notes/private-write.md");
  });

  test("brain_agent_diff", async () => {
    const r = await writePair(["brain_agent_diff", { kind: "note" }]);
    expect(r.withheld).toBe(r.absent);
    expect(r.withheld).not.toContain("private-write");
    expect(r.local).toContain("Notes/private-write.md");
  });
});

/** A vault whose dream pass fires one rollup rung, so its envelope carries link candidates. */
function armRollup(vault: string): void {
  atomicWriteFileSync(
    brainConfigPath(vault),
    "schema_version: 1\nrollup:\n  fact_threshold: 1\n  identity_threshold: 5\n",
  );
  writePreference(vault, {
    slug: "one-fact",
    topic: "one-fact",
    principle: "principle for one fact",
    created_at: "2026-01-01T00:00:00Z",
    unconfirmed_until: "2026-01-08T00:00:00Z",
    confirmed_at: new Date().toISOString(),
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: [],
    applied_count: 0,
    violated_count: 0,
    last_evidence_at: null,
    confidence_value: 0,
  });
}

/** The rollup envelope's link candidates of a dream pass bound to the handler's predicate. */
async function dreamCandidates(dropSecret: boolean, reach?: "local"): Promise<string> {
  const fx = await fixture([], dropSecret, armRollup);
  const ctx = {
    vault: fx.vault,
    configPath: fx.configPath,
    repoRoot: null,
    ...(reach !== undefined ? { reach: TRANSPORT_REACH.local } : {}),
  };
  const summary = dream(fx.vault, { dryRun: true, readable: readableAtContextReach(ctx) });
  expect(summary.rollups).toHaveLength(1);
  return JSON.stringify(summary.rollups[0]!.envelope.link_candidates);
}

describe("link candidates leave out a withheld page as they leave out an absent one", () => {
  test("brain_design_note", async () => {
    const r = await pair([], ["brain_design_note", { topic: "secret plan" }]);
    expect(r.withheld).toBe(r.absent);
    expect(r.withheld).not.toContain('"secret"');
    expect(r.local).toContain('"secret"');
  });

  test("brain_diarize", async () => {
    const setup: ReadonlyArray<Call> = [
      [
        "brain_ingest_source",
        {
          source_path: "Notes/open.md",
          summary: "open summary",
          entities: [{ category: "person", name: "Olga Open" }],
        },
      ],
    ];
    const r = await pair(setup, ["brain_diarize", { entity: "Olga Open" }]);
    expect(r.withheld).toBe(r.absent);
    expect(r.withheld).not.toContain('"secret"');
    expect(r.local).toContain('"secret"');
  });

  // brain_dream does not project the rollup envelope onto the wire; the
  // pass the handler runs is driven here with the predicate it binds.
  test("brain_dream's rollup envelope", async () => {
    const withheld = await dreamCandidates(false);
    expect(withheld).toBe(await dreamCandidates(true));
    expect(withheld).not.toContain('"secret"');
    expect(await dreamCandidates(false, "local")).toContain('"secret"');
  });
});

describe("a revert plan over a withheld page seals what an absent page's plan seals", () => {
  test("brain_writes plan_revert", async () => {
    const r = await writePair([
      "brain_writes",
      { action: "plan_revert", path: "Notes/private-write.md" },
    ]);
    expect(r.withheld.replace(/"planned_at":"[^"]*"/, "")).toBe(
      r.absent.replace(/"planned_at":"[^"]*"/, ""),
    );
    expect(r.withheld).toContain('"entries":[]');
    expect(r.local).toContain('"target":"Notes/private-write.md"');
  });
});

/** The brain_status hygiene problem line, or a marker when there is none. */
function hygieneLine(answerText: string): string {
  const body = JSON.parse(answerText) as {
    problems: ReadonlyArray<{ code: string; detail: string }>;
  };
  return body.problems.find((p) => p.code === "hygiene-findings")?.detail ?? "<none>";
}

// `secret-2.md` beside `secret.md` is a slug-collision finding that
// names both pages.
function collide(vault: string): void {
  writeFileSync(join(vault, "Notes/secret-2.md"), "# Two\n");
}

describe("aggregate counts leave out a withheld page as they leave out an absent one", () => {
  test("brain_status hygiene count", async () => {
    const r = await pair([], ["brain_status", {}], collide);
    expect(hygieneLine(r.withheld)).toBe(hygieneLine(r.absent));
    expect(hygieneLine(r.local)).not.toBe(hygieneLine(r.withheld));
  });
});
