# Vault Scope (v0.10.9) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the "Vault Scope" gap: introduce `vault.ignore_paths` in `Brain/_brain.yaml` as the single source of truth for every vault walker (search indexer, scan-inline), expose visibility via `o2b vault status` / `o2b vault inspect` and the extended `second_brain_status` MCP payload, and warn via `o2b brain doctor` when an ignore entry points at a missing path.

**Architecture:** A new module `src/core/vault-scope` owns the default exclusion set, the rule shape, the resolver and the matcher. The search indexer and scan-inline walker delegate ignore decisions to that module via `matchIgnore`. A new `o2b vault` CLI dispatcher with two verbs (`status`, `inspect`) and a new field on `second_brain_status` give the operator one-shot visibility. Doctor adds one warning lint.

**Tech Stack:** TypeScript on Bun runtime (`bun test` for unit + e2e), `bun:test` API, existing repo helpers (`tests/helpers/run-cli.ts`, `tests/helpers/search-fixtures.ts`).

**Spec:** `docs/plans/2026-05-19-vault-scope-design.md`. Read it once before starting Task 1.

---

## File Structure

| File | Role |
|---|---|
| `src/core/vault-scope/index.ts` | NEW. `DEFAULT_VAULT_IGNORE_PATHS`, `VaultIgnoreRule`, `VaultScope`, `resolveVaultScope`, `matchIgnore`, `walkVaultScope`, `inspectPath`. |
| `src/core/brain/types.ts` | MODIFY. Add `BrainVaultConfig` + `BrainConfig.vault?`. |
| `src/core/brain/policy.ts` | MODIFY. Parse and validate the `vault:` block, extend `DEFAULT_BRAIN_CONFIG_YAML`. |
| `src/core/brain/doctor.ts` | MODIFY. Add `checkVaultIgnore`. |
| `src/core/search/types.ts` | MODIFY. Replace `ignorePaths: ReadonlyArray<string>` with `ignoreRules: ReadonlyArray<VaultIgnoreRule>`. |
| `src/core/search/index.ts` | MODIFY. Delete `DEFAULT_IGNORE_PATHS`, `parseIgnorePaths`, and the env/config plumbing for `OPEN_SECOND_BRAIN_SEARCH_IGNORE` / `search_ignore_paths`. Call `resolveVaultScope`. |
| `src/core/search/walker.ts` | MODIFY. Delete local `parseIgnore`; consume `ignoreRules` via `matchIgnore`. |
| `src/core/brain/inline-scan.ts` | MODIFY. Delete `HARD_SKIP_DIRS`; resolve scope, append synthetic `Brain` name-rule + user excludes, route through `matchIgnore`. |
| `src/cli/vault.ts` | NEW. `handleVaultSubcommand` dispatcher. |
| `src/cli/vault/verbs/status.ts` | NEW. `cmdVaultStatus`. |
| `src/cli/vault/verbs/inspect.ts` | NEW. `cmdVaultInspect`. |
| `src/cli/vault/help-text.ts` | NEW. `VAULT_HELP` + `VAULT_VERB_HELP`. |
| `src/cli/main.ts` | MODIFY. Dispatch case `"vault"` → `handleVaultSubcommand`. |
| `src/mcp/tools.ts` | MODIFY. Extend `toolStatus` with the `vault` block. |
| `tests/core/vault-scope.test.ts` | NEW. Unit tests for resolver + matcher + walker + inspectPath. |
| `tests/core/brain.policy.test.ts` | MODIFY. Cases for the new `vault:` block. |
| `tests/core/brain.doctor.test.ts` | MODIFY. Case for `vault-ignore-missing-path`. |
| `tests/core/search/walker.test.ts` | MODIFY. Adapt fixtures to `ignoreRules`. |
| `tests/core/search/store.test.ts` | MODIFY. Adapt fixtures to `ignoreRules`. |
| `tests/core/search/store.vec.test.ts` | MODIFY. Adapt fixtures to `ignoreRules`. |
| `tests/core/search/config.test.ts` | MODIFY. Drop legacy env / config tests; assert that `OPEN_SECOND_BRAIN_SEARCH_IGNORE` / `search_ignore_paths` have NO effect. |
| `tests/helpers/search-fixtures.ts` | MODIFY. `makeConfig` builds `ignoreRules` internally. |
| `tests/core/brain.inline-scan.test.ts` | MODIFY. New cases: `.obsidian/plugins/foo/note.md` skipped; `Brain` always skipped; `--exclude` narrows. |
| `tests/e2e/brain-capture-and-fields.test.ts` | MODIFY. Add marker inside `.obsidian/plugins/x/note.md` and confirm it is not picked up. |
| `tests/cli/vault.test.ts` | NEW. CLI surface tests. |
| `tests/mcp/tools.test.ts` | MODIFY (or NEW if absent). Assert `second_brain_status` payload contains the `vault` block. |
| `CHANGELOG.md` | MODIFY. New `[0.10.9]` section. |
| `package.json` + sync-version targets | MODIFY. Bump to `0.10.9` and run `bun run sync-version`. |

---

## Conventions for every task

- **TDD:** write the failing test, run it to confirm it fails, then write the smallest implementation that makes it pass.
- **Commit cadence:** one commit per task (or per major step inside a task). Commit message format follows the repo convention - see `git log -1` on the project for the current style. Do NOT include AI-attribution trailers unless the user explicitly asks for them.
- **No git mutations from the agent without operator approval.** This plan documents commit points; the executing agent surfaces the commit messages for the operator. The operator runs `git commit` (or approves) themselves.
- **Run mode:** `bun test <file>` for a single file, `bun test` for full suite. Use `--watch` only locally.
- **Avoid `bun test -t '<name>'` for new tests** until at least one assertion is in place - bun's filter silently passes empty suites.

---

## Task 1: `vault-scope` skeleton + DEFAULT constants

**Files:**
- Create: `src/core/vault-scope/index.ts`
- Create: `tests/core/vault-scope.test.ts`

- [ ] **Step 1: Write the failing test for `DEFAULT_VAULT_IGNORE_PATHS` and rule types**

`tests/core/vault-scope.test.ts`:

```ts
import { test, expect } from "bun:test";
import {
  DEFAULT_VAULT_IGNORE_PATHS,
  type VaultIgnoreRule,
} from "../../src/core/vault-scope/index.ts";

test("DEFAULT_VAULT_IGNORE_PATHS contains the v0.10.9 baseline", () => {
  expect([...DEFAULT_VAULT_IGNORE_PATHS]).toEqual([
    ".git",
    "node_modules",
    ".open-second-brain",
    ".obsidian",
    ".trash",
    ".stversions",
    "Brain/.snapshots",
  ]);
});

test("DEFAULT_VAULT_IGNORE_PATHS is frozen", () => {
  expect(Object.isFrozen(DEFAULT_VAULT_IGNORE_PATHS)).toBe(true);
});

test("VaultIgnoreRule kind union covers the two semantic cases", () => {
  const a: VaultIgnoreRule = { raw: ".git", kind: "name" };
  const b: VaultIgnoreRule = { raw: "Brain/.snapshots", kind: "path" };
  expect(a.kind).toBe("name");
  expect(b.kind).toBe("path");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/vault-scope.test.ts`
Expected: FAIL with `Cannot find module ... vault-scope/index.ts`.

- [ ] **Step 3: Write the minimal module**

`src/core/vault-scope/index.ts`:

```ts
/**
 * Vault Scope — single source of truth for vault-wide exclusion
 * policy.
 *
 * Anchored in docs/plans/2026-05-19-vault-scope-design.md §5.
 */

export interface VaultIgnoreRule {
  /** Entry exactly as written in `Brain/_brain.yaml`. */
  readonly raw: string;
  /**
   * `name` — match any directory whose basename equals `raw`,
   * anywhere in the tree.
   * `path` — match a vault-relative POSIX path exactly.
   */
  readonly kind: "name" | "path";
}

export const DEFAULT_VAULT_IGNORE_PATHS: ReadonlyArray<string> = Object.freeze([
  ".git",
  "node_modules",
  ".open-second-brain",
  ".obsidian",
  ".trash",
  ".stversions",
  "Brain/.snapshots",
]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/core/vault-scope.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

Surface to operator: "Task 1 done. Suggested commit message: `feat(vault-scope): introduce module skeleton and default ignore set`". Wait for operator to commit.

---

## Task 2: `matchIgnore` matcher

**Files:**
- Modify: `src/core/vault-scope/index.ts`
- Modify: `tests/core/vault-scope.test.ts`

- [ ] **Step 1: Write failing tests for `matchIgnore`**

Append to `tests/core/vault-scope.test.ts`:

```ts
import { matchIgnore } from "../../src/core/vault-scope/index.ts";

const rules: ReadonlyArray<VaultIgnoreRule> = [
  { raw: ".git", kind: "name" },
  { raw: "node_modules", kind: "name" },
  { raw: "Brain/.snapshots", kind: "path" },
];

test("matchIgnore returns excluded=false on a plain path", () => {
  const r = matchIgnore("Notes/idea.md", rules);
  expect(r.excluded).toBe(false);
  expect(r.rule).toBeNull();
  expect(r.matchedAt).toBeNull();
});

test("matchIgnore catches a bare-name rule at the root", () => {
  const r = matchIgnore(".git/HEAD", rules);
  expect(r.excluded).toBe(true);
  expect(r.rule?.raw).toBe(".git");
  expect(r.matchedAt).toBe(".git");
});

test("matchIgnore catches a bare-name rule at any depth", () => {
  const r = matchIgnore("deep/nested/.git/HEAD", rules);
  expect(r.excluded).toBe(true);
  expect(r.rule?.raw).toBe(".git");
  expect(r.matchedAt).toBe("deep/nested/.git");
});

test("matchIgnore catches a path rule by exact prefix", () => {
  const r = matchIgnore("Brain/.snapshots/2026-05-19.tar.zst", rules);
  expect(r.excluded).toBe(true);
  expect(r.rule?.raw).toBe("Brain/.snapshots");
  expect(r.matchedAt).toBe("Brain/.snapshots");
});

test("matchIgnore does NOT match a path rule on a prefix collision", () => {
  // "Brain/.snapshots-old" must NOT be eaten by "Brain/.snapshots".
  const r = matchIgnore("Brain/.snapshots-old/x.md", rules);
  expect(r.excluded).toBe(false);
});

test("matchIgnore on an empty relPath is excluded=false (vault root)", () => {
  const r = matchIgnore("", rules);
  expect(r.excluded).toBe(false);
});

test("matchIgnore with empty rules excludes nothing", () => {
  const r = matchIgnore(".git/HEAD", []);
  expect(r.excluded).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/vault-scope.test.ts`
Expected: FAIL with `matchIgnore is not a function`.

- [ ] **Step 3: Implement `matchIgnore`**

Append to `src/core/vault-scope/index.ts`:

```ts
export interface IgnoreMatch {
  readonly excluded: boolean;
  readonly rule: VaultIgnoreRule | null;
  /** POSIX rel-path of the prefix that triggered the match, or null. */
  readonly matchedAt: string | null;
}

/**
 * Walk `relPath` segment by segment. For each prefix, check name-
 * and path-rules. Return the shortest prefix that excludes, or
 * `{excluded: false}` if no rule fires.
 */
export function matchIgnore(
  relPath: string,
  rules: ReadonlyArray<VaultIgnoreRule>,
): IgnoreMatch {
  if (relPath === "") {
    return { excluded: false, rule: null, matchedAt: null };
  }
  const segments = relPath.split("/").filter((s) => s.length > 0);
  let prefix = "";
  for (const seg of segments) {
    prefix = prefix === "" ? seg : `${prefix}/${seg}`;
    for (const rule of rules) {
      if (rule.kind === "name" && rule.raw === seg) {
        return { excluded: true, rule, matchedAt: prefix };
      }
      if (rule.kind === "path" && rule.raw === prefix) {
        return { excluded: true, rule, matchedAt: prefix };
      }
    }
  }
  return { excluded: false, rule: null, matchedAt: null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/core/vault-scope.test.ts`
Expected: PASS (3 + 7 = 10 tests).

- [ ] **Step 5: Commit**

Suggested commit: `feat(vault-scope): add matchIgnore matcher with name/path rules`.

---

## Task 3: `_brain.yaml` types and parser support for `vault:` block

**Files:**
- Modify: `src/core/brain/types.ts`
- Modify: `src/core/brain/policy.ts`
- Modify: `tests/core/brain.policy.test.ts`

- [ ] **Step 1: Write failing tests for the new block**

Find `tests/core/brain.policy.test.ts` and append:

```ts
test("vault block: parses ignore_paths list", () => {
  const path = writeYaml(`schema_version: 1
vault:
  ignore_paths:
    - .git
    - node_modules
    - Brain/.snapshots
`);
  const cfg = loadBrainConfig(path);
  expect(cfg.vault?.ignore_paths).toEqual([".git", "node_modules", "Brain/.snapshots"]);
});

test("vault block: absent block leaves vault undefined", () => {
  const path = writeYaml(`schema_version: 1\n`);
  const cfg = loadBrainConfig(path);
  expect(cfg.vault).toBeUndefined();
});

test("vault block: empty ignore_paths is honoured as explicit empty", () => {
  const path = writeYaml(`schema_version: 1
vault:
  ignore_paths:
`);
  const cfg = loadBrainConfig(path);
  expect(cfg.vault?.ignore_paths).toEqual([]);
});

test("vault block: entry with control char is rejected", () => {
  const path = writeYaml(`schema_version: 1
vault:
  ignore_paths:
    - "bad\\nentry"
`);
  expect(() => loadBrainConfig(path)).toThrow(/vault\.ignore_paths\[0\]/);
});

test("vault block: unknown sibling field emits a warning, not error", () => {
  const path = writeYaml(`schema_version: 1
vault:
  ignore_paths:
    - .git
  unknown_extra: true
`);
  const { config, warnings } = loadBrainConfigDetailed(dirnameFor(path));
  expect(config.vault?.ignore_paths).toEqual([".git"]);
  expect(warnings.some((w) => w.message.includes("unknown_extra"))).toBe(true);
});
```

*If `writeYaml` / `loadBrainConfig` / `loadBrainConfigDetailed` / `dirnameFor` helpers do not exist in this test file in this exact form, look at the top of `tests/core/brain.policy.test.ts` for the test scaffolding pattern in use and adapt the new tests to match - keep the SAME assertion shape and field paths.*

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/core/brain.policy.test.ts`
Expected: FAIL — `vault` property does not exist on `BrainConfig`.

- [ ] **Step 3: Extend types**

In `src/core/brain/types.ts`, add (near the other block interfaces, before `BrainConfig`):

```ts
/**
 * Vault-wide exclusion policy (`Brain/_brain.yaml` -> `vault:`).
 * Single source of truth for every walker - search indexer,
 * scan-inline, future scanners.
 */
export interface BrainVaultConfig {
  /**
   * Vault-relative POSIX paths or bare directory names. A bare
   * name (no `/`) matches that directory anywhere in the tree;
   * an entry with `/` is matched against the vault-relative path
   * exactly. Order is preserved for `o2b vault status` output.
   */
  readonly ignore_paths: ReadonlyArray<string>;
}
```

In the `BrainConfig` interface, add:

```ts
readonly vault?: BrainVaultConfig;
```

- [ ] **Step 4: Extend the parser and validator**

In `src/core/brain/policy.ts`:

1. Add `"vault"` to the `known` Set near the end of `validateBrainConfigDetailed`.
2. After the `snapshots` validation block (around line 391) and BEFORE the `discipline_report` block, add:

```ts
let vault: BrainVaultConfig | undefined;
if ("vault" in obj) {
  const raw = obj["vault"];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BrainConfigError(
      `block must be a map of keys; got ${describe(raw)}`,
      "vault",
      source,
    );
  }
  const rawMap = raw as Record<string, unknown>;
  let ignorePaths: ReadonlyArray<string> = [];
  if ("ignore_paths" in rawMap) {
    const list = rawMap["ignore_paths"];
    // Block-list with no items (`ignore_paths:` followed by nothing)
    // is parsed by parseBrainYaml as an empty array.
    if (!Array.isArray(list)) {
      throw new BrainConfigError(
        `must be a list of strings; got ${describe(list)}`,
        "vault.ignore_paths",
        source,
      );
    }
    const validated: string[] = [];
    list.forEach((entry, i) => {
      if (typeof entry !== "string") {
        throw new BrainConfigError(
          `must be a string; got ${describe(entry)}`,
          `vault.ignore_paths[${i}]`,
          source,
        );
      }
      const trimmed = entry.trim();
      if (trimmed.length === 0) {
        throw new BrainConfigError(
          "must be a non-empty string",
          `vault.ignore_paths[${i}]`,
          source,
        );
      }
      for (const bad of YAML_STRING_REJECTED_CHARS) {
        if (trimmed.includes(bad)) {
          throw new BrainConfigError(
            `contains a disallowed character ${JSON.stringify(bad)}; ` +
              "use a simple one-line path",
            `vault.ignore_paths[${i}]`,
            source,
          );
        }
      }
      validated.push(trimmed);
    });
    ignorePaths = Object.freeze(validated);
  }
  // Forward-compat: unknown sub-keys -> warning.
  for (const key of Object.keys(rawMap)) {
    if (key !== "ignore_paths") {
      warnings.push({
        path: source ?? "<config>",
        message: `vault.${key}: unknown field ignored (forward-compat)`,
      });
    }
  }
  vault = { ignore_paths: ignorePaths };
}
```

3. In the final `BrainConfig` literal at the end of the function, add:

```ts
...(vault !== undefined ? { vault } : {}),
```

4. Also import `BrainVaultConfig` at the top of the file alongside the other type-only imports:

```ts
import type { BrainConfig, BrainVaultConfig, DisciplineReportConfig } from "./types.ts";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/core/brain.policy.test.ts`
Expected: PASS — including the 5 new vault-block tests plus all existing policy tests.

- [ ] **Step 6: Update the default YAML body**

In `src/core/brain/policy.ts`, replace `DEFAULT_BRAIN_CONFIG_YAML` so the trailing block reads:

```
snapshots:
  retention_count: 10

# Single source of truth for every vault walker (search indexer,
# scan-inline, future scanners). Entries without a slash match a
# directory name anywhere in the tree; entries with a slash are
# matched against a vault-relative POSIX path exactly. Leave the
# block absent to use the built-in defaults below; set
# `ignore_paths: []` to disable exclusions entirely.
vault:
  ignore_paths:
    - .git
    - node_modules
    - .open-second-brain
    - .obsidian
    - .trash
    - .stversions
    - Brain/.snapshots
```

Update `DEFAULT_BRAIN_CONFIG` likewise:

```ts
export const DEFAULT_BRAIN_CONFIG: BrainConfig = Object.freeze({
  // ...existing fields...
  vault: Object.freeze({
    ignore_paths: Object.freeze([
      ".git",
      "node_modules",
      ".open-second-brain",
      ".obsidian",
      ".trash",
      ".stversions",
      "Brain/.snapshots",
    ]),
  }),
}) as BrainConfig;
```

- [ ] **Step 7: Add a test confirming `brain init` writes the new block**

In `tests/core/brain.init.test.ts` (search for the existing test that asserts `_brain.yaml` is written) add a sibling:

```ts
test("brain init writes the vault.ignore_paths block", () => {
  const tmp = mkdtempSync(join(tmpdir(), "brain-init-vault-"));
  bootstrapBrain(tmp);  // existing test helper
  const body = readFileSync(join(tmp, "Brain", "_brain.yaml"), "utf8");
  expect(body).toContain("vault:");
  expect(body).toContain("- .obsidian");
  expect(body).toContain("- Brain/.snapshots");
});
```

If the test file uses a different bootstrap helper name, match it.

- [ ] **Step 8: Run the relevant test suites**

Run: `bun test tests/core/brain.policy.test.ts tests/core/brain.init.test.ts`
Expected: ALL PASS.

- [ ] **Step 9: Commit**

Suggested commit: `feat(brain): parse vault.ignore_paths block in _brain.yaml`.

---

## Task 4: `resolveVaultScope` resolver

**Files:**
- Modify: `src/core/vault-scope/index.ts`
- Modify: `tests/core/vault-scope.test.ts`

- [ ] **Step 1: Write failing tests for `resolveVaultScope`**

Append to `tests/core/vault-scope.test.ts`:

```ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "bun:test";

import { resolveVaultScope } from "../../src/core/vault-scope/index.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-scope-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writeBrainYaml(body: string): void {
  writeFileSync(join(vault, "Brain", "_brain.yaml"), body);
}

test("resolveVaultScope: defaults when _brain.yaml is absent", () => {
  const scope = resolveVaultScope(vault);
  expect(scope.source).toBe("defaults");
  expect(scope.ignorePaths).toContain(".obsidian");
  expect(scope.ignorePaths).toContain("Brain/.snapshots");
  expect(scope.rules.find((r) => r.raw === "Brain/.snapshots")?.kind).toBe("path");
  expect(scope.rules.find((r) => r.raw === ".obsidian")?.kind).toBe("name");
});

test("resolveVaultScope: reads vault.ignore_paths when present", () => {
  writeBrainYaml(`schema_version: 1
vault:
  ignore_paths:
    - .git
    - my-cache
`);
  const scope = resolveVaultScope(vault);
  expect(scope.source).toBe("_brain.yaml");
  expect(scope.ignorePaths).toEqual([".git", "my-cache"]);
  expect(scope.rules.map((r) => r.kind)).toEqual(["name", "name"]);
});

test("resolveVaultScope: explicit empty list excludes nothing", () => {
  writeBrainYaml(`schema_version: 1
vault:
  ignore_paths:
`);
  const scope = resolveVaultScope(vault);
  expect(scope.source).toBe("_brain.yaml");
  expect(scope.ignorePaths).toEqual([]);
  expect(scope.rules).toEqual([]);
});

test("resolveVaultScope: absent vault block falls back to defaults", () => {
  writeBrainYaml(`schema_version: 1\n`);
  const scope = resolveVaultScope(vault);
  expect(scope.source).toBe("defaults");
});

test("resolveVaultScope: invalid _brain.yaml fails closed instead of defaulting", () => {
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "garbage::not yaml::");
  expect(() => resolveVaultScope(vault)).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/vault-scope.test.ts`
Expected: FAIL — `resolveVaultScope is not a function`.

- [ ] **Step 3: Implement `resolveVaultScope`**

Append to `src/core/vault-scope/index.ts`:

```ts
import { loadBrainConfig } from "../brain/policy.ts";

export interface VaultScope {
  /** Final list of paths in the order they were declared. */
  readonly ignorePaths: ReadonlyArray<string>;
  /** Same list, classified as `name | path`. */
  readonly rules: ReadonlyArray<VaultIgnoreRule>;
  readonly source: "_brain.yaml" | "defaults";
}

function classify(raw: string): VaultIgnoreRule {
  return { raw, kind: raw.includes("/") ? "path" : "name" };
}

function buildScope(
  paths: ReadonlyArray<string>,
  source: VaultScope["source"],
): VaultScope {
  const ignorePaths = Object.freeze([...paths]);
  const rules = Object.freeze(ignorePaths.map(classify));
  return Object.freeze({ ignorePaths, rules, source });
}

const DEFAULT_SCOPE = buildScope(DEFAULT_VAULT_IGNORE_PATHS, "defaults");

export function resolveVaultScope(vault: string): VaultScope {
  // Missing `_brain.yaml` is the only "silent" case — pre-v0.10.9
  // vaults stay working under built-in defaults. Anything else
  // (malformed YAML, schema mismatch, unreadable file) fails closed
  // by propagating the `BrainConfigError` to the caller; walkers
  // refuse to ingest paths the operator meant to hide.
  if (!existsSync(brainConfigPath(vault))) return DEFAULT_SCOPE;
  const cfg = loadBrainConfig(vault);
  const declared = cfg.vault?.ignore_paths;
  if (declared === undefined) return DEFAULT_SCOPE;
  return buildScope(declared, "_brain.yaml");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/core/vault-scope.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Suggested commit: `feat(vault-scope): add resolveVaultScope reading Brain/_brain.yaml`.

---

## Task 5: `walkVaultScope` and `inspectPath`

**Files:**
- Modify: `src/core/vault-scope/index.ts`
- Modify: `tests/core/vault-scope.test.ts`

- [ ] **Step 1: Write failing tests for `walkVaultScope`**

Append to `tests/core/vault-scope.test.ts`:

```ts
import { walkVaultScope, inspectPath } from "../../src/core/vault-scope/index.ts";

test("walkVaultScope: counts files+dirs and reports excluded subtree once", () => {
  mkdirSync(join(vault, "Notes"), { recursive: true });
  writeFileSync(join(vault, "Notes", "a.md"), "x");
  writeFileSync(join(vault, "Notes", "b.md"), "x");
  mkdirSync(join(vault, ".obsidian", "plugins", "foo"), { recursive: true });
  writeFileSync(join(vault, ".obsidian", "app.json"), "{}");
  writeFileSync(join(vault, ".obsidian", "plugins", "foo", "note.md"), "x");

  const scope = resolveVaultScope(vault); // uses defaults; Brain dir empty
  const walk = walkVaultScope(vault, scope);

  expect(walk.includedFiles).toBeGreaterThanOrEqual(2);
  expect(walk.excludedDirs.find((d) => d.relPath === ".obsidian")).toBeTruthy();
  // Subtree must NOT have its descendants reported separately.
  expect(walk.excludedDirs.filter((d) => d.relPath.startsWith(".obsidian/"))).toHaveLength(0);
  expect(walk.excludedDirs.find((d) => d.relPath === ".obsidian")?.rule.raw).toBe(".obsidian");
});

test("inspectPath: included path", () => {
  mkdirSync(join(vault, "Notes"), { recursive: true });
  writeFileSync(join(vault, "Notes", "idea.md"), "x");
  const scope = resolveVaultScope(vault);
  const r = inspectPath("Notes/idea.md", scope);
  expect(r.excluded).toBe(false);
});

test("inspectPath: excluded by name rule", () => {
  const scope = resolveVaultScope(vault);
  const r = inspectPath(".obsidian/plugins/foo/note.md", scope);
  expect(r.excluded).toBe(true);
  expect(r.rule?.raw).toBe(".obsidian");
  expect(r.matchedAt).toBe(".obsidian");
});

test("inspectPath: excluded by path rule", () => {
  const scope = resolveVaultScope(vault);
  const r = inspectPath("Brain/.snapshots/2026-05-19.tar.zst", scope);
  expect(r.excluded).toBe(true);
  expect(r.rule?.raw).toBe("Brain/.snapshots");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/vault-scope.test.ts`
Expected: FAIL — `walkVaultScope` and `inspectPath` not defined.

- [ ] **Step 3: Implement walker + inspector**

Append to `src/core/vault-scope/index.ts`:

```ts
import { readdirSync, statSync, realpathSync, type Dirent } from "node:fs";
import { join, sep } from "node:path";

export interface ExcludedEntry {
  readonly relPath: string;
  readonly rule: VaultIgnoreRule;
}

export interface VaultScopeWalk {
  readonly includedFiles: number;
  readonly includedDirs: number;
  readonly excludedDirs: ReadonlyArray<ExcludedEntry>;
  readonly excludedFiles: ReadonlyArray<ExcludedEntry>;
}

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

/**
 * Recursive fs walk that counts every file and directory, applies
 * the supplied scope, and records the *root* of each excluded
 * subtree (descendants are not enumerated again — see the design
 * doc §5.2).
 */
export function walkVaultScope(vault: string, scope: VaultScope): VaultScopeWalk {
  const vaultReal = (() => {
    try { return realpathSync(vault); } catch { return vault; }
  })();
  const excludedDirs: ExcludedEntry[] = [];
  const excludedFiles: ExcludedEntry[] = [];
  let includedFiles = 0;
  let includedDirs = 0;

  const seenDirs = new Set<string>([vaultReal]);

  function walk(absDir: string, relDir: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(absDir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const abs = join(absDir, entry.name);
      const rel = relDir === "" ? toPosix(entry.name) : `${relDir}/${toPosix(entry.name)}`;
      let stat;
      try { stat = statSync(abs); } catch { continue; }
      if (stat.isDirectory()) {
        const m = matchIgnore(rel, scope.rules);
        if (m.excluded && m.rule) {
          excludedDirs.push({ relPath: rel, rule: m.rule });
          continue;
        }
        // acyclic symlink guard
        let real: string;
        try { real = realpathSync(abs); } catch { continue; }
        if (real !== vaultReal && !real.startsWith(vaultReal + sep)) continue;
        if (seenDirs.has(real)) continue;
        seenDirs.add(real);
        includedDirs++;
        walk(abs, rel);
        continue;
      }
      if (!stat.isFile()) continue;
      const m = matchIgnore(rel, scope.rules);
      if (m.excluded && m.rule) {
        excludedFiles.push({ relPath: rel, rule: m.rule });
        continue;
      }
      includedFiles++;
    }
  }

  walk(vaultReal, "");

  return Object.freeze({
    includedFiles,
    includedDirs,
    excludedDirs: Object.freeze(excludedDirs),
    excludedFiles: Object.freeze(excludedFiles),
  });
}

export interface InspectResult {
  readonly relPath: string;
  readonly excluded: boolean;
  readonly rule: VaultIgnoreRule | null;
  readonly matchedAt: string | null;
  readonly source: VaultScope["source"];
}

export function inspectPath(relPath: string, scope: VaultScope): InspectResult {
  // Normalise: collapse leading "./", strip surrounding slashes, OS-native -> POSIX.
  const normalised = toPosix(relPath).replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
  if (normalised.includes("..")) {
    throw new Error(`relPath must not traverse outside the vault: ${relPath}`);
  }
  const m = matchIgnore(normalised, scope.rules);
  return Object.freeze({
    relPath: normalised,
    excluded: m.excluded,
    rule: m.rule,
    matchedAt: m.matchedAt,
    source: scope.source,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/core/vault-scope.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Suggested commit: `feat(vault-scope): add walkVaultScope and inspectPath`.

---

## Task 6: Rewire the search walker to consume rules

**Files:**
- Modify: `src/core/search/types.ts`
- Modify: `src/core/search/walker.ts`
- Modify: `tests/helpers/search-fixtures.ts`

- [ ] **Step 1: Replace `ignorePaths` with `ignoreRules` in the type**

In `src/core/search/types.ts`, find the `ResolvedSearchConfig` interface. Replace the line `readonly ignorePaths: ReadonlyArray<string>;` with:

```ts
readonly ignoreRules: ReadonlyArray<import("../vault-scope/index.ts").VaultIgnoreRule>;
```

- [ ] **Step 2: Update the test helper**

In `tests/helpers/search-fixtures.ts`, replace the body of `makeConfig` so it builds rules from the optional `ignorePaths` shortcut:

```ts
import type { VaultIgnoreRule } from "../../src/core/search/types.ts";
// (or the re-exported type path the search types ends up using)

export function makeConfig(opts: {
  vault: string;
  dbPath: string;
  ignorePaths?: ReadonlyArray<string>;
  semantic?: Partial<ResolvedEmbeddingConfig>;
}): ResolvedSearchConfig {
  // ...semantic block unchanged...
  const paths = opts.ignorePaths ?? [
    ".git",
    "node_modules",
    ".open-second-brain",
    ".obsidian",
    ".trash",
    ".stversions",
    "Brain/.snapshots",
  ];
  const ignoreRules: ReadonlyArray<VaultIgnoreRule> = Object.freeze(
    paths.map((raw) => ({ raw, kind: raw.includes("/") ? "path" as const : "name" as const })),
  );
  return Object.freeze({
    vault: opts.vault,
    dbPath: opts.dbPath,
    ignoreRules,
    chunkSize: 800,
    chunkOverlap: 100,
    keywordWeight: 0.6,
    semanticWeight: 0.4,
    semantic,
  });
}
```

Re-export `VaultIgnoreRule` from `src/core/search/types.ts` so the helper does not reach across module boundaries arbitrarily:

```ts
export type { VaultIgnoreRule } from "../vault-scope/index.ts";
```

- [ ] **Step 3: Rewrite the walker**

Replace the body of `src/core/search/walker.ts`. The exports stay (`walkVault`, `WalkedFile`). The internal `parseIgnore` helper is removed; the matcher comes from `vault-scope`:

```ts
import { readdirSync, statSync, realpathSync, type Dirent, type Stats } from "node:fs";
import { join, relative, sep } from "node:path";

import { matchIgnore } from "../vault-scope/index.ts";
import type { ResolvedSearchConfig } from "./types.ts";

export interface WalkedFile {
  readonly absPath: string;
  readonly relPath: string;
  readonly stat: Stats;
}

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

function isInsideVault(absTarget: string, vaultReal: string): boolean {
  try {
    const r = realpathSync(absTarget);
    return r === vaultReal || r.startsWith(vaultReal + sep);
  } catch {
    return false;
  }
}

export function* walkVault(config: ResolvedSearchConfig): Generator<WalkedFile> {
  const vaultReal = (() => {
    try { return realpathSync(config.vault); } catch { return config.vault; }
  })();
  const seenDirs = new Set<string>([vaultReal]);

  function* walk(dir: string): Generator<WalkedFile> {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const absPath = join(dir, entry.name);
      const relRaw = relative(vaultReal, absPath);
      if (relRaw === "" || relRaw.startsWith("..")) continue;
      const relPath = toPosix(relRaw);

      const isLinkHint = entry.isSymbolicLink();

      let stat: Stats;
      try { stat = statSync(absPath); } catch { continue; }

      if (stat.isDirectory()) {
        if (matchIgnore(relPath, config.ignoreRules).excluded) continue;
        let real: string;
        try { real = realpathSync(absPath); } catch { continue; }
        if (real !== vaultReal && !real.startsWith(vaultReal + sep)) continue;
        if (seenDirs.has(real)) continue;
        seenDirs.add(real);
        yield* walk(absPath);
        continue;
      }
      if (!stat.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith(".md")) continue;
      if (isLinkHint && !isInsideVault(absPath, vaultReal)) continue;
      // file-level rule too, in case someone configures `path/to/file.md`
      if (matchIgnore(relPath, config.ignoreRules).excluded) continue;

      yield { absPath, relPath, stat };
    }
  }

  yield* walk(vaultReal);
}
```

- [ ] **Step 4: Run walker tests to verify they pass**

Run: `bun test tests/core/search/walker.test.ts`
Expected: PASS. If any test asserts on `cfg.ignorePaths` directly (it should not after Step 2), change the assertion to read `cfg.ignoreRules.map((r) => r.raw)`.

- [ ] **Step 5: Commit**

Suggested commit: `refactor(search): consume VaultIgnoreRule via matchIgnore`.

---

## Task 7: Drop legacy env / config keys from `resolveSearchConfig`

**Files:**
- Modify: `src/core/search/index.ts`
- Modify: `tests/core/search/config.test.ts`
- Modify: `tests/core/search/store.test.ts`
- Modify: `tests/core/search/store.vec.test.ts`

- [ ] **Step 1: Update tests to assert the new behaviour**

In `tests/core/search/config.test.ts`:

1. Remove `"OPEN_SECOND_BRAIN_SEARCH_IGNORE"` from the `ENV_KEYS` array — the variable is gone.
2. Replace the existing `cfg.ignorePaths` assertions (around lines 60-61) with assertions on `cfg.ignoreRules`:

```ts
expect(cfg.ignoreRules.map((r) => r.raw)).toContain(".git");
expect(cfg.ignoreRules.map((r) => r.raw)).toContain(".open-second-brain");
```

3. Add a regression test that confirms the legacy surfaces are inert:

```ts
test("OPEN_SECOND_BRAIN_SEARCH_IGNORE has no effect (removed in v0.10.9)", () => {
  writeFileSync(configPath, `vault: "${tmp}"\n`);
  process.env["OPEN_SECOND_BRAIN_SEARCH_IGNORE"] = "foo,bar,baz";
  const cfg = resolveSearchConfig({ vault: tmp, configPath });
  expect(cfg.ignoreRules.map((r) => r.raw)).not.toContain("foo");
});

test("search_ignore_paths in config.yaml has no effect (removed in v0.10.9)", () => {
  writeFileSync(
    configPath,
    `vault: "${tmp}"\nsearch_ignore_paths: "foo,bar,baz"\n`,
  );
  const cfg = resolveSearchConfig({ vault: tmp, configPath });
  expect(cfg.ignoreRules.map((r) => r.raw)).not.toContain("foo");
});
```

4. Add a test that confirms `Brain/_brain.yaml` is read instead:

```ts
test("vault.ignore_paths in Brain/_brain.yaml is the source of truth", () => {
  mkdirSync(join(tmp, "Brain"), { recursive: true });
  writeFileSync(
    join(tmp, "Brain", "_brain.yaml"),
    `schema_version: 1
vault:
  ignore_paths:
    - my-cache
`,
  );
  writeFileSync(configPath, `vault: "${tmp}"\n`);
  const cfg = resolveSearchConfig({ vault: tmp, configPath });
  expect(cfg.ignoreRules.map((r) => r.raw)).toEqual(["my-cache"]);
});
```

Also update `tests/core/search/store.test.ts` and `tests/core/search/store.vec.test.ts`: every literal `ignorePaths: Object.freeze([".git"])` inside the inline `ResolvedSearchConfig` becomes `ignoreRules: Object.freeze([{ raw: ".git", kind: "name" as const }])`.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `bun test tests/core/search/config.test.ts`
Expected: FAIL — the legacy variable still does what it used to.

- [ ] **Step 3: Strip the legacy surfaces from the resolver**

In `src/core/search/index.ts`:

1. Delete the `DEFAULT_IGNORE_PATHS` constant (lines 46-53).
2. Delete the `parseIgnorePaths` function (lines 150-156).
3. Replace the block at lines 202-204:

```ts
const ignorePaths = parseIgnorePaths(
  envOrConfig(env, config, "OPEN_SECOND_BRAIN_SEARCH_IGNORE", "search_ignore_paths"),
);
```

with:

```ts
const scope = resolveVaultScope(opts.vault);
const ignoreRules = scope.rules;
```

4. In the final config literal (around line 256):

```ts
const base: ResolvedSearchConfig = Object.freeze({
  vault: opts.vault,
  dbPath,
  ignoreRules,            // was: ignorePaths: Object.freeze([...ignorePaths]),
  chunkSize,
  chunkOverlap,
  keywordWeight,
  semanticWeight,
  semantic,
});
```

5. Update the `Omit` / overrides type at the top of the file:

```ts
type SearchConfigOverrides = Partial<Omit<ResolvedSearchConfig, "ignoreRules" | "semantic">> & {
  readonly ignoreRules?: ReadonlyArray<VaultIgnoreRule>;
  readonly semantic?: Partial<ResolvedEmbeddingConfig>;
};
```

…and the merged-overrides return:

```ts
ignoreRules: opts.overrides.ignoreRules
  ? Object.freeze([...opts.overrides.ignoreRules])
  : base.ignoreRules,
```

6. Add the imports at the top:

```ts
import { resolveVaultScope } from "../vault-scope/index.ts";
import type { VaultIgnoreRule } from "../vault-scope/index.ts";
```

7. Re-export `VaultIgnoreRule` from this module so external callers do not learn the new path twice (optional convenience):

```ts
export type { VaultIgnoreRule } from "../vault-scope/index.ts";
```

- [ ] **Step 4: Run all search tests to verify they pass**

Run: `bun test tests/core/search/`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

Suggested commit: `feat(search)!: drop OPEN_SECOND_BRAIN_SEARCH_IGNORE / search_ignore_paths in favour of vault.ignore_paths`.

---

## Task 8: Rewire scan-inline to use the shared scope

**Files:**
- Modify: `src/core/brain/inline-scan.ts`
- Modify: `tests/core/brain.inline-scan.test.ts`
- Modify: `tests/e2e/brain-capture-and-fields.test.ts`

- [ ] **Step 1: Write failing tests for scan-inline**

Append to `tests/core/brain.inline-scan.test.ts`:

```ts
test("scan-inline skips files under .obsidian even when they contain @osb markers", async () => {
  // Build a tmp vault with `.obsidian/plugins/foo/note.md` carrying a marker.
  // The exact tmp scaffolding pattern is the one used by the existing tests
  // in this file - copy it verbatim from the closest existing case.
  const tmp = makeTempVault();
  mkdirSync(join(tmp, ".obsidian", "plugins", "foo"), { recursive: true });
  writeFileSync(
    join(tmp, ".obsidian", "plugins", "foo", "note.md"),
    `@osb feedback negative principle="x" topic=t scope=writing\n`,
  );

  const result = await scanInline(tmp, { agent: "test" });
  expect(result.found).toBe(0);
  expect(result.created).toBe(0);
});

test("scan-inline always skips Brain/ even if it contains markers (hardcoded invariant)", async () => {
  const tmp = makeTempVault();
  // Operator declares an empty ignore list - Brain is still skipped.
  mkdirSync(join(tmp, "Brain"), { recursive: true });
  writeFileSync(
    join(tmp, "Brain", "_brain.yaml"),
    `schema_version: 1\nvault:\n  ignore_paths:\n`,
  );
  writeFileSync(
    join(tmp, "Brain", "stray.md"),
    `@osb feedback positive principle="x" topic=t\n`,
  );
  const result = await scanInline(tmp, { agent: "test" });
  expect(result.found).toBe(0);
});

test("scan-inline reads vault.ignore_paths from _brain.yaml", async () => {
  const tmp = makeTempVault();
  mkdirSync(join(tmp, "Brain"), { recursive: true });
  writeFileSync(
    join(tmp, "Brain", "_brain.yaml"),
    `schema_version: 1\nvault:\n  ignore_paths:\n    - Drafts\n`,
  );
  mkdirSync(join(tmp, "Drafts"), { recursive: true });
  writeFileSync(
    join(tmp, "Drafts", "x.md"),
    `@osb feedback negative principle="x" topic=t\n`,
  );
  const result = await scanInline(tmp, { agent: "test" });
  expect(result.found).toBe(0);
});

test("scan-inline --exclude narrows further on top of the shared set", async () => {
  const tmp = makeTempVault();
  mkdirSync(join(tmp, "Notes"), { recursive: true });
  writeFileSync(
    join(tmp, "Notes", "x.md"),
    `@osb feedback negative principle="x" topic=t\n`,
  );
  const result = await scanInline(tmp, { agent: "test", exclude: ["Notes"] });
  expect(result.found).toBe(0);
});
```

Match `makeTempVault` to whatever scaffolding the existing tests in this file use; do NOT introduce a new helper if one already exists.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/core/brain.inline-scan.test.ts`
Expected: FAIL — at least the `.obsidian/plugins/foo/note.md` case fails because right now `HARD_SKIP_DIRS` includes `.obsidian`, but the new test asserting that the `_brain.yaml`-declared `Drafts` exclusion is honoured will fail.

- [ ] **Step 3: Replace the hard-coded skip list with the resolved scope**

In `src/core/brain/inline-scan.ts`:

1. Delete `HARD_SKIP_DIRS` (lines 47-55).
2. Add imports:

```ts
import { resolveVaultScope, matchIgnore, type VaultIgnoreRule } from "../vault-scope/index.ts";
```

3. Replace the body of `walkVault` (the inline generator at the bottom of the file) and the part of `scanInline` that builds `userExcludes`. The new flow:

```ts
// Inside scanInline, before calling walkVault:
const scope = resolveVaultScope(vault);
const rules: VaultIgnoreRule[] = [
  ...scope.rules,
  // Hardcoded invariant: scan-inline never recurses into Brain/.
  // Markers there would self-reference the derived layer; do not
  // expose this as a config knob.
  { raw: "Brain", kind: "name" },
  // User --exclude entries are vault-relative path prefixes.
  ...(opts.exclude ?? []).map((raw) => ({ raw: normalisePrefix(raw), kind: "path" as const })),
];

const includePrefixes = (opts.paths ?? []).map(normalisePrefix);

for (const filePath of walkVault(vault, includePrefixes, rules)) {
  // ...existing body unchanged...
}
```

`normalisePrefix` already exists in this file; it strips leading/trailing slashes and converts to OS-native separators. Replace it so it returns a POSIX path instead (since `matchIgnore` expects POSIX):

```ts
function normalisePrefix(rel: string): string {
  return rel.replace(/^\/+|\/+$/g, "").replace(/\\/g, "/");
}
```

4. Replace the walker generator at the bottom of the file:

```ts
function* walkVault(
  vault: string,
  includePrefixes: ReadonlyArray<string>,
  rules: ReadonlyArray<VaultIgnoreRule>,
): Generator<string> {
  const stack: Array<{ abs: string; rel: string }> = [{ abs: vault, rel: "" }];
  while (stack.length > 0) {
    const { abs: dir, rel: relDir } = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const relPosix = relDir === "" ? entry.name : `${relDir}/${entry.name}`;

      if (matchIgnore(relPosix, rules).excluded) continue;

      if (entry.isDirectory()) {
        // Descend; include-narrowing applies only to files.
        stack.push({ abs: full, rel: relPosix });
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".md")) continue;

      if (includePrefixes.length > 0) {
        const matches = includePrefixes.some(
          (p) => relPosix === p || relPosix.startsWith(p + "/"),
        );
        if (!matches) continue;
      }

      yield full;
    }
  }
}
```

5. Drop the `relative` and `sep` imports if no longer used in this file (they were used by the old `walkVault`); keep only what the body needs.

- [ ] **Step 4: Update the existing e2e test**

In `tests/e2e/brain-capture-and-fields.test.ts`, find the step that creates a marker file and add a second marker placed at `.obsidian/plugins/x/note.md`. After running `o2b brain scan-inline`, assert that ONLY the expected marker was captured (the obsidian one is skipped):

```ts
// In the existing scaffold where one marker file is created:
mkdirSync(join(vault, ".obsidian", "plugins", "x"), { recursive: true });
writeFileSync(
  join(vault, ".obsidian", "plugins", "x", "note.md"),
  `@osb feedback negative principle="should-not-be-captured" topic=ignored\n`,
);
// After the scan-inline run, assert no signal was created for that topic.
const inbox = readdirSync(join(vault, "Brain", "inbox"));
expect(inbox.some((f) => f.includes("ignored"))).toBe(false);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/core/brain.inline-scan.test.ts tests/e2e/brain-capture-and-fields.test.ts`
Expected: ALL PASS.

- [ ] **Step 6: Commit**

Suggested commit: `refactor(brain): scan-inline reads vault.ignore_paths from _brain.yaml`.

---

## Task 9: `o2b vault status` and `o2b vault inspect` CLI

**Files:**
- Create: `src/cli/vault.ts`
- Create: `src/cli/vault/help-text.ts`
- Create: `src/cli/vault/verbs/status.ts`
- Create: `src/cli/vault/verbs/inspect.ts`
- Modify: `src/cli/main.ts`
- Create: `tests/cli/vault.test.ts`

- [ ] **Step 1: Write failing CLI tests**

`tests/cli/vault.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-vault-cli-"));
  vault = join(tmp, "vault");
  config = join(tmp, "config.yaml");
});

afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

async function bootstrap(): Promise<void> {
  let r = await runCli(["init", "--vault", vault], { env: { OPEN_SECOND_BRAIN_CONFIG: config } });
  expect(r.returncode).toBe(0);
  r = await runCli(["brain", "init", "--vault", vault], { env: { OPEN_SECOND_BRAIN_CONFIG: config } });
  expect(r.returncode).toBe(0);
}

describe("o2b vault status", () => {
  test("prints counts and source on a fresh vault", async () => {
    await bootstrap();
    mkdirSync(join(vault, ".obsidian"), { recursive: true });
    writeFileSync(join(vault, "Notes.md"), "x");
    const r = await runCli(["vault", "status", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("ignore source: _brain.yaml");
    expect(r.stdout).toContain(".obsidian");
  });

  test("--json output is machine-readable", async () => {
    await bootstrap();
    mkdirSync(join(vault, ".obsidian"), { recursive: true });
    const r = await runCli(["vault", "status", "--vault", vault, "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.ignore_source).toBe("_brain.yaml");
    expect(payload.included.files).toBeGreaterThanOrEqual(0);
    expect(payload.excluded.dirs.some((d: any) => d.rel_path === ".obsidian")).toBe(true);
  });
});

describe("o2b vault inspect", () => {
  test("included path", async () => {
    await bootstrap();
    writeFileSync(join(vault, "idea.md"), "x");
    const r = await runCli(["vault", "inspect", "idea.md", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("status:  included");
  });

  test("excluded path by name rule", async () => {
    await bootstrap();
    const r = await runCli(
      ["vault", "inspect", ".obsidian/plugins/foo/note.md", "--vault", vault],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("status:       excluded");
    expect(r.stdout).toContain("matched rule: .obsidian (name)");
    expect(r.stdout).toContain("matched at:   .obsidian");
  });

  test("missing relpath exits 2", async () => {
    await bootstrap();
    const r = await runCli(["vault", "inspect", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(2);
  });

  test("--json shape", async () => {
    await bootstrap();
    const r = await runCli(
      ["vault", "inspect", ".obsidian/plugins/foo/note.md", "--vault", vault, "--json"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.status).toBe("excluded");
    expect(payload.matched_rule.raw).toBe(".obsidian");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/cli/vault.test.ts`
Expected: FAIL — unknown command `vault`.

- [ ] **Step 3: Create help text**

`src/cli/vault/help-text.ts`:

```ts
export const VAULT_HELP = `usage: o2b vault <verb> [options]

Vault-wide exclusion policy inspection.

verbs:
  status              Show how many files/directories the policy
                      includes and which exclusion rules fire.
  inspect <relpath>   Point-check one vault-relative path with the
                      matched rule.

The exclusion policy lives in <vault>/Brain/_brain.yaml under
\`vault.ignore_paths\` (single source of truth for every walker).
`;

export const VAULT_VERB_HELP: Record<string, string> = {
  status:
    "usage: o2b vault status [--vault <path>] [--json]\n\n" +
    "Walks the vault under the active policy and reports counts plus\n" +
    "every excluded directory with the matched rule.\n",
  inspect:
    "usage: o2b vault inspect <relpath> [--vault <path>] [--json]\n\n" +
    "Resolves the policy and runs matchIgnore against <relpath>. The\n" +
    "relpath is vault-relative (POSIX). Path traversal outside the\n" +
    "vault is rejected with exit 2.\n",
};
```

- [ ] **Step 4: Create the `status` verb**

`src/cli/vault/verbs/status.ts`:

```ts
import { defaultConfigPath } from "../../../core/config.ts";
import { resolveVaultScope, walkVaultScope } from "../../../core/vault-scope/index.ts";
import { resolveBrainVault } from "../../brain/helpers.ts";
import { fail, info, ok } from "../../output.ts";
import { parseFlags } from "../../argparse.ts";

export async function cmdVaultStatus(argv: ReadonlyArray<string>): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const cfg = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, cfg);
  const scope = resolveVaultScope(vault);
  let walk;
  try {
    walk = walkVaultScope(vault, scope);
  } catch (exc) {
    return fail(`vault status failed: ${(exc as Error).message ?? exc}`);
  }

  if (flags["json"]) {
    const payload = {
      vault,
      ignore_source: scope.source,
      rules: scope.rules.map((r) => ({ raw: r.raw, kind: r.kind })),
      included: { files: walk.includedFiles, dirs: walk.includedDirs },
      excluded: {
        dirs: walk.excludedDirs.map((d) => ({
          rel_path: d.relPath,
          rule: d.rule.raw,
          kind: d.rule.kind,
        })),
        files: walk.excludedFiles.map((f) => ({
          rel_path: f.relPath,
          rule: f.rule.raw,
          kind: f.rule.kind,
        })),
      },
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return 0;
  }

  info(`vault:         ${vault}`);
  info(`ignore source: ${scope.source}`);
  info("");
  info(`included: ${walk.includedFiles} files, ${walk.includedDirs} directories`);
  info(`excluded: ${walk.excludedDirs.length} directories, ${walk.excludedFiles.length} files`);
  if (walk.excludedDirs.length > 0) {
    info("");
    info("excluded directories:");
    for (const d of walk.excludedDirs) {
      info(`  ${d.relPath.padEnd(30)} rule ${d.rule.raw} (${d.rule.kind})`);
    }
  }
  if (walk.excludedFiles.length > 0) {
    info("");
    info("excluded files:");
    for (const f of walk.excludedFiles) {
      info(`  ${f.relPath.padEnd(30)} rule ${f.rule.raw} (${f.rule.kind})`);
    }
  }
  return 0;
}
```

(`ok` is unused above but kept available; `info` matches the existing `o2b brain status` text idiom.)

- [ ] **Step 5: Create the `inspect` verb**

`src/cli/vault/verbs/inspect.ts`:

```ts
import { defaultConfigPath } from "../../../core/config.ts";
import { inspectPath, resolveVaultScope } from "../../../core/vault-scope/index.ts";
import { resolveBrainVault } from "../../brain/helpers.ts";
import { fail, info } from "../../output.ts";
import { CliError, parseFlags } from "../../argparse.ts";

export async function cmdVaultInspect(argv: ReadonlyArray<string>): Promise<number> {
  const { flags, positional } = parseFlags(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const relpath = positional[0];
  if (!relpath) {
    process.stderr.write("error: usage: o2b vault inspect <relpath> [--vault <path>] [--json]\n");
    return 2;
  }
  const cfg = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, cfg);
  const scope = resolveVaultScope(vault);
  let result;
  try {
    result = inspectPath(relpath, scope);
  } catch (exc) {
    process.stderr.write(`error: ${(exc as Error).message ?? exc}\n`);
    return 2;
  }
  if (flags["json"]) {
    process.stdout.write(JSON.stringify({
      relpath: result.relPath,
      status: result.excluded ? "excluded" : "included",
      matched_rule: result.rule ? { raw: result.rule.raw, kind: result.rule.kind } : null,
      matched_at: result.matchedAt,
      source: result.source,
    }, null, 2) + "\n");
    return 0;
  }
  info(`relpath:      ${result.relPath}`);
  if (!result.excluded) {
    info("status:       included");
    return 0;
  }
  info("status:       excluded");
  if (result.rule) info(`matched rule: ${result.rule.raw} (${result.rule.kind})`);
  if (result.matchedAt) info(`matched at:   ${result.matchedAt}`);
  info(`source:       ${result.source}`);
  return 0;
}
```

- [ ] **Step 6: Wire up the dispatcher**

`src/cli/vault.ts`:

```ts
import { CliError } from "./argparse.ts";
import { VAULT_HELP, VAULT_VERB_HELP } from "./vault/help-text.ts";
import { cmdVaultStatus } from "./vault/verbs/status.ts";
import { cmdVaultInspect } from "./vault/verbs/inspect.ts";

export async function handleVaultSubcommand(argv: ReadonlyArray<string>): Promise<number> {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(VAULT_HELP);
    return argv.length === 0 ? 2 : 0;
  }
  const verb = argv[0]!;
  const rest = argv.slice(1);

  if (rest.length === 1 && (rest[0] === "-h" || rest[0] === "--help")) {
    const text = VAULT_VERB_HELP[verb];
    if (text) { process.stdout.write(text); return 0; }
    process.stdout.write(VAULT_HELP);
    return 2;
  }

  try {
    switch (verb) {
      case "status": return await cmdVaultStatus(rest);
      case "inspect": return await cmdVaultInspect(rest);
      default:
        process.stderr.write(`error: unknown vault verb: ${verb}\n`);
        process.stdout.write(VAULT_HELP);
        return 2;
    }
  } catch (exc) {
    if (exc instanceof CliError) { process.stderr.write(`error: ${exc.message}\n`); return 1; }
    throw exc;
  }
}
```

In `src/cli/main.ts`:

1. Add `import { handleVaultSubcommand } from "./vault.ts";` next to the other dispatchers.
2. In the `switch (command)` block, add (after `case "brain":`):

```ts
case "vault":
  return await handleVaultSubcommand(rest);
```

3. Append `vault` to the top-level `HELP` string if there is one (look for the lines listing `init`, `brain`, `search` etc. and add `  vault              Inspect the vault-wide exclusion policy`).

- [ ] **Step 7: Run tests to verify they pass**

Run: `bun test tests/cli/vault.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

Suggested commit: `feat(cli): add o2b vault status and o2b vault inspect`.

---

## Task 10: Extend `second_brain_status` with `vault` block

**Files:**
- Modify: `src/mcp/tools.ts`
- Modify: `tests/cli/mcp-scope-arg.test.ts` (or the closest existing MCP-status test)

- [ ] **Step 1: Locate the existing test that asserts `second_brain_status` shape**

Run: `grep -rn "second_brain_status" tests/ --include="*.ts"` and pick the test file that asserts on the JSON payload structure (most likely `tests/cli/mcp-scope-arg.test.ts` or a file under `tests/mcp/`). If no such test exists, create `tests/mcp/tools-status.test.ts` instead.

- [ ] **Step 2: Add a failing assertion for the new `vault` block**

Append a new test:

```ts
test("second_brain_status payload includes the vault block (v0.10.9)", async () => {
  // Reuse the test's existing helper to bootstrap a populated vault.
  const vault = await makePopulatedVault();
  const ctx = { vault, configPath: null, repoRoot: null };
  const result = await toolStatus(ctx) as Record<string, unknown>;
  expect(result.vault).toBeDefined();
  const v = result.vault as Record<string, unknown>;
  expect(v.ignore_source).toBeDefined();
  expect(Array.isArray((v as any).rules)).toBe(true);
  expect((v as any).included.files).toBeGreaterThanOrEqual(0);
  expect((v as any).excluded.dirs).toBeGreaterThanOrEqual(0);
});
```

If `toolStatus` is not directly exported, exercise the same code path through the existing MCP test harness (whichever pattern that file already uses).

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test <the chosen test file>`
Expected: FAIL — `result.vault is undefined`.

- [ ] **Step 4: Extend `toolStatus`**

In `src/mcp/tools.ts`:

1. Add imports:

```ts
import { resolveVaultScope, walkVaultScope } from "../core/vault-scope/index.ts";
```

2. Inside `toolStatus`, after the `brain` block is computed:

```ts
let vault: Record<string, unknown> | null = null;
if (vaultExists) {
  const scope = resolveVaultScope(ctx.vault);
  const walk = walkVaultScope(ctx.vault, scope);
  vault = {
    ignore_source: scope.source,
    rules: scope.rules.map((r) => ({ raw: r.raw, kind: r.kind })),
    included: { files: walk.includedFiles, dirs: walk.includedDirs },
    excluded: { dirs: walk.excludedDirs.length, files: walk.excludedFiles.length },
  };
}
```

3. In the return literal, add `...(vault ? { vault } : {})` — place it directly after the existing `vault_exists` field, before the existing `brain` / `search` spreads, so the property order matches the design doc (operator-friendly).

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test <the chosen test file>`
Expected: PASS.

- [ ] **Step 6: Commit**

Suggested commit: `feat(mcp): add vault block to second_brain_status payload`.

---

## Task 11: `o2b brain doctor` lint for missing ignore paths

**Files:**
- Modify: `src/core/brain/doctor.ts`
- Modify: `tests/core/brain.doctor.test.ts`

- [ ] **Step 1: Write the failing doctor test**

Append to `tests/core/brain.doctor.test.ts`:

```ts
test("doctor warns when vault.ignore_paths contains a missing path entry", () => {
  const vault = makeTempBrain();   // existing helper used elsewhere in this file
  writeFileSync(
    join(vault, "Brain", "_brain.yaml"),
    `schema_version: 1
vault:
  ignore_paths:
    - Brain/.snapshots
    - Notes/does-not-exist
`,
  );
  const { warnings } = runDoctor(vault);
  const missing = warnings.find((w) => w.code === "vault-ignore-missing-path");
  expect(missing).toBeDefined();
  expect(missing?.message).toContain("Notes/does-not-exist");
});

test("doctor does NOT warn about bare-name entries that have no current match", () => {
  const vault = makeTempBrain();
  writeFileSync(
    join(vault, "Brain", "_brain.yaml"),
    `schema_version: 1
vault:
  ignore_paths:
    - .git
    - node_modules
`,
  );
  const { warnings } = runDoctor(vault);
  expect(warnings.find((w) => w.code === "vault-ignore-missing-path")).toBeUndefined();
});

test("doctor does NOT warn when vault block is absent and defaults are used", () => {
  const vault = makeTempBrain();
  writeFileSync(join(vault, "Brain", "_brain.yaml"), `schema_version: 1\n`);
  const { warnings } = runDoctor(vault);
  expect(warnings.find((w) => w.code === "vault-ignore-missing-path")).toBeUndefined();
});
```

If `makeTempBrain` is named differently in this file (`bootstrapVault`, `makeFixture`, etc.), use that name verbatim.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/core/brain.doctor.test.ts`
Expected: FAIL — `vault-ignore-missing-path` code does not exist.

- [ ] **Step 3: Implement `checkVaultIgnore`**

In `src/core/brain/doctor.ts`, near the other `check*` helpers:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveVaultScope } from "../vault-scope/index.ts";

function checkVaultIgnore(vault: string, issues: DoctorIssue[]): void {
  const scope = resolveVaultScope(vault);
  if (scope.source !== "_brain.yaml") return;
  for (const rule of scope.rules) {
    if (rule.kind !== "path") continue;
    const abs = join(vault, rule.raw);
    if (existsSync(abs)) continue;
    issues.push({
      severity: "warning",
      code: "vault-ignore-missing-path",
      message:
        `vault.ignore_paths entry '${rule.raw}' does not exist in this vault`,
    });
  }
}
```

In `runDoctor`, after `checkConfig(vault, issues)`:

```ts
checkVaultIgnore(vault, issues);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/core/brain.doctor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Suggested commit: `feat(brain): doctor warns on vault.ignore_paths entries missing from disk`.

---

## Task 12: Documentation, CHANGELOG, version bump

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json`
- Run: `bun run sync-version`

- [ ] **Step 1: Add the CHANGELOG entry**

At the top of `CHANGELOG.md`, above the existing `## [0.10.8]` section, add:

```markdown
## [0.10.9] - YYYY-MM-DD

Closes the "Vault Scope" feature: a single declarative exclusion
policy in `Brain/_brain.yaml` (`vault.ignore_paths`) replaces the
per-walker rules that used to drift between the search indexer
and `scan-inline`. Operator visibility via `o2b vault status` and
`o2b vault inspect`. Brain `doctor` warns when a path-style ignore
entry points at nothing on disk. The MCP `second_brain_status`
payload gains a `vault` block.

### Removed

- `search_ignore_paths` key from the flat plugin config.
- `OPEN_SECOND_BRAIN_SEARCH_IGNORE` environment variable.
  Configure exclusions in `Brain/_brain.yaml` under
  `vault.ignore_paths`.

### Added

- `vault.ignore_paths` block in `Brain/_brain.yaml`. Single source
  of truth for every vault walker (search indexer, `scan-inline`,
  future scanners). Default set widens `.obsidian/cache` to
  `.obsidian` (the entire directory) and adds `Brain/.snapshots`
  explicitly.
- `o2b vault status` - one-shot view of how many files and
  directories the active policy includes, plus the excluded
  directories with the matched rule.
- `o2b vault inspect <relpath>` - point-check for one vault-
  relative path.
- `second_brain_status` MCP payload gains a `vault` block with the
  same counts and the rule list.
- `o2b brain doctor` warns when a path-style entry under
  `vault.ignore_paths` does not exist in the vault
  (`vault-ignore-missing-path`).

### Changed

- The search indexer and `scan-inline` walker now consume the
  shared `vault-scope` matcher; previously each had its own list
  of skip-paths. Behaviour is otherwise unchanged.

### Migration

No vault-data migration. Vaults whose `Brain/_brain.yaml` does not
include a `vault:` block continue to use the built-in default set
unchanged on this release. Vaults that used to set
`search_ignore_paths` or `OPEN_SECOND_BRAIN_SEARCH_IGNORE` should
copy the entries into `vault.ignore_paths`; the legacy surfaces
no longer have any effect.
```

Replace `YYYY-MM-DD` with the actual release date when shipping.

- [ ] **Step 2: Bump the package version**

Edit `package.json`: change `"version": "0.10.8"` to `"version": "0.10.9"`.

Run: `bun run sync-version`
Expected: writes the new version into the satellite manifests (`plugin.yaml`, `pyproject.toml`, `openclaw.plugin.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `plugins/codex/.codex-plugin/plugin.json`, `plugins/hermes/plugin.yaml`).

- [ ] **Step 3: Run the full suite to confirm green**

Run: `bun test`
Expected: ALL PASS.

Run: `bun run typecheck`
Expected: PASS (no `tsc` errors).

- [ ] **Step 4: Smoke-test on the operator's real vault**

Surface a manual verification step to the operator: from a shell on this server,

```
o2b vault status --vault /root/vault
o2b vault inspect .obsidian/community-plugins.json --vault /root/vault
o2b vault inspect Brain/active.md --vault /root/vault
```

Confirm:
- status shows `ignore source: defaults` (because the user's vault has no `vault:` block yet),
- `.obsidian/community-plugins.json` reports `excluded`, matched rule `.obsidian`,
- `Brain/active.md` reports `included`.

Optional: edit `/root/vault/Brain/_brain.yaml`, append the `vault:` block from `DEFAULT_BRAIN_CONFIG_YAML`, rerun `o2b vault status` and confirm `ignore source: _brain.yaml`.

- [ ] **Step 5: Commit**

Suggested commit: `chore(release): v0.10.9 — vault scope feature`.

---

## Self-Review

**Spec coverage check** (every section of `docs/plans/2026-05-19-vault-scope-design.md`):

- §1 Problem — context, addressed by Tasks 1-8 collectively.
- §2 Goals 1-6 — each covered:
  1. single source of truth → Tasks 3 + 4 + 7 + 8
  2. updated default set → Task 1
  3. status/inspect verbs → Task 9
  4. scan-inline reads policy + `--exclude` narrows → Task 8
  5. brain doctor warning → Task 11
  6. no vault-data migration, no MCP contract break, one release → Task 10 (additive MCP) + Task 12 (CHANGELOG, no migration script)
- §3 Non-goals — explicitly observed (no glob patterns, no legacy fallback, no GUI).
- §4 `_brain.yaml` block — Task 3.
- §5 `vault-scope` module — Tasks 1, 2, 4, 5.
- §5.1 default set — Task 1.
- §5.2 walker semantics (subtree reported once) — Task 5 (explicit test).
- §6.1 search walker — Tasks 6, 7.
- §6.2 scan-inline walker — Task 8.
- §7 CLI verbs — Task 9.
- §8 MCP block — Task 10.
- §9 doctor lint — Task 11.
- §10 breaking changes + CHANGELOG — Task 12 + Task 7 (the actual removal).
- §11 test plan items — distributed across every task that creates the corresponding test file.
- §12 out-of-scope — explicitly NOT implemented; nothing in the plan touches them.
- §13 implementation order — this plan IS that order.

**Placeholder scan:** none of "TBD / TODO / fill in / implement later / similar to Task N" present in this plan.

**Type consistency:**
- `VaultIgnoreRule.kind` is `"name" | "path"` throughout.
- `VaultScope.source` is `"_brain.yaml" | "defaults"` throughout.
- `ResolvedSearchConfig.ignoreRules` (NEW name) replaces `ignorePaths` consistently across Tasks 6 + 7.
- `BrainConfig.vault?.ignore_paths` (snake-case) is used in YAML; the TypeScript field uses the same snake-case key to mirror the YAML for the small parser.
- `excludedDirs` / `excludedFiles` shape (`{relPath, rule}`) is identical in `walkVaultScope` (Task 5), in the status verb (Task 9), and in the MCP block (Task 10).

No drift detected.

---

## Execution Handoff

Plan complete. Two execution options:

1. **Subagent-Driven (recommended)** — one fresh subagent per task, two-stage review, fast iteration. Use `superpowers:subagent-driven-development`.
2. **Inline Execution** — execute tasks in this session with checkpoints. Use `superpowers:executing-plans`.
