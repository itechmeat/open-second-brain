/**
 * `brain_tension` answers at the caller's reach.
 *
 * Both vaults carry the log of tests/helpers/reach-log-fixture.ts and a
 * note corpus under `Notes/` with one public pair that contradicts itself
 * (so a remote answer is never empty) and a public note on indentation.
 * Vault A also holds a note withheld from a remote caller by visibility
 * that contradicts the public indentation note; vault B never had it. A
 * server with no reach minted is a remote caller: detect, list, show,
 * verify and the transitions over the two vaults must answer identically
 * once the volatile parts are masked, and a withheld tension page is
 * neither shown nor rewritten. The local control proves the withheld
 * tension is there to find.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import {
  buildReachLogFixture,
  maskVolatile,
  reachServer,
  type ReachLogFixture as Fixture,
} from "../helpers/reach-log-fixture.ts";

const TOOL = "brain_tension";
/** The frontmatter id of the withheld note; a tension names its subjects by id. */
const PRIVATE_ID = "note-zzwithheld";
const RESERVE_LINE = `visibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]`;
/** The line a tension page derived from the withheld note carries. */
const STAMPED_LINE = `visibility: [${JSON.stringify(REMOTE_DENY_VISIBILITY_TOKEN)}]`;
/** The withheld note's own wording, which a tension quotes. */
const PRIVATE_QUOTE = "Always indent source files with tabs";

const bases: string[] = [];
const savedConfig = process.env["OPEN_SECOND_BRAIN_CONFIG"];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfig;
});

function note(vault: string, name: string, id: string, body: string, reserved = false): void {
  const front = [`id: ${id}`, ...(reserved ? [RESERVE_LINE] : [])].join("\n");
  writeFileSync(join(vault, "Notes", name), `---\n${front}\n---\n${body}\n`);
}

function fixture(withPrivate: boolean): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-tension-reach-"));
  bases.push(base);
  const f = buildReachLogFixture(base, withPrivate);
  appendFileSync(join(f.vault, "Brain", "_brain.yaml"), "\nnotes:\n  read_paths:\n    - Notes\n");
  mkdirSync(join(f.vault, "Notes"), { recursive: true });
  note(f.vault, "spaces.md", "note-spaces", "Never indent source files with tabs.");
  note(f.vault, "deploy-yes.md", "note-deploy-yes", "Always deploy the release branch on Fridays.");
  note(f.vault, "deploy-no.md", "note-deploy-no", "Never deploy the release branch on Fridays.");
  if (withPrivate) note(f.vault, "tabs.md", PRIVATE_ID, `${PRIVATE_QUOTE}.`, true);
  return f;
}

async function answer(
  f: Fixture,
  args: Record<string, unknown>,
  reach?: TransportReach,
): Promise<string> {
  try {
    const result = await reachServer(f, reach).callTool(TOOL, args);
    return maskVolatile(f, result["structuredContent"] ?? result);
  } catch (error) {
    // A refusal is part of the answer: it must read alike over both vaults.
    return maskVolatile(f, { error: (error as Error).message });
  }
}

/** Run a local detect, so the tension pages exist on disk. */
async function detectLocally(f: Fixture): Promise<string> {
  return answer(f, { action: "detect" }, TRANSPORT_REACH.local);
}

interface Row {
  readonly slug: string;
  readonly subject_a: string;
  readonly subject_b: string;
}

/** The slug of the tension the withheld note takes part in, from a local answer on vault A. */
function withheldSlug(localDetect: string): string {
  const rows = (JSON.parse(localDetect) as { tensions: ReadonlyArray<Row> }).tensions;
  const row = rows.find((r) => r.subject_a === PRIVATE_ID || r.subject_b === PRIVATE_ID);
  if (row === undefined) throw new Error("the local detect found no withheld tension");
  return row.slug;
}

function tensionPage(f: Fixture, slug: string): string {
  return join(f.vault, "Brain", "tensions", `tension-${slug}.md`);
}

describe("brain_tension answers at the caller's reach", () => {
  test("remote reach: detect neither reads nor persists a withheld note", async () => {
    const withheld = await answer(fixture(true), { action: "detect" });
    const absent = await answer(fixture(false), { action: "detect" });
    expect(withheld).toBe(absent);
    expect(withheld).not.toContain(PRIVATE_ID);
    expect(absent).toContain("note-deploy");
  });

  test("remote reach: list and verify leave out a tension a local detect persisted", async () => {
    const a = fixture(true);
    const b = fixture(false);
    await detectLocally(a);
    await detectLocally(b);
    for (const args of [
      { action: "list" },
      { action: "list", unresolved: true },
      { action: "verify" },
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      const withheld = await answer(a, args);
      // oxlint-disable-next-line no-await-in-loop
      expect(withheld).toBe(await answer(b, args));
      expect(withheld).not.toContain(PRIVATE_ID);
    }
  });

  test("remote reach: show and the transitions answer a withheld tension as an absent one", async () => {
    const a = fixture(true);
    const b = fixture(false);
    const slug = withheldSlug(await detectLocally(a));
    await detectLocally(b);
    const page = readFileSync(tensionPage(a, slug), "utf8");
    for (const action of ["show", "verify", "confirm", "dismiss", "resolve"]) {
      // In turn: a transition the guard let through would change the next answer.
      // oxlint-disable-next-line no-await-in-loop
      const withheld = await answer(a, { action, slug });
      // oxlint-disable-next-line no-await-in-loop
      expect(withheld).toBe(await answer(b, { action, slug }));
      expect(withheld).toContain(`no tension: ${slug}`);
    }
    expect(readFileSync(tensionPage(a, slug), "utf8")).toBe(page);
  });

  test("local control: the operator's own shell sees and quotes the withheld tension", async () => {
    const a = fixture(true);
    const slug = withheldSlug(await detectLocally(a));
    const shown = await answer(a, { action: "show", slug }, TRANSPORT_REACH.local);
    expect(shown).toContain(PRIVATE_QUOTE);
    expect(await answer(a, { action: "list" }, TRANSPORT_REACH.local)).toContain(PRIVATE_ID);
    expect(readFileSync(tensionPage(a, slug), "utf8")).toContain(STAMPED_LINE);
  });

  test("a local re-detect restamps a tension page whose source note became reserved", async () => {
    const a = fixture(false);
    const b = fixture(false);
    // The note starts at default visibility, so the first detect persists
    // a default-visibility tension page that quotes it.
    note(a.vault, "tabs.md", PRIVATE_ID, `${PRIVATE_QUOTE}.`);
    const slug = withheldSlug(await detectLocally(a));
    expect(readFileSync(tensionPage(a, slug), "utf8")).not.toContain(STAMPED_LINE);
    // The operator reserves the note; the next local detect must carry
    // that onto the page that quotes it.
    note(a.vault, "tabs.md", PRIVATE_ID, `${PRIVATE_QUOTE}.`, true);
    await detectLocally(a);
    // Vault B never had the note; two detects keep its counts in step.
    await detectLocally(b);
    await detectLocally(b);
    expect(readFileSync(tensionPage(a, slug), "utf8")).toContain(STAMPED_LINE);
    const withheld = await answer(a, { action: "list" });
    expect(withheld).toBe(await answer(b, { action: "list" }));
    expect(withheld).not.toContain(PRIVATE_ID);
  });
});
