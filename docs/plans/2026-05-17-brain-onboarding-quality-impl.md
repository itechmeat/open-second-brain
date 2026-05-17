# v0.10.4 Brain onboarding quality — Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` (or
> `superpowers:subagent-driven-development` for fresh-context-per-task
> dispatch) to walk this plan task-by-task. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** Ship §18 (`o2b brain protect`), §4-partial (per-runtime
identity-reminder templates) and §15-partial (`o2b brain init --starter`)
from `Projects/OpenSecondBrain/Features/_summary` in one PR.

**Architecture:** Three independent slices land in dependency order.
§4 lands first because its `RuntimeTarget` resolver introduces the
runtime-naming union that §18 reuses (renamed `ProtectTarget` — narrower
membership). §18 lands second because it is the largest slice and
benefits from §4 already being on disk for tests that exercise both.
§15 lands last because its starter bundle gates on `o2b brain doctor`
being green, which means every prior change must be settled.

- **§4** lives in `src/core/identity-reminder.ts` (resolver), two new
  `templates/identity-reminder.<target>.txt` files for the two
  runtimes that call `buildReminder` (`hermes`, `openclaw`), two
  call-site sweeps (`src/openclaw/index.ts`, `plugins/hermes/__init__.py`),
  plus fixtures for TS↔Python parity. Claude Code / Codex per-runtime
  steering lives in `hooks/lib/messages.ts` (different mechanism)
  and is deferred — see design doc D5.
- **§18** lives entirely in a new module `src/core/brain/protect.ts`
  plus a CLI surface in `src/cli/brain.ts`. The manifest file
  (`<vault>/.open-second-brain/protect.lock.json`) is owned by this
  module and never touched by any other writer.
- **§15** drops a `templates/brain-starter/` tree (14 files), adds a
  `copyStarterBundle` helper to `src/core/brain/init.ts`, and surfaces
  two new flags on `o2b brain init`.

**Tech Stack:** TypeScript on Bun. No new external dependencies.
Re-uses `fs-atomic.ts`, `proper-lockfile` (already in deps),
`bun:test`, `tsc --noEmit`.

**Source of truth for behaviour:**
[`docs/plans/2026-05-17-brain-onboarding-quality-design.md`](./2026-05-17-brain-onboarding-quality-design.md).
Every task below implements a slice of that spec — on conflict the
spec wins and this plan is amended.

---

## Plan-wide conventions

These apply to every task; do not re-state per step.

- **Imports.** Production code uses `node:`-prefixed builtins
  (`node:fs`, `node:os`, `node:path`). Tests use
  `import { test, expect, describe, beforeEach, afterEach } from "bun:test"`.
  Always `.ts` extensions in cross-module imports.
- **Result shape.** New public-API return values are `Object.freeze`-d
  at the producing call site (project convention, mirrors
  `src/core/brain/query.ts`).
- **Errors.** Reuse existing typed errors when the failure mode
  matches; create one new typed error `BrainProtectError` for §18
  because its failure shape (target / vault / manifest mismatch) is
  distinct enough to warrant separate catch handling.
- **No git from this plan.** Each task ends with **Pause for review
  (no commit).** Active git is reserved for the user — see vault
  memory `project_o2b_no_active_git`.
- **No misleading fallbacks.** New CLI flags exit 2 with an explicit
  message rather than silently fall through. Unknown
  `RuntimeTarget` env value warns to stderr once and uses common
  template; it does not silently coerce.
- **Atomic writes** via `src/core/fs-atomic.ts:atomicWriteFileSync`.
  Manifest writes (§18) hold `proper-lockfile.lock(path, { retries: 3,
  factor: 2 })` to prevent torn state under concurrent `--apply`.
- **Style preferences (Brain active):**
  - `pref-no-exclamation-marks-in-docs` — no exclamation marks in
    prose strings (rendered text, error messages, comments).
  - `pref-no-simply-word` — the word "simply" is forbidden in any
    written artifact (docs, comments, log strings, tests).
- **Verification.** Every task ends with a targeted `bun test
  tests/path/to/file.test.ts` and an expected pass count. End of
  every Phase: full `bun test` + `bun run typecheck` green.
- **CHANGELOG.** Touched exactly once, in Phase 4. Do not bump in
  mid-PR — per vault memory `feedback_one_pr_one_version`.

---

## File map

New files (count: 21):

```
docs/plans/2026-05-17-brain-onboarding-quality-impl.md   # this file
src/core/brain/protect.ts                                # §18 module
src/cli/brain-protect.ts                                 # §18 CLI verb
templates/identity-reminder.hermes.txt                   # §4
templates/identity-reminder.openclaw.txt                 # §4
templates/brain-starter/preferences/pref-imperative-commit-messages.md   # §15
templates/brain-starter/preferences/pref-no-unexplained-abbreviations.md
templates/brain-starter/preferences/pref-prefer-typed-errors.md
templates/brain-starter/preferences/pref-explicit-imports-only.md
templates/brain-starter/preferences/pref-changelog-every-release.md
templates/brain-starter/preferences/pref-russian-in-chat.md
templates/brain-starter/preferences/pref-test-before-refactor.md
templates/brain-starter/preferences/pref-prefer-bun-over-npx.md
templates/brain-starter/retired/ret-tabs-over-spaces.md
templates/brain-starter/retired/ret-no-emojis-in-code.md
templates/brain-starter/retired/ret-prefer-curl-over-wget.md
templates/brain-starter/inbox/sig-2026-05-10-strict-types.md
templates/brain-starter/log/2026-05-15.md
templates/brain-starter/log/2026-05-16.md
tests/core/brain/protect.test.ts
tests/cli/brain-protect.test.ts
tests/core/brain/starter.test.ts
tests/fixtures/identity-reminder/hermes.txt
tests/fixtures/identity-reminder/openclaw.txt
```

Modified files (count: 10):

```
src/core/identity-reminder.ts                            # §4 resolver
src/core/brain/init.ts                                   # §15 helper
src/cli/brain.ts                                         # §18 + §15 wiring
src/openclaw/index.ts                                    # §4 call site
plugins/hermes/__init__.py                               # §4 Python parity
tests/core/identity-reminder.test.ts                     # §4 unit
tests/python/test_hermes_plugin.py                       # §4 Python unit
install.md                                               # all three notes
CHANGELOG.md                                             # Phase 4 only
package.json                                             # version bump Phase 4
```

Version-mirror files (touched once in Phase 4):

```
.claude-plugin/plugin.json
.codex-plugin/plugin.json
plugins/codex/.codex-plugin/plugin.json
plugins/hermes/plugin.yaml
plugin.yaml
openclaw.plugin.json
__init__.py
```

`bun run sync-version` rewrites these from `package.json`; do not
hand-edit.

---

## Phase 1 — §4-partial Per-runtime identity-reminder templates

Smallest blast radius. Lays the `RuntimeTarget` type that §18 reuses
under a narrower name.

### Task 1: Add `RuntimeTarget` type and known-target set

**Objective:** Introduce the closed union of runtime names without
yet changing resolver behaviour. Pure type addition.

**Files:**

- Modify: `src/core/identity-reminder.ts`

**Step 1: Read current state**

Run: `wc -l src/core/identity-reminder.ts` — expected 46.

**Step 2: Add the type and the const set**

Append to `src/core/identity-reminder.ts` (above
`loadReminderTemplate`):

```ts
/**
 * Closed enumeration of runtime targets the resolver knows about.
 * Adding a target is a PR-change (new template file + new union
 * member), not a runtime decision — the project deliberately ships
 * a fixed list rather than a dynamic registry. The list contains
 * exactly the runtimes that call `buildReminder` per-turn /
 * per-action; Claude Code and Codex steer through a different
 * mechanism (`hooks/lib/messages.ts`) and are intentionally not
 * here.
 */
export const KNOWN_RUNTIME_TARGETS = ["hermes", "openclaw"] as const;

export type RuntimeTarget = (typeof KNOWN_RUNTIME_TARGETS)[number];

export function isRuntimeTarget(value: string | undefined): value is RuntimeTarget {
  return (
    typeof value === "string"
    && (KNOWN_RUNTIME_TARGETS as readonly string[]).includes(value)
  );
}
```

**Step 3: Typecheck**

Run: `bun run typecheck`
Expected: 0 errors.

**Step 4: Pause for review (no commit)**

### Task 2: Test the per-target template lookup

**Objective:** Express the expected resolver behaviour as failing
tests; lock in the contract before writing the resolver.

**Files:**

- Modify: `tests/core/identity-reminder.test.ts`

**Step 1: Add fixture loader helper at top of file**

```ts
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "identity-reminder",
);

function readFixture(target: string): string {
  return readFileSync(resolve(FIXTURE_DIR, `${target}.txt`), "utf8").trimEnd();
}
```

(The fixture files do not exist yet — tests will fail with ENOENT
until Task 6 lands. That is expected.)

**Step 2: Add a describe block for per-target resolution**

```ts
describe("buildReminder per-target resolution", () => {
  test("explicit target=hermes returns hermes template body", () => {
    const out = buildReminder("test-agent", "hermes");
    expect(out).toContain("Identity: @test-agent");
    expect(out).toContain("Hermes turns are short");
  });

  test("explicit target=openclaw returns openclaw template body", () => {
    const out = buildReminder("test-agent", "openclaw");
    expect(out).toContain("OpenClaw has no session boundary");
  });

  test("no target falls back to common template", () => {
    const out = buildReminder("test-agent");
    expect(out).toContain("Identity: @test-agent");
    expect(out).not.toContain("Hermes turns are short");
    expect(out).not.toContain("OpenClaw has no session boundary");
  });
});
```

**Step 3: Run tests**

Run: `bun test tests/core/identity-reminder.test.ts`
Expected: 3 failures (signature mismatch on `buildReminder` plus
missing fixtures).

**Step 4: Pause for review (no commit)**

### Task 3: Extend `buildReminder` with target overload

**Objective:** Resolver — explicit `target` first, env second, common
fallback last. Missing per-target file falls back without warning;
unknown env value warns once and falls back.

**Files:**

- Modify: `src/core/identity-reminder.ts`

**Step 1: Replace `buildReminder` signature**

Replace the existing `buildReminder` block with:

```ts
const PER_TARGET_PATH = (target: RuntimeTarget): string =>
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "templates",
    `identity-reminder.${target}.txt`,
  );

function tryReadTargetTemplate(target: RuntimeTarget): string | null {
  try {
    return readFileSync(PER_TARGET_PATH(target), "utf8").trimEnd();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

let envWarnedOnce = false;
function resolveTargetFromEnv(): RuntimeTarget | undefined {
  const raw = process.env.O2B_TARGET;
  if (raw === undefined || raw === "") return undefined;
  if (isRuntimeTarget(raw)) return raw;
  if (!envWarnedOnce) {
    envWarnedOnce = true;
    process.stderr.write(
      `open-second-brain: unknown O2B_TARGET='${raw}', using common identity template\n`,
    );
  }
  return undefined;
}

export function buildReminder(agent: string, target?: RuntimeTarget): string {
  const effective = target ?? resolveTargetFromEnv();
  if (effective !== undefined) {
    const tpl = tryReadTargetTemplate(effective);
    if (tpl !== null) return tpl.replace(/\{agent\}/g, agent);
  }
  return loadReminderTemplate().replace(/\{agent\}/g, agent);
}
```

**Step 2: Reset the env-warned flag (test-only export)**

Append:

```ts
/** Test-only: reset internal warn-once latch. */
export function __resetEnvWarnedOnceForTests(): void {
  envWarnedOnce = false;
}
```

**Step 3: Typecheck**

Run: `bun run typecheck`
Expected: 0 errors.

**Step 4: Run resolver tests**

Run: `bun test tests/core/identity-reminder.test.ts`
Expected: 3 failures (fixtures still missing — error now is
`ENOENT` on the per-target template files). The resolver code is
correct; the failure mode confirms it reached the template-read
path.

**Step 5: Pause for review (no commit)**

### Task 4: Create the two per-target template files

**Objective:** Final text content per the design doc §4-partial
section. Each file is plain text, 5–7 lines, single `{agent}`
placeholder. Claude Code and Codex template files are intentionally
**not** created — their steering goes through `hooks/lib/messages.ts`,
which is a separate mechanism tracked under design doc D5.

**Files:**

- Create: `templates/identity-reminder.hermes.txt`
- Create: `templates/identity-reminder.openclaw.txt`

**Step 1: Write `identity-reminder.hermes.txt`**

```text
[open-second-brain] Identity: @{agent}. After every durable artifact this turn — code shipped, bug fixed, config or deployment change, instruction-file edit, content artifact created, research finding or design decision reached, investigation that surfaced a fact future sessions should know — call the event_log_append tool with the plain event description as `message`. The server prepends timestamp and `@{agent}` automatically, do not include them yourself. Hermes turns are short; do not batch the log calls across turns. Skip pure discussion, exploration, read-only queries, and planning that hasn't yet produced an artifact.
```

**Step 2: Write `identity-reminder.openclaw.txt`**

```text
[open-second-brain] Identity: @{agent}. After every durable in-process action — code shipped, bug fixed, config or deployment change, instruction-file edit, content artifact created, research finding or design decision reached, investigation that surfaced a fact future sessions should know — call the event_log_append tool with the plain event description as `message`. The server prepends timestamp and `@{agent}` automatically, do not include them yourself. OpenClaw has no session boundary; log immediately. Skip pure discussion, exploration, read-only queries, and planning that hasn't yet produced an artifact.
```

**Step 3: Pause for review (no commit)**

### Task 5: Write parity fixtures and confirm tests pass

**Objective:** Pin the expected output per (agent, target) so TS and
Python diverging is caught by tests on both sides.

**Files:**

- Create: `tests/fixtures/identity-reminder/hermes.txt`
- Create: `tests/fixtures/identity-reminder/openclaw.txt`

**Step 1: Generate each fixture from the matching template**

For each `<target>` in `hermes`, `openclaw`, copy
`templates/identity-reminder.<target>.txt` to
`tests/fixtures/identity-reminder/<target>.txt` and substitute
`{agent}` → `test-agent`.

**Step 2: Add fixture-parity tests**

Append to `tests/core/identity-reminder.test.ts`:

```ts
describe("buildReminder fixture parity", () => {
  for (const target of KNOWN_RUNTIME_TARGETS) {
    test(`agent=test-agent target=${target} matches fixture`, () => {
      const expected = readFixture(target);
      const actual = buildReminder("test-agent", target);
      expect(actual).toBe(expected);
    });
  }
});
```

Add the matching import at the top:

```ts
import { buildReminder, KNOWN_RUNTIME_TARGETS } from "../../src/core/identity-reminder.ts";
```

**Step 3: Run targeted tests**

Run: `bun test tests/core/identity-reminder.test.ts`
Expected: 5 tests pass (3 from Task 2 + 2 parity).

**Step 4: Pause for review (no commit)**

### Task 6: Test env-based resolution

**Objective:** Cover `O2B_TARGET` env path and unknown-value warn.

**Files:**

- Modify: `tests/core/identity-reminder.test.ts`

**Step 1: Add env-resolution tests**

```ts
describe("buildReminder env-based resolution", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.O2B_TARGET;
    __resetEnvWarnedOnceForTests();
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.O2B_TARGET;
    else process.env.O2B_TARGET = savedEnv;
  });

  test("env O2B_TARGET=openclaw resolves to openclaw template", () => {
    process.env.O2B_TARGET = "openclaw";
    expect(buildReminder("test-agent")).toContain("OpenClaw has no session boundary");
  });

  test("explicit target beats env", () => {
    process.env.O2B_TARGET = "openclaw";
    expect(buildReminder("test-agent", "hermes")).toContain(
      "Hermes turns are short",
    );
  });

  test("unknown env value falls back to common template", () => {
    process.env.O2B_TARGET = "nonsense";
    const out = buildReminder("test-agent");
    expect(out).not.toContain("Hermes turns are short");
    expect(out).not.toContain("OpenClaw has no session boundary");
  });
});
```

Add the matching import:

```ts
import {
  buildReminder,
  KNOWN_RUNTIME_TARGETS,
  __resetEnvWarnedOnceForTests,
} from "../../src/core/identity-reminder.ts";
```

**Step 2: Run targeted tests**

Run: `bun test tests/core/identity-reminder.test.ts`
Expected: 8 tests pass.

**Step 3: Pause for review (no commit)**

### Task 7: Wire OpenClaw call site

**Objective:** OpenClaw passes `target: "openclaw"` explicitly; no
env dependency in-process.

**Files:**

- Modify: `src/openclaw/index.ts`

**Step 1: Locate the `buildReminder` call**

Run: `grep -n "buildReminder" src/openclaw/index.ts`

**Step 2: Pass the target argument**

Change `buildReminder(agent)` to `buildReminder(agent, "openclaw")`.
Import the type if not already imported.

**Step 3: Build OpenClaw bundle**

Run: `bun run build:openclaw`
Expected: success, `openclaw/index.js` rebuilt.

**Step 4: Run OpenClaw tests**

Run: `bun test tests/openclaw/`
Expected: all pre-existing tests still pass; one of them (whichever
asserts the reminder body) now matches the openclaw-specific text.
If a test asserts a substring like "Hermes turns are short" or
similar runtime-specific text from the common template, update it
to assert the OpenClaw substring "OpenClaw has no session boundary".

**Step 5: Pause for review (no commit)**

### Task 8: Verify MCP instructions are out of scope

**Objective:** Confirm by re-grep that `src/mcp/instructions.ts` and
the rest of `src/mcp/` do not call `buildReminder` — so they are
correctly out of scope for §4-partial. No code change.

The MCP `initialize.instructions` field describes the Brain tool
surface (`brain_feedback`, `brain_apply_evidence`, …) and is
independent prose, not the per-turn identity reminder. Per-runtime
text for Claude Code / Codex is deferred (design doc D5) because it
lives in `hooks/lib/messages.ts:postWriteReminder`, which is a
post-tool-call mechanism, not a per-turn injection.

**Step 1: Confirm the grep returns no MCP hits**

Run: `grep -rn "buildReminder" src/mcp/`
Expected: no output (zero matches).

**Step 2: If the grep returns hits, stop and escalate**

A non-empty result means the assumption underlying this
narrow-scope decision has changed. Stop and re-discuss with the
user before proceeding.

**Step 3: Pause for review (no commit)**

### Task 9: Python shim parity — Hermes plugin

**Objective:** `plugins/hermes/__init__.py` mirrors the TS resolver:
read `templates/identity-reminder.hermes.txt` when present, fall
back to `templates/identity-reminder.txt`.

**Files:**

- Modify: `plugins/hermes/__init__.py`

**Step 1: Locate the reminder-loading code**

Run: `grep -n "identity-reminder" plugins/hermes/__init__.py`

**Step 2: Add target resolver helper**

Insert near the top:

```python
_KNOWN_TARGETS = frozenset({"hermes", "claudecode", "codex", "openclaw"})


def _resolve_target() -> str | None:
    """Mirror src/core/identity-reminder.ts:resolveTargetFromEnv."""
    import os
    raw = os.environ.get("O2B_TARGET")
    if raw and raw in _KNOWN_TARGETS:
        return raw
    return None
```

**Step 3: Update the template-loading function**

Wrap the existing common-template `Path(...) / "identity-reminder.txt"`
read with a per-target check. The Hermes shim runs inside Hermes
itself; pass `target="hermes"` explicitly rather than via env so
the behaviour is deterministic regardless of how Hermes invokes
plugins.

```python
def _load_reminder_template() -> str:
    target = "hermes"  # always; this plugin runs inside Hermes
    target_path = TEMPLATES_DIR / f"identity-reminder.{target}.txt"
    if target_path.is_file():
        return target_path.read_text(encoding="utf-8").rstrip()
    return COMMON_TEMPLATE_PATH.read_text(encoding="utf-8").rstrip()
```

(Variable names depend on the existing file; preserve them.)

**Step 4: Pause for review (no commit)**

### Task 10: Python shim test

**Objective:** Pin the Python output against the same fixture as TS,
so divergence breaks both languages' CI.

**Files:**

- Modify: `tests/python/test_hermes_plugin.py`

**Step 1: Add a fixture-parity test**

```python
def test_reminder_matches_typescript_fixture():
    from pathlib import Path
    from plugins.hermes import _load_reminder_template

    raw = _load_reminder_template().replace("{agent}", "test-agent")
    fixture = (
        Path(__file__).resolve().parents[1]
        / "fixtures"
        / "identity-reminder"
        / "hermes.txt"
    ).read_text(encoding="utf-8").rstrip()
    assert raw == fixture
```

(Adapt the import path to wherever `_load_reminder_template` is
exposed — it may need a small re-export from `plugins/hermes/__init__.py`.)

**Step 2: Run Python tests**

Run: `python3 -m unittest tests.python.test_hermes_plugin`
Expected: all tests pass, including the new parity one.

**Step 3: Pause for review (no commit)**

### Task 11: Phase 1 close — full green

**Step 1: Run the full TS test suite**

Run: `bun test`
Expected: every test passes.

**Step 2: Typecheck**

Run: `bun run typecheck`
Expected: 0 errors.

**Step 3: Python tests**

Run: `python3 -m unittest discover tests/python/`
Expected: all pass.

**Step 4: Pause for review (no commit)**

---

## Phase 2 — §18 `o2b brain protect`

Largest slice. Pure renderer first (no IO), then IO surfaces, then
CLI wiring.

### Task 12: Skeleton — types and `BrainProtectError`

**Objective:** Define the public surface of `src/core/brain/protect.ts`
without behaviour. Compilable, importable, no tests yet.

**Files:**

- Create: `src/core/brain/protect.ts`

**Step 1: Author the skeleton**

```ts
/**
 * §18 of the OSB features summary: machine-enforced write protection
 * for Brain/preferences/, retired/, log/, .snapshots/ and
 * Brain/_brain.yaml against runtimes whose native config supports
 * path-level deny rules. Brain/inbox/ stays writable.
 */

export const PROTECT_TARGETS = ["claudecode", "codex"] as const;
export type ProtectTarget = (typeof PROTECT_TARGETS)[number];

export class BrainProtectError extends Error {
  constructor(
    message: string,
    readonly cause?: { code: string; detail?: unknown },
  ) {
    super(message);
    this.name = "BrainProtectError";
  }
}

export interface ProtectRule {
  readonly kind: "deny" | "allow";
  readonly action: "Write" | "Edit";
  readonly path: string;
}

export interface RenderedSnippet {
  readonly target: ProtectTarget;
  readonly body: string;
  readonly destination: string;
}

export interface ApplyResult {
  readonly target: ProtectTarget;
  readonly destination: string;
  readonly backupPath: string;
  readonly changed: boolean;
}

export const PROTECT_SCHEMA_VERSION = 1;
```

**Step 2: Typecheck**

Run: `bun run typecheck`
Expected: 0 errors.

**Step 3: Pause for review (no commit)**

### Task 13: Pure rule set — `buildProtectRules(vault)`

**Objective:** Vault → 6 deterministic rules. Pure, no IO.

**Files:**

- Modify: `src/core/brain/protect.ts`
- Create: `tests/core/brain/protect.test.ts`

**Step 1: Write the failing test**

```ts
import { test, expect, describe } from "bun:test";
import { buildProtectRules } from "../../../src/core/brain/protect.ts";

describe("buildProtectRules", () => {
  test("returns 6 rules in stable order for a given vault", () => {
    const rules = buildProtectRules("/vault");
    expect(rules).toHaveLength(11); // 5 deny paths × 2 actions + 1 allow
    expect(rules[0]).toEqual({
      kind: "deny",
      action: "Write",
      path: "/vault/Brain/preferences/**",
    });
    const last = rules[rules.length - 1];
    expect(last).toEqual({
      kind: "allow",
      action: "Write",
      path: "/vault/Brain/inbox/**",
    });
  });
});
```

**Step 2: Run — expect failure**

Run: `bun test tests/core/brain/protect.test.ts`
Expected: FAIL — `buildProtectRules is not exported`.

**Step 3: Implement**

Append to `src/core/brain/protect.ts`:

```ts
import { join } from "node:path";

const DENY_PATHS = [
  "Brain/preferences/**",
  "Brain/retired/**",
  "Brain/log/**",
  "Brain/.snapshots/**",
  "Brain/_brain.yaml",
] as const;

const ALLOW_PATHS = ["Brain/inbox/**"] as const;

export function buildProtectRules(vault: string): ReadonlyArray<ProtectRule> {
  const rules: ProtectRule[] = [];
  for (const rel of DENY_PATHS) {
    for (const action of ["Write", "Edit"] as const) {
      rules.push({ kind: "deny", action, path: join(vault, rel) });
    }
  }
  for (const rel of ALLOW_PATHS) {
    rules.push({ kind: "allow", action: "Write", path: join(vault, rel) });
  }
  return Object.freeze(rules);
}
```

**Step 4: Run — expect pass**

Run: `bun test tests/core/brain/protect.test.ts`
Expected: 1 pass.

**Step 5: Pause for review (no commit)**

### Task 14: Renderer for Claude Code

**Objective:** Pure function: rules → JSON snippet shape that
`<vault>/.claude/settings.json` would receive. Includes the managed
manifest payload separately.

**Files:**

- Modify: `src/core/brain/protect.ts`
- Modify: `tests/core/brain/protect.test.ts`

**Step 1: Write the failing test**

```ts
import { renderClaudeCode } from "../../../src/core/brain/protect.ts";

describe("renderClaudeCode", () => {
  test("emits a snippet with deny + allow arrays and a manifest", () => {
    const rules = buildProtectRules("/vault");
    const out = renderClaudeCode(rules);
    expect(out.snippet).toEqual({
      permissions: {
        deny: expect.arrayContaining([
          "Write(/vault/Brain/preferences/**)",
          "Edit(/vault/Brain/preferences/**)",
        ]),
        allow: ["Write(/vault/Brain/inbox/**)"],
      },
    });
    expect(out.manifest).toEqual({
      schema_version: 1,
      target: "claudecode",
      vault: "/vault",
      owned_deny: expect.any(Array),
      owned_allow: ["Write(/vault/Brain/inbox/**)"],
    });
    expect(out.manifest.owned_deny).toHaveLength(10);
  });
});
```

**Step 2: Run — expect failure (import error)**

Run: `bun test tests/core/brain/protect.test.ts`
Expected: FAIL.

**Step 3: Implement**

```ts
export interface ClaudeCodeRender {
  readonly snippet: {
    permissions: { deny: string[]; allow: string[] };
  };
  readonly manifest: {
    schema_version: number;
    target: "claudecode";
    vault: string;
    owned_deny: string[];
    owned_allow: string[];
  };
}

export function renderClaudeCode(
  rules: ReadonlyArray<ProtectRule>,
  vault: string = inferVault(rules),
): ClaudeCodeRender {
  const deny = rules
    .filter((r) => r.kind === "deny")
    .map((r) => `${r.action}(${r.path})`);
  const allow = rules
    .filter((r) => r.kind === "allow")
    .map((r) => `${r.action}(${r.path})`);
  return Object.freeze({
    snippet: { permissions: { deny, allow } },
    manifest: {
      schema_version: PROTECT_SCHEMA_VERSION,
      target: "claudecode" as const,
      vault,
      owned_deny: deny,
      owned_allow: allow,
    },
  });
}

function inferVault(rules: ReadonlyArray<ProtectRule>): string {
  const first = rules[0];
  if (!first) {
    throw new BrainProtectError("renderClaudeCode requires at least one rule");
  }
  return first.path.split("/Brain/")[0]!;
}
```

**Step 4: Run — expect pass**

Run: `bun test tests/core/brain/protect.test.ts`
Expected: 2 passes.

**Step 5: Pause for review (no commit)**

### Task 15: Renderer for Codex

**Objective:** Pure function: rules → TOML body wrapped in the
managed-block fence. Includes `[permissions.osb_protected.filesystem]`
plus `default_permissions = "osb_protected"`.

**Files:**

- Modify: `src/core/brain/protect.ts`
- Modify: `tests/core/brain/protect.test.ts`

**Step 1: Write failing test**

```ts
import { renderCodex } from "../../../src/core/brain/protect.ts";

describe("renderCodex", () => {
  test("emits TOML wrapped in osb fence with right keys", () => {
    const rules = buildProtectRules("/vault");
    const out = renderCodex(rules);
    expect(out.body).toContain("# >>> open-second-brain managed >>>");
    expect(out.body).toContain("# <<< open-second-brain managed <<<");
    expect(out.body).toContain("[permissions.osb_protected.filesystem]");
    expect(out.body).toContain('"/vault/Brain/preferences/**" = "none"');
    expect(out.body).toContain('"/vault/Brain/inbox/**" = "write"');
    expect(out.body).toContain('default_permissions = "osb_protected"');
    expect(out.body).toContain(`schema_version = ${PROTECT_SCHEMA_VERSION}`);
  });
});
```

**Step 2: Run — expect failure**

Run: `bun test tests/core/brain/protect.test.ts`
Expected: FAIL.

**Step 3: Implement**

```ts
const FENCE_OPEN = "# >>> open-second-brain managed >>>";
const FENCE_CLOSE = "# <<< open-second-brain managed <<<";

export interface CodexRender {
  readonly body: string;
}

export function renderCodex(rules: ReadonlyArray<ProtectRule>): CodexRender {
  const lines: string[] = [
    FENCE_OPEN,
    `# schema_version = ${PROTECT_SCHEMA_VERSION}`,
    `default_permissions = "osb_protected"`,
    "",
    "[permissions.osb_protected.filesystem]",
  ];
  for (const r of rules) {
    const value = r.kind === "deny" ? "none" : "write";
    lines.push(`"${r.path}" = "${value}"`);
  }
  lines.push(FENCE_CLOSE);
  return Object.freeze({ body: lines.join("\n") + "\n" });
}
```

**Step 4: Run — expect pass**

Run: `bun test tests/core/brain/protect.test.ts`
Expected: 3 passes.

**Step 5: Pause for review (no commit)**

### Task 16: Manifest read / write helpers

**Objective:** Read and write `<vault>/.open-second-brain/protect.lock.json`
atomically; reject malformed manifests.

**Files:**

- Modify: `src/core/brain/protect.ts`
- Modify: `tests/core/brain/protect.test.ts`

**Step 1: Write failing tests**

```ts
import { mkdtempSync } from "node:fs";
import { join, tmpdir } from "node:os"; // adjust to "node:path"
import { readManifest, writeManifest } from "../../../src/core/brain/protect.ts";

describe("manifest", () => {
  test("round-trip claudecode manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "osb-protect-"));
    const m = {
      schema_version: 1,
      target: "claudecode" as const,
      vault: dir,
      owned_deny: ["Write(/v/Brain/preferences/**)"],
      owned_allow: ["Write(/v/Brain/inbox/**)"],
    };
    writeManifest(dir, m);
    expect(readManifest(dir, "claudecode")).toEqual(m);
  });

  test("reading absent manifest returns null", () => {
    const dir = mkdtempSync(join(tmpdir(), "osb-protect-"));
    expect(readManifest(dir, "claudecode")).toBeNull();
  });

  test("higher schema_version on disk throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "osb-protect-"));
    writeManifest(dir, {
      schema_version: 999,
      target: "claudecode",
      vault: dir,
      owned_deny: [],
      owned_allow: [],
    });
    expect(() => readManifest(dir, "claudecode")).toThrow(BrainProtectError);
  });
});
```

(Adjust the `node:os` / `node:path` import as needed.)

**Step 2: Run — expect failure**

Run: `bun test tests/core/brain/protect.test.ts`

**Step 3: Implement**

```ts
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { atomicWriteFileSync } from "./../fs-atomic.ts";

const MANIFEST_DIR = ".open-second-brain";
const MANIFEST_FILE = "protect.lock.json";

function manifestPath(vault: string): string {
  return join(vault, MANIFEST_DIR, MANIFEST_FILE);
}

interface ManifestRecordClaudeCode {
  schema_version: number;
  target: "claudecode";
  vault: string;
  owned_deny: string[];
  owned_allow: string[];
}

interface ManifestRecordCodex {
  schema_version: number;
  target: "codex";
  vault: string;
  // For Codex, the fence is enough; we keep target presence for
  // symmetry but do not need owned_* fields.
}

type ManifestRecord = ManifestRecordClaudeCode | ManifestRecordCodex;

export function readManifest(
  vault: string,
  target: ProtectTarget,
): ManifestRecord | null {
  const path = manifestPath(vault);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new BrainProtectError(`malformed manifest at ${path}`, {
      code: "MANIFEST_MALFORMED",
      detail: err,
    });
  }
  const all = parsed as { entries?: ManifestRecord[] } | undefined;
  const entry = all?.entries?.find((e) => e.target === target);
  if (!entry) return null;
  if (entry.schema_version > PROTECT_SCHEMA_VERSION) {
    throw new BrainProtectError(
      `manifest schema_version ${entry.schema_version} is newer than this binary (${PROTECT_SCHEMA_VERSION}); run \`o2b update\``,
      { code: "MANIFEST_NEWER_SCHEMA" },
    );
  }
  return entry;
}

export function writeManifest(vault: string, entry: ManifestRecord): void {
  const path = manifestPath(vault);
  mkdirSync(join(vault, MANIFEST_DIR), { recursive: true });
  const existing: { entries: ManifestRecord[] } = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : { entries: [] };
  const others = existing.entries.filter((e) => e.target !== entry.target);
  const next = { entries: [...others, entry] };
  atomicWriteFileSync(path, JSON.stringify(next, null, 2) + "\n");
}

export function removeManifestEntry(vault: string, target: ProtectTarget): void {
  const path = manifestPath(vault);
  if (!existsSync(path)) return;
  const existing: { entries: ManifestRecord[] } = JSON.parse(
    readFileSync(path, "utf8"),
  );
  const next = { entries: existing.entries.filter((e) => e.target !== target) };
  atomicWriteFileSync(path, JSON.stringify(next, null, 2) + "\n");
}
```

**Step 4: Run — expect pass**

Run: `bun test tests/core/brain/protect.test.ts`
Expected: 6 passes.

**Step 5: Pause for review (no commit)**

### Task 17: `applyClaudeCode` — write settings.json + manifest

**Objective:** Idempotent `--apply` for Claude Code. Reads existing
`<vault>/.claude/settings.json`, merges OSB-owned entries (replacing
any owned-by-prior-manifest), writes manifest, backs up old file.

**Files:**

- Modify: `src/core/brain/protect.ts`
- Modify: `tests/core/brain/protect.test.ts`

**Step 1: Write failing tests**

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { applyProtect, unprotect } from "../../../src/core/brain/protect.ts";

describe("applyProtect claudecode", () => {
  test("creates settings.json + manifest on a fresh vault", () => {
    const dir = mkdtempSync(join(tmpdir(), "osb-protect-"));
    const res = applyProtect({ target: "claudecode", vault: dir });
    expect(res.changed).toBe(true);
    const settings = JSON.parse(
      readFileSync(join(dir, ".claude", "settings.json"), "utf8"),
    );
    expect(settings.permissions.deny).toContain(
      `Write(${dir}/Brain/preferences/**)`,
    );
  });

  test("idempotent: second apply produces byte-identical settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "osb-protect-"));
    applyProtect({ target: "claudecode", vault: dir });
    const first = readFileSync(join(dir, ".claude", "settings.json"), "utf8");
    applyProtect({ target: "claudecode", vault: dir });
    const second = readFileSync(join(dir, ".claude", "settings.json"), "utf8");
    expect(second).toBe(first);
  });

  test("preserves user-authored permissions on apply", () => {
    const dir = mkdtempSync(join(tmpdir(), "osb-protect-"));
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({
        permissions: { deny: ["Bash(rm -rf /)"], allow: [] },
      }),
    );
    applyProtect({ target: "claudecode", vault: dir });
    const settings = JSON.parse(
      readFileSync(join(dir, ".claude", "settings.json"), "utf8"),
    );
    expect(settings.permissions.deny).toContain("Bash(rm -rf /)");
    expect(settings.permissions.deny).toContain(
      `Write(${dir}/Brain/preferences/**)`,
    );
  });
});
```

**Step 2: Run — expect failure**

Run: `bun test tests/core/brain/protect.test.ts`

**Step 3: Implement**

```ts
export interface ApplyOptions {
  readonly target: ProtectTarget;
  readonly vault: string;
}

export function applyProtect(opts: ApplyOptions): ApplyResult {
  switch (opts.target) {
    case "claudecode": return applyClaudeCode(opts.vault);
    case "codex":      return applyCodex(opts.vault);
  }
}

function applyClaudeCode(vault: string): ApplyResult {
  ensureVaultBootstrapped(vault);
  const rules = buildProtectRules(vault);
  const rendered = renderClaudeCode(rules, vault);
  const dest = join(vault, ".claude", "settings.json");
  mkdirSync(join(vault, ".claude"), { recursive: true });

  const prev = readManifest(vault, "claudecode") as ManifestRecordClaudeCode | null;
  const before = existsSync(dest) ? readFileSync(dest, "utf8") : "{}";
  const settings = JSON.parse(before);
  settings.permissions ??= { deny: [], allow: [] };
  settings.permissions.deny ??= [];
  settings.permissions.allow ??= [];

  // Remove prior owned entries.
  const priorDeny = prev?.owned_deny ?? [];
  const priorAllow = prev?.owned_allow ?? [];
  settings.permissions.deny = settings.permissions.deny.filter(
    (e: string) => !priorDeny.includes(e),
  );
  settings.permissions.allow = settings.permissions.allow.filter(
    (e: string) => !priorAllow.includes(e),
  );

  // Add new owned entries, deduping against user-authored same-string.
  for (const e of rendered.snippet.permissions.deny) {
    if (!settings.permissions.deny.includes(e)) {
      settings.permissions.deny.push(e);
    }
  }
  for (const e of rendered.snippet.permissions.allow) {
    if (!settings.permissions.allow.includes(e)) {
      settings.permissions.allow.push(e);
    }
  }

  const after = JSON.stringify(settings, null, 2) + "\n";
  const changed = after !== before;
  const backupPath = `${dest}.bak.${Date.now()}`;
  if (changed && existsSync(dest)) {
    writeFileSync(backupPath, before);
  }
  atomicWriteFileSync(dest, after);
  writeManifest(vault, rendered.manifest);
  return Object.freeze({
    target: "claudecode",
    destination: dest,
    backupPath: changed ? backupPath : "",
    changed,
  });
}

function ensureVaultBootstrapped(vault: string): void {
  if (!existsSync(join(vault, "Brain"))) {
    throw new BrainProtectError(
      `vault at ${vault} has no Brain/ directory; run \`o2b brain init\` first`,
      { code: "VAULT_NOT_BOOTSTRAPPED" },
    );
  }
}
```

Note: tests need to `mkdirSync(join(vault, "Brain"), { recursive: true })`
before calling `applyProtect` because of the bootstrap check. Update
the failing tests in Step 1 accordingly before Step 3.

**Step 4: Run — expect pass**

Run: `bun test tests/core/brain/protect.test.ts`
Expected: 9 passes.

**Step 5: Pause for review (no commit)**

### Task 18: `unprotect` for Claude Code

**Objective:** Round-trip: protect → unprotect → byte-equal pre-protect
state (modulo backup files).

**Files:**

- Modify: `src/core/brain/protect.ts`
- Modify: `tests/core/brain/protect.test.ts`

**Step 1: Failing test**

```ts
describe("unprotect claudecode", () => {
  test("round-trip restores settings.json to pre-protect content", () => {
    const dir = mkdtempSync(join(tmpdir(), "osb-protect-"));
    mkdirSync(join(dir, "Brain"), { recursive: true });
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const userSettings = JSON.stringify(
      { permissions: { deny: ["Bash(rm -rf /)"], allow: [] } },
      null,
      2,
    ) + "\n";
    writeFileSync(join(dir, ".claude", "settings.json"), userSettings);

    applyProtect({ target: "claudecode", vault: dir });
    unprotect({ target: "claudecode", vault: dir });

    const after = readFileSync(join(dir, ".claude", "settings.json"), "utf8");
    expect(after).toBe(userSettings);
  });

  test("unprotect on absent manifest exits without throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "osb-protect-"));
    mkdirSync(join(dir, "Brain"), { recursive: true });
    expect(() => unprotect({ target: "claudecode", vault: dir })).not.toThrow();
  });
});
```

**Step 2: Run — expect failure**

**Step 3: Implement**

```ts
export interface UnprotectOptions {
  readonly target: ProtectTarget;
  readonly vault: string;
}

export function unprotect(opts: UnprotectOptions): void {
  switch (opts.target) {
    case "claudecode": return unprotectClaudeCode(opts.vault);
    case "codex":      return unprotectCodex(opts.vault);
  }
}

function unprotectClaudeCode(vault: string): void {
  const dest = join(vault, ".claude", "settings.json");
  const prev = readManifest(vault, "claudecode") as
    | ManifestRecordClaudeCode
    | null;
  if (!prev || !existsSync(dest)) return;

  const raw = readFileSync(dest, "utf8");
  const parsed = JSON.parse(raw);
  if (parsed?.permissions?.deny) {
    parsed.permissions.deny = parsed.permissions.deny.filter(
      (e: string) => !prev.owned_deny.includes(e),
    );
  }
  if (parsed?.permissions?.allow) {
    parsed.permissions.allow = parsed.permissions.allow.filter(
      (e: string) => !prev.owned_allow.includes(e),
    );
  }
  // If permissions is now { deny: [], allow: [] }, leave it — that
  // matches what the user's settings.json would look like after they
  // remove all rules manually. Do not delete the key.

  const after = JSON.stringify(parsed, null, 2) + "\n";
  atomicWriteFileSync(dest, after);
  removeManifestEntry(vault, "claudecode");
}
```

**Step 4: Run — expect pass**

Run: `bun test tests/core/brain/protect.test.ts`
Expected: 11 passes.

**Step 5: Pause for review (no commit)**

### Task 19: `applyCodex` — patch `~/.codex/config.toml` fence

**Objective:** Locate (or create) `~/.codex/config.toml`, inject the
managed fence emitted by `renderCodex`. Re-apply replaces the fence
content; outside-fence content untouched.

**Files:**

- Modify: `src/core/brain/protect.ts`
- Modify: `tests/core/brain/protect.test.ts`

**Step 1: Failing test**

```ts
describe("applyProtect codex", () => {
  test("creates config.toml with the managed fence on a fresh user home", () => {
    const home = mkdtempSync(join(tmpdir(), "osb-codex-home-"));
    const vault = mkdtempSync(join(tmpdir(), "osb-codex-vault-"));
    mkdirSync(join(vault, "Brain"), { recursive: true });
    const res = applyProtect({
      target: "codex",
      vault,
      __homeOverride: home, // test seam
    } as ApplyOptions & { __homeOverride?: string });
    expect(res.changed).toBe(true);
    const config = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(config).toContain("# >>> open-second-brain managed >>>");
    expect(config).toContain("[permissions.osb_protected.filesystem]");
  });

  test("idempotent on Codex too", () => {
    const home = mkdtempSync(join(tmpdir(), "osb-codex-home-"));
    const vault = mkdtempSync(join(tmpdir(), "osb-codex-vault-"));
    mkdirSync(join(vault, "Brain"), { recursive: true });
    applyProtect({ target: "codex", vault, __homeOverride: home } as ApplyOptions & { __homeOverride?: string });
    const first = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    applyProtect({ target: "codex", vault, __homeOverride: home } as ApplyOptions & { __homeOverride?: string });
    const second = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(second).toBe(first);
  });

  test("preserves user content outside the fence", () => {
    const home = mkdtempSync(join(tmpdir(), "osb-codex-home-"));
    const vault = mkdtempSync(join(tmpdir(), "osb-codex-vault-"));
    mkdirSync(join(vault, "Brain"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    const userToml = '# user content\nmodel = "gpt-5.5"\n';
    writeFileSync(join(home, ".codex", "config.toml"), userToml);
    applyProtect({ target: "codex", vault, __homeOverride: home } as ApplyOptions & { __homeOverride?: string });
    const after = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(after.startsWith(userToml)).toBe(true);
    expect(after).toContain("# >>> open-second-brain managed >>>");
  });
});
```

**Step 2: Run — expect failure**

**Step 3: Implement**

Extend `ApplyOptions` to support a test seam:

```ts
export interface ApplyOptions {
  readonly target: ProtectTarget;
  readonly vault: string;
  /** Test-only: override $HOME for Codex config path resolution. */
  readonly __homeOverride?: string;
}

import { homedir } from "node:os";

function applyCodex(vault: string, homeOverride?: string): ApplyResult {
  ensureVaultBootstrapped(vault);
  const home = homeOverride ?? homedir();
  const dest = join(home, ".codex", "config.toml");
  mkdirSync(join(home, ".codex"), { recursive: true });

  const before = existsSync(dest) ? readFileSync(dest, "utf8") : "";
  const rules = buildProtectRules(vault);
  const fence = renderCodex(rules).body;

  const FENCE_RE = new RegExp(
    `${escapeRe(FENCE_OPEN)}[\\s\\S]*?${escapeRe(FENCE_CLOSE)}\\n?`,
    "m",
  );
  const stripped = before.replace(FENCE_RE, "");
  const sep = stripped.length === 0 || stripped.endsWith("\n") ? "" : "\n";
  const after = stripped + sep + fence;
  const changed = after !== before;
  const backupPath = `${dest}.bak.${Date.now()}`;
  if (changed && existsSync(dest)) {
    writeFileSync(backupPath, before);
  }
  atomicWriteFileSync(dest, after);
  writeManifest(vault, {
    schema_version: PROTECT_SCHEMA_VERSION,
    target: "codex",
    vault,
  });
  return Object.freeze({
    target: "codex",
    destination: dest,
    backupPath: changed ? backupPath : "",
    changed,
  });
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
```

Update `applyProtect`'s switch to pass `opts.__homeOverride` to
`applyCodex`.

**Step 4: Run — expect pass**

Run: `bun test tests/core/brain/protect.test.ts`
Expected: 14 passes.

**Step 5: Pause for review (no commit)**

### Task 20: `unprotect` for Codex + round-trip test

**Objective:** Remove the fence block. Round-trip yields byte-identical
pre-protect content.

**Files:**

- Modify: `src/core/brain/protect.ts`
- Modify: `tests/core/brain/protect.test.ts`

**Step 1: Failing test**

```ts
describe("unprotect codex", () => {
  test("round-trip on Codex restores pre-protect content", () => {
    const home = mkdtempSync(join(tmpdir(), "osb-codex-home-"));
    const vault = mkdtempSync(join(tmpdir(), "osb-codex-vault-"));
    mkdirSync(join(vault, "Brain"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    const userToml = '# user content\nmodel = "gpt-5.5"\n';
    writeFileSync(join(home, ".codex", "config.toml"), userToml);
    applyProtect({ target: "codex", vault, __homeOverride: home } as ApplyOptions & { __homeOverride?: string });
    unprotect({ target: "codex", vault, __homeOverride: home } as UnprotectOptions & { __homeOverride?: string });
    const after = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(after).toBe(userToml);
  });
});
```

**Step 2: Run — expect failure**

**Step 3: Implement**

Add `__homeOverride` to `UnprotectOptions`. Implement:

```ts
function unprotectCodex(vault: string, homeOverride?: string): void {
  const home = homeOverride ?? homedir();
  const dest = join(home, ".codex", "config.toml");
  if (!existsSync(dest)) return;
  const raw = readFileSync(dest, "utf8");
  const FENCE_RE = new RegExp(
    `\\n?${escapeRe(FENCE_OPEN)}[\\s\\S]*?${escapeRe(FENCE_CLOSE)}\\n?`,
    "m",
  );
  const stripped = raw.replace(FENCE_RE, "");
  atomicWriteFileSync(dest, stripped);
  removeManifestEntry(vault, "codex");
}
```

**Step 4: Run — expect pass**

Run: `bun test tests/core/brain/protect.test.ts`
Expected: 15 passes.

**Step 5: Pause for review (no commit)**

### Task 21: `printSnippet` — `--print` mode

**Objective:** Render to stdout-friendly string without touching the
filesystem. Same content as `--apply` would produce, minus the user's
existing config.

**Files:**

- Modify: `src/core/brain/protect.ts`
- Modify: `tests/core/brain/protect.test.ts`

**Step 1: Failing test**

```ts
import { printSnippet } from "../../../src/core/brain/protect.ts";

describe("printSnippet", () => {
  test("claudecode prints the JSON shape only (no manifest)", () => {
    const out = printSnippet({ target: "claudecode", vault: "/v" });
    expect(out.body).toContain('"Write(/v/Brain/preferences/**)"');
    expect(out.body).toContain("permissions");
    expect(out.body).not.toContain("schema_version"); // manifest stays internal
  });

  test("codex prints the fenced TOML block", () => {
    const out = printSnippet({ target: "codex", vault: "/v" });
    expect(out.body).toContain("# >>> open-second-brain managed >>>");
  });
});
```

**Step 2: Run — expect failure**

**Step 3: Implement**

```ts
export function printSnippet(opts: {
  target: ProtectTarget;
  vault: string;
}): RenderedSnippet {
  const rules = buildProtectRules(opts.vault);
  switch (opts.target) {
    case "claudecode": {
      const r = renderClaudeCode(rules, opts.vault);
      return Object.freeze({
        target: "claudecode" as const,
        body: JSON.stringify(r.snippet, null, 2) + "\n",
        destination: join(opts.vault, ".claude", "settings.json"),
      });
    }
    case "codex": {
      const r = renderCodex(rules);
      return Object.freeze({
        target: "codex" as const,
        body: r.body,
        destination: join(homedir(), ".codex", "config.toml"),
      });
    }
  }
}
```

**Step 4: Run — expect pass**

Run: `bun test tests/core/brain/protect.test.ts`
Expected: 17 passes.

**Step 5: Pause for review (no commit)**

### Task 22: CLI surface — `o2b brain protect` and `o2b brain unprotect`

**Objective:** Wire the verbs in `src/cli/brain.ts` (or a sibling
`src/cli/brain-protect.ts`, depending on existing patterns; mirror how
`brain set-primary` is wired).

**Files:**

- Create: `src/cli/brain-protect.ts`
- Modify: `src/cli/brain.ts`

**Step 1: Inspect existing CLI dispatch**

Run: `grep -n "set-primary\|cmdBrain" src/cli/brain.ts`

**Step 2: Implement `src/cli/brain-protect.ts`**

```ts
import {
  applyProtect,
  printSnippet,
  unprotect,
  PROTECT_TARGETS,
  type ProtectTarget,
} from "../core/brain/protect.ts";

export interface CmdResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export function cmdBrainProtect(argv: string[]): CmdResult {
  const args = parseArgs(argv);
  if (!isProtectTarget(args.target)) {
    return {
      stdout: "",
      stderr: `unknown --target='${args.target}', supported: ${PROTECT_TARGETS.join(", ")}\n`,
      exitCode: 2,
    };
  }
  if (args.apply) {
    const r = applyProtect({ target: args.target, vault: args.vault });
    const note = r.changed ? `applied to ${r.destination}` : "no changes";
    return {
      stdout: `${note}\n${r.backupPath ? `backup: ${r.backupPath}\n` : ""}`,
      stderr: "",
      exitCode: 0,
    };
  }
  const s = printSnippet({ target: args.target, vault: args.vault });
  return { stdout: s.body, stderr: "", exitCode: 0 };
}

export function cmdBrainUnprotect(argv: string[]): CmdResult {
  const args = parseArgs(argv);
  if (!isProtectTarget(args.target)) {
    return {
      stdout: "",
      stderr: `unknown --target='${args.target}'\n`,
      exitCode: 2,
    };
  }
  unprotect({ target: args.target, vault: args.vault });
  return { stdout: "unprotect complete\n", stderr: "", exitCode: 0 };
}

interface ParsedArgs {
  target: string;
  vault: string;
  apply: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  // Reuse existing arg-parsing helpers from src/cli/argparse.ts.
  // ... implementation depends on what argparse exports.
  throw new Error("not implemented");
}

function isProtectTarget(s: string): s is ProtectTarget {
  return (PROTECT_TARGETS as readonly string[]).includes(s);
}
```

Replace the `parseArgs` stub with the actual pattern used in
`src/cli/brain.ts` for `set-primary`. The contract: `--target <name>`
(required), `--vault <path>` (default from `defaultConfigPath()`),
`--apply` (boolean flag, default false).

**Step 3: Dispatch in `src/cli/brain.ts`**

Add two cases to the existing brain-subcommand dispatch table:

```ts
case "protect":   return cmdBrainProtect(rest);
case "unprotect": return cmdBrainUnprotect(rest);
```

**Step 4: CLI tests**

Create `tests/cli/brain-protect.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdBrainProtect, cmdBrainUnprotect } from "../../src/cli/brain-protect.ts";

describe("o2b brain protect CLI", () => {
  test("--target claudecode --print returns JSON body, exit 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "osb-protect-"));
    mkdirSync(join(dir, "Brain"), { recursive: true });
    const r = cmdBrainProtect(["--target", "claudecode", "--vault", dir]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Write(");
  });

  test("unknown target exits 2", () => {
    const r = cmdBrainProtect(["--target", "vim"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("unknown --target");
  });

  test("apply + unprotect round-trip works", () => {
    const dir = mkdtempSync(join(tmpdir(), "osb-protect-"));
    mkdirSync(join(dir, "Brain"), { recursive: true });
    expect(
      cmdBrainProtect(["--target", "claudecode", "--vault", dir, "--apply"])
        .exitCode,
    ).toBe(0);
    expect(
      cmdBrainUnprotect(["--target", "claudecode", "--vault", dir]).exitCode,
    ).toBe(0);
  });
});
```

**Step 5: Run CLI tests**

Run: `bun test tests/cli/brain-protect.test.ts`
Expected: 3 passes.

**Step 6: Pause for review (no commit)**

### Task 23: install.md addendum for §18

**Objective:** Add a step "5c — Optional: machine-enforced Brain
protection" to Claude Code (Branch D) and Codex (Branch C) branches.
Branches A and B and E mention `o2b brain protect` is not yet
available for their target.

**Files:**

- Modify: `install.md`

**Step 1: Locate the right anchor in branches C and D**

Run:
`grep -n "### 6. Verify the installation" install.md`

**Step 2: Insert the protect note**

For each branch (C and D), after step 5 (or 5b) and before step 6,
add:

```markdown
### 5c. Optional — machine-enforce write protection on `Brain/`

OSB defends `Brain/preferences/`, `retired/`, `log/`, `.snapshots/`,
and `Brain/_brain.yaml` against accidental writes by the running
agent through the runtime's native permissions mechanism. `Brain/inbox/`
stays writable — that's where `brain_feedback` legitimately drops
signals.

Preview the snippet first:

```bash
o2b brain protect --target <claudecode|codex>
```

Apply when you are satisfied:

```bash
o2b brain protect --target <claudecode|codex> --apply
```

`o2b brain unprotect --target <claudecode|codex>` removes the OSB-owned
entries. A sidecar manifest at `<vault>/.open-second-brain/protect.lock.json`
records what `protect` added, so `unprotect` removes exactly that
and never touches user-authored rules.
```

For branches A, B, E, add a short note in the closing section:
"`o2b brain protect` currently supports `claudecode` and `codex`
targets; the convention-only `_BRAIN.md` instructions are the only
mechanism available for other runtimes."

**Step 3: Pause for review (no commit)**

### Task 24: Phase 2 close

**Step 1: Full test**

Run: `bun test`
Expected: every test passes.

**Step 2: Typecheck**

Run: `bun run typecheck`
Expected: 0 errors.

**Step 3: Pause for review (no commit)**

---

## Phase 3 — §15-partial `o2b brain init --starter`

### Task 25: Author the 8 starter preference files

**Objective:** Hand-author 8 markdown files matching the v0.10.x
preference schema. Mixed confidence, scope, pinned flags.

**Files:**

- Create: `templates/brain-starter/preferences/pref-imperative-commit-messages.md`
- Create: `templates/brain-starter/preferences/pref-no-unexplained-abbreviations.md`
- Create: `templates/brain-starter/preferences/pref-prefer-typed-errors.md`
- Create: `templates/brain-starter/preferences/pref-explicit-imports-only.md`
- Create: `templates/brain-starter/preferences/pref-changelog-every-release.md`
- Create: `templates/brain-starter/preferences/pref-russian-in-chat.md`
- Create: `templates/brain-starter/preferences/pref-test-before-refactor.md`
- Create: `templates/brain-starter/preferences/pref-prefer-bun-over-npx.md`

**Step 1: For each file, follow this template**

Read `src/core/brain/preference.ts` and `docs/how-it-works.md` §
"A preference's lifecycle" for the canonical frontmatter shape.

A confirmed entry example (`pref-imperative-commit-messages.md`):

```markdown
---
id: pref-imperative-commit-messages
topic: imperative-commit-messages
principle: Use imperative voice in commit messages — "Add", "Fix", "Refactor", not "Added" / "Fixes" / "Refactored".
scope: process
signal: positive
_status: confirmed
_created_at: 2026-04-01T10:00:00Z
_confirmed_at: 2026-04-15T10:00:00Z
_applied_count: 6
_violated_count: 0
_confidence: high
_confidence_value: 0.72
_last_evidence_at: 2026-05-10T14:00:00Z
pinned: false
evidenced_by:
  - "[[Brain/log/2026-05-15]]"
  - "[[Brain/log/2026-05-16]]"
---

# {{principle}}

## Why

Commit titles read as instructions the reader executes mentally. Imperative voice mirrors how git itself describes its operations.

## Origin

Three signals across 14 days in early starter usage.
```

Repeat per the table below. Vary `_confidence` (high/medium/low),
`_applied_count`, `scope`, and `pinned` to demonstrate the range.
One entry must be `_status: unconfirmed` with `unconfirmed_until`
set so the field's purpose is visible.

| Slug | Scope | Confidence | Pinned | Status |
|---|---|---|---|---|
| pref-imperative-commit-messages | process | high | false | confirmed |
| pref-no-unexplained-abbreviations | writing | high | **true** | confirmed |
| pref-prefer-typed-errors | coding | medium | false | confirmed |
| pref-explicit-imports-only | coding | medium | false | confirmed |
| pref-changelog-every-release | process | high | false | confirmed |
| pref-russian-in-chat | writing | low | false | confirmed |
| pref-test-before-refactor | coding | — | false | **unconfirmed** |
| pref-prefer-bun-over-npx | infra | low | false | confirmed |

**Step 2: Pause for review (no commit)**

### Task 26: Author the 3 retired files

**Objective:** Three retire reasons — `user-rejected`, `rebutted`,
`stale-no-evidence` — to show the doctor lint surface and the
retired-pref shape.

**Files:**

- Create: `templates/brain-starter/retired/ret-tabs-over-spaces.md`
- Create: `templates/brain-starter/retired/ret-no-emojis-in-code.md`
- Create: `templates/brain-starter/retired/ret-prefer-curl-over-wget.md`

**Step 1: For each file, follow the retired schema**

Reference `src/core/brain/preference.ts:moveToRetired` and `docs/how-it-works.md`
for the retired frontmatter shape. Example (`ret-tabs-over-spaces.md`):

```markdown
---
id: ret-tabs-over-spaces
topic: tabs-over-spaces
principle: Use tabs for indentation, not spaces.
_retired_at: 2026-04-20T09:00:00Z
_retired_reason: user-rejected
user_rejected_reason: "Mixed indentation is acceptable in this codebase — different repos have different conventions and a single rule can't capture that."
scope: coding
_original_status: confirmed
_applied_count: 2
_violated_count: 0
---

# {{principle}}

## Why retired

User rejected the rule explicitly. Reason recorded above.
```

**Step 2: Pause for review (no commit)**

### Task 27: Author the inbox signal and 6 log days

**Objective:** One pending signal showing the inbox shape; six
log-day files showing apply-evidence and a retire entry.

**Files:**

- Create: `templates/brain-starter/inbox/sig-2026-05-10-strict-types.md`
- Create: `templates/brain-starter/log/2026-05-15.md`
- Create: `templates/brain-starter/log/2026-05-16.md`

**Step 1: Author the signal file**

Schema from `src/core/brain/types.ts:BrainSignal`. Sample:

```markdown
---
id: sig-2026-05-10-strict-types
topic: strict-types-in-public-api
signal: positive
principle: Public-API function signatures should be fully typed — no implicit any in exports.
scope: coding
created_at: 2026-05-10T15:30:00Z
agent: starter-author
source: ["[[Daily/2026.05.10]]"]
source_type: live
---

## Raw

"Public functions should never accept implicit any — readers reading the type signature get the whole contract."
```

**Step 2: Author the log days**

Sample `2026-05-15.md`:

```markdown
---
date: 2026-05-15
---

## 2026-05-15T14:00:00Z apply-evidence
- pref: [[pref-imperative-commit-messages]]
- artifact: [[Brain/log/2026-05-15#example-commit]]
- result: applied
- agent: starter-author

## 2026-05-15T15:10:00Z apply-evidence
- pref: [[pref-no-unexplained-abbreviations]]
- artifact: [[docs/example-doc.md]]
- result: applied
- agent: starter-author
```

Sample `2026-05-16.md`:

```markdown
---
date: 2026-05-16
---

## 2026-05-16T09:30:00Z apply-evidence
- pref: [[pref-prefer-typed-errors]]
- artifact: [[src/example.ts:42-60]]
- result: applied
- agent: starter-author

## 2026-05-16T11:00:00Z retire
- pref: [[ret-tabs-over-spaces]]
- reason: user-rejected
- agent: starter-author
```

**Step 3: Pause for review (no commit)**

### Task 28: `copyStarterBundle` helper

**Objective:** Pure copy helper. Refuses if any of `Brain/preferences/`,
`retired/`, `inbox/`, `log/` is non-empty. Returns a manifest of what
was copied.

**Files:**

- Modify: `src/core/brain/init.ts`
- Create: `tests/core/brain/starter.test.ts`

**Step 1: Failing tests**

```ts
import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyStarterBundle } from "../../../src/core/brain/init.ts";

describe("copyStarterBundle", () => {
  test("copies the 18 starter files into an empty Brain", () => {
    const vault = mkdtempSync(join(tmpdir(), "osb-starter-"));
    mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
    mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
    mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
    mkdirSync(join(vault, "Brain", "log"), { recursive: true });
    const result = copyStarterBundle(vault);
    expect(result.copied).toHaveLength(14);
    expect(readdirSync(join(vault, "Brain", "preferences"))).toHaveLength(8);
    expect(readdirSync(join(vault, "Brain", "retired"))).toHaveLength(3);
    expect(readdirSync(join(vault, "Brain", "inbox"))).toHaveLength(1);
    expect(readdirSync(join(vault, "Brain", "log"))).toHaveLength(2);
  });

  test("refuses to copy when preferences/ already has a file", () => {
    const vault = mkdtempSync(join(tmpdir(), "osb-starter-"));
    mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
    mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
    mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
    mkdirSync(join(vault, "Brain", "log"), { recursive: true });
    writeFileSync(
      join(vault, "Brain", "preferences", "pref-existing.md"),
      "---\nid: pref-existing\n---\n",
    );
    expect(() => copyStarterBundle(vault)).toThrow(
      /already has content/i,
    );
  });

  test("custom --starter-path resolves relative to cwd", () => {
    const vault = mkdtempSync(join(tmpdir(), "osb-starter-"));
    mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
    mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
    mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
    mkdirSync(join(vault, "Brain", "log"), { recursive: true });
    const custom = mkdtempSync(join(tmpdir(), "osb-starter-src-"));
    mkdirSync(join(custom, "preferences"), { recursive: true });
    writeFileSync(
      join(custom, "preferences", "pref-x.md"),
      "---\nid: pref-x\n---\n",
    );
    const result = copyStarterBundle(vault, { starterPath: custom });
    expect(result.copied).toHaveLength(1);
  });
});
```

**Step 2: Run — expect failure**

Run: `bun test tests/core/brain/starter.test.ts`

**Step 3: Implement**

Add to `src/core/brain/init.ts`:

```ts
import { readdirSync, copyFileSync } from "node:fs";

export interface StarterBundleResult {
  readonly copied: ReadonlyArray<string>;
}

export interface CopyStarterOptions {
  readonly starterPath?: string;
}

const DEFAULT_STARTER_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "templates",
  "brain-starter",
);

const STARTER_TARGETS = ["preferences", "retired", "inbox", "log"] as const;

export function copyStarterBundle(
  vault: string,
  opts: CopyStarterOptions = {},
): StarterBundleResult {
  const src = opts.starterPath ?? DEFAULT_STARTER_DIR;
  for (const sub of STARTER_TARGETS) {
    const dir = join(vault, "Brain", sub);
    if (!existsSync(dir)) {
      throw new Error(
        `Brain/${sub} does not exist — run \`o2b brain init\` without --starter first`,
      );
    }
    const existing = readdirSync(dir).filter((n) => !n.startsWith("."));
    if (existing.length > 0) {
      throw new Error(
        `Brain/${sub} already has content — --starter is intended for fresh vaults. ` +
          `Inspect the bundle at ${src} and copy individual files manually if needed.`,
      );
    }
  }
  const copied: string[] = [];
  for (const sub of STARTER_TARGETS) {
    const srcDir = join(src, sub);
    if (!existsSync(srcDir)) continue;
    for (const name of readdirSync(srcDir)) {
      const from = join(srcDir, name);
      const to = join(vault, "Brain", sub, name);
      copyFileSync(from, to);
      copied.push(join("Brain", sub, name));
    }
  }
  return Object.freeze({ copied });
}
```

**Step 4: Run — expect pass**

Run: `bun test tests/core/brain/starter.test.ts`
Expected: 3 passes.

**Step 5: Pause for review (no commit)**

### Task 29: Wire `--starter` and `--starter-path` flags

**Objective:** `o2b brain init [--starter] [--starter-path <dir>]`
calls `copyStarterBundle` after the existing init succeeds.

**Files:**

- Modify: `src/cli/brain.ts`
- Modify: `src/core/brain/init.ts` (option threading on `bootstrapBrain`)

**Step 1: Extend `BootstrapBrainOptions`**

```ts
export interface BootstrapBrainOptions {
  // ... existing fields ...
  readonly starter?: boolean;
  readonly starterPath?: string;
}
```

In `bootstrapBrain`, after the existing logic, if `opts.starter`:

```ts
const starterResult = copyStarterBundle(vault, {
  starterPath: opts.starterPath,
});
created.push(...starterResult.copied);
```

**Step 2: Surface in CLI**

In `src/cli/brain.ts`, locate the existing `init` parser. Add
`--starter` (boolean) and `--starter-path <path>` (string).

**Step 3: CLI test**

Add to an existing CLI test file (or new `tests/cli/brain-init-starter.test.ts`):

```ts
import { test, expect } from "bun:test";
// ... setup ...

test("o2b brain init --starter copies 14 files", () => {
  // construct config + vault, run cmdBrainInit with ["--starter"],
  // assert the four Brain/ subdirs have the expected counts.
});
```

**Step 4: Run tests**

Run: `bun test tests/cli/`
Expected: existing passes + new starter test passes.

**Step 5: Pause for review (no commit)**

### Task 30: Doctor cleanliness gate

**Objective:** A fresh vault initialised with `--starter` passes
`o2b brain doctor` with zero warnings. This is a CI gate — the
starter must remain doctor-clean as the project evolves.

**Files:**

- Modify: `tests/core/brain/starter.test.ts`

**Step 1: Add the smoke test**

```ts
import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";

test("doctor is clean after init --starter on a fresh vault", () => {
  const vault = mkdtempSync(join(tmpdir(), "osb-starter-doctor-"));
  // Write a minimal machine config first; bootstrapBrain refuses
  // without it.
  // ... setup machine config ...
  bootstrapBrain(vault, { starter: true });
  const result = runDoctor(vault);
  expect(result.warnings).toEqual([]);
  expect(result.errors).toEqual([]);
});
```

Adjust `runDoctor` import to the actual exported name.

**Step 2: Run**

Run: `bun test tests/core/brain/starter.test.ts`
Expected: 4 passes (the existing 3 plus doctor smoke).

If doctor flags any issue, fix the offending starter file (not the
doctor — doctor's pass/fail is the gate).

**Step 3: Pause for review (no commit)**

### Task 31: Dream no-op gate

**Objective:** A fresh vault initialised with `--starter` is a no-op
under `o2b brain dream --now <fixed-time>`.

**Files:**

- Modify: `tests/core/brain/starter.test.ts`

**Step 1: Add the dream no-op test**

```ts
import { dream } from "../../../src/core/brain/dream.ts";

test("dream is no-op on the fresh --starter vault", () => {
  const vault = mkdtempSync(join(tmpdir(), "osb-starter-dream-"));
  // ... setup as in the doctor smoke test ...
  bootstrapBrain(vault, { starter: true });
  const result = dream(vault, {
    now: new Date("2026-05-17T12:00:00Z"),
    dryRun: true,
  });
  expect(result.changed).toBe(false);
});
```

**Step 2: Run**

Run: `bun test tests/core/brain/starter.test.ts`
Expected: 5 passes.

If dream reports `changed: true`, audit the starter content: the
unconfirmed preference's `unconfirmed_until` must be after the fixed
`--now` so the trial-window-expired path does not fire; no log
entries should be old enough to flip a counter.

**Step 3: Pause for review (no commit)**

### Task 32: install.md addendum for §15

**Objective:** Append a one-line "or `o2b brain init --starter` if you
want example preferences" to the init step in each install branch.

**Files:**

- Modify: `install.md`

**Step 1: Locate each branch's init step**

Run:
`grep -n "### 4. Initialize the vault" install.md`

**Step 2: Append the note**

After the existing `o2b init` invocation paragraph in each of branches
A, B, C, D, E, add:

```markdown
Optionally append `--starter` to drop a bundled example set of 8
preferences, 3 retired entries, 1 inbox signal, and 6 log days. The
bundle passes `o2b brain doctor` cleanly and is a no-op under
`o2b brain dream`. The starter refuses to run on a non-empty Brain.
```

**Step 3: Pause for review (no commit)**

### Task 33: Phase 3 close

**Step 1: Full test**

Run: `bun test`
Expected: every test passes.

**Step 2: Typecheck**

Run: `bun run typecheck`
Expected: 0 errors.

**Step 3: Pause for review (no commit)**

---

## Phase 4 — Release housekeeping

### Task 34: CHANGELOG entry

**Objective:** Single v0.10.4 block under the next version anchor;
no `[Unreleased]` (per memory `feedback_no_unreleased_section`).

**Files:**

- Modify: `CHANGELOG.md`

**Step 1: Read the current top of CHANGELOG**

Run: `head -40 CHANGELOG.md`

**Step 2: Insert the new entry directly under the H1**

Use the draft from the design doc:

```markdown
## v0.10.4 — Brain onboarding quality

### Added

- §18 — `o2b brain protect --target {claudecode|codex}` writes a
  managed, idempotent block into the runtime's native permissions
  config that denies writes to `Brain/preferences/`, `retired/`,
  `log/`, `.snapshots/`, and `_brain.yaml` while leaving
  `Brain/inbox/` writable. Pair `o2b brain unprotect` removes the
  block. `--print` outputs the snippet without touching disk;
  `--apply` writes and backs up the prior config.
- §4 (partial) — per-runtime identity-reminder templates for the
  two runtimes that read `buildReminder` per-turn / per-action:
  `templates/identity-reminder.{hermes,openclaw}.txt`. Resolver in
  `buildReminder` accepts an explicit `target`, falls back to
  `O2B_TARGET`, and finally to the common template. Hermes Python
  shim has parity through a pinned fixture test. The common
  `identity-reminder.txt` is unchanged. Claude Code and Codex steer
  through `hooks/lib/messages.ts`, which is a separate mechanism not
  touched here.
- §15 (partial) — `o2b brain init --starter` drops a curated bundle
  of 8 confirmed preferences, 3 retired, 1 inbox signal, and 2 log
  days into a fresh Brain. The bundle passes `o2b brain doctor`
  cleanly and is a no-op under `o2b brain dream` at install time.
  Refuses to run on a non-empty Brain.

### Deferred

Full multi-runtime `o2b install` orchestrator (§4 second half),
interactive `o2b init --interactive` wizard (§15 second half), and
`brain-memory` SKILL "good-vs-bad" examples section. Triggers to
revisit are recorded in the vault summary's "Deferred work"
section.
```

**Step 3: Pause for review (no commit)**

### Task 35: Version bump and version-mirror sync

**Objective:** Set `package.json` version to `0.10.4` and propagate
to every mirror file via `sync-version`.

**Files:**

- Modify: `package.json`
- Auto-modified by sync-version: `.claude-plugin/plugin.json`,
  `.codex-plugin/plugin.json`, `plugins/codex/.codex-plugin/plugin.json`,
  `plugins/hermes/plugin.yaml`, `plugin.yaml`, `openclaw.plugin.json`,
  `__init__.py`

**Step 1: Edit `package.json`**

Change `"version": "0.10.3"` to `"version": "0.10.4"`.

**Step 2: Run sync-version**

Run: `bun run sync-version`
Expected: all mirror files updated to `0.10.4`.

**Step 3: Verify**

Run: `bun run sync-version:check`
Expected: exit 0 ("all in sync").

**Step 4: Pause for review (no commit)**

### Task 36: Final green gate

**Step 1: Full TS test**

Run: `bun test`
Expected: every test passes.

**Step 2: Typecheck**

Run: `bun run typecheck`
Expected: 0 errors.

**Step 3: Python tests**

Run: `python3 -m unittest discover tests/python/`
Expected: all pass.

**Step 4: Optional — OpenClaw build**

Run: `bun run build:openclaw`
Expected: success.

**Step 5: Verify install.md and CHANGELOG render**

Run:
```bash
grep -c "v0.10.4" CHANGELOG.md
grep -c "o2b brain protect" install.md
grep -c "o2b brain init --starter" install.md
```

Expected: `≥1` for each.

**Step 6: Pause for final review (no commit)**

---

## Open items left for impl-time decisions

The design doc's three open questions are restated here so the
implementer encounters them in context:

1. **Backup file lifecycle for `protect --apply`.** Current plan
   always writes a `.bak.<ts>` and never prunes. If the user
   prefers opt-out behaviour, add `--no-backup` on the CLI surface
   in Task 22.

2. **Codex managed-block uniqueness across multiple vaults.** Current
   plan: one fence per host (vault paths concatenate inside the same
   `[permissions.osb_protected.filesystem]`). If multi-vault use
   becomes common, the renderer in Task 15 will need per-vault
   profile names (`osb_protected_<vault-hash>`).

3. **Starter i18n.** No `--starter-lang` switch in v0.10.4. The
   bundled `pref-russian-in-chat` plus all-English peers demonstrate
   the mixed-language policy from `brain-memory` skill organically.

---

## References

- Design doc: [`2026-05-17-brain-onboarding-quality-design.md`](./2026-05-17-brain-onboarding-quality-design.md)
- Vault summary: `Projects/OpenSecondBrain/Features/_summary.md`
  (§4, §15, §18, "Deferred work")
- Codex permissions doc:
  <https://developers.openai.com/codex/config-advanced>
- Claude Code permissions: project's prior installer notes inside
  `install.md` already reference `settings.json` structure.
- Prior impl plan to mirror structurally:
  [`2026-05-17-tier-a-snapshot-confidence-pointer-impl.md`](./2026-05-17-tier-a-snapshot-confidence-pointer-impl.md).
