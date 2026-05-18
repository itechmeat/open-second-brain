import { describe, expect, test } from "bun:test";

import {
  detectHookRuntime,
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

  test("artifact + bash that runs the legacy `vault-log` wrapper counts as log", () => {
    const s = summarizeTurn(
      [{ name: "Write" }, { name: "Bash" }],
      ["vault-log 'noted finding'"],
    );
    expect(s).toEqual({ hadArtifact: true, hadLog: true });
  });

  test("the trailing space in the `vault-log ` needle prevents false matches on paths", () => {
    // A path like `/srv/audit/vault-log.json` must NOT be misread as
    // an `o2b vault-log` invocation. The needle's trailing space (the
    // CLI is always followed by an argument) makes the match precise.
    const s = summarizeTurn(
      [{ name: "Write" }, { name: "Bash" }],
      ["cat /srv/audit/vault-log.json"],
    );
    expect(s).toEqual({ hadArtifact: true, hadLog: false });
  });

  test("starting the MCP server (`o2b mcp …`) does NOT count as log", () => {
    // Spawning `o2b mcp` only launches the server subprocess — it
    // does not append anything to the daily log. Regression guard
    // against an earlier, looser needle list that incorrectly
    // treated `o2b mcp` as a log call.
    const s = summarizeTurn(
      [{ name: "Write" }, { name: "Bash" }],
      ["o2b mcp --vault /tmp/vault"],
    );
    expect(s).toEqual({ hadArtifact: true, hadLog: false });
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

describe("detectHookRuntime", () => {
  test("Claude Code transcript path → claudecode", () => {
    expect(
      detectHookRuntime({
        transcript_path:
          "/Users/x/.claude/projects/-srv/projects/foo/abc.jsonl",
      }),
    ).toBe("claudecode");
  });

  test("Codex transcript path → codex", () => {
    expect(
      detectHookRuntime({
        transcript_path: "/root/.codex/sessions/2026-05-18.json",
      }),
    ).toBe("codex");
  });

  test("Claude Code triple without transcript_path → claudecode", () => {
    expect(
      detectHookRuntime({
        session_id: "x",
        cwd: "/srv",
        tool_use_id: "y",
      }),
    ).toBe("claudecode");
  });

  test("Codex apply_patch shape → codex", () => {
    expect(
      detectHookRuntime({
        tool_name: "apply_patch",
        tool_input: {
          input:
            "*** Begin Patch\n*** Update File: /tmp/x\n*** End Patch",
        },
      }),
    ).toBe("codex");
  });

  test("apply_patch without a recognisable body → unknown", () => {
    // The tool name alone is not enough — runtime detection requires
    // the patch body so we never label hand-rolled payloads.
    expect(
      detectHookRuntime({
        tool_name: "apply_patch",
        tool_input: { input: "not a patch" },
      }),
    ).toBe("unknown");
  });

  test("malformed payloads → unknown without throwing", () => {
    expect(detectHookRuntime(null)).toBe("unknown");
    expect(detectHookRuntime(undefined)).toBe("unknown");
    expect(detectHookRuntime("string")).toBe("unknown");
    expect(detectHookRuntime(42)).toBe("unknown");
    expect(detectHookRuntime({})).toBe("unknown");
    expect(detectHookRuntime({ transcript_path: 42 })).toBe("unknown");
  });
});
