/**
 * `brain_health` and the `brain_doctor` repair branch answer at the
 * caller's reach.
 *
 * Vault A holds a preference reserved against remote reads that both
 * contradicts a shared one (a `brain_health` finding naming it) and cites
 * a dead evidence signal (a repair the doctor would plan, and apply, on
 * it). Vault B never had it. The same remote call must answer identically
 * in both once vault paths are normalised; at remote reach the reserved
 * record is neither planned nor written and no repair event is logged for
 * it. A local caller is still told about it and still gets it fixed, so
 * an identical pair is not an empty surface.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { brainDirs } from "../../src/core/brain/paths.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { BRAIN_PREFERENCE_STATUS, BRAIN_SIGNAL_SIGN } from "../../src/core/brain/types.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import { MCPServer } from "../../src/mcp/server.ts";

const PRIVATE_SLUG = "zzwithheldrulezz";
const PRIVATE_PATH = `Brain/preferences/pref-${PRIVATE_SLUG}.md`;
const DEAD_SIGNAL = "sig-never-written";
const RESERVE_LINE = `visibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]`;
const REPAIR_EVENT = "doctor-repair";
/** Doctor classes no fixer covers, which the fixture's records raise. */
const UNUSED_RULE_CODE = "low-evidence-confirmed";
const BROKEN_BACKLINK_CODE = "broken-backlinks";
/** Any ISO-8601 instant: the two vaults are built seconds apart. */
const STAMP_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

const bases: string[] = [];
const savedConfig = process.env["OPEN_SECOND_BRAIN_CONFIG"];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfig;
});

interface Fixture {
  readonly base: string;
  readonly configPath: string;
  readonly vault: string;
}

function signal(vault: string, slug: string, sign: "positive" | "negative"): string {
  return writeSignal(vault, {
    topic: "indentation",
    signal: sign === "positive" ? BRAIN_SIGNAL_SIGN.positive : BRAIN_SIGNAL_SIGN.negative,
    agent: "t",
    principle: `use ${slug}`,
    created_at: "2026-05-01T00:00:00Z",
    date: "2026-05-01",
    slug,
  }).id;
}

function confirmed(
  vault: string,
  slug: string,
  principle: string,
  evidence: ReadonlyArray<string>,
): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    confirmed_at: "2026-05-08T00:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: evidence.map((id) => `[[${id}]]`),
  });
}

function fixture(withPrivate: boolean): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-health-repair-reach-"));
  bases.push(base);
  const vault = join(base, "vault");
  const configPath = join(base, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  const pos = signal(vault, "tabs-pos", "positive");
  const neg = signal(vault, "tabs-neg", "negative");
  confirmed(vault, "spaces-rule", "never indent source with tabs always spaces", [neg]);
  if (withPrivate) {
    confirmed(vault, PRIVATE_SLUG, "always indent source with tabs not spaces", [pos, DEAD_SIGNAL]);
    const abs = join(vault, PRIVATE_PATH);
    const text = readFileSync(abs, "utf8");
    const close = text.indexOf("\n---\n", "---\n".length);
    writeFileSync(abs, `${text.slice(0, close)}\n${RESERVE_LINE}${text.slice(close)}`);
  }
  return { base, configPath, vault };
}

async function answer(
  f: Fixture,
  tool: string,
  args: Record<string, unknown>,
  reach: TransportReach,
): Promise<string> {
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = f.configPath;
  const server = new MCPServer({ vault: f.vault, configPath: f.configPath }, { reach });
  const result = await server.callTool(tool, args);
  return JSON.stringify(result)
    .split(JSON.stringify(f.vault).slice(1, -1))
    .join("<V>")
    .split(JSON.stringify(f.base).slice(1, -1))
    .join("<B>")
    .replaceAll("\\\\\\\\", "/")
    .replace(STAMP_RE, "<T>");
}

/** `unfixable` of a `brain_doctor {repair:true}` answer, as code -> count. */
function unfixableCounts(answerText: string): Map<string, number> {
  const envelope = JSON.parse(answerText) as { content: ReadonlyArray<{ text: string }> };
  const payload = JSON.parse(envelope.content[0]!.text) as {
    repair: { unfixable: ReadonlyArray<{ code: string; count: number }> };
  };
  return new Map(payload.repair.unfixable.map((u) => [u.code, u.count]));
}

/** Every log day's text: a repair event names the page it fixed. */
function logText(f: Fixture): string {
  const dir = brainDirs(f.vault).log;
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .join("\n");
}

describe("a reserved preference is absent from health and repair at remote reach", () => {
  for (const [tool, args] of [
    ["brain_health", {}],
    ["brain_doctor", { repair: true }],
  ] as const) {
    test(`${tool} ${JSON.stringify(args)} answers identically`, async () => {
      const withheld = await answer(fixture(true), tool, args, TRANSPORT_REACH.remote);
      const absent = await answer(fixture(false), tool, args, TRANSPORT_REACH.remote);
      expect(withheld).not.toContain(PRIVATE_SLUG);
      expect(withheld).toBe(absent);
    });
  }

  test("brain_doctor repair apply neither writes the reserved record nor logs it", async () => {
    const a = fixture(true);
    const before = readFileSync(join(a.vault, PRIVATE_PATH), "utf8");
    const withheld = await answer(
      a,
      "brain_doctor",
      { repair: true, apply: true },
      TRANSPORT_REACH.remote,
    );
    const absent = await answer(
      fixture(false),
      "brain_doctor",
      { repair: true, apply: true },
      TRANSPORT_REACH.remote,
    );
    expect(withheld).toBe(absent);
    expect(readFileSync(join(a.vault, PRIVATE_PATH), "utf8")).toBe(before);
    expect(logText(a)).not.toContain(PRIVATE_SLUG);
  });

  test("a remote caller is still told about a shared record and still gets it repaired", async () => {
    // Positive control for the A/B above: vault B alone has no finding and
    // no fix, so an identical pair also passes if remote reach drops every
    // finding. A shared record with the same defects must survive remote.
    const b = fixture(false);
    const sharedSlug = "zzsharedrulezz";
    const sharedDead = "sig-shared-never-written";
    confirmed(b.vault, sharedSlug, "always indent source with tabs not spaces", [
      signal(b.vault, "tabs-pos-shared", "positive"),
      sharedDead,
    ]);
    const sharedPath = join(b.vault, `Brain/preferences/pref-${sharedSlug}.md`);
    // Nothing is withheld here, so the remote answer is the local one.
    const health = await answer(b, "brain_health", {}, TRANSPORT_REACH.remote);
    expect(health).toContain(sharedSlug);
    expect(health).toBe(await answer(b, "brain_health", {}, TRANSPORT_REACH.local));
    const plan = await answer(b, "brain_doctor", { repair: true }, TRANSPORT_REACH.remote);
    expect(plan).toContain(sharedDead);
    expect(plan).toBe(await answer(b, "brain_doctor", { repair: true }, TRANSPORT_REACH.local));
    await answer(b, "brain_doctor", { repair: true, apply: true }, TRANSPORT_REACH.remote);
    expect(readFileSync(sharedPath, "utf8")).not.toContain(sharedDead);
  });

  test("the unfixable counts leave the reserved record out at remote and count it locally", async () => {
    // The reserved record is a confirmed rule with no recorded use, a
    // class no fixer covers, so it lands in `unfixable[].count`, and it
    // also breaks a backlink. Locally both are counted; at remote reach
    // the counts are vault B's.
    const a = fixture(true);
    const local = unfixableCounts(
      await answer(a, "brain_doctor", { repair: true }, TRANSPORT_REACH.local),
    );
    expect(local.get(UNUSED_RULE_CODE)).toBe(2);
    expect(local.get(BROKEN_BACKLINK_CODE)).toBe(1);
    const remote = unfixableCounts(
      await answer(a, "brain_doctor", { repair: true }, TRANSPORT_REACH.remote),
    );
    expect(remote.get(UNUSED_RULE_CODE)).toBe(1);
    expect(remote.has(BROKEN_BACKLINK_CODE)).toBe(false);
    expect(remote).toEqual(
      unfixableCounts(
        await answer(fixture(false), "brain_doctor", { repair: true }, TRANSPORT_REACH.remote),
      ),
    );
  });

  test("a local caller is still told about the record and still gets it repaired", async () => {
    const a = fixture(true);
    expect(await answer(a, "brain_health", {}, TRANSPORT_REACH.local)).toContain(PRIVATE_SLUG);
    expect(await answer(a, "brain_doctor", { repair: true }, TRANSPORT_REACH.local)).toContain(
      DEAD_SIGNAL,
    );
    await answer(a, "brain_doctor", { repair: true, apply: true }, TRANSPORT_REACH.local);
    expect(readFileSync(join(a.vault, PRIVATE_PATH), "utf8")).not.toContain(DEAD_SIGNAL);
    expect(logText(a)).toContain(REPAIR_EVENT);
    expect(logText(a)).toContain(PRIVATE_SLUG);
  });
});
