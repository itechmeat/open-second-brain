/**
 * `brain_scaffold_stub` answers at the caller's reach.
 *
 * Vault A holds a note withheld from a remote caller by visibility, which
 * links to a missing page; vault B never had it. Both hold the same public
 * note with its own dangling link. A server with no reach minted is a
 * remote caller: a withheld note named as a stub source is refused exactly
 * as a missing one (nothing written), the dangling list carries neither
 * the withheld note nor the target only it links to, and the refusal for a
 * target that resolves to the withheld note does not name its path. The
 * local control proves the withheld note is there.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../src/core/graph/visibility.ts";
import { resolveSearchConfig } from "../../src/core/search/index.ts";
import type { MCPError } from "../../src/mcp/protocol.ts";
import { indexVault } from "../../src/core/search/indexer.ts";
import {
  buildReachLogFixture,
  maskVolatile,
  reachServer,
  type ReachLogFixture as Fixture,
} from "../helpers/reach-log-fixture.ts";

const TOOL = "brain_scaffold_stub";
const PUBLIC_NOTE = "Notes/public.md";
const PRIVATE_NOTE = "Deep/withheld.md";

const bases: string[] = [];
const savedConfig = process.env["OPEN_SECOND_BRAIN_CONFIG"];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = savedConfig;
});

function write(f: Fixture, rel: string, text: string): void {
  mkdirSync(join(f.vault, rel, ".."), { recursive: true });
  writeFileSync(join(f.vault, rel), text);
}

async function fixture(withPrivate: boolean): Promise<Fixture> {
  const base = mkdtempSync(join(tmpdir(), "o2b-scaffold-reach-"));
  bases.push(base);
  const f = buildReachLogFixture(base, false);
  write(f, PUBLIC_NOTE, "# Public\n\nSee [[Shared Ghost]].\n");
  if (withPrivate) {
    write(
      f,
      PRIVATE_NOTE,
      `---\nvisibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]\n---\n\n# Withheld\n\nSee [[Shared Ghost]] and [[Nightingale Plan]].\n`,
    );
  }
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = f.configPath;
  await indexVault(resolveSearchConfig({ vault: f.vault, configPath: f.configPath }), {
    force: true,
  });
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

/** The Markdown notes outside Brain/: what a stub write would add to. */
function notes(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!child.startsWith("Brain") && !child.startsWith(".")) out.push(...notes(root, child));
    } else if (child.endsWith(".md")) out.push(child);
  }
  return out.toSorted();
}

const SOURCE_WRITES: ReadonlyArray<[string, Record<string, unknown>]> = [
  ["plan", { action: "write", target: "Shared Ghost", sources: [PRIVATE_NOTE] }],
  ["apply", { action: "write", target: "Shared Ghost", sources: [PRIVATE_NOTE], apply: true }],
];

describe("brain_scaffold_stub answers at the caller's reach", () => {
  for (const [name, args] of SOURCE_WRITES) {
    test(`remote reach: a withheld source is refused as a missing one (${name})`, async () => {
      const a = await fixture(true);
      const before = notes(a.vault);
      const withheld = await answer(a, args);
      expect(withheld).toBe(await answer(await fixture(false), args));
      expect(withheld).toContain("is not an existing Markdown note");
      expect(notes(a.vault)).toEqual(before);
    });
  }

  test("remote reach: the dangling list leaves out the withheld note and its own target", async () => {
    const args = { action: "list" };
    const withheld = await answer(await fixture(true), args);
    expect(withheld).toBe(await answer(await fixture(false), args));
    expect(withheld).toContain("Shared Ghost");
    expect(withheld).not.toContain("Nightingale");
  });

  test("remote reach: a target resolving to the withheld note does not name its path", async () => {
    const withheld = await answer(await fixture(true), {
      action: "write",
      target: "Deep/withheld",
    });
    expect(withheld).toContain("already resolves to a note");
    expect(withheld).not.toContain(PRIVATE_NOTE);
  });

  test("remote reach: an ambiguity among withheld notes names no candidate list", async () => {
    const a = await fixture(false);
    const hidden = `---\nvisibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]\n---\n\n# Twin\n`;
    write(a, "Deep/twin.md", hidden);
    write(a, "Other/twin.md", hidden);
    // The title resolver walks the declared note roots only.
    const brainYaml = join(a.vault, "Brain", "_brain.yaml");
    writeFileSync(
      brainYaml,
      `${readFileSync(brainYaml, "utf8")}\nnotes:\n  read_paths:\n    - Deep\n    - Other\n`,
    );
    let refusal: MCPError | null = null;
    try {
      await reachServer(a).callTool(TOOL, { action: "write", target: "twin" });
    } catch (error) {
      refusal = error as MCPError;
    }
    expect(refusal?.message).toContain("already names more than one note");
    expect(refusal?.message.endsWith(": ")).toBe(false);
    expect(refusal?.message).not.toContain("twin.md");
    expect((refusal?.data as Record<string, unknown> | undefined)?.["candidates"]).toBeUndefined();
  });

  test("local control: the operator's own shell cites and lists the withheld note", async () => {
    const a = await fixture(true);
    const local = TRANSPORT_REACH.local;
    expect(await answer(a, { action: "list" }, local)).toContain("Nightingale");
    expect(await answer(a, SOURCE_WRITES[0]![1], local)).toContain('"applied":false');
    expect(await answer(a, { action: "write", target: "Deep/withheld" }, local)).toContain(
      PRIVATE_NOTE,
    );
    expect(readFileSync(join(a.vault, PRIVATE_NOTE), "utf8")).toContain("Nightingale");
  });
});
