/**
 * `brain_doctor` caps its removed-tool warnings and counts the states
 * behind its stale-dependency note at the caller's reach.
 *
 * Both are computed inside the doctor's checks, before the handler's
 * own filter runs: a withheld page that spent a slot of the removed-tool
 * cap, or a withheld retired record counted in `states_changed`, would
 * change the answer even though no finding names it.
 *
 * The vault pair is tests/helpers/reach-log-fixture.ts, plus 50 readable
 * pages naming a removed tool in both and, in vault A only, a withheld
 * Brain page whose validity closed (a state that stopped being current)
 * and 50 withheld pages naming the removed tool: the walk lists them in directory order, so withheld
 * pages are among the first 50 whatever that order is. Two more pairs
 * extend it: a readable closed state cited by a readable preference and,
 * in vault A only, by a withheld one; and 50 readable Brain pages with a
 * frontmatter line the scanner drops, plus 50 withheld ones in vault A
 * only, which sort first. A server with no reach minted is a remote
 * caller, and its whole masked answer must be the same over both vaults;
 * the local control proves the withheld items are there to count.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writePreference } from "../../src/core/brain/preference.ts";
import { BRAIN_CONFIDENCE, BRAIN_PREFERENCE_STATUS } from "../../src/core/brain/types.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import {
  buildReachLogFixture,
  maskVolatile,
  reachServer,
  type ReachLogFixture as Fixture,
} from "../helpers/reach-log-fixture.ts";

/** A tool the product no longer ships, which the doctor reports when a page names it. */
const REMOVED_TOOL = "brain_digest";
const PAGE_COUNT = 50;
const PAGE_DIR = "Brain/memos";
const PRIVATE_PATH = "PRIVATE_PATH";
/**
 * Prefix of every withheld page that competes with readable pages for a
 * 50-slot cap. The scans walk in directory order, which the filesystem
 * decides: case-insensitive alphabetical on NTFS, where `memo-` sorts before
 * `PRIVATE_PATH-` and the readable pages alone fill the cap. The prefix sorts
 * before the readable names (`memo-`, `zz-draft-`) in byte order and in
 * case-insensitive order alike, so an alphabetical walk reaches the withheld
 * pages first and a hashed walk (ext4) interleaves them with the readable ones.
 */
const WITHHELD_FIRST_PREFIX = "AA-";
const REMOVED_TOOL_CODE = "removed-tool-reference";
const STALE_DEPENDENCY_CODE = "stale-dependency";
const RESERVE_LINE = `visibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]`;
/** A readable state whose validity closed, cited by the consumers below. */
const CLOSED_STATE = "pubclosed";
/** A consumer written before the state closed, so the citation is stale. */
const CONSUMER_WRITTEN_AT = new Date("2025-06-01T00:00:00Z");
/** A frontmatter line the line scanner cannot express, so it is dropped. */
const DROPPED_LINE = "this line is not yaml";

/** Which extra page pairs a fixture carries beside the removed-tool pages. */
interface Extras {
  /** The readable closed state and its consumers. */
  readonly cited?: boolean;
  /** The pages with a dropped frontmatter line. */
  readonly dropped?: boolean;
  /** A withheld vault-root instruction file over the ceiling (vault A only). */
  readonly instruction?: boolean;
}

/** A vault-root instruction file the doctor measures against its ceiling. */
const INSTRUCTION_FILE = "AGENTS.md";
/** Over the default `guardrails.instruction_file_max_lines` of 200. */
const INSTRUCTION_FILE_LINES = 250;

const bases: string[] = [];
const savedConfig = process.env["OPEN_SECOND_BRAIN_CONFIG"];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfig;
});

function page(index: number, reserved: boolean): string {
  const front = reserved ? `---\nvisibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]\n---\n` : "";
  return `${front}# memo ${index}\n\nCall ${REMOVED_TOOL} for the summary.\n`;
}

/** A confirmed preference citing {@link CLOSED_STATE}, written before it closed. */
function consumer(vault: string, slug: string, principle: string, reserved: boolean): void {
  writePreference(vault, {
    slug,
    topic: slug,
    // Principles that share no word, so no concept gap rides along.
    principle,
    created_at: "2025-05-01T00:00:00Z",
    unconfirmed_until: "2025-05-08T00:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: [],
    confirmed_at: "2025-05-02T00:00:00Z",
    applied_count: 1,
    violated_count: 0,
    last_evidence_at: "2025-05-02T00:00:00Z",
    confidence: BRAIN_CONFIDENCE.high,
    confidence_value: 0.8,
  });
  const path = join(vault, "Brain", "preferences", `pref-${slug}.md`);
  appendFileSync(path, `\nSee [[${CLOSED_STATE}]].\n`);
  if (reserved) {
    const text = readFileSync(path, "utf8");
    const close = text.indexOf("\n---\n", "---\n".length);
    writeFileSync(path, `${text.slice(0, close)}\n${RESERVE_LINE}${text.slice(close)}`);
  }
  utimesSync(path, CONSUMER_WRITTEN_AT, CONSUMER_WRITTEN_AT);
}

function addCited(vault: string, withPrivate: boolean): void {
  writeFileSync(
    join(vault, "Brain", `${CLOSED_STATE}.md`),
    "---\nvalid_until: 2026-01-01T00:00:00Z\n---\n# closed\n",
  );
  consumer(vault, "consumer-public", "Keep the ledger tidy.", false);
  if (withPrivate) {
    consumer(vault, `${PRIVATE_PATH.toLowerCase()}-consumer`, "Archive weekly snapshots.", true);
  }
}

function addDropped(vault: string, withPrivate: boolean): void {
  const dir = join(vault, "Brain", "drafts");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < PAGE_COUNT; i++) {
    const n = String(i).padStart(2, "0");
    writeFileSync(join(dir, `zz-draft-${n}.md`), `---\ntitle: d\n${DROPPED_LINE}\n---\n# d\n`);
    if (withPrivate) {
      writeFileSync(
        join(dir, `${WITHHELD_FIRST_PREFIX}${PRIVATE_PATH}-${n}.md`),
        `---\n${RESERVE_LINE}\n${DROPPED_LINE}\n---\n# d\n`,
      );
    }
  }
}

function fixture(withPrivate: boolean, extras: Extras = {}): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-doctor-counts-reach-"));
  bases.push(base);
  const f = buildReachLogFixture(base, withPrivate);
  const dir = join(f.vault, ...PAGE_DIR.split("/"));
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < PAGE_COUNT; i++) {
    const n = String(i).padStart(2, "0");
    writeFileSync(join(dir, `memo-${n}.md`), page(i, false));
    if (withPrivate) {
      writeFileSync(join(dir, `${WITHHELD_FIRST_PREFIX}${PRIVATE_PATH}-${n}.md`), page(i, true));
    }
  }
  if (withPrivate) {
    writeFileSync(
      join(f.vault, "Brain", `${PRIVATE_PATH}-closed.md`),
      `---\nvisibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]\nvalid_until: 2026-01-01T00:00:00Z\n---\n# closed\n`,
    );
  }
  if (extras.cited) addCited(f.vault, withPrivate);
  if (extras.dropped) addDropped(f.vault, withPrivate);
  if (extras.instruction && withPrivate) {
    const body = Array.from({ length: INSTRUCTION_FILE_LINES }, (_, i) => `- rule ${i}`);
    writeFileSync(
      join(f.vault, INSTRUCTION_FILE),
      `---\n${RESERVE_LINE}\n---\n${body.join("\n")}\n`,
    );
  }
  return f;
}

interface Entry {
  readonly code: string;
  readonly message: string;
}

interface Report {
  readonly warnings: ReadonlyArray<Entry>;
  readonly uncertain?: ReadonlyArray<Entry>;
}

/** The doctor's whole answer as JSON, with the fixture's paths and instants masked. */
async function doctorJson(f: Fixture, reach?: TransportReach): Promise<string> {
  const result = (await reachServer(f, reach).callTool("brain_doctor", {})) as Record<
    string,
    unknown
  >;
  return maskVolatile(f, result["structuredContent"] ?? result);
}

/** The repair preview (a dry run) as JSON, with the fixture's paths and instants masked. */
async function repairJson(f: Fixture, reach?: TransportReach): Promise<string> {
  const result = (await reachServer(f, reach).callTool("brain_doctor", {
    repair: true,
    format: "json",
  })) as Record<string, unknown>;
  return maskVolatile(f, result["structuredContent"] ?? result);
}

interface Unfixable {
  readonly code: string;
  readonly count: number;
}

function unfixableCount(json: string, code: string): number | undefined {
  const parsed = JSON.parse(json) as { repair: { unfixable: ReadonlyArray<Unfixable> } };
  return parsed.repair.unfixable.find((u) => u.code === code)?.count;
}

async function doctor(f: Fixture, reach?: TransportReach): Promise<Report> {
  return JSON.parse(await doctorJson(f, reach)) as Report;
}

/** The remote answers over vault A and vault B, whole and masked. */
async function remotePair(extras: Extras = {}): Promise<readonly [string, string]> {
  const withheld = await doctorJson(fixture(true, extras));
  const absent = await doctorJson(fixture(false, extras));
  return [withheld, absent];
}

function staleRows(report: Report): ReadonlyArray<string> {
  return report.warnings.filter((w) => w.code === STALE_DEPENDENCY_CODE).map((w) => w.message);
}

function droppedLineEntries(report: Report): number {
  return (report.uncertain ?? []).filter(
    (u) => u.message.includes(DROPPED_LINE) || u.code === "frontmatter-line-dropped",
  ).length;
}

function removedToolWarnings(report: Report): ReadonlyArray<string> {
  return report.warnings
    .filter((w) => w.code === REMOVED_TOOL_CODE)
    .map((w) => w.message)
    .toSorted();
}

function staleNotes(report: Report): ReadonlyArray<string> {
  return (report.uncertain ?? [])
    .filter((u) => u.code === STALE_DEPENDENCY_CODE)
    .map((u) => u.message);
}

describe("brain_doctor counts at the caller's reach", () => {
  test("remote reach: withheld pages spend no slot of the removed-tool cap", async () => {
    const [withheld, absent] = await remotePair();
    expect(withheld).toBe(absent);
    expect(removedToolWarnings(JSON.parse(absent) as Report)).toHaveLength(PAGE_COUNT);
    expect(withheld).not.toContain(PRIVATE_PATH);
  });

  test("remote reach: the repair preview spends no slot of the removed-tool cap on withheld pages", async () => {
    const withheld = await repairJson(fixture(true));
    const absent = await repairJson(fixture(false));
    expect(withheld).toBe(absent);
    expect(unfixableCount(absent, REMOVED_TOOL_CODE)).toBe(PAGE_COUNT);
    expect(withheld).not.toContain(PRIVATE_PATH);
  });

  test("local control: the operator's repair preview over the same vault counts the withheld pages", async () => {
    // The removed-tool count sits at the cap either way; the withheld
    // pages show in the codes and counts the remote preview leaves out.
    const json = await repairJson(fixture(true), TRANSPORT_REACH.local);
    expect(unfixableCount(json, REMOVED_TOOL_CODE)).toBe(PAGE_COUNT);
    expect(json).not.toBe(await repairJson(fixture(true)));
  });

  test("remote reach: a withheld closed state moves no stale-dependency count", async () => {
    const [withheld, absent] = await remotePair();
    expect(withheld).toBe(absent);
    expect(staleNotes(JSON.parse(withheld) as Report)).toEqual([]);
  });

  test("remote reach: a withheld consumer neither counts toward nor hides a readable row", async () => {
    const [withheld, absent] = await remotePair({ cited: true });
    expect(withheld).toBe(absent);
    expect(staleRows(JSON.parse(withheld) as Report)).toHaveLength(1);
    expect(withheld).not.toContain(PRIVATE_PATH.toLowerCase());
  });

  test("remote reach: withheld pages spend no slot of the uncertain cap", async () => {
    const [withheld, absent] = await remotePair({ dropped: true });
    expect(withheld).toBe(absent);
    expect(droppedLineEntries(JSON.parse(withheld) as Report)).toBe(PAGE_COUNT);
    expect(withheld).not.toContain(PRIVATE_PATH);
  });

  test("local control: the operator's own shell counts the withheld items", async () => {
    const a = await doctor(fixture(true), TRANSPORT_REACH.local);
    const b = await doctor(fixture(false), TRANSPORT_REACH.local);
    const local = removedToolWarnings(a);
    expect(local).toHaveLength(PAGE_COUNT);
    expect(local.join("\n")).toContain(PRIVATE_PATH);
    expect(staleNotes(b)).toEqual([]);
    expect(staleNotes(a).join("\n")).toContain("1 state stopped being current");
  });

  test("remote reach: a withheld instruction file raises no ceiling warning", async () => {
    const [withheld, absent] = await remotePair({ instruction: true });
    expect(withheld).toBe(absent);
    expect(withheld).not.toContain(INSTRUCTION_FILE);
  });

  // One fixture and one doctor pass per control, so no test spends more
  // than a fraction of Bun's default 5 s per-test timeout on the Linux job.
  test("local control: the withheld consumer is counted", async () => {
    const cited = await doctorJson(fixture(true, { cited: true }), TRANSPORT_REACH.local);
    expect(cited).toContain(PRIVATE_PATH.toLowerCase());
  });

  test("local control: the withheld dropped lines are counted", async () => {
    const dropped = await doctorJson(fixture(true, { dropped: true }), TRANSPORT_REACH.local);
    expect(dropped).toContain(PRIVATE_PATH);
  });

  test("local control: the withheld instruction file is measured", async () => {
    const instruction = await doctorJson(
      fixture(true, { instruction: true }),
      TRANSPORT_REACH.local,
    );
    expect(instruction).toContain(INSTRUCTION_FILE);
  });
});
