/**
 * Adapter registry + autodetect — cross-table tests to confirm no
 * adapter mis-recognises a foreign format.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  detectAdapter,
  getAdapter,
  isSessionAdapterId,
  SESSION_ADAPTERS,
  sessionAdapterFormatChoices,
} from "../../src/core/brain/sessions/registry.ts";

const FIXTURES = {
  claude: resolve("tests/fixtures/sessions/claude-minimal.jsonl"),
  codex: resolve("tests/fixtures/sessions/codex-minimal.jsonl"),
  hermes: resolve("tests/fixtures/sessions/hermes-minimal.jsonl"),
  opencode: resolve("tests/fixtures/sessions/opencode-minimal.jsonl"),
  grok: resolve("tests/fixtures/sessions/grok-minimal.jsonl"),
};

function firstLine(path: string): string {
  return readFileSync(path, "utf8").split("\n")[0]!;
}

describe("registry — single source of adapters", () => {
  test("exposes all five adapters", () => {
    const ids = SESSION_ADAPTERS.map((a) => a.id).toSorted();
    expect(ids).toEqual(["claude", "codex", "grok", "hermes", "opencode"]);
  });

  test("owns runtime validation and help choices", () => {
    expect(sessionAdapterFormatChoices()).toBe("auto|claude|codex|hermes|opencode|grok");
    expect(isSessionAdapterId("claude")).toBe(true);
    expect(isSessionAdapterId("codex")).toBe(true);
    expect(isSessionAdapterId("hermes")).toBe(true);
    expect(isSessionAdapterId("opencode")).toBe(true);
    expect(isSessionAdapterId("grok")).toBe(true);
    expect(isSessionAdapterId("copilot")).toBe(false);
  });

  test("exposes the default agent label per adapter", () => {
    const labels = Object.fromEntries(SESSION_ADAPTERS.map((a) => [a.id, a.defaultAgent]));
    expect(labels).toEqual({
      claude: "claude",
      codex: "codex",
      hermes: "hermes",
      opencode: "opencode",
      grok: "grok",
    });
  });

  test("getAdapter returns each by id", () => {
    expect(getAdapter("claude").id).toBe("claude");
    expect(getAdapter("codex").id).toBe("codex");
    expect(getAdapter("hermes").id).toBe("hermes");
    expect(getAdapter("opencode").id).toBe("opencode");
    expect(getAdapter("grok").id).toBe("grok");
  });
});

describe("detectAdapter — autodetect across all three formats", () => {
  test("picks claude on the claude fixture", () => {
    expect(detectAdapter(firstLine(FIXTURES.claude))?.id).toBe("claude");
  });
  test("picks codex on the codex fixture", () => {
    expect(detectAdapter(firstLine(FIXTURES.codex))?.id).toBe("codex");
  });
  test("picks hermes on the hermes fixture", () => {
    expect(detectAdapter(firstLine(FIXTURES.hermes))?.id).toBe("hermes");
  });
  test("picks opencode on the opencode fixture", () => {
    expect(detectAdapter(firstLine(FIXTURES.opencode))?.id).toBe("opencode");
  });
  test("picks grok on the grok fixture", () => {
    expect(detectAdapter(firstLine(FIXTURES.grok))?.id).toBe("grok");
  });

  test("no adapter claims a foreign fixture (full cross-table)", () => {
    for (const [name, path] of Object.entries(FIXTURES)) {
      const detected = detectAdapter(firstLine(path));
      expect(detected?.id).toBe(name as never);
      for (const adapter of SESSION_ADAPTERS) {
        if (adapter.id !== name) {
          expect(adapter.detect(firstLine(path))).toBe(false);
        }
      }
    }
  });

  test("returns null on unknown JSON", () => {
    expect(detectAdapter(`{"foo":"bar"}`)).toBeNull();
  });

  test("returns null on non-JSON garbage", () => {
    expect(detectAdapter("not json at all")).toBeNull();
  });
});
