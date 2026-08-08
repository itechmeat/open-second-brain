/**
 * The collision the quote fold CREATES, at the seams a caller reaches
 * (what-the-index-already-knew, task A - review follow-up).
 *
 * `quote-variant-fold.test.ts` pins the kernel and the three refusals that
 * were already wired: alias-vs-alias, alias-vs-canonical-name, and the
 * archive release. None of those is the case the fold actually creates.
 * Folding typographic quote variants makes two previously-distinct
 * CANONICAL NAMES resolve to one identity key, and both records are on
 * disk already: the id allocator suffixes `-2` on a slug collision, so an
 * older binary wrote them side by side without ever seeing a conflict.
 *
 * That state reaches three seams, and this file pins what each must do:
 *
 *   1. `upsertEntity` - the write seam. Resolving a CONTESTED identity key
 *      picks the walk's first claimant and rewrites it, reporting
 *      `created: false`. The caller's label is discarded, the other record
 *      is untouched, and nothing says so. It must refuse instead, naming
 *      both records and the registered exit.
 *   2. The category-LESS read - `getEntity` with no category. It throws,
 *      but says the reference is ambiguous "across categories" when both
 *      records sit in ONE category, and names "pass a category" as the
 *      exit - which resolves nothing here. It must name the real reason.
 *   3. The doctor - the pre-existing safety net. It must still report the
 *      pair, and the finding must carry the code whose exit is registered
 *      rather than the one whose exit is written up as absent.
 *
 * The category-SCOPED read deliberately keeps returning the first
 * claimant: `archiveEntity` resolves through it, and that archive IS the
 * registered exit, so a read that refused would put the remedy behind the
 * fault it reports. That decision is asserted here, not merely written
 * down.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { DIAGNOSTIC_SIGNALS } from "../../../../src/core/brain/diagnostics.ts";
import { ENTITY_QUOTE_VARIANT_COLLISION_CODE } from "../../../../src/core/brain/entities/canonical.ts";
import { entityRegistryCheck } from "../../../../src/core/brain/doctor/entity-checks.ts";
import {
  archiveEntity,
  getEntity,
  upsertEntity,
} from "../../../../src/core/brain/entities/registry.ts";
import type { DoctorIssue } from "../../../../src/core/brain/types.ts";

const NOW = new Date("2026-06-02T12:00:00Z");
const AGENT = "claude-dev-agent";
const CATEGORY = "music";

/** U+2019 RIGHT SINGLE QUOTATION MARK - what an editor substitutes. */
const CURLY_LABEL = "Taylor’s Version";
/** U+0027 APOSTROPHE - the fold target, and what a keyboard types. */
const ASCII_LABEL = "Taylor's Version";

const CURLY_ID = "ent-music-taylor-s-version";
const ASCII_ID = "ent-music-taylor-s-version-2";

let vault: string;
let configHome: string;

/**
 * The two records an older binary left on disk. Written directly, because
 * the API cannot produce this state once the fold is in - which is exactly
 * why the state exists in the field and not in any suite.
 */
function seedPreFoldPair(): void {
  const dir = join(vault, "Brain", "entities", CATEGORY);
  mkdirSync(dir, { recursive: true });
  for (const [id, label] of [
    [CURLY_ID, CURLY_LABEL],
    [ASCII_ID, ASCII_LABEL],
  ] as const) {
    atomicWriteFileSync(
      join(dir, `${id}.md`),
      [
        "---",
        "kind: brain-entity",
        `entity_id: ${id}`,
        `category: ${CATEGORY}`,
        `name: ${label}`,
        "status: active",
        "created_at: 2026-06-01T00:00:00Z",
        "updated_at: 2026-06-01T00:00:00Z",
        "---",
        "",
        `# ${label}`,
        "",
      ].join("\n"),
    );
  }
}

/** The registered exit, read from the registry rather than retyped. */
function registeredExit(): string {
  const signal = DIAGNOSTIC_SIGNALS.get(ENTITY_QUOTE_VARIANT_COLLISION_CODE);
  expect(signal).toBeDefined();
  return signal!.nextCommand;
}

function runEntityDoctor(): DoctorIssue[] {
  const issues: DoctorIssue[] = [];
  entityRegistryCheck.run(
    { vault, configPath: join(configHome, "config.yaml") } as never,
    { issues, uncertain: [] } as never,
  );
  return issues;
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-quote-collision-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-quote-collision-cfg-"));
  atomicWriteFileSync(join(configHome, "config.yaml"), `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath: join(configHome, "config.yaml") });
  seedPreFoldPair();
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("the write seam refuses a contested identity key", () => {
  test("upsert into the folded pair refuses instead of rewriting one of them", () => {
    let message = "";
    let result: unknown = null;
    try {
      result = upsertEntity(vault, {
        category: CATEGORY,
        name: ASCII_LABEL,
        agent: AGENT,
        now: NOW,
        body: "# rewritten by the caller",
      });
    } catch (exc) {
      message = (exc as Error).message;
    }
    expect(result).toBeNull();
    expect(message).toContain(CURLY_ID);
    expect(message).toContain(ASCII_ID);
    expect(message).toContain(registeredExit());
  });

  test("the refusal names the quote-variant cause, not just the duplicate", () => {
    let message = "";
    try {
      upsertEntity(vault, { category: CATEGORY, name: ASCII_LABEL, agent: AGENT, now: NOW });
    } catch (exc) {
      message = (exc as Error).message;
    }
    expect(message).toContain("typographic quote form");
  });
});

describe("the category-less read names the real reason", () => {
  test("a same-category collision is not reported as ambiguity across categories", () => {
    let message = "";
    try {
      getEntity(vault, { query: ASCII_LABEL });
    } catch (exc) {
      message = (exc as Error).message;
    }
    expect(message).not.toContain("across categories");
    expect(message).not.toContain("pass a category");
    expect(message).toContain(CATEGORY);
    expect(message).toContain("typographic quote form");
    expect(message).toContain(registeredExit());
  });

  test("a genuine cross-category ambiguity keeps the message it always had", () => {
    upsertEntity(vault, { category: "people", name: "Ada", agent: AGENT, now: NOW });
    upsertEntity(vault, { category: "projects", name: "Ada", agent: AGENT, now: NOW });
    let message = "";
    try {
      getEntity(vault, { query: "Ada" });
    } catch (exc) {
      message = (exc as Error).message;
    }
    expect(message).toContain("ambiguous across categories");
    expect(message).toContain("pass a category");
    expect(message).not.toContain(registeredExit());
  });
});

describe("the registered exit stays reachable", () => {
  test("the category-scoped read still resolves, so archive can run", () => {
    const held = getEntity(vault, { category: CATEGORY, query: ASCII_LABEL });
    expect(held).not.toBeNull();
    expect(held!.id).toBe(CURLY_ID);
    const archived = archiveEntity(vault, { category: CATEGORY, query: ASCII_LABEL }, { now: NOW });
    expect(archived.id).toBe(CURLY_ID);
    // One archive ends the collision: the survivor is now reachable, and
    // the write seam is open again.
    const after = upsertEntity(vault, {
      category: CATEGORY,
      name: ASCII_LABEL,
      agent: AGENT,
      now: NOW,
    });
    expect(after.created).toBe(false);
    expect(after.entity.id).toBe(ASCII_ID);
  });
});

describe("the doctor reports the pair with the code that has an exit", () => {
  test("the finding carries the registered quote-variant code", () => {
    const issues = runEntityDoctor();
    const codes = issues.map((i) => i.code);
    expect(codes).toContain(ENTITY_QUOTE_VARIANT_COLLISION_CODE);
    const finding = issues.find((i) => i.code === ENTITY_QUOTE_VARIANT_COLLISION_CODE)!;
    expect(finding.message).toContain(CURLY_ID);
    expect(finding.message).toContain(ASCII_ID);
    expect(finding.message).toContain("typographic quote form");
  });

  test("an ordinary duplicate keeps the duplicate-entity code", () => {
    const dir = join(vault, "Brain", "entities", "people");
    mkdirSync(dir, { recursive: true });
    for (const id of ["ent-people-ada", "ent-people-ada-2"]) {
      atomicWriteFileSync(
        join(dir, `${id}.md`),
        [
          "---",
          "kind: brain-entity",
          `entity_id: ${id}`,
          "category: people",
          "name: Ada",
          "status: active",
          "created_at: 2026-06-01T00:00:00Z",
          "updated_at: 2026-06-01T00:00:00Z",
          "---",
          "",
          "# Ada",
          "",
        ].join("\n"),
      );
    }
    const issues = runEntityDoctor();
    const duplicate = issues.filter((i) => i.code === "duplicate-entity");
    expect(duplicate.length).toBe(1);
    expect(duplicate[0]!.message).toContain("people:ada");
    expect(duplicate[0]!.message).not.toContain("typographic quote form");
  });
});
