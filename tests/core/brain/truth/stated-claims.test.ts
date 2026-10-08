/**
 * Grounded agent-stated claim core (truth-correctable-time-aware,
 * task 4): a stated claim { subject, relation, object } asserted with
 * its assertion `text` commits as one ledger event with the
 * `agent_stated` extractor tag - entity is the normalized subject,
 * aspect the relation token (validated against the single relation
 * vocabulary), value the object display form. The payload boundary
 * refuses whole calls (unknown relation, missing text, missing source,
 * empty agent, malformed ts) with nothing written; the anchoring verdict
 * is per claim, so
 * grounded claims commit while ungrounded claims are reported back
 * with machine reason codes. Anchoring uses the one occurrence kernel
 * (`anchorEntityForms`, quality-gated normalized match forms,
 * minimum length 3).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  anchorEntityForms,
  type AtomicEntityLike,
} from "../../../../src/core/brain/atomic-facts.ts";
import {
  appendStatedClaims,
  StatedClaimsRefusal,
  type StatedClaim,
} from "../../../../src/core/brain/truth/stated-claims.ts";
import { readClaimEvents } from "../../../../src/core/brain/truth/store.ts";
import { withDeviceId } from "../../../helpers/device-id.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-truth-stated-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

const PAYLOAD = {
  ts: "2026-06-01T10:00:00Z",
  agent: "claude-dev-agent",
  source: "[[Brain/notes/standup.md]]",
  text: "Alice Mason joined Google in June after leaving Meta.",
} as const;

function claim(over: Partial<StatedClaim> = {}): StatedClaim {
  return { subject: "Alice Mason", relation: "extends", object: "Google", ...over };
}

const ALICE: AtomicEntityLike = {
  id: "ent-alice",
  name: "Alice Mason",
  aliases: ["AM", "Alice"],
  status: "active",
};

describe("anchorEntityForms", () => {
  test("returns the quality-gated normalized forms that occur in the text", () => {
    expect(anchorEntityForms("Alice Mason joined Google.", ["Alice Mason", "Google"])).toEqual([
      "alice mason",
      "google",
    ]);
  });

  test("drops forms shorter than three characters before matching", () => {
    // "al" would substring-match "Alice", but the quality gate excludes it.
    expect(anchorEntityForms("Alice walked.", ["al"])).toEqual([]);
  });

  test("drops structurally invalid forms", () => {
    expect(anchorEntityForms("nothing anchors here", ["!!!"])).toEqual([]);
  });
});

describe("appendStatedClaims", () => {
  test("commits a grounded claim as a ledger event with the agent_stated tag", () => {
    const outcome = withDeviceId("", () =>
      appendStatedClaims(vault, { ...PAYLOAD, claims: [claim()] }),
    );
    expect(outcome.ungrounded).toEqual([]);
    expect(outcome.committed).toHaveLength(1);
    const event = outcome.committed[0]!.event;
    expect(event.entity).toBe("alice mason");
    expect(event.aspect).toBe("extends");
    expect(event.value).toBe("Google");
    expect(event.extractor).toBe("agent_stated");
    expect(event.source).toBe(PAYLOAD.source);
    expect(event.agent).toBe(PAYLOAD.agent);
    // The event is in the ledger.
    const events = readClaimEvents(vault).events;
    expect(events).toHaveLength(1);
    expect(events[0]!.extractor).toBe("agent_stated");
  });

  test("refuses an unknown relation before any write", () => {
    expect(() =>
      withDeviceId("", () =>
        appendStatedClaims(vault, { ...PAYLOAD, claims: [claim({ relation: "joined" })] }),
      ),
    ).toThrow(StatedClaimsRefusal);
    expect(readClaimEvents(vault).events).toHaveLength(0);
  });

  test("one unknown relation refuses the whole payload, valid claims included", () => {
    expect(() =>
      withDeviceId("", () =>
        appendStatedClaims(vault, {
          ...PAYLOAD,
          claims: [claim(), claim({ subject: "Alice Mason", relation: "hates" })],
        }),
      ),
    ).toThrow(/unknown relation/);
    expect(readClaimEvents(vault).events).toHaveLength(0);
  });

  test("missing text refuses the whole payload", () => {
    expect(() =>
      withDeviceId("", () =>
        appendStatedClaims(vault, { ...PAYLOAD, text: "   ", claims: [claim()] }),
      ),
    ).toThrow(/text/);
    expect(readClaimEvents(vault).events).toHaveLength(0);
  });

  test("missing source refuses the whole payload", () => {
    expect(() =>
      withDeviceId("", () =>
        appendStatedClaims(vault, { ...PAYLOAD, source: "", claims: [claim()] }),
      ),
    ).toThrow(/source/);
    expect(readClaimEvents(vault).events).toHaveLength(0);
  });

  test("a malformed ts refuses the whole payload through the refusal channel, before any write", () => {
    // Two grounded claims: a boundary that validated ts only inside the
    // append loop would leave the payload's refusal to the store's plain
    // Error - outside the documented refusal channel - instead of this
    // whole-call refusal with nothing written.
    expect(() =>
      withDeviceId("", () =>
        appendStatedClaims(vault, {
          ...PAYLOAD,
          ts: "2026-06-01 10:00:00",
          claims: [claim(), claim({ object: "Meta" })],
        }),
      ),
    ).toThrow(StatedClaimsRefusal);
    expect(readClaimEvents(vault).events).toHaveLength(0);
  });

  test("an empty agent refuses the whole payload through the refusal channel, before any write", () => {
    expect(() =>
      withDeviceId("", () =>
        appendStatedClaims(vault, {
          ...PAYLOAD,
          agent: "   ",
          claims: [claim(), claim({ object: "Meta" })],
        }),
      ),
    ).toThrow(StatedClaimsRefusal);
    expect(readClaimEvents(vault).events).toHaveLength(0);
  });

  test("an unanchored subject is reported back and never written", () => {
    const outcome = withDeviceId("", () =>
      appendStatedClaims(vault, {
        ...PAYLOAD,
        claims: [claim({ subject: "Bob Stone" })],
      }),
    );
    expect(outcome.committed).toEqual([]);
    expect(outcome.ungrounded).toHaveLength(1);
    expect(outcome.ungrounded[0]!.reasons).toEqual(["subject_unanchored"]);
    expect(readClaimEvents(vault).events).toHaveLength(0);
  });

  test("an unanchored object is reported back with its own reason", () => {
    const outcome = withDeviceId("", () =>
      appendStatedClaims(vault, {
        ...PAYLOAD,
        claims: [claim({ object: "Apple" })],
      }),
    );
    expect(outcome.committed).toEqual([]);
    expect(outcome.ungrounded[0]!.reasons).toEqual(["object_unanchored"]);
  });

  test("verdicts are per claim: a grounded claim commits beside reported-back ones", () => {
    const outcome = withDeviceId("", () =>
      appendStatedClaims(vault, {
        ...PAYLOAD,
        claims: [claim(), claim({ subject: "Bob Stone" }), claim({ object: "Apple" })],
      }),
    );
    expect(outcome.committed).toHaveLength(1);
    expect(outcome.committed[0]!.event.value).toBe("Google");
    expect(outcome.ungrounded).toHaveLength(2);
    expect(outcome.ungrounded.map((u) => u.reasons).toSorted()).toEqual([
      ["object_unanchored"],
      ["subject_unanchored"],
    ]);
    expect(readClaimEvents(vault).events).toHaveLength(1);
  });

  test("both anchors missing report both reasons", () => {
    const outcome = withDeviceId("", () =>
      appendStatedClaims(vault, {
        ...PAYLOAD,
        claims: [claim({ subject: "Bob Stone", object: "Apple" })],
      }),
    );
    expect(outcome.ungrounded[0]!.reasons).toEqual(["subject_unanchored", "object_unanchored"]);
  });

  test("a form shorter than the quality gate never anchors a subject", () => {
    const outcome = withDeviceId("", () =>
      appendStatedClaims(vault, {
        ...PAYLOAD,
        claims: [claim({ subject: "Al" })],
      }),
    );
    // "Al" occurs inside "Alice" but the minimum-length gate excludes it.
    expect(outcome.committed).toEqual([]);
    expect(outcome.ungrounded[0]!.reasons).toEqual(["subject_unanchored"]);
  });

  test("registry aliases extend the anchoring forms of a named entity", () => {
    const outcome = withDeviceId("", () =>
      appendStatedClaims(
        vault,
        {
          ...PAYLOAD,
          text: "Alice joined Google in June after leaving Meta.",
          claims: [claim()],
        },
        { entities: [ALICE] },
      ),
    );
    // The text says "Alice", not "Alice Mason": the alias anchors.
    expect(outcome.ungrounded).toEqual([]);
    expect(outcome.committed).toHaveLength(1);
    expect(outcome.committed[0]!.event.entity).toBe("alice mason");
  });

  test("a claim with an empty subject reports missing_subject", () => {
    const outcome = withDeviceId("", () =>
      appendStatedClaims(vault, { ...PAYLOAD, claims: [claim({ subject: "  " })] }),
    );
    expect(outcome.committed).toEqual([]);
    expect(outcome.ungrounded[0]!.reasons).toEqual(["missing_subject"]);
  });

  test("a claim with an empty object reports missing_object", () => {
    const outcome = withDeviceId("", () =>
      appendStatedClaims(vault, { ...PAYLOAD, claims: [claim({ object: "" })] }),
    );
    expect(outcome.committed).toEqual([]);
    expect(outcome.ungrounded[0]!.reasons).toEqual(["missing_object"]);
  });

  test("an empty claims payload writes nothing and reports nothing", () => {
    const outcome = withDeviceId("", () => appendStatedClaims(vault, { ...PAYLOAD, claims: [] }));
    expect(outcome.committed).toEqual([]);
    expect(outcome.ungrounded).toEqual([]);
    expect(readClaimEvents(vault).events).toHaveLength(0);
  });
});
