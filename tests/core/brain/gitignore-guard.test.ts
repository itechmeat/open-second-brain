/**
 * The vault `.gitignore` guard seeder (t_206562ae, task B1).
 *
 * `bootstrapBrain` seeds a managed block into `<vault>/.gitignore` whose
 * entry list starts as exactly one vault-root-anchored line,
 * `/.open-second-brain/` - one entry covering every Tier A derived-state
 * writer (brain.sqlite, hook-audit, secrets, maintenance sqlite and
 * journals, ingest checkpoints, dead-letters, session ledgers, watchdog
 * fallback, self-heal state, locks, bench runs). The seeder never shells
 * out to git and never touches bytes outside the block.
 *
 * The census at the bottom is the source-reading half (same discipline as
 * `tests/hooks/audit-root.test.ts` and the sync-lockfile lock-site
 * census): the entry covers the directory only while every derived-state
 * writer actually resolves under it, so the sweep pins the population.
 */

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_BEGIN_MARKER,
  DEFAULT_END_MARKER,
} from "../../../src/core/install/managed-block.ts";
import {
  ensureVaultGitignoreEntries,
  GITIGNORE_GUARD_ENTRIES,
  GITIGNORE_GUARD_FILE,
} from "../../../src/core/brain/gitignore-guard.ts";
import { BENCH_RUNS_REL, DERIVED_STORE_DIR } from "../../../src/core/brain/path-constants.ts";

let vault: string;

function freshVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "o2b-gitignore-guard-"));
  return dir;
}

function gitignorePath(): string {
  return join(vault, GITIGNORE_GUARD_FILE);
}

function seededBlock(): string {
  return `${DEFAULT_BEGIN_MARKER}\n${GITIGNORE_GUARD_ENTRIES.join("\n")}\n${DEFAULT_END_MARKER}\n`;
}

/**
 * The git-valid spellings of a negating line the matcher must catch.
 * Beyond the two plain forms: a trailing slash, git's ignored unescaped
 * trailing whitespace, and the double-star-slash prefix that matches
 * zero or more directories (so it covers the vault root too). Spellings
 * OUTSIDE this list - escaped-dot spellings, character-class and
 * bracket-expression tricks - stay out of scope on purpose: the doctor's
 * git-tracked-state row measures what git actually did, and is the
 * authority for everything this matcher cannot name.
 */
const NEGATION_LINE_VARIANTS: ReadonlyArray<string> = [
  "!.open-second-brain",
  "!/.open-second-brain",
  "!.open-second-brain/",
  "!/.open-second-brain/",
  "!.open-second-brain  ",
  "!**/.open-second-brain",
  "!**/.open-second-brain/",
];

describe("ensureVaultGitignoreEntries", () => {
  test("creates a .gitignore containing only the block when none exists", () => {
    vault = freshVault();
    try {
      const result = ensureVaultGitignoreEntries(vault);
      expect(result.status).toBe("created");
      expect(result.file).toBe(GITIGNORE_GUARD_FILE);
      expect(existsSync(gitignorePath())).toBe(true);
      expect(readFileSync(gitignorePath(), "utf8")).toBe(seededBlock());
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test("appends the block to an existing user .gitignore, byte-preserving user content", () => {
    vault = freshVault();
    try {
      const user = "# my patterns\n*.tmp\n.obsidian/workspace.json\n";
      writeFileSync(gitignorePath(), user, "utf8");
      const result = ensureVaultGitignoreEntries(vault);
      expect(result.status).toBe("updated");
      const next = readFileSync(gitignorePath(), "utf8");
      expect(next.startsWith(user)).toBe(true);
      expect(next).toContain(DEFAULT_BEGIN_MARKER);
      expect(next).toContain(`/${DERIVED_STORE_DIR}/`);
      expect(next).toContain(DEFAULT_END_MARKER);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test("a second run is a no-op: byte-equal file, skipped", () => {
    vault = freshVault();
    try {
      ensureVaultGitignoreEntries(vault);
      const before = readFileSync(gitignorePath(), "utf8");
      const second = ensureVaultGitignoreEntries(vault);
      expect(second.status).toBe("skipped");
      expect(readFileSync(gitignorePath(), "utf8")).toBe(before);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test("a user line that already ignores the path yields a skip, not a duplicate", () => {
    vault = freshVault();
    try {
      const user = "*.tmp\n/.open-second-brain/\n";
      writeFileSync(gitignorePath(), user, "utf8");
      const result = ensureVaultGitignoreEntries(vault);
      expect(result.status).toBe("skipped");
      expect(readFileSync(gitignorePath(), "utf8")).toBe(user);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test("CRLF files keep their line endings in both the user content and the block", () => {
    vault = freshVault();
    try {
      writeFileSync(gitignorePath(), "# my patterns\r\n*.tmp\r\n", "utf8");
      const result = ensureVaultGitignoreEntries(vault);
      expect(result.status).toBe("updated");
      const next = readFileSync(gitignorePath(), "utf8");
      expect(next.startsWith("# my patterns\r\n*.tmp\r\n")).toBe(true);
      expect(next).toContain(`${DEFAULT_BEGIN_MARKER}\r\n`);
      expect(next).toContain(`/${DERIVED_STORE_DIR}/\r\n`);
      expect(next).toContain(`${DEFAULT_END_MARKER}\r\n`);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test("an existing conforming block with extra entries merges without losing them", () => {
    vault = freshVault();
    try {
      const prior = `${DEFAULT_BEGIN_MARKER}\n*.log\n${DEFAULT_END_MARKER}\n`;
      writeFileSync(gitignorePath(), prior, "utf8");
      const result = ensureVaultGitignoreEntries(vault);
      expect(result.status).toBe("updated");
      const next = readFileSync(gitignorePath(), "utf8");
      // The block survives as ONE block, its prior entries kept, ours added.
      expect(next.match(new RegExp(DEFAULT_BEGIN_MARKER, "g"))).toHaveLength(1);
      expect(next).toContain("*.log");
      expect(next).toContain(`/${DERIVED_STORE_DIR}/`);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test("malformed existing markers surface the named conflict without writing", () => {
    vault = freshVault();
    try {
      const broken = "# mine\n# >>> open-second-brain managed >>>\n*.tmp\n";
      writeFileSync(gitignorePath(), broken, "utf8");
      const result = ensureVaultGitignoreEntries(vault);
      expect(result.status).toBe("conflict");
      expect(result.detail).toBeTruthy();
      // Warn-and-continue: the file is exactly as the user left it.
      expect(readFileSync(gitignorePath(), "utf8")).toBe(broken);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test("two begin markers are a conflict too", () => {
    vault = freshVault();
    try {
      const broken = `${DEFAULT_BEGIN_MARKER}\n${DEFAULT_END_MARKER}\n${DEFAULT_BEGIN_MARKER}\n`;
      writeFileSync(gitignorePath(), broken, "utf8");
      const result = ensureVaultGitignoreEntries(vault);
      expect(result.status).toBe("conflict");
      expect(readFileSync(gitignorePath(), "utf8")).toBe(broken);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test("a later negating line turns the exact-line skip into a named conflict", () => {
    // git evaluates .gitignore patterns in order and the LAST match
    // wins: with `!.open-second-brain` after the entry the store is NOT
    // ignored, so reporting a clean skip here would be optimistic. The
    // doctor row catches it later; the init report itself must not lie.
    for (const negation of NEGATION_LINE_VARIANTS) {
      vault = freshVault();
      try {
        const hostile = `/.open-second-brain/\n*.tmp\n${negation}\n`;
        writeFileSync(gitignorePath(), hostile, "utf8");
        let result!: ReturnType<typeof ensureVaultGitignoreEntries>;
        const { stderr } = captureStderr(() => {
          result = ensureVaultGitignoreEntries(vault);
        });
        expect(result.status).toBe("conflict");
        expect(result.detail).toContain(negation.trim());
        // Warn-and-continue: the file is exactly as the user left it.
        expect(readFileSync(gitignorePath(), "utf8")).toBe(hostile);
        expect(stderr).toMatch(/warning:/);
        expect(stderr).toContain("derived-brain-state");
      } finally {
        rmSync(vault, { recursive: true, force: true });
      }
    }
  });

  test("a conforming block that a later negation defeats is a conflict, not a clean update", () => {
    // The merge would land the entry INSIDE the earlier block, so the
    // negation after the block still wins under git's last-match rule:
    // a clean `updated` here would seed nothing effective while the
    // report claimed the guard moved.
    vault = freshVault();
    try {
      const hostile = `${DEFAULT_BEGIN_MARKER}\n*.log\n${DEFAULT_END_MARKER}\n!.open-second-brain\n`;
      writeFileSync(gitignorePath(), hostile, "utf8");
      let result!: ReturnType<typeof ensureVaultGitignoreEntries>;
      const { stderr } = captureStderr(() => {
        result = ensureVaultGitignoreEntries(vault);
      });
      expect(result.status).toBe("conflict");
      expect(result.detail).toContain("!.open-second-brain");
      // Warn-and-continue: the file is exactly as the user left it, and
      // the store stays unprotected - reported, never claimed as seeded.
      expect(readFileSync(gitignorePath(), "utf8")).toBe(hostile);
      expect(stderr).toMatch(/warning:/);
      expect(stderr).toContain("derived-brain-state");
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test("a negation BEFORE the block is overridden by the merged entry - a clean update", () => {
    // Last-match-wins favors the entry the merge adds, because it lands
    // after the negation inside the block.
    vault = freshVault();
    try {
      const user = `!.open-second-brain\n${DEFAULT_BEGIN_MARKER}\n*.log\n${DEFAULT_END_MARKER}\n`;
      writeFileSync(gitignorePath(), user, "utf8");
      const result = ensureVaultGitignoreEntries(vault);
      expect(result.status).toBe("updated");
      const next = readFileSync(gitignorePath(), "utf8");
      expect(next).toContain(`/${DERIVED_STORE_DIR}/`);
      expect(next).toContain("*.log");
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test("an existing empty block gains the entry without a stray blank line", () => {
    // Begin marker directly followed by end marker: the block body is
    // the empty string, and `"".split("\n")` yields [""], which used to
    // open the merged block with a blank line.
    vault = freshVault();
    try {
      writeFileSync(gitignorePath(), `${DEFAULT_BEGIN_MARKER}\n${DEFAULT_END_MARKER}\n`, "utf8");
      const result = ensureVaultGitignoreEntries(vault);
      expect(result.status).toBe("updated");
      expect(readFileSync(gitignorePath(), "utf8")).toBe(
        `${DEFAULT_BEGIN_MARKER}\n/${DERIVED_STORE_DIR}/\n${DEFAULT_END_MARKER}\n`,
      );
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test("a negation BEFORE the entry is a clean skip - last-match-wins favors the entry", () => {
    vault = freshVault();
    try {
      const harmless = "!.open-second-brain\n/.open-second-brain/\n";
      writeFileSync(gitignorePath(), harmless, "utf8");
      const result = ensureVaultGitignoreEntries(vault);
      expect(result.status).toBe("skipped");
      expect(readFileSync(gitignorePath(), "utf8")).toBe(harmless);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});

/** Run `fn`, capturing everything it writes to stderr; restore afterwards. */
function captureStderr(fn: () => unknown): { stderr: string } {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return { stderr: captured };
}

// ----- Source-reading census ------------------------------------------------

/**
 * Every `src/` file that references the derived store, by constant or by
 * the directory's literal name (as a quoted path segment or a
 * slash-anchored pattern in a message). This is the population the
 * `/.open-second-brain/` entry has to cover.
 */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src");

const DERIVED_STORE_REFERENCE_RE =
  /DERIVED_STORE_DIR|DERIVED_STORE_FILE|BENCH_RUNS_REL|"\.open-second-brain"|\/\.open-second-brain/;

function derivedStoreSites(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      if (DERIVED_STORE_REFERENCE_RE.test(readFileSync(full, "utf8"))) {
        out.push(full.slice(SRC.length + 1).replaceAll("\\", "/"));
      }
    }
  };
  walk(SRC);
  return out.toSorted();
}

/**
 * Declared derived-state sites, each with what its reference IS. A new
 * site fails the census until its author states what the reference is
 * here; a declared site whose reference disappears (a writer moved its
 * paths outside the covered directory) fails the membership assertion.
 */
const DECLARED_SITES: ReadonlyMap<string, string> = new Map([
  ["cli/bootstrap/receipt.ts", "bootstraps the bootstrap lockfile under the store"],
  ["cli/bootstrap/run.ts", "CLI bootstrap reporting that names the store"],
  ["cli/brain/help-text.ts", "help prose naming the store directory"],
  ["cli/brain/verbs/bench.ts", "bench runs default dir, composed from BENCH_RUNS_REL"],
  ["cli/brain/verbs/dead-letters.ts", "dead-letter listing prose naming the store"],
  [
    "core/brain/checkpoint-store.ts",
    "the shared checkpoint substrate under the store (ingest and session-import lanes)",
  ],
  ["core/brain/dead-letter.ts", "dead letters under the store"],
  ["core/brain/gitignore-guard.ts", "composes the seeded guard entry from the constant"],
  ["core/brain/init.ts", "bootstraps the seed; names the entry in its step 1c docblock"],
  [
    "core/brain/doctor/git-tracked-state-check.ts",
    "composes the ls-files pathspec and the guard ignore line from the constant",
  ],
  ["core/brain/ingest/checkpoint.ts", "ingest checkpoints under the store"],
  [
    "core/brain/ingest/content-manifest.ts",
    "ingest content manifest under the store, spelled as the private MACHINE_ARTIFACT_DIR beside its join",
  ],
  [
    "core/brain/inject-failopen.ts",
    "inject cache under the store, spelled as the private INJECT_CACHE_DIR beside its join",
  ],
  ["core/brain/maintenance/journal.ts", "maintenance journals under the store"],
  ["core/brain/maintenance/lease.ts", "maintenance lease sqlite under the store"],
  ["core/brain/path-constants.ts", "owns the directory name itself"],
  ["core/brain/paths.ts", "composes the hook-audit root under the store from the constant"],
  [
    "core/brain/protect.ts",
    "protect manifest under the store, spelled as the private MANIFEST_DIR beside its join",
  ],
  ["core/brain/recall-inject.ts", "recall injection reporting that names the store"],
  ["core/brain/secrets/store.ts", "secrets directory under the store, spelled as a join literal"],
  ["core/brain/secrets/token-store.ts", "token-store reporting that names the store"],
  ["core/brain/session-mining-ledger.ts", "session mining ledger under the store"],
  ["core/brain/session-mining-surveys.ts", "session mining surveys under the store"],
  ["core/brain/sessions/discover.ts", "session import ledger under the store"],
  ["core/brain/snapshot.ts", "snapshot recovery reaching the brain.sqlite file"],
  ["core/brain/storage/usage.ts", "storage census over the store"],
  ["core/brain/sync-lockfile.ts", "lock files under the store"],
  [
    "core/brain/temporal/weekly-brief.ts",
    "weekly brief EXCLUDES the store by directory name, it writes nothing there",
  ],
  ["core/brain/watchdog.ts", "watchdog audit fallback under the store"],
  ["core/derived-store-guard.ts", "the symlink guard over the store directory itself"],
  ["core/doctor-selftest.ts", "doctor self-test writing probe state under the store"],
  [
    "core/graph/mcp-config.ts",
    "MCP config SKIP_DIRS excludes the store by name, it writes nothing there",
  ],
  ["core/install/adapters/aider.ts", "aider adapter reporting that names the store"],
  [
    "core/install/adapters/aider-wrapper.ts",
    "aider context artifact under the store, spelled as a join literal",
  ],
  ["core/install/manifest.ts", "install lockfile under the store, spelled as a join literal"],
  ["core/maintenance/self-heal-upgrade-state.ts", "self-heal upgrade state under the store"],
  ["core/search/paths.ts", "composes the brain.sqlite path under the store from the constants"],
  ["core/state/surfaces.ts", "state surfaces census over the store"],
  [
    "core/vault-scope/defaults.ts",
    "DEFAULT_VAULT_IGNORE_PATHS excludes the store by name, it writes nothing there",
  ],
]);

describe("every derived-state site sits under the covered directory", () => {
  test("the sweep actually found the sites", () => {
    // A census over an empty set passes for the wrong reason.
    expect(derivedStoreSites().length).toBeGreaterThan(20);
  });

  test("no derived-state site is missing from the declared set", () => {
    const undeclared = derivedStoreSites().filter((rel) => !DECLARED_SITES.has(rel));
    expect(undeclared).toEqual([]);
  });

  test("every declared site still exists and still references the store", () => {
    const vanished = [...DECLARED_SITES.keys()].filter((rel) => {
      const path = join(SRC, rel);
      if (!existsSync(path)) return true;
      return !DERIVED_STORE_REFERENCE_RE.test(readFileSync(path, "utf8"));
    });
    expect(vanished).toEqual([]);
  });

  test("the bench runs dir is hoisted, not locally spelled", () => {
    // The default runs dir is named beside DERIVED_STORE_DIR so the
    // guard's single entry provably covers it (task B1).
    expect(BENCH_RUNS_REL).toBe(`${DERIVED_STORE_DIR}/bench-runs`);
    const bench = readFileSync(join(SRC, "cli", "brain", "verbs", "bench.ts"), "utf8");
    expect(bench).not.toContain('".open-second-brain"');
    expect(bench).toContain("BENCH_RUNS_REL");
  });
});

describe("the guard's entry list", () => {
  test("starts as exactly one vault-root-anchored entry naming the store", () => {
    expect([...GITIGNORE_GUARD_ENTRIES]).toEqual([`/${DERIVED_STORE_DIR}/`]);
  });

  test("seeding a fresh vault covers the derived store root", () => {
    vault = freshVault();
    try {
      mkdirSync(vault, { recursive: true });
      ensureVaultGitignoreEntries(vault);
      const content = readFileSync(gitignorePath(), "utf8");
      expect(content).toContain(`/${DERIVED_STORE_DIR}/`);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});
