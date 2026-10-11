/**
 * Session-entity mining inside the import loop (recall-quality, B1).
 *
 * Mining runs where the raw turn text still exists - recall rows may
 * hold externalized payload placeholders, but the import loop reads the
 * transcript line before anything is externalized. The lane writes ONE
 * continuity record per (family, key, session), honors the capture
 * boundary (an ignored file imports nothing, a stateless scan writes
 * nothing), withholds turns carrying a `<private>` region whole, refuses
 * secret-shaped tokens, and reports every outcome through never-silent
 * counters on the import result.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import {
  continuityLogDir,
  listContinuityRecords,
} from "../../../../src/core/brain/continuity/store.ts";
import {
  MAX_MINED_KEYS_PER_SESSION,
  SESSION_ENTITY_MENTION_KIND,
} from "../../../../src/core/brain/link-graph/session-mining.ts";
import { importSession } from "../../../../src/core/brain/sessions/import.ts";
import { brainConfigPath } from "../../../../src/core/brain/paths.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { FAKE_VENDOR_KEY, fakeCredential } from "../../../helpers/fake-credentials.ts";

let tmp: string;
let vault: string;
let sessionsDir: string;

const NOW = new Date("2026-09-18T10:00:00Z");

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-import-mining-"));
  vault = join(tmp, "vault");
  sessionsDir = mkdtempSync(join(tmpdir(), "o2b-import-mining-sessions-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(sessionsDir, { recursive: true, force: true });
});

/** One Claude-format session file, each text a USER turn. */
function writeUserSession(name: string, texts: readonly string[]): string {
  return writeSession(
    name,
    texts.map((text) => ({ role: "user" as const, text })),
  );
}

/** One Claude-format session file with alternating user/assistant turns. */
function writeSession(
  name: string,
  turns: ReadonlyArray<{ readonly role: "user" | "assistant"; readonly text: string }>,
): string {
  const lines = turns.map((turn, i) =>
    JSON.stringify({
      type: turn.role,
      parentUuid: null,
      entrypoint: "cli",
      sessionId: "s1",
      uuid: `u-${i}`,
      timestamp: "2026-09-18T09:00:00.000Z",
      message: { role: turn.role, content: [{ type: "text", text: turn.text }] },
    }),
  );
  const path = join(sessionsDir, name);
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
  return path;
}

function ledgerMentions(): ReturnType<typeof listContinuityRecords> {
  return listContinuityRecords(vault, { kind: SESSION_ENTITY_MENTION_KIND });
}

function setSessionsPolicy(lines: string[]): void {
  const path = brainConfigPath(vault);
  atomicWriteFileSync(path, readFileSync(path, "utf8") + "\n" + lines.join("\n") + "\n");
}

describe("importSession - session entity mining", () => {
  test("an admitted turn mints one mention per (family, key, session)", async () => {
    const path = writeUserSession("mining-basic.jsonl", [
      "wire `SessionStore` to https://osb.example/run today",
    ]);

    const result = await importSession(vault, path, { agent: "tester", now: NOW });

    expect(result.mined_extracted).toBe(2);
    expect(result.mined_deduped).toBe(0);
    const records = ledgerMentions();
    expect(records.length).toBe(2);
    const keys = records.map((r) => `${r.payload["family"]}:${r.payload["key"]}`).toSorted();
    expect(keys).toEqual(["symbol:SessionStore", "url:https://osb.example/run"]);
    // Provenance keys on the portable session identity, never a host path.
    for (const record of records) {
      expect(record.payload["session_ref"]).toBe("mining-basic.jsonl");
      expect(record.sourceRefs[0]!.id.startsWith("mining-basic.jsonl:")).toBe(true);
    }
  });

  test("assistant turns are mined too, and the per-session fold dedupes repeats", async () => {
    const path = writeSession("mining-dedupe.jsonl", [
      { role: "user", text: "touch `SessionStore` please" },
      { role: "assistant", text: "edited SessionStore via `SessionStore` just now" },
    ]);

    const result = await importSession(vault, path, { agent: "tester", now: NOW });

    // Turn 1 mints symbol:SessionStore; turn 2 repeats it - the prose
    // "SessionStore" is not code and mines nothing, the code span dedupes.
    expect(result.mined_extracted).toBe(1);
    expect(result.mined_deduped).toBe(1);
    expect(ledgerMentions().length).toBe(1);
  });

  test("a dry run forecasts the mined count and writes nothing", async () => {
    const path = writeUserSession("mining-dry.jsonl", ["pin `SessionStore` here"]);

    const result = await importSession(vault, path, { agent: "tester", now: NOW, dryRun: true });

    expect(result.mined_extracted).toBe(0);
    expect(result.mined_withheld).toBe(1);
    expect(ledgerMentions()).toEqual([]);
  });

  test("secret-shaped tokens are refused and counted, never written", async () => {
    const tok = fakeCredential("tok", "en-9f8e7d6c5b");
    const path = writeUserSession("mining-secrets.jsonl", [
      `key \`${FAKE_VENDOR_KEY}\` and https://osb.example/pull?token=${tok}`,
    ]);

    const result = await importSession(vault, path, { agent: "tester", now: NOW });

    expect(result.mined_extracted).toBe(0);
    expect(result.mined_secret_refused).toBe(2);
    expect(ledgerMentions()).toEqual([]);
  });

  test("a turn carrying a private region is withheld from mining whole", async () => {
    const path = writeUserSession("mining-private.jsonl", [
      "public plan: use `PublicStore` here",
      "private notes: <private>token `SecretStore` inside</private>",
    ]);

    const result = await importSession(vault, path, { agent: "tester", now: NOW });

    expect(result.mined_private_withheld).toBe(1);
    expect(result.mined_extracted).toBe(1);
    const records = ledgerMentions();
    expect(records.length).toBe(1);
    expect(records[0]!.payload["key"]).toBe("PublicStore");
  });

  test("a file matching an ignore glob mines nothing and still reports counters", async () => {
    setSessionsPolicy(["sessions:", "  ignore_patterns:", '    - "*cron-export*"']);
    const path = writeUserSession("cron-export-1.jsonl", ["wire `SessionStore` here"]);

    const result = await importSession(vault, path, { agent: "tester", now: NOW });

    expect(result.boundary_decision).toBe("ignore");
    expect(result.mined_extracted).toBe(0);
    expect(result.mined_deduped).toBe(0);
    expect(result.mined_withheld).toBe(0);
    expect(result.mined_secret_refused).toBe(0);
    expect(result.mined_private_withheld).toBe(0);
    expect(result.mined_ledger_failed).toBe(0);
    expect(result.mined_cap_overflow).toBe(0);
    expect(ledgerMentions()).toEqual([]);
  });

  test("a stateless scan stays read-only: no mentions are written", async () => {
    setSessionsPolicy(["sessions:", "  stateless_patterns:", '    - "*scratch*"']);
    const path = writeUserSession("scratch-notes.jsonl", ["wire `SessionStore` here"]);

    const result = await importSession(vault, path, { agent: "tester", now: NOW });

    expect(result.boundary_decision).toBe("stateless");
    expect(result.mined_extracted).toBe(0);
    expect(ledgerMentions()).toEqual([]);
  });

  test("re-importing the session appends no duplicate mention rows", async () => {
    const path = writeUserSession("mining-reimport.jsonl", ["pin `SessionStore` here"]);
    await importSession(vault, path, { agent: "tester", now: NOW });
    // A run's dedupe set is seeded from the ledger rows already on disk,
    // so a re-import folds every mention to its (family, key, sessionRef)
    // row instead of appending a duplicate: the ledger stays one row per
    // mention no matter how often the directory import repeats.
    const second = await importSession(vault, path, { agent: "tester", now: NOW });

    expect(second.mined_extracted).toBe(0);
    expect(second.mined_deduped).toBe(1);
    expect(ledgerMentions().length).toBe(1);

    const third = await importSession(vault, path, { agent: "tester", now: NOW });
    expect(third.mined_extracted).toBe(0);
    expect(third.mined_deduped).toBe(1);
    expect(ledgerMentions().length).toBe(1);
  });

  test("a sabotaged ledger mid-import names the failure through the import result", async () => {
    // Sabotage: a regular file where the continuity ledger's directory must
    // be, so every mention append throws. The import itself still succeeds
    // (telemetry-grade tolerance), but the result's counters must say so -
    // the miner's ledgerFailed slot surfaced, never swallowed between the
    // miner and the import report.
    writeFileSync(continuityLogDir(vault), "not a directory\n");
    const path = writeUserSession("mining-ledger-fail.jsonl", ["pin `SessionStore` here"]);

    const result = await importSession(vault, path, { agent: "tester", now: NOW });

    expect(result.mined_extracted).toBe(0);
    expect(result.mined_ledger_failed).toBe(1);
    expect(result.errors).toEqual([]);
    // Repair the read side, then confirm nothing landed while it was down.
    rmSync(continuityLogDir(vault), { force: true });
    expect(ledgerMentions()).toEqual([]);
  });

  test("an over-cap session reports the overflow through the import result", async () => {
    const overCap = MAX_MINED_KEYS_PER_SESSION + 3;
    const text = Array.from({ length: overCap }, (_, i) => `\`Import_cap_key_${i}\``).join("\n");
    const path = writeUserSession("mining-cap.jsonl", [text]);

    const result = await importSession(vault, path, { agent: "tester", now: NOW });

    expect(result.mined_extracted).toBe(MAX_MINED_KEYS_PER_SESSION);
    expect(result.mined_cap_overflow).toBe(3);
    expect(result.mined_ledger_failed).toBe(0);
    expect(ledgerMentions().length).toBe(MAX_MINED_KEYS_PER_SESSION);
  });
});
