/**
 * The delivery-provenance doctor check (delivery-trust, lane A task A5).
 *
 * Fail-closed delivery fences every page whose provenance cannot be
 * derived - a legacy vault fences nearly everything at remote reads on
 * day one. That widening is the honest reading of the stamps, and this
 * check is what keeps it observable: ONE warning naming how many
 * delivered pages carry no derivable provenance, with a capped named-path
 * list. Silences, each deliberate: a fully stamped vault (every page's
 * authorship is derivable, whether operator or agent), the two compiled
 * digests (the system's own render, whose absence of stamps is by
 * design), and a page the caller may not read (`ctx.readable`, the
 * contract every counting check follows).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DoctorCheckContext } from "../../../../src/core/brain/doctor/check.ts";
import {
  DELIVERY_PROVENANCE_NAMED_PATH_LIMIT,
  DELIVERY_PROVENANCE_UNKNOWN_CODE,
  deliveryProvenanceCheck,
} from "../../../../src/core/brain/doctor/delivery-provenance-check.ts";
import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import type { DoctorIssue } from "../../../../src/core/brain/types.ts";

const NOW = new Date("2026-06-01T00:00:00.000Z");

let base: string;
let vault: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "o2b-delivery-provenance-"));
  vault = join(base, "vault");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** One plain unstamped page at an arbitrary vault-relative directory. */
function page(rel: string, frontmatter = ""): string {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(
    abs,
    frontmatter === ""
      ? `---\ntitle: ${rel}\n---\n\nzzbodyzz of ${rel}\n`
      : `---\ntitle: ${rel}\n${frontmatter}---\n\nzzbodyzz of ${rel}\n`,
  );
  return rel;
}

function run(extra: Partial<DoctorCheckContext> = {}): DoctorIssue[] {
  const issues: DoctorIssue[] = [];
  const uncertain: never[] = [];
  deliveryProvenanceCheck.run(
    {
      vault,
      now: NOW,
      config: undefined,
      configPath: undefined,
      ...extra,
    } as unknown as DoctorCheckContext,
    { issues, uncertain },
  );
  return issues;
}

describe("deliveryProvenanceCheck", () => {
  test("is failSoft", () => {
    expect(deliveryProvenanceCheck.failSoft).toBe(true);
  });

  test("a vault of unstamped pages yields one warning with a capped named-path list", () => {
    for (let i = 1; i <= DELIVERY_PROVENANCE_NAMED_PATH_LIMIT + 2; i++) {
      page(`page-${i}.md`);
    }
    const issues = run();
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe(DELIVERY_PROVENANCE_UNKNOWN_CODE);
    expect(issues[0]!.severity).toBe("warning");
    // The count is the whole population; the list stops at the cap and
    // says so.
    expect(issues[0]!.message).toContain(
      `${DELIVERY_PROVENANCE_NAMED_PATH_LIMIT + 2} delivered page(s)`,
    );
    expect(issues[0]!.message).toContain("page-1.md");
    expect(issues[0]!.message).toContain(
      `and ${DELIVERY_PROVENANCE_NAMED_PATH_LIMIT + 2 - DELIVERY_PROVENANCE_NAMED_PATH_LIMIT} more`,
    );
    for (
      let i = DELIVERY_PROVENANCE_NAMED_PATH_LIMIT + 1;
      i <= DELIVERY_PROVENANCE_NAMED_PATH_LIMIT + 2;
      i++
    ) {
      expect(issues[0]!.message).not.toContain(`page-${i}.md`);
    }
  });

  test("a fully stamped vault is silent, whatever the stamps prove", () => {
    // Every stamp the derivation reads is evidence, operator-authored or
    // agent-authored or withheld - each names its own delivery treatment,
    // so none of them is "unknown provenance".
    page("operator.md", "origin_channel: cli\n");
    page("agent.md", "origin_channel: mcp-tool\n");
    page("imported.md", "origin_channel: import\n");
    page("derived.md", "content_class: prompt-derived\n");
    page("untrusted.md", "untrusted_source: true\n");
    expect(run()).toHaveLength(0);
  });

  test("the unset literal and total absence are both unknown provenance", () => {
    page("unset.md", "origin_channel: unset\n");
    page("bare.md");
    const issues = run();
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("2 delivered page(s)");
  });

  test("unreadable pages are excluded via ctx.readable and never named", () => {
    page("readable.md");
    const withheld = page("withheld.md");
    const issues = run({
      readable: (rel: string) => rel !== withheld,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("1 delivered page(s)");
    expect(issues[0]!.message).toContain("readable.md");
    expect(issues[0]!.message).not.toContain(withheld);
  });

  test("the compiled digests do not move the count", () => {
    // A bootstrapped vault whose only unstamped pages are the generated
    // pair: the system's own render is not a provenance question, and a
    // check that counted it would warn on every vault forever. The two
    // writes stand in for the dream pass that regenerates them.
    bootstrapBrain(vault);
    writeFileSync(join(vault, "Brain", "active.md"), "---\nkind: brain-active\n---\n\n");
    writeFileSync(join(vault, "Brain", "lessons.md"), "---\nkind: brain-lessons\n---\n\n");
    expect(run()).toHaveLength(0);
  });
});
