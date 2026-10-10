/**
 * The note-lane owner-frontmatter guard (write-side-trust, Task 13).
 *
 * `owner` joins the refused update-frontmatter keys under the
 * owner-write gate: a caller-named `owner:` on a note is the same claim
 * a caller-named `owner:` on a preference is, and one lane refusing it
 * while the other honoured it would be an isolation boundary with a
 * door in it. The gate is the Task 8 predicate; the lane files stay
 * thin - they resolve the identity, the mode and the document, and the
 * predicate decides.
 *
 * The two states that must never blur:
 *
 *   - gate `off` (the default vault): not one byte of behavior moves.
 *     A note update or create naming any owner writes exactly as it
 *     did before this wave, and no ledger row appears.
 *   - gate `fail`: a caller-named owner that disagrees with the
 *     resolved identity refuses as `owner-write-refused` BEFORE any
 *     byte - and, because the guard runs ahead of every existence
 *     check, the refusal says nothing about whether the target
 *     existed. A caller probing foreign owners learns only that the
 *     claim was refused, never which paths are real.
 *
 * `warn` sits between: the write passes and exactly one decision-ledger
 * row lands per allowed write, so the operator can watch what `fail`
 * would refuse before tightening the gate.
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNote, CreateNoteError } from "../../../src/core/brain/notes/create-note.ts";
import { applyWriteBatch, WriteBatchError } from "../../../src/core/brain/write-batch.ts";
import { brainConfigPath } from "../../../src/core/brain/paths.ts";
import { queryDecisionLedger } from "../../../src/core/brain/permissions/ledger.ts";
import { resetVaultIdentityPins } from "../../../src/core/brain/vault-identity.ts";
import type { FrontmatterMap } from "../../../src/core/types.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { GATE_MODE } from "../../../src/core/integrity/stamp.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

/** The identity the vault's config resolves to, i.e. the writer. */
const SELF = "agent-self";
/** The foreign token a probe names - the marker of a cross-owner claim. */
const CROSS_OWNER_MARKER = "agent-cross-owner";

/** Env this file owns, pinned per test file by convention. */
const OWNED_ENV = ["HOME", "VAULT_AGENT_NAME", "VAULT_DIR", "OPEN_SECOND_BRAIN_CONFIG"] as const;

let tmp: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-owner-write-notes-"));
  for (const key of OWNED_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env["HOME"] = join(tmp, "home");
  mkdirSync(process.env["HOME"]!, { recursive: true });
  resetVaultIdentityPins();
});

afterEach(() => {
  resetVaultIdentityPins();
  rmSync(tmp, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/**
 * A bare vault whose config names {@link SELF}. `writesGate` lands in the
 * `integrity:` block; absent, the vault has never opted in and every gate
 * resolves off - the two-state probe's second state.
 */
function makeVault(name: string, writesGate?: string): string {
  const vault = join(tmp, name);
  for (const sub of ["preferences", "retired", "inbox", "log"]) {
    mkdirSync(join(vault, "Brain", sub), { recursive: true });
  }
  atomicWriteFileSync(
    brainConfigPath(vault),
    `schema_version: 1\n${
      writesGate === undefined ? "" : `integrity:\n  owner_scope_writes: ${writesGate}\n`
    }`,
  );
  const configPath = join(tmp, `${name}-config.yaml`);
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: ${SELF}\n`);
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  return vault;
}

function createOp(
  path: string,
  frontmatter?: FrontmatterMap,
): {
  kind: "create_note";
  path: string;
  frontmatter?: FrontmatterMap;
  content: string;
} {
  return {
    kind: "create_note",
    path,
    ...(frontmatter === undefined ? {} : { frontmatter }),
    content: `body of ${path}\n`,
  };
}

function updateOp(
  path: string,
  frontmatter?: FrontmatterMap,
): {
  kind: "update_note";
  path: string;
  frontmatter?: FrontmatterMap;
} {
  return {
    kind: "update_note",
    path,
    ...(frontmatter === undefined ? {} : { frontmatter }),
  };
}

/** The `owner:` a note file carries on disk, or null. */
function ownerOf(vault: string, relPath: string): string | null {
  const text = readFileSync(join(vault, relPath), "utf8");
  const match = /^owner:\s*(\S+)\s*$/m.exec(text);
  return match === null ? null : match[1]!;
}

/** Ledger rows the gate could have written. */
function gateRows(vault: string): ReturnType<typeof queryDecisionLedger> {
  return queryDecisionLedger(vault, { action: "owner_write" });
}

/**
 * The two-state probe, update arm: a page confronted with an update that
 * names a foreign owner, under each gate mode.
 */
describe("two-state probe: an update naming a foreign owner", () => {
  test("is refused under fail, leaving the page byte-untouched", () => {
    const vault = makeVault("probe-fail", GATE_MODE.fail);
    applyWriteBatch(vault, [createOp("notes/probe.md")], {
      configPath: process.env["OPEN_SECOND_BRAIN_CONFIG"],
    });
    const before = readFileSync(join(vault, "notes/probe.md"), "utf8");

    let caught: unknown;
    try {
      applyWriteBatch(vault, [updateOp("notes/probe.md", { owner: CROSS_OWNER_MARKER })], {
        configPath: process.env["OPEN_SECOND_BRAIN_CONFIG"],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WriteBatchError);
    const err = caught as WriteBatchError;
    expect(err.code).toBe("owner_write_refused");
    expect(err.message).toContain("owner-write-refused");
    expect(err.message).toContain(CROSS_OWNER_MARKER);
    expect(err.message).toContain(SELF);
    expect(readFileSync(join(vault, "notes/probe.md"), "utf8")).toBe(before);
    expect(gateRows(vault)).toEqual([]);
  });

  test("is writable under warn with exactly one ledger row", () => {
    const vault = makeVault("probe-warn", GATE_MODE.warn);
    applyWriteBatch(vault, [createOp("notes/probe.md")], {
      configPath: process.env["OPEN_SECOND_BRAIN_CONFIG"],
    });

    const result = applyWriteBatch(
      vault,
      [updateOp("notes/probe.md", { owner: CROSS_OWNER_MARKER })],
      { configPath: process.env["OPEN_SECOND_BRAIN_CONFIG"] },
    );
    expect(result.applied).toBe(1);
    expect(ownerOf(vault, "notes/probe.md")).toBe(CROSS_OWNER_MARKER);

    const rows = gateRows(vault);
    expect(rows.length).toBe(1);
    expect(rows[0]!.source).toBe("integrity.owner_scope_writes");
    expect(rows[0]!.verdict).toBe(GATE_MODE.warn);
    expect(rows[0]!.actor).toBe(SELF);
    expect(rows[0]!.target).toBe("notes/probe.md");
    expect(rows[0]!.reason).toContain(CROSS_OWNER_MARKER);
  });

  test("a byte-identical re-apply under warn leaves the one row it already wrote", () => {
    // The skipped rewrite is a write that did not happen, so it owes no
    // warn row: the ledger counts watched WRITES, not watched attempts.
    const vault = makeVault("probe-warn-skip", GATE_MODE.warn);
    const opts = { configPath: process.env["OPEN_SECOND_BRAIN_CONFIG"] };
    applyWriteBatch(vault, [createOp("notes/probe.md")], opts);
    applyWriteBatch(vault, [updateOp("notes/probe.md", { owner: CROSS_OWNER_MARKER })], opts);
    expect(gateRows(vault).length).toBe(1);

    const again = applyWriteBatch(
      vault,
      [updateOp("notes/probe.md", { owner: CROSS_OWNER_MARKER })],
      opts,
    );
    expect(again.applied).toBe(1);
    expect(ownerOf(vault, "notes/probe.md")).toBe(CROSS_OWNER_MARKER);
    expect(gateRows(vault).length).toBe(1);
  });

  test("leaves every legacy byte in place under off: written as named, no row", () => {
    const vault = makeVault("probe-off");
    applyWriteBatch(vault, [createOp("notes/probe.md")], {
      configPath: process.env["OPEN_SECOND_BRAIN_CONFIG"],
    });

    const result = applyWriteBatch(
      vault,
      [updateOp("notes/probe.md", { owner: CROSS_OWNER_MARKER })],
      { configPath: process.env["OPEN_SECOND_BRAIN_CONFIG"] },
    );
    expect(result.applied).toBe(1);
    expect(ownerOf(vault, "notes/probe.md")).toBe(CROSS_OWNER_MARKER);
    expect(gateRows(vault)).toEqual([]);
  });
});

/**
 * The two-state probe, create arm: a create that carries the marker in
 * its frontmatter. Under fail the refusal comes before any byte - and
 * before any existence check, so it cannot answer the question "does
 * this path exist" for a probing caller.
 */
describe("two-state probe: a create carrying a foreign owner", () => {
  test("refuses under fail before any byte, at an occupied target too", () => {
    const vault = makeVault("create-fail", GATE_MODE.fail);
    applyWriteBatch(vault, [createOp("notes/occupied.md")], {
      configPath: process.env["OPEN_SECOND_BRAIN_CONFIG"],
    });

    for (const path of ["notes/fresh.md", "notes/occupied.md"]) {
      let caught: unknown;
      try {
        createNote(vault, {
          path,
          frontmatter: { owner: CROSS_OWNER_MARKER },
          content: "claimed\n",
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(CreateNoteError);
      const err = caught as CreateNoteError;
      expect(err.code).toBe("owner_write_refused");
      expect(err.message).toContain("owner-write-refused");
      expect(existsSync(join(vault, path))).toBe(path === "notes/occupied.md");
    }
    expect(gateRows(vault)).toEqual([]);
  });

  test("is writable under warn with exactly one ledger row per allowed write", () => {
    const vault = makeVault("create-warn", GATE_MODE.warn);
    const result = createNote(vault, {
      path: "notes/claimed.md",
      frontmatter: { owner: CROSS_OWNER_MARKER },
      content: "claimed\n",
    });
    expect(result.outcome).toBe("created");
    expect(ownerOf(vault, "notes/claimed.md")).toBe(CROSS_OWNER_MARKER);
    expect(gateRows(vault).length).toBe(1);
  });

  test("writes as named under off, with no ledger row", () => {
    const vault = makeVault("create-off");
    const result = createNote(vault, {
      path: "notes/claimed.md",
      frontmatter: { owner: CROSS_OWNER_MARKER },
      content: "claimed\n",
    });
    expect(result.outcome).toBe("created");
    expect(ownerOf(vault, "notes/claimed.md")).toBe(CROSS_OWNER_MARKER);
    expect(gateRows(vault)).toEqual([]);
  });
});

describe("matching-identity and unnamed owners always pass", () => {
  test("a create naming the caller's own owner writes under fail", () => {
    const vault = makeVault("create-own", GATE_MODE.fail);
    createNote(vault, {
      path: "notes/own.md",
      frontmatter: { owner: SELF },
      content: "own\n",
    });
    expect(ownerOf(vault, "notes/own.md")).toBe(SELF);
  });

  test("an update naming the caller's own owner passes under fail", () => {
    const vault = makeVault("update-own", GATE_MODE.fail);
    applyWriteBatch(vault, [createOp("notes/own.md")], {
      configPath: process.env["OPEN_SECOND_BRAIN_CONFIG"],
    });
    const result = applyWriteBatch(vault, [updateOp("notes/own.md", { owner: SELF })], {
      configPath: process.env["OPEN_SECOND_BRAIN_CONFIG"],
    });
    expect(result.applied).toBe(1);
    expect(ownerOf(vault, "notes/own.md")).toBe(SELF);
  });

  test("an update of a foreign-OWNED page that names no owner still passes under fail", () => {
    // The gate refuses the claim a caller MAKES; it does not fence
    // pages. A page that already carries a foreign owner (stamped here
    // by hand, the way a synced vault would have arrived at it) stays
    // editable without naming an owner - the carry-forward merge keeps
    // the existing owner on disk, so the gate adds a refusal, never a
    // re-own.
    const vault = makeVault("carry", GATE_MODE.fail);
    applyWriteBatch(vault, [createOp("notes/carried.md")], {
      configPath: process.env["OPEN_SECOND_BRAIN_CONFIG"],
    });
    // Stamp the foreign owner by hand, the way a page that predates the
    // gate (or arrived through a sync) would carry it.
    const page = join(vault, "notes/carried.md");
    atomicWriteFileSync(page, "---\nowner: " + CROSS_OWNER_MARKER + "\n---\n\noriginal body\n");
    expect(ownerOf(vault, "notes/carried.md")).toBe(CROSS_OWNER_MARKER);

    const result = applyWriteBatch(vault, [updateOp("notes/carried.md", { body: "rewritten\n" })], {
      configPath: process.env["OPEN_SECOND_BRAIN_CONFIG"],
    });
    expect(result.applied).toBe(1);
    expect(ownerOf(vault, "notes/carried.md")).toBe(CROSS_OWNER_MARKER);
  });
});

describe("the batch kernel", () => {
  test("a create op naming a foreign owner aborts the whole batch before any commit", () => {
    const vault = makeVault("batch-abort", GATE_MODE.fail);
    let caught: unknown;
    try {
      applyWriteBatch(
        vault,
        [createOp("notes/first.md"), createOp("notes/claimed.md", { owner: CROSS_OWNER_MARKER })],
        { configPath: process.env["OPEN_SECOND_BRAIN_CONFIG"] },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WriteBatchError);
    const err = caught as WriteBatchError;
    expect(err.code).toBe("owner_write_refused");
    expect(err.index).toBe(1);
    expect(existsSync(join(vault, "notes/first.md"))).toBe(false);
  });

  test("an update op naming a foreign owner refuses with the operation index", () => {
    const vault = makeVault("batch-update", GATE_MODE.fail);
    applyWriteBatch(vault, [createOp("notes/probe.md")], {
      configPath: process.env["OPEN_SECOND_BRAIN_CONFIG"],
    });
    let caught: unknown;
    try {
      applyWriteBatch(vault, [updateOp("notes/probe.md", { owner: CROSS_OWNER_MARKER })], {
        configPath: process.env["OPEN_SECOND_BRAIN_CONFIG"],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WriteBatchError);
    expect((caught as WriteBatchError).index).toBe(0);
  });
});

describe("the refusal never answers the existence question", () => {
  test("an update naming a foreign owner refuses identically on a missing target", () => {
    const vault = makeVault("no-leak", GATE_MODE.fail);
    let caught: unknown;
    try {
      applyWriteBatch(vault, [updateOp("notes/absent.md", { owner: CROSS_OWNER_MARKER })], {
        configPath: process.env["OPEN_SECOND_BRAIN_CONFIG"],
      });
    } catch (err) {
      caught = err;
    }
    // `target_missing` is the answer an update to a missing note gets
    // for every other reason; the owner gate runs AHEAD of the read, so
    // a probing caller cannot distinguish the two states by error code.
    expect(caught).toBeInstanceOf(WriteBatchError);
    const err = caught as WriteBatchError;
    expect(err.code).toBe("owner_write_refused");
    expect(err.code).not.toBe("target_missing");
  });
});

describe("the document composes with the note lane", () => {
  test("a document denying owner_write refuses a note create naming any owner, gate off", () => {
    const vault = makeVault("doc-deny");
    atomicWriteFileSync(
      join(vault, "Brain", "_permissions.yaml"),
      "version: 1\ndefault_action: deny\n",
    );
    let caught: unknown;
    try {
      createNote(vault, {
        path: "notes/denied.md",
        frontmatter: { owner: SELF },
        content: "denied\n",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CreateNoteError);
    expect((caught as CreateNoteError).code).toBe("owner_write_refused");
    expect(existsSync(join(vault, "notes/denied.md"))).toBe(false);
  });
});
