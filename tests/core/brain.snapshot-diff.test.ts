/**
 * Tests for `src/core/brain/snapshot-diff.ts` and its renderer.
 *
 * Fixture-driven: each test builds two on-disk Brain/ subtrees from
 * scratch (no real snapshot archive needed — the differ takes any
 * two roots), runs `diffBrainTrees`, and asserts on the structured
 * payload. Markdown rendering is locked separately to keep parser
 * regressions visible without re-deriving the structured shape.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { diffBrainTrees } from "../../src/core/brain/snapshot-diff.ts";
import {
  renderDiffJson,
  renderDiffMarkdown,
} from "../../src/core/brain/snapshot-diff-render.ts";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "o2b-brain-snapdiff-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface PrefShape {
  readonly slug: string;
  readonly principle?: string;
  readonly status?: "unconfirmed" | "confirmed" | "quarantine";
  readonly applied?: number;
  readonly violated?: number;
  readonly confidence?: "low" | "medium" | "high";
  readonly confidence_value?: number | null;
  readonly pinned?: boolean;
}

function makeRoot(name: string): string {
  const root = join(scratch, name);
  for (const sub of ["preferences", "retired", "inbox", "log"]) {
    mkdirSync(join(root, sub), { recursive: true });
  }
  return root;
}

function writePref(root: string, s: PrefShape): void {
  const id = `pref-${s.slug}`;
  const path = join(root, "preferences", `${id}.md`);
  const body = `---
kind: brain-preference
id: ${id}
created_at: 2026-05-01T00:00:00Z
_confirmed_at: ${s.status === "confirmed" ? "2026-05-02T00:00:00Z" : "null"}
unconfirmed_until: 2026-05-30T00:00:00Z
tags: [brain, brain/preference, brain/topic/${s.slug}]
topic: ${s.slug}
_status: ${s.status ?? "unconfirmed"}
principle: ${s.principle ?? `principle for ${s.slug}`}
_evidenced_by: []
_applied_count: ${s.applied ?? 0}
_violated_count: ${s.violated ?? 0}
_last_evidence_at: null
_confidence: ${s.confidence ?? "low"}
_confidence_value: ${
    s.confidence_value === undefined
      ? 0
      : s.confidence_value === null
        ? "null"
        : s.confidence_value
  }
pinned: ${s.pinned ?? false}
---
`;
  writeFileSync(path, body, "utf8");
}

function writeSig(root: string, slug: string): void {
  const id = `sig-2026-05-01-${slug}`;
  const path = join(root, "inbox", `${id}.md`);
  writeFileSync(
    path,
    `---
kind: brain-signal
id: ${id}
created_at: 2026-05-01T00:00:00Z
tags: [brain, brain/signal]
topic: ${slug}
signal: positive
agent: tester
principle: rule
---
`,
    "utf8",
  );
}

function writeLog(root: string, day: string, body: string): void {
  writeFileSync(
    join(root, "log", `${day}.md`),
    `---\nkind: brain-log\ndate: ${day}\ntags: [brain, brain/log]\n---\n\n${body}\n`,
    "utf8",
  );
}

describe("diffBrainTrees — adds and removes", () => {
  test("preference added in B only", () => {
    const a = makeRoot("a");
    const b = makeRoot("b");
    writePref(a, { slug: "alpha" });
    writePref(b, { slug: "alpha" });
    writePref(b, { slug: "beta", principle: "Beta principle" });
    const d = diffBrainTrees(a, b);
    expect(d.removed).toEqual([]);
    expect(d.modified).toEqual([]);
    expect(d.added).toHaveLength(1);
    expect(d.added[0]!.id).toBe("pref-beta");
    expect(d.added[0]!.kind).toBe("preference");
    expect(d.added[0]!.principle).toBe("Beta principle");
  });

  test("preference removed in B", () => {
    const a = makeRoot("a");
    const b = makeRoot("b");
    writePref(a, { slug: "gone" });
    const d = diffBrainTrees(a, b);
    expect(d.added).toEqual([]);
    expect(d.modified).toEqual([]);
    expect(d.removed).toHaveLength(1);
    expect(d.removed[0]!.id).toBe("pref-gone");
  });

  test("signal added/removed (immutable, no field-diff)", () => {
    const a = makeRoot("a");
    const b = makeRoot("b");
    writeSig(a, "old");
    writeSig(b, "new");
    const d = diffBrainTrees(a, b);
    expect(d.added.map((e) => e.id)).toEqual(["sig-2026-05-01-new"]);
    expect(d.removed.map((e) => e.id)).toEqual(["sig-2026-05-01-old"]);
    expect(d.modified.find((c) => c.entry.kind === "signal")).toBeUndefined();
  });
});

describe("diffBrainTrees — field-level modifications", () => {
  test("preference status + applied_count change", () => {
    const a = makeRoot("a");
    const b = makeRoot("b");
    writePref(a, {
      slug: "rule",
      principle: "Rule",
      status: "confirmed",
      applied: 4,
      violated: 0,
      confidence: "medium",
    });
    writePref(b, {
      slug: "rule",
      principle: "Rule",
      status: "quarantine",
      applied: 7,
      violated: 3,
      confidence: "low",
    });
    const d = diffBrainTrees(a, b);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.modified).toHaveLength(1);
    const change = d.modified[0]!;
    expect(change.entry.id).toBe("pref-rule");
    expect(change.bodyChanged).toBe(false);
    const fieldNames = change.fields.map((f) => f.field).sort();
    expect(fieldNames).toEqual([
      "applied_count",
      "confidence",
      "confirmed_at",
      "status",
      "violated_count",
    ]);
  });

  test("byte-equal preferences produce no change", () => {
    const a = makeRoot("a");
    const b = makeRoot("b");
    writePref(a, { slug: "stable" });
    writePref(b, { slug: "stable" });
    const d = diffBrainTrees(a, b);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.modified).toEqual([]);
  });

  test("log body change marks bodyChanged=true with no fields", () => {
    const a = makeRoot("a");
    const b = makeRoot("b");
    writeLog(a, "2026-05-14", "## 10:00 — feedback\n- x: 1");
    writeLog(b, "2026-05-14", "## 10:00 — feedback\n- x: 2");
    const d = diffBrainTrees(a, b);
    expect(d.modified).toHaveLength(1);
    expect(d.modified[0]!.entry.kind).toBe("log");
    expect(d.modified[0]!.fields).toEqual([]);
    expect(d.modified[0]!.bodyChanged).toBe(true);
  });
});

describe("diffBrainTrees — ignored regions", () => {
  test("entries under .snapshots/ are skipped", () => {
    const a = makeRoot("a");
    const b = makeRoot("b");
    mkdirSync(join(a, ".snapshots"), { recursive: true });
    mkdirSync(join(b, ".snapshots"), { recursive: true });
    writeFileSync(join(a, ".snapshots", "x.tar.zst"), "old", "utf8");
    writeFileSync(join(b, ".snapshots", "y.tar.zst"), "new", "utf8");
    const d = diffBrainTrees(a, b);
    expect(
      d.added.find((e) => e.path.includes(".snapshots/")),
    ).toBeUndefined();
    expect(
      d.removed.find((e) => e.path.includes(".snapshots/")),
    ).toBeUndefined();
  });

  test("symlinks are not followed (defense against malicious snapshot tarballs)", async () => {
    const a = makeRoot("a");
    const b = makeRoot("b");
    // Plant a real file outside the walker root, and a symlink under
    // Brain/preferences/ pointing at it. A naive `statSync`-based
    // walker would dereference the symlink and surface the target's
    // bytes as a "preference" inside the diff.
    const secret = join(scratch, "secret.txt");
    writeFileSync(secret, "SECRET_TOKEN_DO_NOT_LEAK", "utf8");
    const { symlinkSync } = await import("node:fs");
    symlinkSync(secret, join(b, "preferences", "pref-trojan.md"));
    const d = diffBrainTrees(a, b);
    // The symlink must not appear in any diff section.
    const allEntries = [
      ...d.added,
      ...d.removed,
      ...d.modified.map((c) => c.entry),
    ];
    expect(allEntries.find((e) => e.path.includes("pref-trojan"))).toBeUndefined();
  });
});

describe("diffBrainTrees — output ordering", () => {
  test("entries sort deterministically by kind then path", () => {
    const a = makeRoot("a");
    const b = makeRoot("b");
    writePref(b, { slug: "zeta" });
    writePref(b, { slug: "alpha" });
    writeSig(b, "later");
    writeSig(b, "earlier");
    const d = diffBrainTrees(a, b);
    const addedKinds = d.added.map((e) => e.kind);
    // 'preference' < 'signal' alphabetically — preferences come first.
    expect(addedKinds).toEqual([
      "preference",
      "preference",
      "signal",
      "signal",
    ]);
    expect(d.added.map((e) => e.id)).toEqual([
      "pref-alpha",
      "pref-zeta",
      "sig-2026-05-01-earlier",
      "sig-2026-05-01-later",
    ]);
  });
});

describe("renderDiffMarkdown / renderDiffJson", () => {
  test("markdown body groups by kind and emits A/B labels", () => {
    const a = makeRoot("a");
    const b = makeRoot("b");
    writePref(b, { slug: "added-rule", principle: "Use spaces" });
    const md = renderDiffMarkdown(diffBrainTrees(a, b), {
      aLabel: "run-x",
      bLabel: "live",
    });
    expect(md).toMatch(/^# Brain snapshot diff$/m);
    expect(md).toMatch(/^- A: run-x$/m);
    expect(md).toMatch(/^- B: live$/m);
    expect(md).toMatch(/^## Preferences$/m);
    expect(md).toMatch(/^- \+ \[\[pref-added-rule\|Use spaces\]\] \(added\)$/m);
  });

  test("modified row lists field deltas", () => {
    const a = makeRoot("a");
    const b = makeRoot("b");
    writePref(a, {
      slug: "rule",
      principle: "Rule",
      applied: 4,
      confidence: "medium",
    });
    writePref(b, {
      slug: "rule",
      principle: "Rule",
      applied: 7,
      confidence: "high",
    });
    const md = renderDiffMarkdown(diffBrainTrees(a, b), {
      aLabel: "old",
      bLabel: "new",
    });
    expect(md).toMatch(/^- ~ \[\[pref-rule\|Rule\]\]:$/m);
    expect(md).toMatch(/^ {2}- applied_count: 4 → 7$/m);
    expect(md).toMatch(/^ {2}- confidence: medium → high$/m);
  });

  test("section without entries renders '(no changes)'", () => {
    const a = makeRoot("a");
    const b = makeRoot("b");
    const md = renderDiffMarkdown(diffBrainTrees(a, b), {});
    expect(md).toMatch(/^## Preferences$/m);
    expect(md).toMatch(/^\(no changes\)$/m);
  });

  test("json renderer returns the diff verbatim", () => {
    const a = makeRoot("a");
    const b = makeRoot("b");
    writePref(b, { slug: "x" });
    const diff = diffBrainTrees(a, b);
    expect(renderDiffJson(diff)).toBe(diff);
  });
});
