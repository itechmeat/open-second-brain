/**
 * A5 (t_66c12a67): fact signal retire lifecycle.
 *
 * `retireSignal` moves a `Brain/inbox/sig-*.md` file into `Brain/retired/`,
 * rewrites its frontmatter with the retire metadata (mirroring the
 * preference retire conventions and A3's rejectPending), appends an audit
 * log event, and refuses source ids outside the inbox. Because the dream
 * pass consumes `Brain/inbox/` only, the directory move IS the exclusion
 * mechanism; the retired signal stays readable in `Brain/retired/`.
 * Retiring a missing / already-retired / non-signal id is a typed error.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";
import { parseFrontmatter } from "../../../src/core/vault.ts";
import { parseSignal, writeSignal } from "../../../src/core/brain/signal.ts";
import { queryByTopic, readAllLogEntries } from "../../../src/core/brain/query.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../../src/core/brain/types.ts";
import {
  InvalidSignalIdError,
  retireSignal,
  SignalAlreadyRetiredError,
  SignalNotFoundError,
} from "../../../src/core/brain/signal-retire.ts";

let tmp: string;
let vault: string;

const NOW = new Date("2026-07-18T12:00:00Z");

function seedSignal(slug: string, topic = slug): string {
  const res = writeSignal(vault, {
    topic,
    signal: "positive",
    agent: "claude-dev-agent",
    principle: `https://${slug}.dev`,
    created_at: NOW.toISOString(),
    date: "2026-07-18",
    slug,
    source_type: "extracted",
    dedup_hash: `hash-${slug}`,
  });
  return res.id;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-signal-retire-"));
  vault = join(tmp, "vault");
  const configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("retireSignal", () => {
  test("moves the signal to retired/ and rewrites the frontmatter", () => {
    const id = seedSignal("fact-url");
    const res = retireSignal(vault, id, {
      reason: "superseded by a fresher capture",
      superseded_by: "sig-2026-07-19-fact-url",
      agent: "claude-dev-agent",
      now: NOW,
    });

    // Moved out of inbox, into retired.
    expect(existsSync(join(brainDirs(vault).inbox, `${id}.md`))).toBe(false);
    expect(res.path.startsWith(brainDirs(vault).retired)).toBe(true);
    expect(existsSync(res.path)).toBe(true);

    const [meta] = parseFrontmatter(res.path);
    // Kind stays brain-signal (consistent with rejectPending).
    expect(meta["kind"]).toBe("brain-signal");
    expect(meta["_status"]).toBe("retired");
    expect(meta["retired_at"]).toBe(NOW.toISOString());
    expect(meta["retired_reason"]).toBe("superseded by a fresher capture");
    expect(meta["superseded_by"]).toBe("sig-2026-07-19-fact-url");
    expect(meta["retired_by"]).toBe("claude-dev-agent");
    // Original signal fields preserved for the audit trail.
    expect(meta["principle"]).toBe("https://fact-url.dev");
    // Tag swapped brain/signal -> brain/retired.
    expect(meta["tags"]).toContain("brain/retired");
    expect(meta["tags"]).not.toContain("brain/signal");
    // Old-id alias present.
    expect(meta["aliases"]).toContain(id);
  });

  test("the retired signal is excluded from dream intake but stays readable", () => {
    const id = seedSignal("fact-url", "fact-url-topic");
    // Before retirement the dream-intake surface (inbox + processed) sees it.
    expect(queryByTopic(vault, "fact-url-topic").signals.map((s) => s.id)).toContain(id);

    const res = retireSignal(vault, id, { reason: "no longer relevant", now: NOW });

    // The dream signal-collection surface no longer sees it.
    expect(queryByTopic(vault, "fact-url-topic").signals.map((s) => s.id)).not.toContain(id);
    // But it remains readable in the retired directory.
    const reread = parseSignal(res.path);
    expect(reread.id).toBe(id);
    expect(reread.principle).toBe("https://fact-url.dev");
  });

  test("appends a signal-retire audit log event", () => {
    const id = seedSignal("fact-url");
    retireSignal(vault, id, { reason: "duplicate", agent: "claude-dev-agent", now: NOW });
    const events = readAllLogEntries(vault).filter(
      (e) => e.eventType === BRAIN_LOG_EVENT_KIND.signalRetire,
    );
    expect(events.length).toBe(1);
    expect(events[0]!.body["signal"]).toBe(`[[${id}]]`);
    expect(events[0]!.body["reason"]).toBe("duplicate");
  });

  test("missing id is a typed error", () => {
    expect(() => retireSignal(vault, "sig-2026-07-18-absent", { reason: "x", now: NOW })).toThrow(
      SignalNotFoundError,
    );
  });

  test("already-retired id (present in retired/) is a typed error", () => {
    const id = seedSignal("fact-url");
    retireSignal(vault, id, { reason: "first", now: NOW });
    expect(() => retireSignal(vault, id, { reason: "again", now: NOW })).toThrow(
      SignalAlreadyRetiredError,
    );
  });

  test("a ret-* id is treated as already retired", () => {
    expect(() => retireSignal(vault, "ret-some-pref", { reason: "x", now: NOW })).toThrow(
      SignalAlreadyRetiredError,
    );
  });

  test("a non-signal id is a typed error", () => {
    expect(() => retireSignal(vault, "pref-some-rule", { reason: "x", now: NOW })).toThrow(
      InvalidSignalIdError,
    );
  });

  test("an id with path traversal is refused (containment)", () => {
    expect(() => retireSignal(vault, "../../etc/passwd", { reason: "x", now: NOW })).toThrow(
      InvalidSignalIdError,
    );
  });
});
