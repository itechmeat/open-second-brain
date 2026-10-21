/**
 * `brain_pledge` reads and writes pledge pages at the caller's reach.
 *
 * Vault A holds a pledge page withheld from a remote caller by
 * visibility, carrying a unique title; vault B never had it. Both share
 * a public pledge with its evidence source page and the log of
 * tests/helpers/reach-log-fixture.ts. A server with no reach minted is a
 * remote caller: `list`, `show`, `fulfill` and `remove` over the two
 * vaults must answer identically once the volatile parts are masked, and
 * the withheld page must stay untouched. Vault A also holds a withheld
 * archived page of the public pledge's slug, which removing the public
 * one must not reveal: below local reach the answer names no archive
 * path at all. The local control proves the withheld page is there to
 * hide.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addPledge, removePledge } from "../../src/core/brain/pledges.ts";
import { BRAIN_PLEDGES_REL } from "../../src/core/brain/path-constants.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import {
  buildReachLogFixture,
  maskVolatile,
  reachServer,
  type ReachLogFixture as Fixture,
} from "../helpers/reach-log-fixture.ts";

const PRIVATE_TITLE = "Zzreservedpromise";
const PRIVATE_SLUG = "zzreservedpromise";
const PUBLIC_TITLE = "Send the weekly report";
const PUBLIC_SLUG = "send-the-weekly-report";
const PUBLIC_DUE = "2026-08-01";
const PRIVATE_DUE = "2026-08-02";
const SOURCE_REL = "Notes/promises-meeting.md";
const SOURCE_TEXT =
  "# Promises meeting\n\nAlice asked me to send the weekly report, and to review the contract draft before the deadline.\n";
const EVIDENCE = ["send the weekly report"];
const RESERVE_LINE = `visibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]`;
const AGENT = "claude";

const bases: string[] = [];
const savedConfig = process.env["OPEN_SECOND_BRAIN_CONFIG"];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfig;
});

interface Vault extends Fixture {
  /** The withheld page's absolute path (vault A only). */
  readonly privatePage: string;
}

function writeSource(vault: string): void {
  mkdirSync(join(vault, "Notes"), { recursive: true });
  writeFileSync(join(vault, SOURCE_REL), SOURCE_TEXT, "utf8");
}

function fixture(withPrivate: boolean): Vault {
  const base = mkdtempSync(join(tmpdir(), "o2b-pledge-reach-"));
  bases.push(base);
  const f = buildReachLogFixture(base, withPrivate);
  writeSource(f.vault);
  if (withPrivate) {
    // An earlier page of the public slug, archived and withheld.
    addPledge(f.vault, {
      title: PUBLIC_TITLE,
      due: PUBLIC_DUE,
      source: SOURCE_REL,
      evidence: EVIDENCE,
      agent: AGENT,
    });
    reserve(removePledge(f.vault, { slug: PUBLIC_SLUG }).archivePath);
  }
  addPledge(f.vault, {
    title: PUBLIC_TITLE,
    due: PUBLIC_DUE,
    source: SOURCE_REL,
    evidence: EVIDENCE,
    agent: AGENT,
  });
  const privatePage = join(f.vault, BRAIN_PLEDGES_REL, `${PRIVATE_SLUG}.md`);
  if (withPrivate) {
    addPledge(f.vault, {
      title: PRIVATE_TITLE,
      due: PRIVATE_DUE,
      source: SOURCE_REL,
      evidence: EVIDENCE,
      agent: AGENT,
    });
    reserve(privatePage);
  }
  return { ...f, privatePage };
}

/** Insert the reserve line before the closing frontmatter fence of `path`. */
function reserve(path: string): void {
  const text = readFileSync(path, "utf8");
  const close = text.indexOf("\n---\n", "---\n".length);
  writeFileSync(path, `${text.slice(0, close)}\n${RESERVE_LINE}${text.slice(close)}`);
}

/** The tool's masked answer, or the masked error message it threw. */
async function pledge(
  f: Fixture,
  args: Record<string, unknown>,
  reach?: TransportReach,
): Promise<string> {
  try {
    const result = await reachServer(f, reach).callTool("brain_pledge", args);
    return maskVolatile(f, result["structuredContent"] ?? result);
  } catch (err) {
    return `error: ${maskVolatile(f, (err as Error).message)}`;
  }
}

describe("brain_pledge answers at the caller's reach", () => {
  test("remote reach: show, fulfill and remove answer as for an absent page", async () => {
    const a = fixture(true);
    const b = fixture(false);
    const before = readFileSync(a.privatePage, "utf8");
    for (const args of [
      { operation: "show", slug: PRIVATE_SLUG },
      { operation: "fulfill", slug: PRIVATE_SLUG },
      { operation: "remove", slug: PRIVATE_SLUG },
    ]) {
      // Sequential on purpose: each server reads the process-wide config
      // variable reachServer sets, so concurrent calls would race on it.
      // oxlint-disable-next-line no-await-in-loop
      const withheld = await pledge(a, args);
      // oxlint-disable-next-line no-await-in-loop
      const absent = await pledge(b, args);
      expect(withheld).toBe(absent);
      expect(withheld).not.toContain(PRIVATE_TITLE);
      if (args["operation"] === "show") {
        // An absent slug is ANSWERED as absent, not refused: the withheld
        // page must answer the same `present:false`, never an error that
        // would hint its state differs from absence.
        expect(withheld).toContain('"present":false');
      } else {
        // fulfill/remove refuse with the named `no pledge` error an absent
        // slug gets, and the error names no archive and no withheld hint.
        expect(withheld.startsWith("error: ")).toBe(true);
        expect(withheld).toContain("no pledge: ");
        expect(withheld).not.toContain("archive");
      }
    }
    expect(readFileSync(a.privatePage, "utf8")).toBe(before);
  });

  test("a raw slug whose pledgeRel folds to a readable page cannot drive fulfill/remove past the gate", async () => {
    const a = fixture(false);
    const b = fixture(false);
    for (const f of [a, b]) {
      addPledge(f.vault, {
        title: "Public",
        due: PUBLIC_DUE,
        source: SOURCE_REL,
        evidence: EVIDENCE,
        agent: AGENT,
      });
    }
    const hidden = addPledge(a.vault, {
      title: "Pledges public",
      due: PRIVATE_DUE,
      source: SOURCE_REL,
      evidence: EVIDENCE,
      agent: AGENT,
    });
    reserve(hidden.path);
    const before = readFileSync(hidden.path, "utf8");
    const slug = "../pledges/public";
    for (const operation of ["fulfill", "remove"]) {
      // oxlint-disable-next-line no-await-in-loop
      const withheld = await pledge(a, { operation, slug });
      // oxlint-disable-next-line no-await-in-loop
      const absent = await pledge(b, { operation, slug });
      expect(withheld).toBe(absent);
      expect(withheld).toContain("no pledge: pledges-public");
      expect(readFileSync(hidden.path, "utf8")).toBe(before);
    }
    expect(existsSync(join(a.vault, BRAIN_PLEDGES_REL, "archive"))).toBe(false);
    expect(await pledge(a, { operation: "show", slug })).toContain(
      '"slug":"../pledges/public","present":false',
    );
  });

  test("remote reach: add citing a private source answers as for an absent source and writes nothing", async () => {
    const a = fixture(false);
    const b = fixture(false);
    writeFileSync(join(a.vault, SOURCE_REL), `---\n${RESERVE_LINE}\n---\n\n${SOURCE_TEXT}`);
    rmSync(join(b.vault, SOURCE_REL));
    const args = {
      operation: "add",
      title: "Private source pledge",
      due: PUBLIC_DUE,
      source: SOURCE_REL,
      evidence: EVIDENCE,
      agent: AGENT,
    };
    const withheld = await pledge(a, args);
    const absent = await pledge(b, args);
    expect(withheld.startsWith("error: ")).toBe(true);
    expect(withheld).toBe(absent);
    for (const f of [a, b]) {
      expect(existsSync(join(f.vault, BRAIN_PLEDGES_REL, "private-source-pledge.md"))).toBe(false);
    }
  });

  test("remote reach: the withheld pledge drops from list", async () => {
    const a = fixture(true);
    const b = fixture(false);
    const withheld = await pledge(a, { operation: "list" });
    const absent = await pledge(b, { operation: "list" });
    expect(withheld).toBe(absent);
    expect(withheld).not.toContain(PRIVATE_TITLE);
    expect(withheld).toContain(PUBLIC_TITLE);
  });

  test("remote reach: removing the public pledge names no archive, so the withheld archived page stays hidden", async () => {
    const a = fixture(true);
    const b = fixture(false);
    // Vault A's archive holds a withheld page of the public slug; the
    // answer must not name where the page went at all.
    const withheld = await pledge(a, { operation: "remove", slug: PUBLIC_SLUG });
    const absent = await pledge(b, { operation: "remove", slug: PUBLIC_SLUG });
    expect(withheld).toBe(absent);
    expect(withheld).not.toContain("archive");
  });

  test("remote reach: a readable pledge is still listed, shown and fulfilled", async () => {
    const a = fixture(true);
    const listed = await pledge(a, { operation: "list" });
    expect(listed).toContain(PUBLIC_TITLE);
    expect(await pledge(a, { operation: "show", slug: PUBLIC_SLUG })).toContain('"present":true');
    expect(await pledge(a, { operation: "fulfill", slug: PUBLIC_SLUG })).toContain(PUBLIC_TITLE);
  });

  test("local control: the operator's own shell lists and shows the withheld page", async () => {
    const a = fixture(true);
    const local = TRANSPORT_REACH.local;
    const listed = JSON.parse(await pledge(a, { operation: "list" }, local)) as {
      pledges: Array<{ slug: string }>;
    };
    expect(listed.pledges.map((p) => p.slug).toSorted()).toEqual(
      [PRIVATE_SLUG, PUBLIC_SLUG].toSorted(),
    );
    expect(await pledge(a, { operation: "show", slug: PRIVATE_SLUG }, local)).toContain(
      PRIVATE_TITLE,
    );
    expect(await pledge(a, { operation: "remove", slug: PUBLIC_SLUG }, local)).toContain(
      "archive_path",
    );
  });
});
