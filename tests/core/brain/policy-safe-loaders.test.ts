/**
 * The `load*ConfigSafe` readers and the ONE failure they are allowed to
 * absorb.
 *
 * `_brain.yaml` ABSENT is not an error: a vault that has never run
 * `o2b brain init` has no config, and the documented block defaults are
 * the correct answer. `_brain.yaml` PRESENT but unreadable is an error:
 * the operator wrote settings, those settings are not in force, and
 * serving the defaults instead makes a broken vault indistinguishable
 * from a healthy one - the exact degradation `loadIntegrityConfigSafe`
 * was already carved out to prevent, generalised here to the other five
 * readers.
 *
 * "Unreadable" is deliberately wider than "malformed YAML": a
 * structurally invalid block, a permission error and a directory where
 * the file should be are all a present config whose contents are not the
 * ones in force.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { regenerateActiveQuiet, renderActive } from "../../../src/core/brain/active.ts";
import { renderDigest } from "../../../src/core/brain/digest.ts";
import { resolveNoteRoots } from "../../../src/core/brain/notes/note-walk.ts";
import { brainConfigPath } from "../../../src/core/brain/paths.ts";
import {
  BRAIN_GUARDRAIL_DEFAULTS,
  BRAIN_MOST_APPLIED_DEFAULTS,
  BRAIN_NOTES_DEFAULTS,
  BRAIN_TEMPORAL_DEFAULTS,
  BrainConfigError,
  DEFAULT_BRAIN_CONFIG,
  loadActiveMostAppliedSafe,
  loadFeedbackDefaultScopeSafe,
  loadGuardrailsConfigSafe,
  loadIntegrityConfigSafe,
  loadNotesConfigSafe,
  loadSnapshotRetentionSafe,
  loadTemporalConfigSafe,
} from "../../../src/core/brain/policy.ts";

/**
 * Every reader that tolerates an uninitialised vault, paired with the
 * value that vault must keep producing. Driving them from one table is
 * what stops the next reader being added with a blanket catch - but only
 * together with the reverse census below, which enumerates the readers
 * from the module and fails when this list does not account for them.
 * The list alone could only ever prove things about readers somebody
 * remembered to add to it.
 */
const SAFE_LOADERS = [
  {
    name: "loadNotesConfigSafe",
    load: loadNotesConfigSafe as (vault: string) => unknown,
    absentValue: BRAIN_NOTES_DEFAULTS as unknown,
  },
  {
    name: "loadTemporalConfigSafe",
    load: loadTemporalConfigSafe as (vault: string) => unknown,
    absentValue: BRAIN_TEMPORAL_DEFAULTS as unknown,
  },
  {
    name: "loadGuardrailsConfigSafe",
    load: loadGuardrailsConfigSafe as (vault: string) => unknown,
    absentValue: BRAIN_GUARDRAIL_DEFAULTS as unknown,
  },
  {
    name: "loadFeedbackDefaultScopeSafe",
    load: loadFeedbackDefaultScopeSafe as (vault: string) => unknown,
    absentValue: undefined as unknown,
  },
  {
    name: "loadSnapshotRetentionSafe",
    load: loadSnapshotRetentionSafe as (vault: string) => unknown,
    absentValue: DEFAULT_BRAIN_CONFIG.snapshots.retention_count as unknown,
  },
  {
    name: "loadActiveMostAppliedSafe",
    load: loadActiveMostAppliedSafe as (vault: string) => unknown,
    absentValue: BRAIN_MOST_APPLIED_DEFAULTS as unknown,
  },
] as const;

// ----- Reverse census: the table must account for every reader ---------------

/**
 * A reader the table deliberately does not drive, with the reason. An
 * entry may only sit here because the module documents a DIFFERENT answer
 * to the same question - never because updating the table was awkward.
 */
const SAFE_LOADER_EXCLUSIONS: ReadonlyMap<string, string> = new Map([
  [
    "loadIntegrityConfigSafe",
    "resolves to BRAIN_INTEGRITY_STRICT_FALLBACK instead of raising, because the " +
      "search layer reads its gate on every store open inside a fail-soft path; " +
      "its own test below pins that asymmetry",
  ],
]);

const LOAD_SOURCE_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "src",
  "core",
  "brain",
  "policy",
  "load.ts",
);

/**
 * Every exported reader in `policy/load.ts`, read out of the SOURCE.
 *
 * The table above is hand-listed, so on its own it can only prove things
 * about readers somebody remembered to add to it - which is the one
 * property a ratchet must not have. Enumerating from the module and
 * asking the table to account for the result is what makes "a seventh
 * reader cannot join with a blanket catch" a checked claim. The doctor's
 * exit census reads its population off disk for the same reason.
 *
 * Two shapes declare a reader, and both are matched: the factory-built
 * `export const <name> = makeAbsentTolerantLoader(`, and a hand-written
 * `export function <name>(` for a reader that answers the split its own
 * way. The `*Safe` suffix is the module's naming convention for "reads
 * the config, tolerates a vault that has never run `brain init`" - a
 * reader that dropped the suffix would fall out of this census, which is
 * why the measured count is pinned below.
 */
const EXPORTED_SAFE_READER_RE = /^export (?:const|function) (load[A-Za-z0-9]*Safe)\b/gm;

function exportedSafeReaders(source: string): ReadonlyArray<string> {
  return [...source.matchAll(new RegExp(EXPORTED_SAFE_READER_RE))].map((m) => m[1]!).toSorted();
}

describe("the safe-loader table accounts for every reader in the module", () => {
  const declared = exportedSafeReaders(readFileSync(LOAD_SOURCE_PATH, "utf8"));

  test("the scan finds readers at all, so a clean sweep cannot be an empty set", () => {
    expect(declared.length).toBe(SAFE_LOADERS.length + SAFE_LOADER_EXCLUSIONS.size);
  });

  test("every declared reader is either driven by the table or excluded with a reason", () => {
    const driven: ReadonlySet<string> = new Set<string>(SAFE_LOADERS.map((l) => l.name));
    const unaccounted = declared.filter(
      (name) => !driven.has(name) && !SAFE_LOADER_EXCLUSIONS.has(name),
    );
    expect(unaccounted).toEqual([]);
  });

  test("nothing is both driven and excluded", () => {
    const driven: ReadonlySet<string> = new Set<string>(SAFE_LOADERS.map((l) => l.name));
    expect([...SAFE_LOADER_EXCLUSIONS.keys()].filter((name) => driven.has(name))).toEqual([]);
  });

  test("the table and the exclusions name only readers the module still declares", () => {
    const present = new Set(declared);
    const stale = [
      ...SAFE_LOADERS.map((l): string => l.name),
      ...SAFE_LOADER_EXCLUSIONS.keys(),
    ].filter((name) => !present.has(name));
    expect(stale).toEqual([]);
  });

  test("every exclusion carries a reason", () => {
    for (const [name, reason] of SAFE_LOADER_EXCLUSIONS) {
      expect(reason.trim().length, `${name} must say why it is excluded`).toBeGreaterThan(0);
    }
  });

  /**
   * The check is worth nothing if it cannot fail. Pointed at a source
   * carrying a reader neither the table nor the exclusions names, it must
   * report exactly that reader.
   */
  test("a reader the table does not list is reported", () => {
    const withEighthReader =
      readFileSync(LOAD_SOURCE_PATH, "utf8") +
      "\nexport const loadUnlistedThingSafe = makeAbsentTolerantLoader(resolveNotes, null);\n";
    const driven: ReadonlySet<string> = new Set<string>(SAFE_LOADERS.map((l) => l.name));
    const unaccounted = exportedSafeReaders(withEighthReader).filter(
      (name) => !driven.has(name) && !SAFE_LOADER_EXCLUSIONS.has(name),
    );
    expect(unaccounted).toEqual(["loadUnlistedThingSafe"]);
  });
});

/** Parses as YAML but fails validation: `read_paths` must be a list. */
const STRUCTURALLY_WRONG = `schema_version: 1\nnotes:\n  read_paths: 5\n`;

/** Does not parse at all: an indented first line has no parent key. */
const MALFORMED_YAML = `  schema_version: 1\n`;

/** A config an operator could plausibly have written, for the happy path. */
const VALID_CONFIG =
  `schema_version: 1\n` +
  `notes:\n  read_paths: [Journal]\n` +
  `guardrails:\n  provenance_trust_ordering: true\n` +
  `feedback:\n  default_scope: writing\n` +
  `snapshots:\n  retention_count: 3\n`;

describe("load*ConfigSafe: absent config", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "o2b-safe-loader-absent-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  for (const loader of SAFE_LOADERS) {
    test(`${loader.name}: a vault with no Brain tree gets the documented default`, () => {
      expect(loader.load(vault)).toEqual(loader.absentValue);
    });

    test(`${loader.name}: a Brain tree with no _brain.yaml gets the documented default`, () => {
      mkdirSync(join(vault, "Brain"), { recursive: true });
      expect(loader.load(vault)).toEqual(loader.absentValue);
    });
  }
});

describe("load*ConfigSafe: present but unreadable config", () => {
  let vault: string;
  let configPath: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "o2b-safe-loader-broken-"));
    mkdirSync(join(vault, "Brain"), { recursive: true });
    configPath = brainConfigPath(vault);
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  for (const loader of SAFE_LOADERS) {
    test(`${loader.name}: malformed YAML raises instead of serving defaults`, () => {
      writeFileSync(configPath, MALFORMED_YAML, "utf8");
      expect(() => loader.load(vault)).toThrow(BrainConfigError);
    });

    test(`${loader.name}: a structurally wrong config raises instead of serving defaults`, () => {
      writeFileSync(configPath, STRUCTURALLY_WRONG, "utf8");
      let caught: unknown;
      try {
        loader.load(vault);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BrainConfigError);
      expect((caught as BrainConfigError).source).toBe(configPath);
    });

    test(`${loader.name}: a directory where the file should be raises`, () => {
      mkdirSync(configPath, { recursive: true });
      let caught: unknown;
      try {
        loader.load(vault);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BrainConfigError);
      expect((caught as BrainConfigError).message).toContain("failed to read");
    });

    test(`${loader.name}: an unreadable file raises rather than reading as absent`, () => {
      writeFileSync(configPath, VALID_CONFIG, "utf8");
      chmodSync(configPath, 0o000);
      try {
        let caught: unknown;
        try {
          loader.load(vault);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(BrainConfigError);
        expect((caught as BrainConfigError).message).toContain("failed to read");
      } finally {
        chmodSync(configPath, 0o600);
      }
    });
  }

  test("the raised message names the file the operator has to fix", () => {
    writeFileSync(configPath, MALFORMED_YAML, "utf8");
    let caught: unknown;
    try {
      loadNotesConfigSafe(vault);
    } catch (err) {
      caught = err;
    }
    expect((caught as BrainConfigError).message).toContain(configPath);
  });

  /**
   * The integrity gates keep their own answer to the same question: they
   * must stay ENFORCING on a vault whose config broke, because the
   * search layer reads them on a store open and cannot take a throw.
   * Pinned here so the two shapes are not accidentally unified later.
   */
  test("loadIntegrityConfigSafe still resolves to its strict fallback, not a throw", () => {
    writeFileSync(configPath, MALFORMED_YAML, "utf8");
    expect(() => loadIntegrityConfigSafe(vault)).not.toThrow();
  });
});

/**
 * The readers raise; what matters to an operator is that the raise lands
 * on a surface. Three representative call sites, one per shape:
 * a plain read that propagates to its verb, a digest render whose
 * fire-and-warn wrapper names the cause on stderr, and the destructive
 * prune that must not run on a guessed retention.
 */
describe("call sites: an unreadable config is surfaced, never absorbed", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "o2b-safe-loader-callsite-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  function breakConfig(): void {
    mkdirSync(join(vault, "Brain"), { recursive: true });
    writeFileSync(brainConfigPath(vault), MALFORMED_YAML, "utf8");
  }

  test("resolveNoteRoots: absent config still means `no folders to walk`", () => {
    expect(resolveNoteRoots(vault)).toEqual([]);
  });

  test("resolveNoteRoots: an unreadable config raises rather than walking nothing", () => {
    breakConfig();
    expect(() => resolveNoteRoots(vault)).toThrow(BrainConfigError);
  });

  test("renderActive: an uninitialised vault still renders its digest", () => {
    expect(renderActive(vault).counts.confirmed).toBe(0);
  });

  test("renderActive: an unreadable config raises, naming the file", () => {
    breakConfig();
    let caught: unknown;
    try {
      renderActive(vault);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BrainConfigError);
    expect((caught as BrainConfigError).message).toContain(brainConfigPath(vault));
  });

  /**
   * `regenerateActiveQuiet` is the fire-and-warn wrapper `dream`, `pin`
   * and `merge` use. The raise must reach its stderr warning - that is
   * the visible channel on the paths that cannot fail the run - rather
   * than a digest silently rebuilt under default guardrails.
   */
  test("regenerateActiveQuiet: the raise is warned on stderr, not swallowed", () => {
    breakConfig();
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      regenerateActiveQuiet(vault);
    } finally {
      process.stderr.write = original;
    }
    const combined = written.join("");
    expect(combined).toContain("regenerate active.md failed");
    expect(combined).toContain(brainConfigPath(vault));
  });

  /**
   * The digest reads the same `active.most_applied` window as `active.md`,
   * but nothing on its path raises first (the owner-scope gate it consults
   * en route is the integrity reader, which resolves rather than throws).
   * So it needs the split itself: an uninitialised vault renders on the
   * documented window, a broken config does not quietly re-window the
   * section an operator reads as their most-applied rules.
   */
  test("renderDigest: an uninitialised vault renders on the documented window", () => {
    const rendered = renderDigest(vault, { format: "json" });
    const payload = JSON.parse(rendered.content) as {
      most_applied: { window_days: number; limit: number };
    };
    expect(payload.most_applied.window_days).toBe(BRAIN_MOST_APPLIED_DEFAULTS.window_days);
    expect(payload.most_applied.limit).toBe(BRAIN_MOST_APPLIED_DEFAULTS.limit);
  });

  test("renderDigest: an unreadable config raises, naming the file", () => {
    breakConfig();
    let caught: unknown;
    try {
      renderDigest(vault, { format: "json" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BrainConfigError);
    expect((caught as BrainConfigError).message).toContain(brainConfigPath(vault));
  });
});

describe("load*ConfigSafe: readable config", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "o2b-safe-loader-valid-"));
    mkdirSync(join(vault, "Brain"), { recursive: true });
    writeFileSync(brainConfigPath(vault), VALID_CONFIG, "utf8");
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  test("each reader returns exactly what the operator wrote", () => {
    expect(loadNotesConfigSafe(vault).read_paths).toEqual(["Journal"]);
    expect(loadGuardrailsConfigSafe(vault).provenance_trust_ordering).toBe(true);
    expect(loadFeedbackDefaultScopeSafe(vault)).toBe("writing");
    expect(loadSnapshotRetentionSafe(vault)).toBe(3);
  });

  test("a block the operator omitted still resolves to its defaults", () => {
    expect(loadTemporalConfigSafe(vault)).toEqual(BRAIN_TEMPORAL_DEFAULTS);
  });
});
