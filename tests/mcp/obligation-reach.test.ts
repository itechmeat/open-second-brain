/**
 * `brain_obligation` reads and writes obligation pages at the caller's
 * reach.
 *
 * Vault A holds an obligation page withheld from a remote caller by
 * visibility, carrying a unique title; vault B never had it. Both share
 * a public obligation and the log of tests/helpers/reach-log-fixture.ts.
 * A server with no reach minted is a remote caller: `list`, `show`,
 * `done` and `remove` over the two vaults must answer identically once
 * the volatile parts are masked, and the withheld page must stay
 * untouched. Vault A also holds a withheld archived page of the public
 * obligation's slug, which removing the public one must not reveal. The
 * local control proves the withheld page is there to hide.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addObligation, removeObligation } from "../../src/core/brain/obligations.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import {
  buildReachLogFixture,
  maskVolatile,
  reachServer,
  type ReachLogFixture as Fixture,
} from "../helpers/reach-log-fixture.ts";

const PRIVATE_TITLE = "Zzreservedduty";
const PRIVATE_SLUG = "zzreservedduty";
const PUBLIC_TITLE = "Water the plants";
const PUBLIC_SLUG = "water-the-plants";
const UNSLUGGED_STEM = "Feed_The_Cat";
const UNSLUGGED_TITLE = "Feed the cat";
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

function fixture(withPrivate: boolean): Vault {
  const base = mkdtempSync(join(tmpdir(), "o2b-obligation-reach-"));
  bases.push(base);
  const f = buildReachLogFixture(base, withPrivate);
  if (withPrivate) {
    // An earlier page of the public slug, archived and withheld.
    addObligation(f.vault, { title: PUBLIC_TITLE, cadence: "daily", agent: AGENT });
    reserve(removeObligation(f.vault, PUBLIC_SLUG).archivePath);
  }
  addObligation(f.vault, { title: PUBLIC_TITLE, cadence: "weekly", agent: AGENT });
  const privatePage = join(f.vault, "Brain", "obligations", `${PRIVATE_SLUG}.md`);
  if (withPrivate) {
    addObligation(f.vault, { title: PRIVATE_TITLE, cadence: "weekly", agent: AGENT });
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
async function obligation(
  f: Fixture,
  args: Record<string, unknown>,
  reach?: TransportReach,
): Promise<string> {
  try {
    const result = await reachServer(f, reach).callTool("brain_obligation", args);
    return maskVolatile(f, result["structuredContent"] ?? result);
  } catch (err) {
    return `error: ${maskVolatile(f, (err as Error).message)}`;
  }
}

describe("brain_obligation answers at the caller's reach", () => {
  test("remote reach: list, show, done and remove answer as for an absent page", async () => {
    const a = fixture(true);
    const b = fixture(false);
    const before = readFileSync(a.privatePage, "utf8");
    for (const args of [
      { operation: "list" },
      { operation: "list", overdue: true },
      { operation: "show", slug: PRIVATE_SLUG },
      { operation: "done", slug: PRIVATE_SLUG },
      { operation: "remove", slug: PRIVATE_SLUG },
      { operation: "remove", slug: PUBLIC_SLUG },
    ]) {
      // Sequential on purpose: each server reads the process-wide config
      // variable reachServer sets, so concurrent calls would race on it.
      // oxlint-disable-next-line no-await-in-loop
      const withheld = await obligation(a, args);
      // oxlint-disable-next-line no-await-in-loop
      const absent = await obligation(b, args);
      expect(withheld).toBe(absent);
      expect(withheld).not.toContain(PRIVATE_TITLE);
    }
    expect(readFileSync(a.privatePage, "utf8")).toBe(before);
  });

  test("remote reach: add over a withheld page refuses and leaves it as it was", async () => {
    const a = fixture(true);
    const before = readFileSync(a.privatePage, "utf8");
    const answer = await obligation(a, {
      operation: "add",
      title: PRIVATE_TITLE,
      cadence: "daily",
    });
    expect(answer.startsWith("error: ")).toBe(true);
    expect(readFileSync(a.privatePage, "utf8")).toBe(before);
  });

  test("remote reach: a readable obligation is still listed, shown and completed", async () => {
    const a = fixture(true);
    const listed = await obligation(a, { operation: "list" });
    expect(listed).toContain(PUBLIC_TITLE);
    expect(await obligation(a, { operation: "show", slug: PUBLIC_SLUG })).toContain(
      '"present":true',
    );
    expect(await obligation(a, { operation: "done", slug: PUBLIC_SLUG })).toContain(PUBLIC_TITLE);
  });

  test("remote reach: a readable page whose file name is not slug-shaped is still listed", async () => {
    const a = fixture(true);
    const dir = join(a.vault, "Brain", "obligations");
    const page = readFileSync(join(dir, `${PUBLIC_SLUG}.md`), "utf8");
    writeFileSync(join(dir, `${UNSLUGGED_STEM}.md`), page.replace(PUBLIC_TITLE, UNSLUGGED_TITLE));
    expect(await obligation(a, { operation: "list" })).toContain(UNSLUGGED_TITLE);
  });

  test("local control: the operator's own shell lists and shows the withheld page", async () => {
    const a = fixture(true);
    const local = TRANSPORT_REACH.local;
    expect(await obligation(a, { operation: "list" }, local)).toContain(PRIVATE_TITLE);
    expect(await obligation(a, { operation: "show", slug: PRIVATE_SLUG }, local)).toContain(
      PRIVATE_TITLE,
    );
    expect(await obligation(a, { operation: "remove", slug: PUBLIC_SLUG }, local)).toContain(
      "archive_path",
    );
  });
});
