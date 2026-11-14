/**
 * `brain_feedback` under the signal-lane review gate (write-side trust,
 * Task 6). The tool calls `writeSignal` without a target directory, so the
 * gate resolves at the chokepoint and the receipt reports it: `staged:
 * true` with `signal_path` under `Brain/pending/` when the signals lane is
 * on, `staged: false` and the historical inbox path when it is off. The
 * dedup consumption is identical on both sides of the gate - a retried
 * idempotency key still dedupes against the staged original.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { brainDirs } from "../../src/core/brain/paths.ts";
import { moveToRetired } from "../../src/core/brain/preference.ts";
import { deleteBySource } from "../../src/core/brain/source-cleanup.ts";
import { sha256Hex } from "../../src/core/integrity/digest.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { PREFERENCE_MARKER_NAMESPACE } from "../../src/mcp/brain/feedback-tool.ts";
import { FEEDBACK_TOOLS } from "../../src/mcp/brain/feedback-tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

const MASTER_ENV = "OPEN_SECOND_BRAIN_WRITE_APPROVAL_ENABLED";

let vault: string;
let configHome: string;
let ctx: ServerContext;
let savedMaster: string | undefined;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-feedback-staged-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-feedback-staged-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
  ctx = { vault, configPath, repoRoot: null };
});

afterEach(() => {
  if (savedMaster === undefined) delete process.env[MASTER_ENV];
  else process.env[MASTER_ENV] = savedMaster;
  savedMaster = undefined;
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function setGate(on: boolean): void {
  if (savedMaster === undefined) savedMaster = process.env[MASTER_ENV];
  if (on) process.env[MASTER_ENV] = "true";
  else delete process.env[MASTER_ENV];
}

const tool = FEEDBACK_TOOLS.find((t) => t.name === "brain_feedback");
const handler = tool!.handler;

const ARGS = {
  topic: "staged feedback",
  signal: "positive",
  principle: "the gate reports staging on the receipt",
};

function pendingFiles(): string[] {
  return readdirSync(brainDirs(vault).pending).filter((f) => f.endsWith(".md"));
}

describe("brain_feedback staged receipt", () => {
  test("gate off keeps the inbox path with staged false", async () => {
    setGate(false);
    const res = (await handler(ctx, ARGS)) as Record<string, unknown>;
    expect(res["staged"]).toBe(false);
    expect(String(res["signal_path"]).startsWith("Brain/inbox/")).toBe(true);
    // Bootstrap creates the pending directory eagerly; the gate-off call
    // leaves it empty and lands the signal in the inbox.
    expect(pendingFiles()).toEqual([]);
  });

  test("gate on stages the signal and reports pending_id-ready coordinates", async () => {
    setGate(true);
    const res = (await handler(ctx, ARGS)) as Record<string, unknown>;
    expect(res["staged"]).toBe(true);
    expect(String(res["signal_path"]).startsWith("Brain/pending/")).toBe(true);
    expect(pendingFiles()).toEqual([`${String(res["signal_id"])}.md`]);
    expect(String(res["path"]).startsWith("Brain/pending/")).toBe(true);
  });

  test("a retried idempotency key dedupes against the staged original", async () => {
    setGate(true);
    const first = (await handler(ctx, { ...ARGS, idempotency_key: "staged-retry-1" })) as Record<
      string,
      unknown
    >;
    expect(first["deduped"]).toBeUndefined();
    expect(first["staged"]).toBe(true);
    const second = (await handler(ctx, { ...ARGS, idempotency_key: "staged-retry-1" })) as Record<
      string,
      unknown
    >;
    expect(second["deduped"]).toBe(true);
    expect(second["staged"]).toBe(false);
    expect(second["signal_id"]).toBe(first["signal_id"]);
    // The retry consumed nothing: the queue still holds exactly the original.
    expect(pendingFiles()).toEqual([`${String(first["signal_id"])}.md`]);
  });

  test("a retry after a failed force-confirmed write resumes the preference", async () => {
    // Block the preferences lane so the first call's force-confirmed write
    // throws AFTER the signal (and its idempotency receipt) landed.
    const prefsDir = join(vault, "Brain", "preferences");
    rmSync(prefsDir, { recursive: true, force: true });
    writeFileSync(prefsDir, "not a directory");
    const args = {
      ...ARGS,
      force_confirmed: true,
      idempotency_key: "resume-key-1",
    };
    await expect(handler(ctx, args)).rejects.toThrow();

    // Unblock the lane and retry with the same key and payload: the
    // receipt dedupes the signal, but the confirmed rule is still absent,
    // so the retry must complete the capture instead of answering deduped.
    rmSync(prefsDir);
    mkdirSync(prefsDir, { recursive: true });
    const retry = (await handler(ctx, args)) as Record<string, unknown>;
    expect(retry["kind"]).toBe("preference");
    expect(retry["deduped"]).toBe(true);
    const prefId = String(retry["preference_id"]);
    expect(prefId).toMatch(/^pref-/);
    expect(existsSync(join(prefsDir, `${prefId}.md`))).toBe(true);
    // The signal was not duplicated by the resume: exactly one capture.
    expect(
      readdirSync(brainDirs(vault).inbox).filter((f) => f.includes("staged-feedback")),
    ).toHaveLength(1);

    // A further retry against the COMPLETED capture stays a true no-op:
    // deduped, and the preference is not rewritten.
    const again = (await handler(ctx, args)) as Record<string, unknown>;
    expect(again["deduped"]).toBe(true);
    expect(again["kind"]).toBe("signal");
    expect(existsSync(join(prefsDir, `${prefId}.md`))).toBe(true);
    // Two sequential retries do not write the preference twice: the DONE
    // marker of the completed capture makes every later replay a no-op.
    const third = (await handler(ctx, args)) as Record<string, unknown>;
    expect(third["kind"]).toBe("signal");
    expect(readdirSync(prefsDir).filter((f) => f.startsWith("pref-"))).toEqual([`${prefId}.md`]);
  });

  test("a replay after delete-by-source stays deduped and writes no preference", async () => {
    // The capture cites a source page, so `deleteBySource` has something
    // to forget: the original, the signal and the folded preference.
    writeFileSync(join(vault, "runbook.md"), "# runbook\n");
    const args = {
      ...ARGS,
      force_confirmed: true,
      idempotency_key: "forgotten-capture-1",
      source: ["runbook.md"],
    };
    const first = (await handler(ctx, args)) as Record<string, unknown>;
    expect(first["kind"]).toBe("preference");
    const prefId = String(first["preference_id"]);
    expect(existsSync(join(vault, "Brain", "preferences", `${prefId}.md`))).toBe(true);

    // The operator forgets the source: the folded preference goes with it
    // (the signal's evidence trail names the forgotten source), but the
    // idempotency receipts never expire.
    appendFileSync(join(vault, String(first["signal_path"])), "\n\nSee [[runbook]].\n");
    deleteBySource(vault, "runbook", { confirm: true, includeOriginals: true });
    expect(existsSync(join(vault, "Brain", "preferences", `${prefId}.md`))).toBe(false);

    // A replay of the same call must NOT resurrect the forgotten rule:
    // the capture completed, so its DONE marker makes the replay a true
    // no-op.
    const replay = (await handler(ctx, args)) as Record<string, unknown>;
    expect(replay["deduped"]).toBe(true);
    expect(replay["kind"]).toBe("signal");
    expect(replay["preference_id"]).toBeUndefined();
    expect(existsSync(join(vault, "Brain", "preferences", `${prefId}.md`))).toBe(false);
    expect(
      readdirSync(join(vault, "Brain", "preferences")).filter((f) => f.startsWith("pref-")),
    ).toEqual([]);
  });

  test("a forced retry of a capture whose first call was not forced writes no preference", async () => {
    const key = "unforced-then-forced-1";
    const base = { ...ARGS, idempotency_key: key };
    // Call 1: no force. By design it writes the inbox signal only.
    const first = (await handler(ctx, base)) as Record<string, unknown>;
    expect(first["kind"]).toBe("signal");
    expect(
      readdirSync(join(vault, "Brain", "preferences")).filter((f) => f.startsWith("pref-")),
    ).toEqual([]);

    // Call 2: same key and payload, plus force_confirmed. The unforced
    // original never asked for a rule, the payload hash that guards the
    // capture names the force flag, so the retry must not confirm one.
    const retry = (await handler(ctx, { ...base, force_confirmed: true })) as Record<
      string,
      unknown
    >;
    expect(retry["deduped"]).toBe(true);
    expect(retry["kind"]).toBe("signal");
    expect(retry["preference_id"]).toBeUndefined();
    expect(
      readdirSync(join(vault, "Brain", "preferences")).filter((f) => f.startsWith("pref-")),
    ).toEqual([]);
  });

  test("a forced retry with a different expiration does not resume the original capture", async () => {
    const args = { ...ARGS, force_confirmed: true, idempotency_key: "expiry-mismatch-1" };
    const first = (await handler(ctx, args)) as Record<string, unknown>;
    expect(first["kind"]).toBe("preference");
    const prefId = String(first["preference_id"]);
    const originalExpiration = readFileSync(
      join(vault, "Brain", "preferences", `${prefId}.md`),
      "utf8",
    );

    // Same key and topic, a different lifetime: a different payload. The
    // retry must not land the original's rule again under a new stamp.
    const retry = (await handler(ctx, { ...args, expires: "2031-01-01" })) as Record<
      string,
      unknown
    >;
    expect(retry["kind"]).toBe("signal");
    expect(
      readdirSync(join(vault, "Brain", "preferences")).filter((f) => f.startsWith("pref-")),
    ).toEqual([`${prefId}.md`]);
    expect(readFileSync(join(vault, "Brain", "preferences", `${prefId}.md`), "utf8")).toBe(
      originalExpiration,
    );
  });

  test("a retry whose pending capture lost its signal stays a no-op", async () => {
    // A first forced call whose preference write fails leaves the PENDING
    // capture marker without DONE - the retry-resume state.
    const prefsDir = join(vault, "Brain", "preferences");
    rmSync(prefsDir, { recursive: true, force: true });
    writeFileSync(prefsDir, "not a directory");
    const args = {
      ...ARGS,
      force_confirmed: true,
      idempotency_key: "forgotten-pending-1",
    };
    await expect(handler(ctx, args)).rejects.toThrow();

    // Before the retry runs, the signal page is forgotten - the state
    // `delete-by-source` and a hand removal both leave: receipts never
    // expire, the signal does.
    const signalFile = readdirSync(brainDirs(vault).inbox).find((f) =>
      f.includes("staged-feedback"),
    );
    expect(signalFile).toBeDefined();
    rmSync(join(brainDirs(vault).inbox, signalFile!));

    // Unblock the lane and replay: the pending marker is there, but the
    // signal it stands for is gone, so the replay stays a true no-op and
    // writes no preference.
    rmSync(prefsDir);
    mkdirSync(prefsDir, { recursive: true });
    const replay = (await handler(ctx, args)) as Record<string, unknown>;
    expect(replay["deduped"]).toBe(true);
    expect(replay["kind"]).toBe("signal");
    expect(replay["preference_id"]).toBeUndefined();
    expect(readdirSync(prefsDir).filter((f) => f.startsWith("pref-"))).toEqual([]);
  });

  test("a capture with a 250-character key replays deduped without an error", async () => {
    // The ledger accepts client keys up to 256 characters. The marker
    // keys are digests of the key, never the key plus a suffix, so a
    // near-limit key must still capture fresh and replay deduped: with a
    // suffix appended the PENDING/DONE appends fail soft and every
    // replay's marker lookup throws instead.
    const key = "k".repeat(250);
    const args = { ...ARGS, force_confirmed: true, idempotency_key: key };
    const first = (await handler(ctx, args)) as Record<string, unknown>;
    expect(first["kind"]).toBe("preference");
    const prefId = String(first["preference_id"]);
    expect(existsSync(join(vault, "Brain", "preferences", `${prefId}.md`))).toBe(true);

    // The forced replay of the completed capture: a deduped no-op that
    // answers normally, with no preference written twice.
    const replay = (await handler(ctx, args)) as Record<string, unknown>;
    expect(replay["deduped"]).toBe(true);
    expect(replay["kind"]).toBe("signal");
    expect(replay["preference_id"]).toBeUndefined();
    expect(
      readdirSync(join(vault, "Brain", "preferences")).filter((f) => f.startsWith("pref-")),
    ).toEqual([`${prefId}.md`]);
  });

  test("a crash-window resume still fires after the dream pass moved the signal", async () => {
    // The same blocked-lane first call as above, but before the retry the
    // signal page MOVES: the dream pass files inbox pages under
    // `Brain/inbox/processed/`. The signal is still alive, so the resume
    // must find it by id in the processed folder and complete the
    // capture instead of answering a dead no-op.
    const prefsDir = join(vault, "Brain", "preferences");
    rmSync(prefsDir, { recursive: true, force: true });
    writeFileSync(prefsDir, "not a directory");
    const args = {
      ...ARGS,
      force_confirmed: true,
      idempotency_key: "moved-signal-resume-1",
    };
    await expect(handler(ctx, args)).rejects.toThrow();

    const signalFile = readdirSync(brainDirs(vault).inbox).find((f) =>
      f.includes("staged-feedback"),
    );
    expect(signalFile).toBeDefined();
    mkdirSync(join(vault, "Brain", "inbox", "processed"), { recursive: true });
    renameSync(
      join(brainDirs(vault).inbox, signalFile!),
      join(vault, "Brain", "inbox", "processed", signalFile!),
    );

    rmSync(prefsDir);
    mkdirSync(prefsDir, { recursive: true });
    const retry = (await handler(ctx, args)) as Record<string, unknown>;
    expect(retry["kind"]).toBe("preference");
    expect(retry["deduped"]).toBe(true);
    expect(existsSync(join(prefsDir, `${String(retry["preference_id"])}.md`))).toBe(true);
  });

  test("a crash-window resume still fires after the staged signal was applied into the inbox", async () => {
    // The apply pass files a staged signal out of `Brain/pending/` into
    // `Brain/inbox/` - the destination an unswitched machine lands on.
    // The signal is still alive there, so the resume must find it by id
    // in the inbox folder and complete the capture instead of answering
    // a dead no-op.
    setGate(true);
    const prefsDir = join(vault, "Brain", "preferences");
    rmSync(prefsDir, { recursive: true, force: true });
    writeFileSync(prefsDir, "not a directory");
    const args = {
      ...ARGS,
      force_confirmed: true,
      idempotency_key: "applied-signal-resume-1",
    };
    await expect(handler(ctx, args)).rejects.toThrow();

    // Apply the staged signal: out of the pending queue, into the inbox.
    const signalFile = pendingFiles().find((f) => f.includes("staged-feedback"));
    expect(signalFile).toBeDefined();
    mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
    renameSync(
      join(brainDirs(vault).pending, signalFile!),
      join(vault, "Brain", "inbox", signalFile!),
    );

    rmSync(prefsDir);
    mkdirSync(prefsDir, { recursive: true });
    const retry = (await handler(ctx, args)) as Record<string, unknown>;
    expect(retry["kind"]).toBe("preference");
    expect(retry["deduped"]).toBe(true);
    expect(existsSync(join(prefsDir, `${String(retry["preference_id"])}.md`))).toBe(true);
  });

  test("a crash-window resume matches a retry key spelled with surrounding whitespace", async () => {
    // The ledger normalises the client key (trim) on every receipt, so
    // the PENDING/DONE marker digests must be taken over the trimmed key
    // too: a retry whose key only differs in surrounding whitespace
    // dedupes the signal and must find the original capture's marker,
    // not strand it behind a hash no retry can match.
    const prefsDir = join(vault, "Brain", "preferences");
    rmSync(prefsDir, { recursive: true, force: true });
    writeFileSync(prefsDir, "not a directory");
    const first = {
      ...ARGS,
      force_confirmed: true,
      idempotency_key: " trim-key-1 ",
    };
    await expect(handler(ctx, first)).rejects.toThrow();

    rmSync(prefsDir);
    mkdirSync(prefsDir, { recursive: true });
    const retry = (await handler(ctx, {
      ...ARGS,
      force_confirmed: true,
      idempotency_key: "trim-key-1",
    })) as Record<string, unknown>;
    expect(retry["deduped"]).toBe(true);
    expect(retry["kind"]).toBe("preference");
    expect(existsSync(join(prefsDir, `${String(retry["preference_id"])}.md`))).toBe(true);
  });

  test("a crash-window replay after the rule was retired writes nothing", async () => {
    // A completed forced capture whose DONE marker is then lost (the
    // crash window: PENDING without DONE) leaves a replay resumable - so
    // a rule the user retired in that window must not be re-confirmed
    // beside its own retirement.
    const args = {
      ...ARGS,
      force_confirmed: true,
      idempotency_key: "retired-in-crash-window-1",
    };
    const first = (await handler(ctx, args)) as Record<string, unknown>;
    expect(first["kind"]).toBe("preference");
    const prefId = String(first["preference_id"]);

    // Lose the DONE marker: rewrite the ledger shards without it, which
    // is exactly the on-disk state a crash between the preference write
    // and the DONE append leaves.
    const doneKey = `pref-capture-done:${sha256Hex(args.idempotency_key)}`;
    const ledgerDir = join(vault, "Brain", "logs", "idempotency");
    let dropped = 0;
    for (const shard of readdirSync(ledgerDir)) {
      const path = join(ledgerDir, shard);
      const kept = readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => {
          if (line.trim() === "") return true;
          const record = JSON.parse(line) as { key?: string; namespace?: string };
          const isDone = record.key === doneKey && record.namespace === PREFERENCE_MARKER_NAMESPACE;
          if (isDone) dropped += 1;
          return !isDone;
        })
        .join("\n");
      writeFileSync(path, kept);
    }
    expect(dropped).toBe(1);

    // The user retires the rule in the crash window.
    moveToRetired(vault, join(vault, "Brain", "preferences", `${prefId}.md`), "user-rejected", {
      now: new Date(),
      retired_by: "[[2026-01-01]]",
      user_rejected_reason: "superseded",
    });

    // The replay: PENDING without DONE and a live signal, but the rule
    // is retired, so the guard keeps the replay a true no-op.
    const replay = (await handler(ctx, args)) as Record<string, unknown>;
    expect(replay["deduped"]).toBe(true);
    expect(replay["kind"]).toBe("signal");
    expect(replay["preference_id"]).toBeUndefined();
    expect(
      readdirSync(join(vault, "Brain", "preferences")).filter((f) => f.startsWith("pref-")),
    ).toEqual([]);
  });

  test("a crash-window replay of a completed capture answers deduped without writing again", async () => {
    // A completed forced capture whose DONE marker is then lost: PENDING
    // without DONE, the signal still alive, and the rule the original
    // call wrote still ACTIVE. The replay must recognise the rule as this
    // capture's own completed write, close the ledger, and answer deduped
    // - not attempt the preference write a second time and fail on the
    // existing rule.
    const args = {
      ...ARGS,
      force_confirmed: true,
      idempotency_key: "active-in-crash-window-1",
    };
    const first = (await handler(ctx, args)) as Record<string, unknown>;
    expect(first["kind"]).toBe("preference");
    const prefId = String(first["preference_id"]);
    const prefsDir = join(vault, "Brain", "preferences");
    expect(existsSync(join(prefsDir, `${prefId}.md`))).toBe(true);

    // Lose the DONE marker: exactly the on-disk state a crash between the
    // preference write and the DONE append leaves.
    dropDoneMarker(vault, args.idempotency_key);

    // The replay: no error, deduped, naming the rule that already exists,
    // and without a second preference page.
    const replay = (await handler(ctx, args)) as Record<string, unknown>;
    expect(replay["deduped"]).toBe(true);
    expect(replay["kind"]).toBe("preference");
    expect(replay["preference_id"]).toBe(prefId);
    expect(readdirSync(prefsDir).filter((f) => f.startsWith("pref-"))).toEqual([`${prefId}.md`]);

    // The ledger is closed again: a further replay is the ordinary
    // completed-capture no-op.
    const again = (await handler(ctx, args)) as Record<string, unknown>;
    expect(again["deduped"]).toBe(true);
    expect(again["kind"]).toBe("signal");
    expect(readdirSync(prefsDir).filter((f) => f.startsWith("pref-"))).toEqual([`${prefId}.md`]);
  });

  test("a crash-window replay does not adopt a pre-existing rule this capture did not write", async () => {
    // Same crash window, but the active rule under the capture's slug was
    // written by something else: same payload, confirmed, yet its
    // evidenced_by names another signal. The replay must not close the
    // ledger on a rule this capture cannot prove it wrote - it falls
    // through, and the conflicting rule surfaces instead of being
    // silently adopted.
    const args = {
      ...ARGS,
      force_confirmed: true,
      idempotency_key: "foreign-rule-in-crash-window-1",
    };
    const first = (await handler(ctx, args)) as Record<string, unknown>;
    expect(first["kind"]).toBe("preference");
    const prefId = String(first["preference_id"]);
    const prefPath = join(vault, "Brain", "preferences", `${prefId}.md`);

    // Lose the DONE marker, then detach the rule from this capture's
    // signal: the on-disk state of a same-slug same-payload rule whose
    // evidence is somebody else's.
    dropDoneMarker(vault, args.idempotency_key);
    const before = readFileSync(prefPath, "utf8");
    const after = before.replace(/_evidenced_by:.*\n/, '_evidenced_by: ["[[sig-elsewhere]]"]\n');
    expect(after).not.toBe(before);
    writeFileSync(prefPath, after);

    // The replay falls through instead of adopting the rule, and the
    // resume write refuses on the rule that is already there.
    await expect(handler(ctx, args)).rejects.toThrow();
    // The foreign rule is untouched and unclaimed by the replay.
    expect(readFileSync(prefPath, "utf8")).toContain('_evidenced_by: ["[[sig-elsewhere]]"]');
    expect(
      readdirSync(join(vault, "Brain", "preferences")).filter((f) => f.startsWith("pref-")),
    ).toEqual([`${prefId}.md`]);
  });
});

/** Rewrite the idempotency ledger shards without this key's DONE marker. */
function dropDoneMarker(vault: string, key: string): void {
  const doneKey = `pref-capture-done:${sha256Hex(key)}`;
  const ledgerDir = join(vault, "Brain", "logs", "idempotency");
  let dropped = 0;
  for (const shard of readdirSync(ledgerDir)) {
    const path = join(ledgerDir, shard);
    const kept = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => {
        if (line.trim() === "") return true;
        const record = JSON.parse(line) as { key?: string; namespace?: string };
        const isDone = record.key === doneKey && record.namespace === PREFERENCE_MARKER_NAMESPACE;
        if (isDone) dropped += 1;
        return !isDone;
      })
      .join("\n");
    writeFileSync(path, kept);
  }
  expect(dropped).toBe(1);
}
