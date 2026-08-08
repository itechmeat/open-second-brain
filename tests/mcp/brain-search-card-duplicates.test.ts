/**
 * `brain_search disclosure:'cards'` reports the merged-away duplicate
 * locations (what-the-index-already-knew, task D follow-up).
 *
 * The layer-1 card is the token-cheap surface an agent reads first, and it
 * named no folded location at all: two byte-identical copies produced one
 * card naming one path, so the caller could not learn that the same bytes
 * live somewhere else without paying for full disclosure. The card carries
 * `path:Lstart-Lend` pointers - the grammar it already speaks - not the
 * full location records.
 *
 * The output schema does not set `additionalProperties: false`, so the new
 * field is declared there deliberately; that declaration is asserted here
 * rather than assumed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SEARCH_TOOLS } from "../../src/mcp/search-tools.ts";
import { indexVault, resolveSearchConfig } from "../../src/core/search/index.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";

/** The passage duplicated verbatim across files below. */
const PASSAGE =
  "# Quantum entanglement\n\n" +
  "Quantum entanglement links two particles so that measuring one fixes " +
  "the other, regardless of the distance separating them. The correlation " +
  "is not a signal and carries no information on its own.\n";

const POINTER_KEY = "duplicate_pointers";

interface CardsOut {
  cards: Array<Record<string, unknown> & { path: string; duplicate_pointers?: string[] }>;
  total: number;
}

let vault: string;
let configHome: string;
let ctx: { vault: string; configPath: string };

const tool = () => SEARCH_TOOLS.find((t) => t.name === "brain_search")!;

function writeNote(rel: string, body: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

async function runCards(query: string): Promise<CardsOut> {
  await indexVault(resolveSearchConfig({ vault, configPath: ctx.configPath }), {});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await tool().handler(ctx as any, { query, disclosure: "cards" })) as CardsOut;
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-card-dup-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-card-dup-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  ctx = { vault, configPath };
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("brain_search card duplicate pointers", () => {
  test("a merged card names the location the passage was folded from", async () => {
    writeNote("physics/entanglement.md", PASSAGE);
    writeNote("archive/entanglement-copy.md", PASSAGE);

    const out = await runCards("quantum entanglement");
    expect(out.cards.length).toBe(1);
    const card = out.cards[0]!;
    expect(card[POINTER_KEY]).toBeDefined();
    const pointers = card.duplicate_pointers!;
    expect(pointers.length).toBe(1);
    const named = [card.path, pointers[0]!.slice(0, pointers[0]!.lastIndexOf(":"))].toSorted();
    expect(named).toEqual(["archive/entanglement-copy.md", "physics/entanglement.md"]);
    expect(pointers[0]).toMatch(/:L\d+(-L\d+)?$/);
  });

  test("no duplicate key at all on a card when nothing was merged", async () => {
    writeNote("one.md", "# Alpha\n\nQuantum alpha notes about the first topic entirely.\n");
    writeNote("two.md", "# Beta\n\nQuantum beta notes about the second topic entirely.\n");

    const out = await runCards("quantum notes");
    expect(out.cards.length).toBe(2);
    for (const card of out.cards) {
      expect(POINTER_KEY in card).toBe(false);
      expect(JSON.stringify(card)).not.toContain("duplicate");
    }
  });

  test("the output schema declares the field on the card shape", () => {
    const schema = tool().outputSchema as {
      properties: {
        cards: { items: { properties: Record<string, { type?: string }> } };
      };
    };
    const declared = schema.properties.cards.items.properties[POINTER_KEY];
    expect(declared).toBeDefined();
    expect(declared!.type).toBe("array");
  });
});
