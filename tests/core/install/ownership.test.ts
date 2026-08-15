/**
 * The ownership statement, and the census that keeps it true.
 *
 * "Every memory is a Markdown file in your own vault; copy it elsewhere,
 * delete it and the brain is gone; there is no service to cancel" is a
 * claim with known counterexamples, and a claim with a known counterexample
 * is exactly what this release exists to remove. So the sentence is not
 * written by hand: it is COMPOSED from the resolved vault path, a
 * filesystem-backing verdict, and an enumeration of the durable state that
 * lives outside the vault.
 *
 * The last describe block is the load-bearing one. It sweeps the tree for
 * every module that writes to a home-, XDG- or temp-rooted path and demands
 * that each be attributed to an entry in that enumeration or excused in
 * writing - so a new out-of-vault location cannot be added without the
 * sentence learning about it.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { registerAllAdapters } from "../../../src/core/install/adapters/all.ts";
import {
  buildDataOwnership,
  type DataOwnershipInput,
  OUT_OF_VAULT_STATE,
  OUT_OF_VAULT_SWEEP_EXCLUSIONS,
  renderDataOwnership,
} from "../../../src/core/install/ownership.ts";
import {
  VAULT_BACKING,
  VAULT_BACKING_UNDETERMINED_REASON,
} from "../../../src/core/vault-backing.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const VAULT = "/tmp/some-vault";

function ownership(overrides: Partial<DataOwnershipInput> = {}) {
  return buildDataOwnership({
    vault: VAULT,
    adapterTargets: ["cursor", "kiro"],
    networkedEmbeddingProvider: false,
    backing: {
      state: VAULT_BACKING.durable,
      filesystem: "ext4",
      reason: null,
      detail: `${VAULT} is backed by ext4 (0xef53)`,
    },
    ...overrides,
  });
}

describe("the statement is built from what was measured", () => {
  test("it names the resolved vault, not a configured one", () => {
    const text = renderDataOwnership(ownership());
    expect(text).toContain(VAULT);
  });

  test("a durable backing is stated as such", () => {
    const text = renderDataOwnership(ownership());
    expect(text).toContain("ext4");
  });

  test("an undetermined backing is never rendered as durability", () => {
    const text = renderDataOwnership(
      ownership({
        backing: {
          state: VAULT_BACKING.undetermined,
          filesystem: null,
          reason: VAULT_BACKING_UNDETERMINED_REASON.probeUnsupported,
          detail: "the filesystem backing /tmp/some-vault was not probed",
        },
      }),
    );
    // The verdict is present and it is the honest one; nothing in the
    // rendering promises the vault survives anything.
    expect(text).toContain("was not probed");
    expect(text).not.toContain("survives this process and a reboot");
  });

  test("a memory-backed vault is stated as a loss, not as a caveat", () => {
    const text = renderDataOwnership(
      ownership({
        backing: {
          state: VAULT_BACKING.volatile,
          filesystem: "tmpfs",
          reason: null,
          detail: "/tmp/some-vault is backed by tmpfs (0x1021994)",
        },
      }),
    );
    expect(text).toContain("tmpfs");
    expect(text).toContain("reboot");
  });
});

describe("the exceptions are named, never omitted", () => {
  test("every enumerated out-of-vault location reaches the rendered statement", () => {
    const text = renderDataOwnership(ownership());
    const missing = OUT_OF_VAULT_STATE.filter((entry) => !text.includes(entry.label));
    expect(missing.map((e) => e.id).join("\n")).toBe("");
  });

  test("the one location that can hold memory content is called out by name", () => {
    const carriers = OUT_OF_VAULT_STATE.filter((e) => e.carries_memory);
    // Not an incidental fact: the opencode spool is the counterexample that
    // makes the unqualified sentence false, so an empty set here means the
    // statement has quietly become the unqualified one again.
    expect(carriers.length).toBeGreaterThan(0);
    const text = renderDataOwnership(ownership());
    for (const carrier of carriers) expect(text).toContain(carrier.location);
  });

  test("every installed runtime target is accounted for in the statement", () => {
    const targets = registerAllAdapters().targets();
    const text = renderDataOwnership(ownership({ adapterTargets: targets }));
    const missing = targets.filter((t) => !text.includes(t));
    expect(missing.join("\n")).toBe("");
  });

  test("no id is spelled twice", () => {
    const ids = OUT_OF_VAULT_STATE.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("`no service to cancel` is state-aware", () => {
  test("with no networked embedding provider the claim stands unqualified", () => {
    const text = renderDataOwnership(ownership());
    expect(text).toContain("nothing to cancel");
    expect(text).not.toContain("embedding_base_url");
  });

  test("with one configured the third-party account is named", () => {
    const text = renderDataOwnership(ownership({ networkedEmbeddingProvider: true }));
    expect(text).toContain("embedding_base_url");
  });
});

// ---------------------------------------------------------------------------
// The census.
// ---------------------------------------------------------------------------

/**
 * Roots swept for out-of-vault writes. `tests/` is deliberately absent:
 * a test writing into a temp home is staging a fixture, not shipping a
 * location an operator will find on their machine afterwards.
 */
const SWEPT_ROOTS: ReadonlyArray<string> = Object.freeze(["src", "hooks", "plugins"]);

/**
 * A path rooted somewhere other than the vault. `env.home` is included
 * because the install adapters receive the home directory injected rather
 * than reading it, and they are the largest family of out-of-vault writers
 * in the tree.
 */
const OUT_OF_VAULT_ANCHOR_RE =
  /XDG_DATA_HOME|XDG_CONFIG_HOME|homedir\(\)|\.local\/(?:bin|share)|tmpdir\(\)|TMPDIR|env\.home/;

/**
 * A module that only reads such a path is not leaving state behind. The
 * trailing `(` matters: the enumeration module and this file both NAME
 * these calls in prose, and a scan that counted a mention as a write would
 * make the census's own documentation part of its population.
 */
const WRITE_RE =
  /(?:writeFileSync|appendFileSync|mkdirSync|symlinkSync|copyFileSync|mkdtempSync)\(/;

/**
 * Comments stripped before either pattern runs, for the same reason: a
 * docblock that explains why a module does NOT write outside the vault
 * would otherwise enrol it.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Every module that writes to a path rooted outside the vault. */
function sweepOutOfVaultWriters(): ReadonlyArray<string> {
  const hits: string[] = [];
  for (const root of SWEPT_ROOTS) {
    const dir = join(REPO_ROOT, root);
    if (!existsSync(dir)) continue;
    for (const file of walk(dir, [])) {
      const source = code(readFileSync(file, "utf8"));
      if (!OUT_OF_VAULT_ANCHOR_RE.test(source)) continue;
      if (!WRITE_RE.test(source)) continue;
      hits.push(relative(REPO_ROOT, file));
    }
  }
  return hits.toSorted();
}

/** True when `file` sits under one of the entry's declared sources. */
function attributed(file: string): boolean {
  for (const entry of OUT_OF_VAULT_STATE) {
    for (const source of entry.sources) {
      if (file === source) return true;
      if (source.endsWith("/") && file.startsWith(source)) return true;
    }
  }
  return false;
}

const MIN_EXCLUSION_REASON_LENGTH = 80;

describe("no out-of-vault write escapes the enumeration", () => {
  test("the sweep found a real population", () => {
    // A regex that stopped matching, or a root that was renamed, would
    // sweep an empty set clean and pass every assertion below.
    expect(sweepOutOfVaultWriters().length).toBeGreaterThan(8);
  });

  test("every writer is either attributed to an entry or excused in writing", () => {
    const orphans = sweepOutOfVaultWriters().filter(
      (file) => !attributed(file) && !OUT_OF_VAULT_SWEEP_EXCLUSIONS.has(file),
    );
    // Named, not counted: the failure message is the work to be done.
    expect(orphans.join("\n")).toBe("");
  });

  test("no exclusion outlives the module it excuses", () => {
    const population = new Set(sweepOutOfVaultWriters());
    const stale = [...OUT_OF_VAULT_SWEEP_EXCLUSIONS.keys()].filter((file) => !population.has(file));
    expect(stale.toSorted().join("\n")).toBe("");
  });

  test("every exclusion reason says something specific", () => {
    for (const [file, reason] of OUT_OF_VAULT_SWEEP_EXCLUSIONS) {
      expect(`${file}: ${reason.trim().length >= MIN_EXCLUSION_REASON_LENGTH}`).toBe(
        `${file}: true`,
      );
    }
  });

  test("every declared source still exists", () => {
    const missing: string[] = [];
    for (const entry of OUT_OF_VAULT_STATE) {
      for (const source of entry.sources) {
        if (!existsSync(join(REPO_ROOT, source))) missing.push(`${entry.id} -> ${source}`);
      }
    }
    expect(missing.join("\n")).toBe("");
  });
});
