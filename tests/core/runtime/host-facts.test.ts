/**
 * What the machine already has, asserted rather than assumed.
 *
 * `RUNTIME_FACTS` is a declaration file: nine rows of things this build
 * claims to know about the runtimes it installs into. A declaration that
 * nothing checks is a comment, so this file checks the three properties
 * the rows are read for.
 *
 * 1. `unknown` is not `unbounded`. A row whose ceiling was never checked
 *    carries a reason and can never be read as "no limit" - that collapse
 *    is the fail-open profile selection the whole unit exists to prevent.
 * 2. Every cross-reference resolves: a declared tool profile is a real
 *    `TOOL_SURFACE_PROFILES` key, a declared session adapter is a real
 *    `SESSION_ADAPTER_ID` member. Both are held by a test rather than by
 *    the type system on purpose - the module is a LEAF, and importing the
 *    MCP profile table into it would close the cycle the architecture
 *    ratchet gates.
 * 3. Root derivation is pure. The roots are functions of an injected home
 *    and an injected environment map, exactly as `InstallEnv` already is,
 *    so a caller can ask where opencode's spool would be on a machine
 *    that is not this one. A `homedir()` call inside the module would
 *    make that unanswerable, so the last block reads the source and
 *    refuses it by name.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isSessionAdapterId, SESSION_ADAPTER_ID } from "../../../src/core/brain/sessions/types.ts";
import {
  INSTALL_TARGET_ID,
  INSTALL_TARGET_IDS,
  isInstallTargetId,
  isToolCeilingKind,
  resolveSessionRoots,
  runtimeFactsFor,
  RUNTIME_FACTS,
  TOOL_CEILING_KIND,
  TOOL_CEILING_KINDS,
  type HostContext,
  type RuntimeFacts,
} from "../../../src/core/runtime/host-facts.ts";
import { TOOL_SURFACE_PROFILES } from "../../../src/mcp/profiles.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const MODULE_PATH = join(REPO_ROOT, "src", "core", "runtime", "host-facts.ts");

/** Strings shaped like plausible drift, not like obvious garbage. */
const NON_MEMBERS: ReadonlyArray<unknown> = Object.freeze([
  "",
  " ",
  "Cursor",
  "copilot",
  "Codex",
  null,
  undefined,
  42,
  {},
]);

/** Two unrelated hosts, so a derivation that ignores its input is visible. */
const ONE: HostContext = Object.freeze({
  home: "/home/one",
  env: Object.freeze({}),
});
const TWO: HostContext = Object.freeze({
  home: "/home/two",
  env: Object.freeze({
    GROK_HOME: "/home/two/grok-elsewhere",
    XDG_DATA_HOME: "/home/two/xdg-data",
  }),
});

const ROWS = Object.values(RUNTIME_FACTS);

/**
 * The bar a citation clears, taken from the sibling census in
 * `tests/core/architecture/state-surface-census.test.ts`.
 *
 * Every check below used to be `.trim() !== ""`, which `reason: "TODO"`
 * and `source: "for now"` both pass. That is not a pedantic gap here: the
 * `unknown` reason is the field the fail-open prevention rests on - it is
 * what `second_brain_capabilities` repeats to say WHY no profile was
 * selected - and a placeholder in it reaches the operator as the silence
 * this whole file exists to end.
 */
const MIN_CITATION_LENGTH = 80;
const LAZY_CITATION = /\bTODO\b|\bTBD\b|\bfor now\b|\blater\b|\bn\/a\b/i;

/** Why `text` is not a citation, or `null` when it is one. */
function citationDefect(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length < MIN_CITATION_LENGTH) {
    return `${trimmed.length} chars, under the ${MIN_CITATION_LENGTH} a citation needs`;
  }
  if (LAZY_CITATION.test(trimmed)) return "a placeholder, not an argument";
  return null;
}

describe("the install-target vocabulary", () => {
  test("the guard accepts every declared member", () => {
    const rejected = INSTALL_TARGET_IDS.filter((id) => !isInstallTargetId(id));
    expect(rejected.join(",")).toBe("");
  });

  test("the guard rejects non-members and non-strings", () => {
    const accepted = NON_MEMBERS.filter((value) => isInstallTargetId(value)).map((value) =>
      JSON.stringify(value),
    );
    expect(accepted.join(",")).toBe("");
  });

  test("the members list and the values object agree", () => {
    expect([...INSTALL_TARGET_IDS].toSorted()).toEqual(Object.values(INSTALL_TARGET_ID).toSorted());
  });

  test("codex is a member now that its adapter ships", () => {
    // The vocabulary is what `--target` is validated against, so a member
    // is only allowed to exist once the registry can find an adapter for
    // it - `tests/core/architecture/host-facts-census.test.ts` holds the
    // two populations equal. Codex was the standing example of the rule
    // while it had no adapter; it is now the example of the rule met.
    expect(isInstallTargetId("codex")).toBe(true);
    expect(runtimeFactsFor(INSTALL_TARGET_ID.codex).sessionAdapter).toBe(SESSION_ADAPTER_ID.codex);
  });
});

describe("the tool-ceiling vocabulary", () => {
  test("it has exactly three members", () => {
    expect([...TOOL_CEILING_KINDS].toSorted()).toEqual(["declared", "unbounded", "unknown"]);
  });

  test("the guard accepts every member and rejects everything else", () => {
    const wrong = [
      ...TOOL_CEILING_KINDS.filter((kind) => !isToolCeilingKind(kind)),
      ...NON_MEMBERS.filter((value) => isToolCeilingKind(value)).map((value) =>
        JSON.stringify(value),
      ),
    ];
    expect(wrong.join(",")).toBe("");
  });

  test("an unknown ceiling carries a reason and nothing that reads as a limit", () => {
    const silent: string[] = [];
    for (const row of ROWS) {
      if (row.toolCeiling.kind !== TOOL_CEILING_KIND.unknown) continue;
      const defect = citationDefect(row.toolCeiling.reason);
      if (defect !== null) silent.push(`${row.target}: ${defect}`);
      if ("maxTools" in row.toolCeiling) silent.push(`${row.target} carries maxTools`);
    }
    expect(silent.join("\n")).toBe("");
  });

  test("a declared ceiling carries a positive integer and cites where it is published", () => {
    const defects: string[] = [];
    for (const row of ROWS) {
      if (row.toolCeiling.kind !== TOOL_CEILING_KIND.declared) continue;
      const { maxTools, source } = row.toolCeiling;
      if (!Number.isSafeInteger(maxTools) || maxTools <= 0) {
        defects.push(`${row.target}: maxTools ${maxTools}`);
      }
      const defect = citationDefect(source);
      if (defect !== null) defects.push(`${row.target}: source is ${defect}`);
    }
    expect(defects.join("\n")).toBe("");
  });

  test("no row ships an unbounded ceiling today, and that is on purpose", () => {
    // Stated as an equality rather than left implicit. The filter in the
    // case below is empty over the live population, so without this line
    // that case reads as coverage when it is really a guard held in
    // reserve. The day a host publishes "no limit", this assertion is what
    // fails first and sends the author to the one below.
    const unbounded = ROWS.filter(
      (row) => row.toolCeiling.kind === TOOL_CEILING_KIND.unbounded,
    ).map((row) => row.target);
    expect(unbounded.join(",")).toBe("");
  });

  test("an unbounded ceiling cites where the absence of a limit is published", () => {
    // Run against a SYNTHETIC row, because no live row uses the member.
    // The predicate is the same one applied to the live population, so
    // the guard is proven to bite before it has anything to bite on -
    // otherwise the first host to declare `unbounded` would be checked by
    // an assertion nobody had ever seen fail.
    const sourceless = (rows: ReadonlyArray<RuntimeFacts>): ReadonlyArray<string> =>
      rows
        .filter(
          (row) =>
            row.toolCeiling.kind === TOOL_CEILING_KIND.unbounded &&
            citationDefect(row.toolCeiling.source) !== null,
        )
        .map((row) => row.target);

    const base = runtimeFactsFor(INSTALL_TARGET_ID.kiro);
    const silent: RuntimeFacts = {
      ...base,
      toolCeiling: { kind: TOOL_CEILING_KIND.unbounded, source: "  " },
    };
    // Long enough to be a citation but still a placeholder: the length
    // floor alone would let this one through.
    const lazy: RuntimeFacts = {
      ...base,
      toolCeiling: {
        kind: TOOL_CEILING_KIND.unbounded,
        source:
          "no limit is documented anywhere this build could find, so treat the surface as " +
          "unbounded for now",
      },
    };
    const sourced: RuntimeFacts = {
      ...base,
      toolCeiling: {
        kind: TOOL_CEILING_KIND.unbounded,
        source:
          "the host's own MCP documentation states that it applies no per-workspace tool limit " +
          "and forwards every registered server's whole surface to the model",
      },
    };
    expect(sourceless([silent]).join(",")).toBe(base.target);
    expect(sourceless([lazy]).join(",")).toBe(base.target);
    expect(sourceless([sourced]).join(",")).toBe("");
    expect(sourceless(ROWS).join(",")).toBe("");
  });

  test("cursor carries the published 40-tool workspace limit", () => {
    const ceiling = runtimeFactsFor(INSTALL_TARGET_ID.cursor).toolCeiling;
    expect(ceiling.kind).toBe(TOOL_CEILING_KIND.declared);
    expect(ceiling.kind === TOOL_CEILING_KIND.declared ? ceiling.maxTools : 0).toBe(40);
  });
});

describe("every row's cross-references resolve", () => {
  test("a declared tool profile is a real TOOL_SURFACE_PROFILES key", () => {
    const dangling = ROWS.filter(
      (row) => row.toolProfile !== null && TOOL_SURFACE_PROFILES[row.toolProfile] === undefined,
    ).map((row) => `${row.target}: ${row.toolProfile}`);
    expect(dangling.join("\n")).toBe("");
  });

  test("a declared session adapter is a real SESSION_ADAPTER_ID member", () => {
    const dangling = ROWS.filter(
      (row) => row.sessionAdapter !== null && !isSessionAdapterId(row.sessionAdapter),
    ).map((row) => `${row.target}: ${row.sessionAdapter}`);
    expect(dangling.join("\n")).toBe("");
  });

  test("every row is keyed by its own target id", () => {
    const mismatched = Object.entries(RUNTIME_FACTS)
      .filter(([key, row]) => key !== row.target)
      .map(([key, row]) => `${key} -> ${row.target}`);
    expect(mismatched.join("\n")).toBe("");
  });

  test("every row carries a label", () => {
    expect(ROWS.filter((row) => row.label.trim() === "").map((row) => row.target)).toEqual([]);
  });

  test("cursor declares the catalog profile and no session adapter", () => {
    // Cursor's transcripts live in a `state.vscdb` SQLite file and no
    // session adapter reads that format, so the row says `null` rather
    // than naming an adapter that would fail on the first file.
    const cursor = runtimeFactsFor(INSTALL_TARGET_ID.cursor);
    expect(`${cursor.toolProfile} ${cursor.sessionAdapter}`).toBe("catalog null");
  });

  test("grok and opencode name the adapters that actually parse their logs", () => {
    expect(runtimeFactsFor(INSTALL_TARGET_ID.grok).sessionAdapter).toBe(SESSION_ADAPTER_ID.grok);
    expect(runtimeFactsFor(INSTALL_TARGET_ID.opencode).sessionAdapter).toBe(
      SESSION_ADAPTER_ID.opencode,
    );
  });
});

describe("session roots", () => {
  test("every root names a glob and the format its files are in", () => {
    const defects: string[] = [];
    for (const row of ROWS) {
      for (const root of row.sessionRoots) {
        if (root.id.trim() === "") defects.push(`${row.target}: a root with no id`);
        if (root.glob.trim() === "") defects.push(`${row.target}/${root.id}: no glob`);
        if (root.format.trim() === "") defects.push(`${row.target}/${root.id}: no format`);
        if (root.adapter !== null && !isSessionAdapterId(root.adapter)) {
          defects.push(`${row.target}/${root.id}: adapter ${root.adapter}`);
        }
      }
    }
    expect(defects.join("\n")).toBe("");
  });

  test("root ids are unique within a row", () => {
    const duplicated: string[] = [];
    for (const row of ROWS) {
      const seen = new Set<string>();
      for (const root of row.sessionRoots) {
        if (seen.has(root.id)) duplicated.push(`${row.target}: ${root.id}`);
        seen.add(root.id);
      }
    }
    expect(duplicated.join("\n")).toBe("");
  });

  test("a row with no session adapter and no non-adapter format declares no roots", () => {
    // aider, pi, copilot-cli, gemini-cli, kiro and generic store no
    // transcripts this build can name. An empty list is the stated answer;
    // a root pointing at a directory that never exists would make
    // discovery report a miss instead of an absence.
    //
    // DERIVED from the predicate the title states, not hand-listed. The
    // list was `[aider, pi, generic]` while the predicate held for twice
    // that many rows, so inventing a root for `kiro` changed nothing here
    // - the very drift this case is the guard against.
    const quiet = INSTALL_TARGET_IDS.filter(
      (target) =>
        runtimeFactsFor(target).sessionAdapter === null &&
        runtimeFactsFor(target).sessionRuntime === null,
    );
    // Both sides non-empty, or the filter is doing the asserting.
    expect(`quiet ${quiet.length > 0}, loud ${quiet.length < INSTALL_TARGET_IDS.length}`).toBe(
      "quiet true, loud true",
    );
    const noisy = quiet.filter(
      (target) =>
        runtimeFactsFor(target).sessionRoots.length > 0 ||
        resolveSessionRoots(target, ONE).length > 0,
    );
    expect(noisy.join(",")).toBe("");
  });

  test("derivation is a pure function of the injected home and environment", () => {
    const first = ROWS.map((row) => resolveSessionRoots(row.target, ONE));
    const again = ROWS.map((row) => resolveSessionRoots(row.target, ONE));
    expect(JSON.stringify(again)).toBe(JSON.stringify(first));
  });

  test("derivation does not read the real process environment", () => {
    const key = "GROK_HOME";
    const saved = process.env[key];
    process.env[key] = "/tmp/host-facts-must-not-read-this";
    try {
      const roots = resolveSessionRoots(INSTALL_TARGET_ID.grok, ONE);
      expect(roots.map((root) => root.path).join("\n")).not.toContain(
        "host-facts-must-not-read-this",
      );
    } finally {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  });

  test("a different home and environment give different roots", () => {
    const one = resolveSessionRoots(INSTALL_TARGET_ID.grok, ONE);
    const two = resolveSessionRoots(INSTALL_TARGET_ID.grok, TWO);
    expect(one.map((root) => root.path)).toEqual([join("/home/one", ".grok", "sessions")]);
    expect(two.map((root) => root.path)).toEqual([join("/home/two/grok-elsewhere", "sessions")]);
  });

  test("the opencode spool honours XDG_DATA_HOME and falls back to ~/.local/share", () => {
    expect(resolveSessionRoots(INSTALL_TARGET_ID.opencode, ONE).map((r) => r.path)).toEqual([
      join("/home/one", ".local", "share", "open-second-brain", "opencode"),
    ]);
    expect(resolveSessionRoots(INSTALL_TARGET_ID.opencode, TWO).map((r) => r.path)).toEqual([
      join("/home/two/xdg-data", "open-second-brain", "opencode"),
    ]);
  });

  test("the cursor roots are the three layouts the transcript scanner already probes", () => {
    expect(resolveSessionRoots(INSTALL_TARGET_ID.cursor, ONE).map((r) => r.path)).toEqual([
      join("/home/one", ".config", "Cursor", "User", "workspaceStorage"),
      join("/home/one", "Library", "Application Support", "Cursor", "User", "workspaceStorage"),
      join("/home/one", ".cursor", "workspaceStorage"),
    ]);
  });

  test("the codex roots are the four subdirectories the scanner walks, under CODEX_HOME", () => {
    // `src/core/discipline/transcripts/codex.ts` probes exactly these
    // four because the CLI has moved its transcripts between releases.
    expect(resolveSessionRoots(INSTALL_TARGET_ID.codex, ONE).map((r) => r.path)).toEqual([
      join("/home/one", ".codex", "sessions"),
      join("/home/one", ".codex", "session"),
      join("/home/one", ".codex", "history"),
      join("/home/one", ".codex", ".tmp"),
    ]);
    const relocated: HostContext = {
      home: "/home/two",
      env: { CODEX_HOME: "/home/two/codex-elsewhere" },
    };
    expect(resolveSessionRoots(INSTALL_TARGET_ID.codex, relocated).map((r) => r.path)).toEqual([
      join("/home/two/codex-elsewhere", "sessions"),
      join("/home/two/codex-elsewhere", "session"),
      join("/home/two/codex-elsewhere", "history"),
      join("/home/two/codex-elsewhere", ".tmp"),
    ]);
  });

  test("a resolved cursor root reports the SQLite format and no adapter", () => {
    const [first] = resolveSessionRoots(INSTALL_TARGET_ID.cursor, ONE);
    expect(`${first?.adapter} ${first?.format}`).toBe("null cursor-state-vscdb");
  });
});

describe("host probes", () => {
  test("a declared probe names a binary and an argv", () => {
    const defects: string[] = [];
    for (const row of ROWS) {
      const probe = row.hostProbe;
      if (probe === null) continue;
      if (probe.bin.trim() === "") defects.push(`${row.target}: no binary`);
      if (probe.argv.length === 0) defects.push(`${row.target}: empty argv`);
      // `answers` is what `--friction` prints as the probe's evidence
      // cell, so a placeholder there is a blank column on the operator's
      // screen rather than a missing string in a table.
      const defect = citationDefect(probe.answers);
      if (defect !== null) defects.push(`${row.target}: answers is ${defect}`);
    }
    expect(defects.join("\n")).toBe("");
  });

  test("copilot-cli declares the registration probe it already runs", () => {
    const probe = runtimeFactsFor(INSTALL_TARGET_ID.copilotCli).hostProbe;
    expect(`${probe?.bin} ${probe?.argv.join(" ")}`).toBe("copilot mcp list");
  });

  test("codex declares the plain-text registration probe, not the JSON one", () => {
    // The shared probe reads the first whitespace-delimited token of each
    // output line, which is the name column of `codex mcp list`. Under
    // `--json` that token is `"name":` on every host, so a JSON probe
    // would answer "nothing registered" everywhere.
    const probe = runtimeFactsFor(INSTALL_TARGET_ID.codex).hostProbe;
    expect(`${probe?.bin} ${probe?.argv.join(" ")}`).toBe("codex mcp list");
  });

  test("a target with no probe declares null rather than an empty command", () => {
    expect(runtimeFactsFor(INSTALL_TARGET_ID.cursor).hostProbe).toBeNull();
  });
});

describe("the module stays a leaf that reads nothing", () => {
  const source = readFileSync(MODULE_PATH, "utf8");

  test("it never resolves a home directory or an environment of its own", () => {
    // The whole point of taking `{home, env}`: the caller supplies them,
    // exactly as `InstallEnv` does, so the same row answers for a machine
    // that is not this one.
    const forbidden = ["homedir(", "process.env"].filter((token) => source.includes(token));
    expect(forbidden.join(",")).toBe("");
  });

  test("it imports nothing from the install subsystem", () => {
    // Importing it back from the install aggregator would close a cycle
    // `tests/core/architecture/import-cycles.test.ts` gates. Relative
    // specifiers only - that is the edge set that ratchet builds its
    // graph from.
    expect([...source.matchAll(/from\s+"(\.[^"]+)"/g)].map((m) => m[1]!)).toEqual([
      "../brain/sessions/types.ts",
    ]);
  });
});
