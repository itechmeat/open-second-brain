/**
 * `brain_search` declares the retrieval trail in its own output schema
 * (evidence-at-the-boundary, C2), and adds it to the response without
 * disturbing a single other byte.
 *
 * The declaration is the enforcement: the server validates every response
 * against the tool's `outputSchema` before it leaves, so a degradation code
 * that is not in the vocabulary fails the contract loudly instead of
 * reaching a client that cannot interpret it. That is the same rule
 * `RECALL_GATE_NEGATIVE_STATES` already puts on the negative-recall states.
 *
 * The second half of the unit answers the question the schema cannot: what
 * a REAL response carries. A healthy non-empty answer must name the key
 * nowhere at all - that absence is the whole compatibility claim - and it
 * is asserted over a vault holding more documents than the caller asked
 * for, because the small fixtures the rest of the suite uses cannot reach
 * the pool cap where the claim actually breaks.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { indexVault, resolveSearchConfig } from "../../src/core/search/index.ts";
import { validateOutputContract, type OutputSchema } from "../../src/mcp/output-contract.ts";
import { SEARCH_TOOLS } from "../../src/mcp/search-tools.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";
import {
  RETRIEVAL_DEGRADATION,
  RETRIEVAL_TRAIL_KEY,
} from "../../src/core/search/retrieval-trail.ts";
import { writeMd } from "../helpers/search-fixtures.ts";

function searchOutputSchema(): OutputSchema {
  const tool = buildToolTable().find((t) => t.name === "brain_search");
  expect(tool).toBeDefined();
  expect(tool!.outputSchema).toBeDefined();
  return tool!.outputSchema!;
}

/** The minimum a `brain_search` response must carry, plus one trail. */
function payloadWithCodes(codes: ReadonlyArray<string>): Record<string, unknown> {
  return {
    results: [],
    warnings: [],
    total: 0,
    [RETRIEVAL_TRAIL_KEY]: {
      retrieved: 0,
      pool: 0,
      degraded: codes.map((code) => ({ code })),
    },
  };
}

describe("brain_search declares the retrieval trail", () => {
  test("a declared code passes the contract", () => {
    expect(
      validateOutputContract(
        searchOutputSchema(),
        payloadWithCodes([RETRIEVAL_DEGRADATION.hybridDegraded]),
      ),
    ).toEqual([]);
  });

  test("an undeclared code fails the contract", () => {
    const errors = validateOutputContract(
      searchOutputSchema(),
      payloadWithCodes(["hybrid_degraded"]),
    );
    expect(errors.length).toBeGreaterThan(0);
    // The violation points at the code that is not in the vocabulary and
    // spells the vocabulary out, so the fix is the message.
    const reported = errors.join("; ");
    expect(reported).toContain(`$.${RETRIEVAL_TRAIL_KEY}.degraded[0].code`);
    expect(reported).toContain(RETRIEVAL_DEGRADATION.hybridDegraded);
  });

  test("the corpus statement's state is closed too", () => {
    const payload = payloadWithCodes([]);
    (payload[RETRIEVAL_TRAIL_KEY] as Record<string, unknown>)["empty"] = {
      state: "definitely-not-a-state",
      reason: "invented",
    };
    expect(validateOutputContract(searchOutputSchema(), payload).length).toBeGreaterThan(0);
  });
});

// ─── what a real response carries ────────────────────────────────────────────

/** The rank cap for a small `limit` - the assembler's pool floor. */
const RANK_CAP_FLOOR = 30;
const WINDOW = 10;

let tmp: string;
let vault: string;
/** Config resolving the default lane pool: the ranker sees exactly the cap. */
let narrowConfigPath: string;
/** Config whose wider lane pool hands the ranker more than the cap admits. */
let wideConfigPath: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-mcp-trail-"));
  vault = join(tmp, "vault");
  for (let i = 0; i < RANK_CAP_FLOOR + WINDOW; i++) {
    writeMd(vault, `notes/doc-${i}.md`, `# Doc ${i}\n\nReindexing the vault is discussed here.`);
  }
  narrowConfigPath = join(tmp, "narrow.yaml");
  wideConfigPath = join(tmp, "wide.yaml");
  atomicWriteFileSync(narrowConfigPath, `vault: "${vault}"\n`);
  atomicWriteFileSync(wideConfigPath, `vault: "${vault}"\nsearch_pool_multiplier: 10\n`);
  await indexVault(resolveSearchConfig({ vault, configPath: narrowConfigPath }));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function brainSearch(configPath: string, query: string): Promise<Record<string, unknown>> {
  const tool = SEARCH_TOOLS.find((t) => t.name === "brain_search");
  expect(tool).toBeDefined();
  return (await tool!.handler(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the server context, narrowed to what a search reads
    { vault, configPath } as any,
    { query, limit: WINDOW },
  )) as Record<string, unknown>;
}

describe("the trail adds a key to brain_search and disturbs nothing else", () => {
  test("a healthy answer over a vault larger than the window names the key nowhere", async () => {
    // The default lane pool ends exactly on the cap here, which is the one
    // arrangement where "the pool ran out" and "the cap cut it" look alike
    // from the inside - and the only one a two-document fixture can never
    // produce. Nothing was discarded, so this response owes no trail.
    const payload = await brainSearch(narrowConfigPath, "reindexing");

    expect((payload["results"] as unknown[]).length).toBe(WINDOW);
    expect(RETRIEVAL_TRAIL_KEY in payload).toBe(false);
    // Byte-level, not key-level: the trail can only reach a client under
    // this key, so its absence from the serialized response is the whole
    // compatibility claim.
    expect(JSON.stringify(payload)).not.toContain(RETRIEVAL_TRAIL_KEY);
  });

  test("a truncated pool adds the trail and no other key", async () => {
    const healthy = await brainSearch(narrowConfigPath, "reindexing");
    const truncated = await brainSearch(wideConfigPath, "reindexing");

    expect(truncated[RETRIEVAL_TRAIL_KEY]).toEqual({
      retrieved: WINDOW,
      pool: RANK_CAP_FLOOR,
      degraded: [
        { code: RETRIEVAL_DEGRADATION.rankCapTruncatedPool, detail: { cap: RANK_CAP_FLOOR } },
      ],
    });
    // The remainder is the healthy response's own shape: one added key,
    // nothing renamed, nothing dropped. The two runs rank different
    // candidate pools by construction - that difference is what makes one
    // of them truncated - so the comparison is the key list, and the
    // per-value byte claim is the assertion above.
    delete truncated[RETRIEVAL_TRAIL_KEY];
    expect(Object.keys(truncated)).toEqual(Object.keys(healthy));
  });
});
