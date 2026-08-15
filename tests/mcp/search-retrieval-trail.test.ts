/**
 * `brain_search` declares the retrieval trail in its own output schema
 * (evidence-at-the-boundary, C2).
 *
 * The declaration is the enforcement: the server validates every response
 * against the tool's `outputSchema` before it leaves, so a degradation code
 * that is not in the vocabulary fails the contract loudly instead of
 * reaching a client that cannot interpret it. That is the same rule
 * `RECALL_GATE_NEGATIVE_STATES` already puts on the negative-recall states.
 */

import { describe, expect, test } from "bun:test";

import { validateOutputContract, type OutputSchema } from "../../src/mcp/output-contract.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";
import {
  RETRIEVAL_DEGRADATION,
  RETRIEVAL_TRAIL_KEY,
} from "../../src/core/search/retrieval-trail.ts";

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
