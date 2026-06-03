import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureSessionLifecycleEvent } from "../../../src/core/brain/session-lifecycle.ts";
import {
  normalizeSessionFocus,
  readSessionFocus,
  writeSessionFocus,
} from "../../../src/core/search/session-focus.ts";
import { resolveSearchConfig } from "../../../src/core/search/index.ts";

const NOW = 1_750_000_000_000;

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-lifecycle-focus-"));
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

test("SessionEnd auto-clears that session's scoped focus only", async () => {
  const cfg = resolveSearchConfig({ vault });
  writeSessionFocus(cfg, normalizeSessionFocus({ query: "mine" }, NOW), "sess-end-1");
  writeSessionFocus(cfg, normalizeSessionFocus({ query: "other" }, NOW), "sess-end-2");
  writeSessionFocus(cfg, normalizeSessionFocus({ query: "global" }, NOW));

  const result = await captureSessionLifecycleEvent(
    vault,
    { hook_event_name: "SessionEnd", session_id: "sess-end-1" },
    { agent: "test-agent" },
  );

  expect(result.focus_cleared).toBe(true);
  expect(readSessionFocus(cfg, NOW, "sess-end-1")).toBeNull();
  expect(readSessionFocus(cfg, NOW, "sess-end-2")?.query).toBe("other");
  expect(readSessionFocus(cfg, NOW)?.query).toBe("global");
});

test("non-SessionEnd events never clear focus", async () => {
  const cfg = resolveSearchConfig({ vault });
  writeSessionFocus(cfg, normalizeSessionFocus({ query: "mine" }, NOW), "sess-live");
  const result = await captureSessionLifecycleEvent(
    vault,
    { hook_event_name: "UserPromptSubmit", session_id: "sess-live", prompt: "hello" },
    { agent: "test-agent" },
  );
  expect(result.focus_cleared).toBeUndefined();
  expect(readSessionFocus(cfg, NOW, "sess-live")?.query).toBe("mine");
});
