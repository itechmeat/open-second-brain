/**
 * `o2b brain dead-letters` CLI surface (one-command recovery,
 * t_50794f57, task C3). Claims pinned here:
 *
 *  1. `list` (the default) renders every letter with its classification
 *     and the exact copy-paste recovery command, and exits 0 - a listing
 *     is a report, never a failure. An empty vault says so and exits 0.
 *  2. `show <id>` prints one letter in full detail; an unknown id is a
 *     typed usage error (exit 2), never a silent no-op.
 *  3. `recover <id>` is dry-run by default and previews the per-item
 *     verdicts; `--apply` performs the re-run.
 *  4. `--apply` without `--yes` under `--json` or a non-TTY stdin refuses
 *     typed, writes nothing, and names the consent rule.
 *  5. A frozen vault refuses the apply by name (exit 1) and points at
 *     `o2b brain unfreeze`.
 *  6. Nothing ever deletes the letter: after a successful recovery the
 *     record is still on disk, and the verb says the removal is the
 *     operator's hand action.
 *  7. The verb is wired: the router dispatches it, the manifest carries
 *     it (so the derived help surfaces list it), and the write error's
 *     diagnostic entry resolves to the verb.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deadLetterDir,
  deadLetterPath,
  listDeadLetters,
  recordDeadLetter,
  type DeadLetterEnvelopeIdentity,
} from "../../src/core/brain/dead-letter.ts";
import { DEAD_LETTER_ITEM_VERDICT } from "../../src/core/brain/dead-letter-recovery.ts";
import { verdictText } from "../../src/cli/brain/verbs/dead-letters.ts";
import { resolveNextStep } from "../../src/core/brain/next-step.ts";
import { freezeVault } from "../../src/core/brain/freeze.ts";
import { resetFreezeMarkerCache } from "../../src/core/brain/freeze-marker.ts";
import { resetVaultIdentityPins } from "../../src/core/brain/vault-identity.ts";
import { importSessionRecall } from "../../src/core/brain/session-recall.ts";
import {
  commitExtractedSignals,
  type ExtractedSignalItem,
} from "../../src/core/brain/extract-signals.ts";
import { buildReconciliationReport } from "../../src/core/reconciliation-report.ts";
import { runCli } from "../helpers/run-cli.ts";

const NOW = new Date("2026-08-23T10:15:00Z");
const SESSION = "sess-cli-recover";
const AGENT = "tester";

let tmp: string;
let vault: string;
let configPath: string;

function item(overrides: Partial<ExtractedSignalItem> = {}): ExtractedSignalItem {
  return {
    topic: "release-notes-style",
    signal: "positive",
    principle: "Name the release theme in the heading, never the ticket id.",
    confidence: 0.9,
    ...overrides,
  };
}

const ENVELOPE: DeadLetterEnvelopeIdentity = Object.freeze({
  lane: "extract-signals",
  step: "extract-signals",
  reference: SESSION,
  target: "Brain/inbox",
});

/** A schema-2 letter over `items` naming `missingKeys`, as the commit writes it. */
function v2Letter(
  items: ReadonlyArray<ExtractedSignalItem>,
  missingKeys: ReadonlyArray<string>,
): ReturnType<typeof recordDeadLetter> {
  return recordDeadLetter(vault, {
    envelope: ENVELOPE,
    report: buildReconciliationReport({
      attempted: items.length,
      found: items.length - missingKeys.length,
      missing: missingKeys,
    }),
    firstError: "EIO: i/o error",
    now: NOW,
    payload: { items: [...items] },
  });
}

function run(args: ReadonlyArray<string>) {
  return runCli(["brain", "dead-letters", ...args, "--vault", vault], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-dead-letters-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\n`);
  importSessionRecall(vault, {
    sessionId: SESSION,
    turns: [
      {
        turnId: "t1",
        timestamp: "2026-08-22T09:01:00Z",
        role: "user",
        text: "Always name the release theme in the heading.",
      },
    ],
    createdAt: "2026-08-22T10:00:00Z",
  });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  resetFreezeMarkerCache();
  resetVaultIdentityPins();
});

describe("dead-letters list", () => {
  test("an empty vault is a clean, zero-exit report", async () => {
    const r = await run([]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("no dead letters");
  });

  test("the default renders the classification and the exact recovery command per row", async () => {
    const letter = v2Letter([item(), item({ topic: "module-names" })], ["items[1]:module-names"]);
    const r = await run([]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain(letter.id);
    expect(r.stdout).toContain("recover");
    expect(r.stdout).toContain(`o2b brain dead-letters recover ${letter.id} --apply --yes`);
    expect(r.stdout).toContain(SESSION);
    expect(r.stdout).toContain("items[1]:module-names");
  });

  test("a resolved row renders no command and names why", async () => {
    const items = [item(), item({ topic: "module-names" })];
    commitExtractedSignals(vault, SESSION, { items }, { agent: AGENT, now: NOW });
    v2Letter(items, ["items[0]:release-notes-style", "items[1]:module-names"]);
    const r = await run([]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("resolved");
    expect(r.stdout).toContain("now on disk");
    expect(r.stdout).not.toContain("--apply");
  });

  test("--json carries the per-row category, reason and command", async () => {
    const letter = v2Letter([item()], ["items[0]:release-notes-style"]);
    const r = await run(["--json"]);
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      ok: boolean;
      total: number;
      letters: Array<{
        id: string;
        lane: string;
        reference: string;
        missing: string[];
        category: string;
        reason: string;
        command: string | null;
      }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.total).toBe(1);
    const row = payload.letters[0]!;
    expect(row.id).toBe(letter.id);
    expect(row.lane).toBe("extract-signals");
    expect(row.reference).toBe(SESSION);
    expect(row.missing).toEqual(["items[0]:release-notes-style"]);
    expect(row.category).toBe("recover");
    expect(row.command).toBe(`o2b brain dead-letters recover ${letter.id} --apply --yes`);
  });

  test("a non-recoverable row is still exit 0 - a listing reports, it does not fail", async () => {
    v2Letter([item()], ["items[0]:release-notes-style"]);
    // A second letter for a session the ledger does not know.
    recordDeadLetter(vault, {
      envelope: { ...ENVELOPE, reference: "sess-nowhere" },
      report: buildReconciliationReport({ attempted: 1, found: 0, missing: ["items[0]:x"] }),
      firstError: "disk full",
      now: NOW,
      payload: { items: [item({ topic: "x" })] },
    });
    const r = await run([]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("not_recoverable");
    expect(r.stdout).toContain("sess-nowhere");
  });
});

describe("dead-letters show", () => {
  test("one letter renders in full detail, missing keys named", async () => {
    const letter = v2Letter([item(), item({ topic: "module-names" })], ["items[1]:module-names"]);
    const r = await run(["show", letter.id]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain(letter.id);
    expect(r.stdout).toContain("items[1]:module-names");
    expect(r.stdout).toContain("EIO: i/o error");
    expect(r.stdout).toContain("module-names");
  });

  test("show --json carries the frozen payload's items", async () => {
    const letter = v2Letter([item()], ["items[0]:release-notes-style"]);
    const r = await run(["show", letter.id, "--json"]);
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      ok: boolean;
      letter: { id: string; payload?: { items: Array<{ topic: string }> } };
    };
    expect(payload.ok).toBe(true);
    expect(payload.letter.id).toBe(letter.id);
    expect(payload.letter.payload?.items[0]?.topic).toBe("release-notes-style");
  });

  test("an unknown id is a typed usage error, not a silent no-op", async () => {
    const r = await run(["show", "extract-signals-0123456789ab"]);
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("extract-signals-0123456789ab");
  });

  test("a missing id argument is a usage error", async () => {
    const r = await run(["show"]);
    expect(r.returncode).toBe(2);
  });

  test("a malformed id reads as unknown too - nothing was ever written under it", async () => {
    const r = await run(["show", "garbage"]);
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("no dead letter with id");
  });
});

describe("a letter the store refuses to parse is exit 1, never unknown-id", () => {
  // A letter whose bytes this build cannot read is a hard error by the
  // store's own contract (`dead-letter.ts`: reading refuses rather than
  // skips) - a surface that turned it into "no dead letter with id" would
  // under-report the exact failure the store exists to prevent.
  const CORRUPT_ID = "extract-signals-001122334455";
  const UNKNOWN_VERSION_ID = "extract-signals-ff0011223344";

  function writeCorruptLetter(): void {
    mkdirSync(deadLetterDir(vault), { recursive: true });
    writeFileSync(deadLetterPath(vault, CORRUPT_ID), "{ not json");
  }

  function writeUnknownVersionLetter(): void {
    mkdirSync(deadLetterDir(vault), { recursive: true });
    writeFileSync(
      deadLetterPath(vault, UNKNOWN_VERSION_ID),
      `${JSON.stringify(
        {
          schema_version: 99,
          id: UNKNOWN_VERSION_ID,
          lane: "extract-signals",
          step: "extract-signals",
          reference: SESSION,
          target: "Brain/inbox",
          attempted: 1,
          found: 0,
          missing: ["items[0]:x"],
          outcome: "partial",
          first_error: "disk full",
          recorded_at: "2026-08-23T10:15:00Z",
        },
        null,
        2,
      )}\n`,
    );
  }

  test("show names the store's corrupt-JSON error at exit 1", async () => {
    writeCorruptLetter();
    const r = await run(["show", CORRUPT_ID]);
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("corrupt");
    expect(r.stderr).not.toContain("no dead letter with id");
  });

  test("show --json refuses typed at exit 1", async () => {
    writeCorruptLetter();
    const r = await run(["show", CORRUPT_ID, "--json"]);
    expect(r.returncode).toBe(1);
    const payload = JSON.parse(r.stdout) as { ok: boolean; message: string };
    expect(payload.ok).toBe(false);
    expect(payload.message).toContain("corrupt");
  });

  test("list names the store's refusal at exit 1 instead of crashing", async () => {
    writeCorruptLetter();
    const r = await run([]);
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("corrupt");
    // A typed refusal, never an uncaught stack: the listing under-reports
    // nothing and the operator gets the same sentence show gives. The
    // frame shape is matched, not the substring "at " - a refusal
    // sentence that happens to contain " at " is not a stack trace.
    expect(r.stderr).not.toMatch(/^\s+at\s/m);
  });

  test("list --json refuses typed at exit 1", async () => {
    writeUnknownVersionLetter();
    const r = await run(["--json"]);
    expect(r.returncode).toBe(1);
    const payload = JSON.parse(r.stdout) as { ok: boolean; message: string };
    expect(payload.ok).toBe(false);
    expect(payload.message).toContain("schema_version");
    expect(payload.message).toContain("parses 1 and 2");
  });

  test("show names an unsupported schema_version at exit 1", async () => {
    writeUnknownVersionLetter();
    const r = await run(["show", UNKNOWN_VERSION_ID]);
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("schema_version");
    expect(r.stderr).not.toContain("no dead letter with id");
  });

  test("recover names the store's refusal at exit 1 and writes nothing", async () => {
    writeCorruptLetter();
    const r = await run(["recover", CORRUPT_ID, "--apply", "--yes"]);
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("corrupt");
    expect(existsSync(join(vault, "Brain", "inbox"))).toBe(false);
  });
});

describe("dead-letters recover", () => {
  test("dry-run is the default and previews the per-item verdicts, writing nothing", async () => {
    commitExtractedSignals(vault, SESSION, { items: [item()] }, { agent: AGENT, now: NOW });
    const letter = v2Letter(
      [item(), item({ topic: "module-names" })],
      ["items[0]:release-notes-style", "items[1]:module-names"],
    );
    const r = await run(["recover", letter.id]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("dry-run");
    expect(r.stdout).toContain("release-notes-style");
    expect(r.stdout).toContain("module-names");
    expect(r.stdout).toMatch(/dedup|already on disk/);
    expect(r.stdout).toContain("--apply");
    // Nothing was written.
    expect(listDeadLetters(vault).length).toBe(1);
    expect(r.stdout).not.toContain("wrote");
  });

  test("recover --json dry-run labels the mode and lists the verdicts", async () => {
    const letter = v2Letter([item()], ["items[0]:release-notes-style"]);
    const r = await run(["recover", letter.id, "--json"]);
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      ok: boolean;
      id: string;
      mode: string;
      items: Array<{ topic: string; verdict: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.id).toBe(letter.id);
    expect(payload.mode).toBe("dry-run");
    expect(payload.items).toEqual([{ topic: "release-notes-style", verdict: "write" }]);
  });

  test("--apply without --yes under --json refuses typed and writes nothing", async () => {
    const letter = v2Letter([item()], ["items[0]:release-notes-style"]);
    const r = await run(["recover", letter.id, "--apply", "--json"]);
    expect(r.returncode).toBe(1);
    const payload = JSON.parse(r.stdout) as { ok: boolean; message: string };
    expect(payload.ok).toBe(false);
    expect(payload.message).toContain("--yes");
    expect(listDeadLetters(vault).length).toBe(1);
  });

  test("--apply without --yes in plain non-TTY mode refuses too", async () => {
    const letter = v2Letter([item()], ["items[0]:release-notes-style"]);
    const r = await run(["recover", letter.id, "--apply"]);
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("--yes");
  });

  test("--dry-run and --apply together refuse as a usage error and write nothing", async () => {
    const letter = v2Letter([item()], ["items[0]:release-notes-style"]);
    const r = await run(["recover", letter.id, "--dry-run", "--apply", "--yes"]);
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("--dry-run");
    expect(r.stderr).toContain("--apply");
    // The refusal precedes every write: the letter's item never reached
    // the inbox, and no new letter was recorded either.
    expect(existsSync(join(vault, "Brain", "inbox"))).toBe(false);
    expect(listDeadLetters(vault).length).toBe(1);
  });

  test("--apply --yes re-runs the payload; already-written items dedup away", async () => {
    commitExtractedSignals(vault, SESSION, { items: [item()] }, { agent: AGENT, now: NOW });
    const letter = v2Letter(
      [item(), item({ topic: "module-names" })],
      ["items[0]:release-notes-style", "items[1]:module-names"],
    );
    const r = await run(["recover", letter.id, "--apply", "--yes", "--json"]);
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      ok: boolean;
      mode: string;
      written: Array<{ topic: string }>;
      deduped: number;
      letter_retained: boolean;
    };
    expect(payload.ok).toBe(true);
    expect(payload.mode).toBe("apply");
    expect(payload.written.map((w) => w.topic)).toEqual(["module-names"]);
    expect(payload.deduped).toBe(1);
    expect(payload.letter_retained).toBe(true);
  });

  test("nothing ever deletes the letter, and the verb says the removal is by hand", async () => {
    const letter = v2Letter([item()], ["items[0]:release-notes-style"]);
    const r = await run(["recover", letter.id, "--apply", "--yes"]);
    expect(r.returncode).toBe(0);
    const after = listDeadLetters(vault);
    expect(after.length).toBe(1);
    expect(readFileSync(deadLetterPath(vault, letter.id), "utf8")).toContain(letter.id);
    expect(r.stdout).toContain("retained");
    expect(deadLetterDir(vault)).toBeTruthy();
  });

  test("recover refuses a letter that is not recoverable, naming the category", async () => {
    // A letter for a session the ledger does not know.
    const letter = recordDeadLetter(vault, {
      envelope: { ...ENVELOPE, reference: "sess-nowhere" },
      report: buildReconciliationReport({ attempted: 1, found: 0, missing: ["items[0]:x"] }),
      firstError: "disk full",
      now: NOW,
      payload: { items: [item({ topic: "x" })] },
    });
    const r = await run(["recover", letter.id, "--apply", "--yes", "--json"]);
    expect(r.returncode).toBe(1);
    const payload = JSON.parse(r.stdout) as { ok: boolean; message: string };
    expect(payload.ok).toBe(false);
    expect(payload.message).toContain("not_recoverable");
  });

  test("a frozen vault refuses the apply and points at unfreeze", async () => {
    const letter = v2Letter([item()], ["items[0]:release-notes-style"]);
    freezeVault(vault, { agent: "@operator", reason: "migrating the fleet" });
    resetFreezeMarkerCache();
    resetVaultIdentityPins();
    const r = await run(["recover", letter.id, "--apply", "--yes", "--json"]);
    expect(r.returncode).toBe(1);
    const payload = JSON.parse(r.stdout) as { ok: boolean; message: string };
    expect(payload.ok).toBe(false);
    expect(payload.message).toContain("frozen");
    expect(payload.message).toContain("o2b brain unfreeze");
    // The letter's items were not written.
    expect(listDeadLetters(vault).length).toBe(1);
  });

  test("an unknown id is a typed usage error", async () => {
    const r = await run(["recover", "extract-signals-0123456789ab"]);
    expect(r.returncode).toBe(2);
  });

  test("a missing id argument is a usage error", async () => {
    const r = await run(["recover"]);
    expect(r.returncode).toBe(2);
  });
});

describe("the dry-run verdict rendering", () => {
  test("every known verdict renders its own words; an unknown one refuses by name", () => {
    // Enumerated against the vocabulary constant: a verdict joining
    // DEAD_LETTER_ITEM_VERDICT must be given its own words here, never
    // silently rendered as another verdict's - "quarantined" reading as
    // "refused" would tell the operator the wrong thing.
    expect(verdictText(DEAD_LETTER_ITEM_VERDICT.write)).toBe("will write");
    expect(verdictText(DEAD_LETTER_ITEM_VERDICT.staged)).toBe("will stage for approval");
    expect(verdictText(DEAD_LETTER_ITEM_VERDICT.dedup)).toBe("already on disk (dedup)");
    expect(verdictText(DEAD_LETTER_ITEM_VERDICT.refused)).toBe("refused");
    expect(() => verdictText("quarantined")).toThrow(/quarantined/);
  });
});

describe("wiring", () => {
  test("an unknown subcommand is a usage error naming the three forms", async () => {
    const r = await run(["frobnicate"]);
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("list");
    expect(r.stderr).toContain("show");
    expect(r.stderr).toContain("recover");
  });

  test("--help prints the verb's own usage", async () => {
    const r = await runCli(["brain", "dead-letters", "--help"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout.startsWith("usage:")).toBe(true);
    expect(r.stdout).toContain("o2b brain dead-letters");
  });

  test("the manifest carries the verb, so the derived help surfaces list it", async () => {
    const help = await runCli(["help"], { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } });
    expect(help.returncode).toBe(0);
    expect(help.stdout).toContain("dead-letters");
  });

  test("the write error's diagnostic entry resolves to the verb", () => {
    const step = resolveNextStep("extract-signals-dead-letter");
    expect(step).not.toBeNull();
    expect(step?.nextCommand).toBe("o2b brain dead-letters");
  });
});
