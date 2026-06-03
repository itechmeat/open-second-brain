import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { packContext } from "../../../src/core/brain/context-pack.ts";
import { normalizeSessionFocus } from "../../../src/core/search/session-focus.ts";
import { resolveSearchFocusContextPack } from "../../../src/core/config.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-pack-focus-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writePref(slug: string, principle: string, createdAt: string): void {
  writeFileSync(
    join(vault, "Brain", "preferences", `pref-${slug}.md`),
    [
      "---",
      `id: pref-${slug}`,
      `topic: ${slug}`,
      `principle: ${principle}`,
      "tier: core",
      `created_at: ${createdAt}`,
      "---",
      "",
      principle,
      "",
    ].join("\n"),
  );
}

test("an active session focus promotes matching memories within their tier", () => {
  // Without focus the newer pref sorts first; the focus flips the order.
  writePref("unrelated", "Always write tests first", "2026-01-02T00:00:00Z");
  writePref("embeddings", "Prefer local embedding providers for recall", "2026-01-01T00:00:00Z");

  const plain = packContext(vault, { maxTokens: 10_000 });
  expect(plain.items.map((i) => i.id)).toEqual(["pref-unrelated", "pref-embeddings"]);

  const focused = packContext(vault, {
    maxTokens: 10_000,
    // Focus must be unexpired relative to the real clock the pack uses.
    sessionFocus: normalizeSessionFocus({ query: "embedding providers recall" }, Date.now()),
  });
  expect(focused.items.map((i) => i.id)).toEqual(["pref-embeddings", "pref-unrelated"]);
});

test("a null or expired focus leaves the pack byte-identical", () => {
  writePref("a", "Alpha principle", "2026-01-02T00:00:00Z");
  writePref("b", "Beta principle", "2026-01-01T00:00:00Z");
  const plain = packContext(vault, { maxTokens: 10_000 });
  const withNull = packContext(vault, { maxTokens: 10_000, sessionFocus: null });
  expect(withNull.items.map((i) => i.id)).toEqual(plain.items.map((i) => i.id));
});

test("resolveSearchFocusContextPack defaults off and reads the config key", () => {
  const tmp = mkdtempSync(join(tmpdir(), "osb-pack-focus-cfg-"));
  const config = join(tmp, "config.yaml");
  writeFileSync(config, `vault: "${vault}"\n`);
  expect(resolveSearchFocusContextPack(config)).toBe(false);
  writeFileSync(config, `vault: "${vault}"\nsearch_focus_context_pack: "true"\n`);
  expect(resolveSearchFocusContextPack(config)).toBe(true);
  rmSync(tmp, { recursive: true, force: true });
});
