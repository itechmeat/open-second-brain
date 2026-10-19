/**
 * The reference report of `brain_note_lifecycle` counts only the pages the
 * caller may read at its reach.
 *
 * A plan names every file that links to the note (`inbound_files`) and
 * counts the files it scanned and rewrote. A page the caller may not read
 * is left out of every one of those lists and counts, so the report is
 * the one a vault without that page gives. The rewrite itself still edits
 * the links inside that page when the plan is applied: leaving them
 * pointing at the old path would break the vault for the readers who can
 * see the page, and nothing about the edit is reported to this caller.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { MCPServer } from "../../src/mcp/server.ts";

const TARGET = "Notes/target.md";
const PRIVATE_PATH = "Notes/secret.md";
const SECRET_BODY = "---\nvisibility: private\n---\n# Secret\nBuilds on [[Notes/target]].\n";

const bases: string[] = [];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

interface Fixture {
  readonly vault: string;
  readonly server: MCPServer;
}

/**
 * A visible note linked from a visible page and, in one of the two vaults,
 * from a private page. With no `reach`, the server mints none: remote.
 * `visibleCarrier`, when given, is an extra VISIBLE page shared by both
 * vaults - the sole carrier of a basename a repair-arm move can contest.
 */
function fixture(
  withSecret: boolean,
  reach?: typeof TRANSPORT_REACH.local,
  visibleCarrier?: string,
): Fixture {
  const base = mkdtempSync(join(tmpdir(), "o2b-lifecycle-refs-reach-"));
  bases.push(base);
  const vault = join(base, "vault");
  mkdirSync(join(vault, "Notes"), { recursive: true });
  const configPath = join(base, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  writeFileSync(join(vault, TARGET), "# Target\n");
  writeFileSync(join(vault, "Notes/open.md"), "# Open\nSee [[Notes/target]].\n");
  if (withSecret) writeFileSync(join(vault, PRIVATE_PATH), SECRET_BODY);
  if (visibleCarrier !== undefined) {
    mkdirSync(dirname(join(vault, visibleCarrier)), { recursive: true });
    writeFileSync(join(vault, visibleCarrier), "# Draft\nA visible note.\n");
  }
  const server = new MCPServer({ vault, configPath }, reach !== undefined ? { reach } : undefined);
  return { vault, server };
}

/** The answer with the per-vault parts (paths, run ids, timestamps) normalised. */
async function answer(f: Fixture, args: Record<string, unknown>): Promise<string> {
  let raw: string;
  try {
    raw = `ok: ${JSON.stringify(await f.server.callTool("brain_note_lifecycle", args))}`;
  } catch (err) {
    const e = err as Error & { code?: unknown; data?: unknown };
    raw = `error: ${e.message} ${JSON.stringify(e.code)} ${JSON.stringify(e.data)}`;
  }
  // The temp folder name carries no separators, so it also matches the
  // JSON-escaped form of a Windows path, where `f.vault` itself does not.
  return raw
    .split(f.vault)
    .join("<vault>")
    .split(basename(dirname(f.vault)))
    .join("<base>")
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "<ts>")
    .replace(/\d{4}-\d{2}-\d{2}-\d{6}/g, "<run>");
}

const CALLS: ReadonlyArray<Record<string, unknown>> = [
  { action: "delete", path: TARGET },
  { action: "delete", path: TARGET, delete_linked: true },
  { action: "move", path: TARGET, to: "Other/target.md" },
  { action: "rename", path: TARGET, to: "Notes/renamed.md" },
  { action: "archive", path: TARGET },
  { action: "move", path: TARGET, to: "Other/target.md", apply: true },
  { action: "delete", path: TARGET, apply: true, confirm: true },
];

describe("a linking page the caller cannot read is left out of the report", () => {
  for (const args of CALLS) {
    test(JSON.stringify(args), async () => {
      const hidden = fixture(true);
      const absent = fixture(false);
      expect(await answer(hidden, args)).toBe(await answer(absent, args));
    });
  }

  test("an applied move still rewrites the link inside it", async () => {
    const hidden = fixture(true);
    await answer(hidden, { action: "move", path: TARGET, to: "Other/target.md", apply: true });
    const secret = readFileSync(join(hidden.vault, PRIVATE_PATH), "utf8");
    // The basename stays unique through the move, so the rewritten link
    // lands at its minimal spelling.
    expect(secret).toContain("[[target]]");
    expect(secret).not.toContain("[[Notes/target]]");
  });
});

describe("at local reach the linking page is reported", () => {
  test("it is an inbound file", async () => {
    const out = await answer(fixture(true, TRANSPORT_REACH.local), {
      action: "delete",
      path: TARGET,
    });
    expect(out).toContain(PRIVATE_PATH);
  });
});

describe("a hidden page at the destination is a known one-bit limitation", () => {
  // Pinned so a later change to it is deliberate: answering as absent
  // would mean moving onto the page or reporting a move that did not
  // happen, so the refusal stays and the page is left untouched.
  const MOVED_ONTO = "Other/secret.md";
  for (const args of [
    { action: "rename", path: TARGET, to: PRIVATE_PATH },
    { action: "move", path: TARGET, to: MOVED_ONTO, apply: true },
  ]) {
    test(JSON.stringify(args), async () => {
      const hidden = fixture(true);
      mkdirSync(join(hidden.vault, "Other"), { recursive: true });
      writeFileSync(join(hidden.vault, MOVED_ONTO), SECRET_BODY);
      const out = await answer(hidden, args);
      expect(out).toContain("destination_occupied");
      expect(out).not.toContain("Builds on");
      expect(readFileSync(join(hidden.vault, String(args.to)), "utf8")).toBe(SECRET_BODY);
      expect(readFileSync(join(hidden.vault, TARGET), "utf8")).toBe("# Target\n");
    });
  }
});

describe("the bare-name repair arm at reach", () => {
  // The repair target spelling is derived from the third-party note that
  // carries the basename the move contests. A carrier the caller may not
  // read must contribute no pair: the remote answer names it no more than
  // a vault without that page would.
  test("a withheld sole carrier of the contested basename is never named", async () => {
    const hidden = fixture(true);
    for (const args of [
      { action: "move", path: TARGET, to: "Other/secret.md" },
      { action: "move", path: TARGET, to: "Other/secret.md", apply: true },
    ]) {
      const out = await answer(hidden, args);
      // The repair's reported `to` is the carrier's suffix-less spelling,
      // so the assertion runs at that precision too.
      expect(out).not.toContain("Notes/secret");
      expect(out).not.toContain(`${PRIVATE_PATH}`);
    }
  });

  test("at local reach the repair names the carrier - the control", async () => {
    const out = await answer(fixture(true, TRANSPORT_REACH.local), {
      action: "move",
      path: TARGET,
      to: "Other/secret.md",
    });
    expect(out).toContain("Notes/secret");
  });

  test("with a visible carrier the answers are byte-identical with and without the withheld page", async () => {
    // A VISIBLE note is the sole carrier of the contested basename, so
    // the repair fires and is reported in both vaults. The unrelated
    // withheld page in one of them must not change a byte of the answer -
    // the same contract the calls above pin, now covering the repair arm.
    const hidden = fixture(true, undefined, "Notes/draft.md");
    const absent = fixture(false, undefined, "Notes/draft.md");
    const args = { action: "move", path: TARGET, to: "Other/draft.md" };
    expect(await answer(hidden, args)).toBe(await answer(absent, args));
  });
});
