/**
 * The session-adapter registry as a REGISTRY (U7 of "nothing runs
 * unwatched").
 *
 * The memory-backend registry already states the property this one has to
 * satisfy: "adding a runtime means adding ONE module that satisfies this
 * interface and registering it - no changes to the import core, CLI, or MCP
 * surfaces" (`src/core/brain/agent-backend/types.ts:9-11`). These tests hold
 * the session adapters to it: an id-keyed lookup that fails loudly on an
 * unknown id, and a seam that takes a caller's own adapter set without the
 * registry file knowing anything about it.
 *
 * They also lock the id vocabulary to the registry's contents, which is what
 * keeps `--format`'s guard honest as adapters are added.
 */

import { describe, expect, test } from "bun:test";

import {
  createSessionAdapterRegistry,
  detectAdapter,
  getAdapter,
  listSessionAdapters,
  SESSION_ADAPTER_REGISTRY,
  sessionAdapterFormatChoices,
} from "../../../../src/core/brain/sessions/registry.ts";
import {
  isSessionAdapterId,
  SESSION_ADAPTER_ID,
  SESSION_ADAPTER_IDS,
  type SessionAdapter,
  type SessionTurn,
} from "../../../../src/core/brain/sessions/types.ts";

/**
 * A whole adapter, defined here and nowhere else - the "one new module" of
 * the protocol. Nothing under `src/` mentions it.
 */
const FIXTURE_MARKER = `"runtime":"fixture-runtime"`;

const fixtureAdapter: SessionAdapter = {
  id: "fixture",
  detect(firstLine: string): boolean {
    return firstLine.includes(FIXTURE_MARKER);
  },
  async *iterate(): AsyncIterable<SessionTurn> {
    yield { turnId: "t1", timestamp: "2026-08-15T00:00:00Z", role: "user", text: "hi" };
  },
};

describe("getAdapter — an unknown id is loud", () => {
  test("names the id that was asked for and the ids that exist", () => {
    let message = "";
    try {
      getAdapter("copilot");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("copilot");
    for (const id of SESSION_ADAPTER_IDS) expect(message).toContain(id);
  });

  test("a registered id still resolves to its adapter", () => {
    for (const id of SESSION_ADAPTER_IDS) expect(getAdapter(id).id).toBe(id);
  });
});

describe("the registry is a seam, not a hardcoded array", () => {
  test("an adapter defined outside src/ resolves through the public seam", () => {
    const registry = createSessionAdapterRegistry([...listSessionAdapters(), fixtureAdapter]);
    expect(getAdapter("fixture", registry)).toBe(fixtureAdapter);
    expect(detectAdapter(`{${FIXTURE_MARKER}}`, registry)?.id).toBe("fixture");
    expect(sessionAdapterFormatChoices(registry)).toContain("fixture");
    // Every built-in still resolves through the extended registry.
    for (const id of SESSION_ADAPTER_IDS) expect(getAdapter(id, registry).id).toBe(id);
  });

  test("extending the registry does not mutate the built-in one", () => {
    createSessionAdapterRegistry([...listSessionAdapters(), fixtureAdapter]);
    expect(() => getAdapter("fixture")).toThrow();
    expect(detectAdapter(`{${FIXTURE_MARKER}}`)).toBeNull();
    expect(SESSION_ADAPTER_REGISTRY.has("fixture")).toBe(false);
  });

  test("a duplicate id is refused rather than silently shadowing", () => {
    const shadow: SessionAdapter = { ...fixtureAdapter, id: SESSION_ADAPTER_ID.claude };
    expect(() => createSessionAdapterRegistry([...listSessionAdapters(), shadow])).toThrow(
      /claude/,
    );
  });
});

describe("the id vocabulary and the registry agree", () => {
  test("the built-in registry's keys are exactly the declared ids", () => {
    expect([...SESSION_ADAPTER_REGISTRY.keys()].toSorted()).toEqual(
      [...SESSION_ADAPTER_IDS].toSorted(),
    );
  });

  test("isSessionAdapterId takes unknown, not string", () => {
    // A `string` parameter forces every caller to narrow first, which is
    // exactly what a guard exists to do. These calls must compile.
    const values: ReadonlyArray<unknown> = [null, undefined, 42, {}, [], "", " ", "Claude"];
    for (const value of values) expect(isSessionAdapterId(value)).toBe(false);
    for (const id of SESSION_ADAPTER_IDS) expect(isSessionAdapterId(id)).toBe(true);
  });
});
