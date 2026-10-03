/**
 * `brain_intention` reads and writes intention chains at the caller's
 * reach.
 *
 * Vault A holds an intention chain withheld from a remote caller by
 * visibility, carrying a unique text, and a withheld archived chain of
 * the public scope from today; vault B never had either. Both share a
 * public chain and the log of tests/helpers/reach-log-fixture.ts. A
 * server with no reach minted is a remote caller: `list`, `show` and
 * `move` over the two vaults must answer identically once the volatile
 * parts are masked, and the withheld chain must stay untouched. The local
 * control proves the withheld chain is there to hide.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { moveIntentionToHistory, setIntention } from "../../src/core/brain/intentions.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import {
  buildReachLogFixture,
  maskVolatile,
  reachServer,
  type ReachLogFixture as Fixture,
} from "../helpers/reach-log-fixture.ts";

const PRIVATE_SCOPE = "zzreservedscope";
const PRIVATE_TEXT = "Zzreservedplan for the quarter";
const PUBLIC_SCOPE = "public-scope";
const PUBLIC_TEXT = "Ship the public release";
const RESERVE_LINE = `visibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]`;
const AGENT = "claude";

const bases: string[] = [];
const savedConfig = process.env["OPEN_SECOND_BRAIN_CONFIG"];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfig;
});

/** Insert the reserve line before the closing frontmatter fence of `path`. */
function reserve(path: string): void {
  const text = readFileSync(path, "utf8");
  const close = text.indexOf("\n---\n", "---\n".length);
  writeFileSync(path, `${text.slice(0, close)}\n${RESERVE_LINE}${text.slice(close)}`);
}

interface Vault extends Fixture {
  /** The withheld chain's absolute path (vault A only). */
  readonly privateChain: string;
}

function fixture(withPrivate: boolean): Vault {
  const base = mkdtempSync(join(tmpdir(), "o2b-intention-reach-"));
  bases.push(base);
  const f = buildReachLogFixture(base, withPrivate);
  if (withPrivate) {
    // An earlier public-scope chain retired today and withheld: the move
    // below must not choose its archive name around it in sight of a
    // remote caller.
    setIntention(f.vault, { scope: PUBLIC_SCOPE, text: PRIVATE_TEXT, agent: AGENT });
    reserve(moveIntentionToHistory(f.vault, { scope: PUBLIC_SCOPE }).archivePath);
  }
  setIntention(f.vault, { scope: PUBLIC_SCOPE, text: PUBLIC_TEXT, agent: AGENT });
  const privateChain = join(f.vault, "Brain", "intentions", `${PRIVATE_SCOPE}.md`);
  if (withPrivate) {
    setIntention(f.vault, { scope: PRIVATE_SCOPE, text: PRIVATE_TEXT, agent: AGENT });
    reserve(privateChain);
  }
  return { ...f, privateChain };
}

/** The tool's masked answer, or the masked error message it threw. */
async function intention(
  f: Fixture,
  args: Record<string, unknown>,
  reach?: TransportReach,
): Promise<string> {
  try {
    const result = await reachServer(f, reach).callTool("brain_intention", args);
    return maskVolatile(f, result["structuredContent"] ?? result);
  } catch (err) {
    return `error: ${maskVolatile(f, (err as Error).message)}`;
  }
}

describe("brain_intention answers at the caller's reach", () => {
  test("remote reach: list, show and move answer as for an absent chain", async () => {
    const a = fixture(true);
    const b = fixture(false);
    const before = readFileSync(a.privateChain, "utf8");
    for (const args of [
      { operation: "list" },
      { operation: "show", scope: PRIVATE_SCOPE },
      { operation: "move", scope: PRIVATE_SCOPE },
      { operation: "move", scope: PUBLIC_SCOPE },
    ]) {
      // Sequential on purpose: each server reads the process-wide config
      // variable reachServer sets, so concurrent calls would race on it.
      // oxlint-disable-next-line no-await-in-loop
      const withheld = await intention(a, args);
      // oxlint-disable-next-line no-await-in-loop
      const absent = await intention(b, args);
      expect(withheld).toBe(absent);
      expect(withheld).not.toContain("Zzreserved");
    }
    expect(readFileSync(a.privateChain, "utf8")).toBe(before);
  });

  test("remote reach: set over a withheld chain refuses and leaves it as it was", async () => {
    const a = fixture(true);
    const before = readFileSync(a.privateChain, "utf8");
    const answer = await intention(a, { operation: "set", scope: PRIVATE_SCOPE, text: "x" });
    expect(answer.startsWith("error: ")).toBe(true);
    expect(answer).not.toContain("Zzreserved");
    expect(readFileSync(a.privateChain, "utf8")).toBe(before);
  });

  test("remote reach: a readable chain is still listed, shown and updated", async () => {
    const a = fixture(true);
    expect(await intention(a, { operation: "list" })).toContain(PUBLIC_TEXT);
    expect(await intention(a, { operation: "show", scope: PUBLIC_SCOPE })).toContain(PUBLIC_TEXT);
    expect(
      await intention(a, { operation: "set", scope: PUBLIC_SCOPE, text: "Next step" }),
    ).toContain('"version":2');
  });

  test("local control: the operator's own shell lists, shows and archives by name", async () => {
    const a = fixture(true);
    const local = TRANSPORT_REACH.local;
    expect(await intention(a, { operation: "list" }, local)).toContain(PRIVATE_TEXT);
    expect(await intention(a, { operation: "show", scope: PRIVATE_SCOPE }, local)).toContain(
      PRIVATE_TEXT,
    );
    expect(await intention(a, { operation: "move", scope: PUBLIC_SCOPE }, local)).toContain(
      "archive_path",
    );
  });

  test("remote reach: a list judges each chain by its own file name", async () => {
    // Hand-written chains whose file names are not scope-shaped: the
    // readable one stays listed, the withheld one is dropped, and a name
    // with no letters or digits does not fail the call.
    const handWritten = (f: Fixture, from: string, to: string, text: string): string => {
      setIntention(f.vault, { scope: from, text, agent: AGENT });
      const dir = join(f.vault, "Brain", "intentions");
      const target = join(dir, `${to}.md`);
      renameSync(join(dir, `${from}.md`), target);
      return target;
    };
    const build = (withPrivate: boolean): Fixture => {
      const f = fixture(withPrivate);
      handWritten(f, "open-plan", "Open_Plan", "Draft the open plan");
      handWritten(f, "symbols-only", "___", "A chain named by symbols");
      if (withPrivate) reserve(handWritten(f, "hidden-plan", "Zzreserved_Plan", PRIVATE_TEXT));
      return f;
    };
    const withheld = await intention(build(true), { operation: "list" });
    const absent = await intention(build(false), { operation: "list" });
    expect(withheld).toBe(absent);
    expect(withheld.startsWith("error: ")).toBe(false);
    expect(withheld).toContain("Open_Plan");
    expect(withheld).toContain("Draft the open plan");
    expect(withheld).not.toContain("Zzreserved");
  });
});
