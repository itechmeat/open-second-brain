/**
 * A legacy vault with the real layout shapes a migration meets: per-device
 * shards of several ledgers written by three devices (one of them silent
 * for two months), legacy un-sharded files, a private preference and the
 * records that name it, a malformed line, a sync-conflict copy, a lane no
 * mapping covers and a stray file. Written byte by byte rather than through
 * the writers, so the fixture holds exactly these shapes and no writer's
 * side effects.
 *
 * Everything lives under one temp parent that {@link LegacyVaultFixture.cleanup}
 * removes.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface LegacyVaultFixture {
  readonly parent: string;
  readonly vault: string;
  /** Write `text` at the vault-relative `rel`, creating folders. */
  write(rel: string, text: string): string;
  cleanup(): void;
}

const DAY_MS = 86_400_000;

/**
 * Legacy entries the fixture plants on purpose that no mapping covers: a
 * sync-conflict log copy, a stray text file and a binary. A migration
 * refuses while they exist, so a bench that migrates removes them first.
 */
export const UNMAPPED_LEGACY_ENTRIES: ReadonlyArray<string> = Object.freeze([
  "Brain/log/2026-11-01.sync-conflict-20261101-120000-ABC.jsonl",
  "Brain/log/stray.txt",
  "Brain/procedures/index.bin",
]);

function jsonl(...rows: ReadonlyArray<unknown>): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

function page(frontmatter: Record<string, string>, body: string): string {
  const lines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n${body}\n`;
}

/** A log row in the legacy JSONL shape (`log.ts` `renderJsonlLine`). */
function logRow(ts: string, kind: string, payload: Record<string, unknown>): unknown {
  return { ts, kind, payload, prev: null, h: "0".repeat(64) };
}

export function makeLegacyVault(prefix = "osb-legacy-vault-"): LegacyVaultFixture {
  const parent = mkdtempSync(join(tmpdir(), prefix));
  const vault = join(parent, "vault");
  mkdirSync(vault, { recursive: true });
  const write = (rel: string, text: string): string => {
    const path = join(vault, ...rel.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return path;
  };

  // Memory lanes.
  write(
    "Brain/inbox/2026-11-01-tabs.md",
    page({ id: "sig-tabs", topic: "tabs", principle: "Use tabs", agent: "@a" }, "Raw."),
  );
  write(
    "Brain/inbox/processed/2026-10-01-old.md",
    page({ id: "sig-old", topic: "old", principle: "Old rule" }, ""),
  );
  write("Brain/pending/2026-11-02-staged.md", page({ id: "sig-staged", topic: "x" }, ""));
  write(
    "Brain/preferences/pref-open.md",
    page({ id: "pref-open", principle: "Open rule", status: "active" }, "Body."),
  );
  write(
    "Brain/preferences/pref-secret.md",
    page({ id: "pref-secret", principle: "Secret rule", visibility: "private" }, "Body."),
  );
  write(
    "Brain/retired/ret-gone.md",
    page({ id: "ret-gone", principle: "Gone rule", status: "retired" }, ""),
  );
  write(
    "Brain/preferences/pref-open.history.dev-a.jsonl",
    jsonl({ revision: 2, field: "principle", before: "a", after: "b" }),
  );
  write("Brain/pinned.md", "Working on [[pref-secret]] today.\n");

  // The Brain log: two devices, a legacy un-sharded day, a private event,
  // a malformed middle line, the day page and a sync-conflict copy.
  write(
    "Brain/log/2026-11-01.dev-a.jsonl",
    jsonl(
      logRow("2026-11-01T10:00:00Z", "note", { text: "open work" }),
      logRow("2026-11-01T11:00:00Z", "apply-evidence", { pref_id: "pref-secret" }),
    ),
  );
  write(
    "Brain/log/2026-11-01.dev-b.jsonl",
    JSON.stringify(logRow("2026-11-01T12:00:00Z", "note", { text: "b" })) +
      "\n{not json\n" +
      JSON.stringify(logRow("2026-11-01T13:00:00Z", "note", { text: "c" })) +
      "\n",
  );
  write("Brain/log/2026-10-01.jsonl", jsonl(logRow("2026-10-01T09:00:00Z", "note", { text: "x" })));
  write("Brain/log/2026-11-01.dev-a.md", "# 2026-11-01\n");
  write("Brain/log/2026-11-01.sync-conflict-20261101-120000-ABC.jsonl", "{}\n");

  // Per-device ledgers.
  write(
    "Brain/log/continuity/2026-11.dev-a.jsonl",
    jsonl({ id: "c1", summary: "handover", session_id: "s1" }),
  );
  const silent = write(
    "Brain/log/continuity/2026-09.dev-c.jsonl",
    jsonl({ id: "c0", summary: "old handover", session_id: "s0" }),
  );
  write(
    "Brain/log/pref-audit/pref-secret/device.dev-a.jsonl",
    jsonl({ pref_id: "pref-secret", agent: "@a", action: "promote" }),
  );
  write(
    "Brain/logs/idempotency/2026-11.dev-b.jsonl",
    jsonl({ key: "k1", namespace: "signal", contentHash: "h" }),
  );
  write("Brain/metrics/recall.dev-a.jsonl", jsonl({ run_at: "2026-11-01T00:00:00Z", n: 1 }));

  // The derived store.
  write(".open-second-brain/brain.sqlite", "SQLite format 3\0");
  write(".open-second-brain/secrets/keyfile", "secret-bytes");
  write(
    ".open-second-brain/hook-audit/2026-W45.dev-b.jsonl",
    jsonl({
      timestamp: "2026-11-02T00:00:00Z",
      actor: "hook",
      action: "run",
      target: "x",
      ok: true,
    }),
  );

  // Record lanes with no kind of their own: lane entries.
  write("Brain/procedures/deploy.md", page({ id: "proc-deploy" }, "Steps."));
  write("Brain/obligations/archive/obl-old.md", page({ visibility: "private" }, "Owed."));
  write("Brain/standing-rules.md", "Always answer in full sentences.\n");
  write("Brain/standing-rules/project/osb.md", page({ scope: "coding" }, "Run the census."));
  write("Brain/state/current-focus.md", page({ aspect: "focus" }, "Migration."));

  // Entries no mapping covers.
  write("Brain/procedures/index.bin", "binary-ish");
  write("Brain/log/stray.txt", "left here by hand\n");

  // dev-c last wrote two months ago: in the cohort, not in the roster.
  const old = new Date(Date.now() - 60 * DAY_MS);
  utimesSync(silent, old, old);

  return {
    parent,
    vault,
    write,
    cleanup: () => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}
