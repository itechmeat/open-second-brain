import { describe, expect, test } from "bun:test";

import {
  isArtifactToolName,
  isLogToolName,
  summarizeTurn,
} from "../../hooks/lib/detect.ts";

describe("isArtifactToolName", () => {
  test.each([["Write"], ["Edit"], ["MultiEdit"], ["apply_patch"]])(
    "%s is an artifact",
    (name) => {
      expect(isArtifactToolName(name)).toBe(true);
    },
  );

  test.each([["Bash"], ["Read"], ["Grep"], ["event_log_append"], ["second_brain_status"]])(
    "%s is NOT an artifact",
    (name) => {
      expect(isArtifactToolName(name)).toBe(false);
    },
  );
});

describe("isLogToolName", () => {
  test("recognises the bare name used in Codex transcripts", () => {
    expect(isLogToolName("event_log_append")).toBe(true);
  });

  test("recognises the Claude Code plugin-decorated MCP name", () => {
    // Verified live against /root/.claude/projects/-root/*.jsonl —
    // Claude prefixes plugin-supplied MCP tools with
    // `mcp__plugin_<plugin>_<server>__`.
    expect(
      isLogToolName("mcp__plugin_open-second-brain_open-second-brain__event_log_append"),
    ).toBe(true);
  });

  test("recognises the legacy short MCP name", () => {
    // Older Claude builds (and some forks) used a shorter prefix.
    expect(isLogToolName("mcp__open-second-brain__event_log_append")).toBe(true);
  });

  test("rejects unrelated names", () => {
    expect(isLogToolName("second_brain_capture")).toBe(false);
    expect(isLogToolName("Write")).toBe(false);
    expect(isLogToolName("event_log_append_other")).toBe(false);
    expect(isLogToolName("not_event_log_append")).toBe(false);
  });

  test("rejects names that contain the suffix but not as a `__`-bounded token", () => {
    expect(isLogToolName("xevent_log_append")).toBe(false);
  });
});

describe("summarizeTurn", () => {
  test("artifact without log → hadArtifact && !hadLog", () => {
    const s = summarizeTurn([{ name: "Write" }, { name: "Bash" }]);
    expect(s).toEqual({ hadArtifact: true, hadLog: false });
  });

  test("artifact AND MCP log → hadLog wins", () => {
    const s = summarizeTurn([{ name: "Write" }, { name: "event_log_append" }]);
    expect(s).toEqual({ hadArtifact: true, hadLog: true });
  });

  test("artifact + bash that runs `o2b append-event` counts as log", () => {
    const s = summarizeTurn(
      [{ name: "apply_patch" }, { name: "Bash" }],
      ["o2b append-event 'fixed bug'"],
    );
    expect(s).toEqual({ hadArtifact: true, hadLog: true });
  });

  test("bash without an OSB log command does NOT count as log", () => {
    const s = summarizeTurn([{ name: "Write" }, { name: "Bash" }], ["echo hello"]);
    expect(s).toEqual({ hadArtifact: true, hadLog: false });
  });

  test("read-only tools yield no artifact", () => {
    const s = summarizeTurn([{ name: "Read" }, { name: "Grep" }]);
    expect(s).toEqual({ hadArtifact: false, hadLog: false });
  });
});
