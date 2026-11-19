/**
 * Every kind of sync leftover a two-machine vault synced by Syncthing
 * holds, built from the list of names a real dry run met (file names
 * only, contents made up here): conflict copies of the freshen state, of
 * a lock, of signal pages (one identical, two versions of one signal),
 * of a Brain log shard and its day page, of audit-trail week shards, of
 * the pinned context, and one in-flight temp file.
 *
 * Every row and page is written byte by byte; `ROW_*` name the rows the
 * tests look for.
 */

export type Write = (rel: string, text: string) => unknown;

function jsonl(...rows: ReadonlyArray<unknown>): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

function logRow(ts: string, text: string): unknown {
  return { ts, kind: "note", payload: { text }, prev: null, h: "0".repeat(64) };
}

function auditRow(timestamp: string, target: string): unknown {
  return { timestamp, actor: "hook", action: "session-start", target, ok: true };
}

function signal(id: string, principle: string): string {
  return `---\nid: ${id}\ntopic: fact\nprinciple: ${principle}\nagent: "@a"\n---\nRaw.\n`;
}

/** A row both the log shard and its conflict copy hold. */
export const ROW_SHARED = logRow("2026-10-28T20:00:00Z", "in both");
/** A row only the log shard's conflict copy holds. */
export const ROW_ONLY_IN_COPY = logRow("2026-10-28T21:16:16Z", "only in the copy");

/** Vault-relative paths of the planted leftovers. */
export const SYNC_LEFTOVERS = Object.freeze({
  logShard: "Brain/log/2026-10-28.dev-b.jsonl",
  logCopy: "Brain/log/2026-10-28.dev-b.sync-conflict-20261028-211616-QFQZVF3.jsonl",
  dayPageCopy: "Brain/log/2026-10-28.dev-b.sync-conflict-20261028-211617-QFQZVF3.md",
  auditShard: "Brain/log/session-lifecycle/2026-W40.jsonl",
  auditCopies: [
    "Brain/log/session-lifecycle/2026-W40.sync-conflict-20260930-151733-QFQZVF3.jsonl",
    "Brain/log/session-lifecycle/2026-W40.sync-conflict-20260930-152016-QFQZVF3.jsonl",
  ],
  auditShardB: "Brain/log/session-lifecycle/2026-W44.dev-b.jsonl",
  auditCopyB:
    "Brain/log/session-lifecycle/2026-W44.dev-b.sync-conflict-20261028-211617-QFQZVF3.jsonl",
  signalSame: "Brain/inbox/sig-2026-08-05-fact-url-3.md",
  signalSameCopy: "Brain/inbox/sig-2026-08-05-fact-url-3.sync-conflict-20260805-091313-PYXV73G.md",
  signalTwo: "Brain/inbox/sig-2026-09-08-fact-quantity-16.md",
  signalTwoCopies: [
    "Brain/inbox/sig-2026-09-08-fact-quantity-16.sync-conflict-20260908-125857-QFQZVF3.md",
    "Brain/inbox/sig-2026-09-08-fact-quantity-16.sync-conflict-20260908-205900-QFQZVF3.md",
  ],
  temp: "Brain/inbox/.syncthing.sig-2026-11-18-fact-url-597.md.tmp",
  tempBecomes: "Brain/inbox/sig-2026-11-18-fact-url-597.md",
  pinnedCopy: "Brain/pinned.sync-conflict-20260827-105124-PYXV73G.md",
  freshen: ".open-second-brain/freshen-state.json",
  freshenCopies: [
    ".open-second-brain/freshen-state.sync-conflict-20261105-220819-QFQZVF3.json",
    ".open-second-brain/freshen-state.sync-conflict-20261106-104127-QFQZVF3.json",
  ],
  lockCopy: ".open-second-brain/self-heal-upgrade.sync-conflict-20261118-225721-QFQZVF3.lock",
});

/** The text of the temp file, and of the signal it becomes. */
export const TEMP_SIGNAL = signal("sig-2026-11-18-fact-url-597", "Arrived by sync");

/** Plant every leftover kind in the vault `write` writes into. */
export function plantSyncLeftovers(write: Write): void {
  const L = SYNC_LEFTOVERS;
  // A Brain log shard and its copy: one shared row, one only in the copy.
  write(L.logShard, jsonl(ROW_SHARED, logRow("2026-10-28T20:30:00Z", "only in the shard")));
  write(L.logCopy, jsonl(ROW_SHARED, ROW_ONLY_IN_COPY));
  // The day page copy: a readable copy of rows, dropped with its original.
  write(L.dayPageCopy, "# 2026-10-28\n\n- in both\n- only in the copy\n");
  // Audit-trail week shards: two copies of an un-sharded week (one equal
  // to its original, one with a row of its own), and a copy of a device's.
  const w40 = auditRow("2026-09-30T15:00:00Z", "s-1");
  write(L.auditShard, jsonl(w40));
  write(L.auditCopies[0]!, jsonl(w40));
  write(L.auditCopies[1]!, jsonl(w40, auditRow("2026-09-30T15:20:16Z", "s-2")));
  const w44 = auditRow("2026-10-28T21:00:00Z", "s-3");
  write(L.auditShardB, jsonl(w44));
  write(L.auditCopyB, jsonl(w44, auditRow("2026-10-28T21:16:17Z", "s-4")));
  // Signal pages: a copy equal to its page, and two versions of one signal.
  write(L.signalSame, signal("sig-2026-08-05-fact-url-3", "Same in both"));
  write(L.signalSameCopy, signal("sig-2026-08-05-fact-url-3", "Same in both"));
  write(L.signalTwo, signal("sig-2026-09-08-fact-quantity-16", "Sixteen"));
  write(L.signalTwoCopies[0]!, signal("sig-2026-09-08-fact-quantity-16", "Sixteen, edited here"));
  write(L.signalTwoCopies[1]!, signal("sig-2026-09-08-fact-quantity-16", "Sixteen, edited there"));
  // A signal still downloading.
  write(L.temp, TEMP_SIGNAL);
  // Pinned context: the fixture's own `Brain/pinned.md` and a differing copy.
  write(L.pinnedCopy, "Working on the other machine's plan.\n");
  // Device-local freshen state and a lock: copies dropped with them.
  write(L.freshen, '{"next":1}\n');
  write(L.freshenCopies[0]!, '{"next":2}\n');
  write(L.freshenCopies[1]!, '{"next":3}\n');
  write(L.lockCopy, "");
}
