/**
 * The page-dedup apply loop is fail-soft per merge attempt (Lane 5, Task
 * 5.2): one cluster's MergeChainError - or any other per-attempt failure -
 * is collected as {key, message}, the later clusters still apply, the
 * report lists the failures, and the CLI exits 1 when failures are
 * non-empty. Before the decomposition one throw aborted every cluster
 * queued behind it.
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { findDuplicateCandidates } from "../../../../src/core/brain/page-dedup.ts";
import {
  applyDedupCandidates,
  cmdBrainPageDedup,
} from "../../../../src/cli/brain/verbs/page-dedup.ts";
import { CHMOD_CANNOT_DENY } from "../../../helpers/platform.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-page-dedup-fail-soft-"));
  vault = join(tmp, "vault");
  mkdirSync(vault, { recursive: true });
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * One preference page in the dedup pool, with its own topic and principle.
 * `kind` selects the pool directory: `brain-preference` pages live in
 * Brain/preferences, `brain-retired` pages in Brain/retired, so two
 * clusters can sit in directories with independent write bits.
 */
function writePoolPage(
  poolDir: "preferences" | "retired",
  slug: string,
  topic: string,
  principle: string,
  body = "",
): string {
  const prefix = poolDir === "preferences" ? "pref" : "ret";
  const kind = poolDir === "preferences" ? "brain-preference" : "brain-retired";
  const path = join(vault, "Brain", poolDir, `${prefix}-${slug}.md`);
  writeFileSync(
    path,
    [
      "---",
      `kind: ${kind}`,
      `id: ${prefix}-${slug}`,
      "tags: [brain]",
      `topic: ${topic}`,
      "_status: confirmed",
      `principle: ${principle}`,
      "unconfirmed_until: 2026-01-15T00:00:00Z",
      "created_at: 2026-01-01T00:00:00Z",
      "---",
      "",
      body,
      "",
    ].join("\n"),
    "utf8",
  );
  return path;
}

describe("applyDedupCandidates", () => {
  test("a MergeChainError on one cluster is collected; later clusters still apply", () => {
    writePoolPage("preferences", "a", "topic-one", "the first rule", "see also [[pref-b]]");
    writePoolPage("preferences", "b", "topic-one", "the first rule");
    writePoolPage("preferences", "c", "topic-two", "the second rule", "see also [[pref-d]]");
    writePoolPage("preferences", "d", "topic-two", "the second rule");

    const report = findDuplicateCandidates(vault);
    expect(report.candidates.length).toBe(2);

    // Sabotage the FIRST cluster: its secondary vanishes between the scan
    // and the apply, which mergePage refuses with a MergeChainError
    // (MALFORMED, "secondary page not found").
    const first = report.candidates[0]!;
    const sabotaged = first.secondaries[0]!;
    unlinkSync(join(vault, "Brain", "preferences", `${sabotaged.id}.md`));

    const applied = applyDedupCandidates(vault, report.candidates);

    // The failure is named by cluster key and message.
    expect(applied.failures.length).toBe(1);
    expect(applied.failures[0]!.key).toBe(first.key);
    expect(applied.failures[0]!.message).toContain(`secondary page not found: ${sabotaged.id}`);

    // The later cluster still applied.
    expect(applied.merged).toBe(1);
    expect(applied.wikilinksUpdated).toBe(1);
    const second = report.candidates[1]!;
    expect(readFileSync(join(vault, "Brain", "preferences", "pref-d.md"), "utf8")).toContain(
      `merged_into: ${second.canonical.id}`,
    );
  });

  test("a clean apply reports zero failures", () => {
    writePoolPage("preferences", "a", "topic-one", "the first rule", "see also [[pref-b]]");
    writePoolPage("preferences", "b", "topic-one", "the first rule");

    const applied = applyDedupCandidates(vault, findDuplicateCandidates(vault).candidates);
    expect(applied.failures).toEqual([]);
    expect(applied.merged).toBe(1);
  });

  test("a link-pass failure reports the partial count and the stamped secondary", () => {
    if (CHMOD_CANNOT_DENY) return;
    // pref-a cites pref-b (rewritable), and a second citing page sits in
    // its own directory the test makes unwritable: the merge STAMP lands,
    // the link pass rewrites what it can, then fails.
    writePoolPage("preferences", "a", "topic-one", "the first rule", "see also [[pref-b]]");
    writePoolPage("preferences", "b", "topic-one", "the first rule");
    mkdirSync(join(vault, "Brain", "notes"), { recursive: true });
    writeFileSync(join(vault, "Brain", "notes", "note.md"), "see [[pref-b]] too\n", "utf8");

    const report = findDuplicateCandidates(vault);
    const notesDir = join(vault, "Brain", "notes");
    chmodSync(notesDir, 0o555);
    try {
      const applied = applyDedupCandidates(vault, report.candidates);

      expect(applied.failures).toHaveLength(1);
      expect(applied.failures[0]!.key).toBe(report.candidates[0]!.key);
      expect(applied.failures[0]!.message).toContain("could not write");
      // The honest count: the link pass rewrote the citing page it could
      // before it hit the one it could not.
      expect(applied.failures[0]!.wikilinksUpdated).toBe(1);
      // The merged half DID land before the failure - the failure report
      // must not leave the reader assuming the secondary is untouched.
      expect(readFileSync(join(vault, "Brain", "preferences", "pref-b.md"), "utf8")).toContain(
        "merged_into: pref-a",
      );
    } finally {
      chmodSync(notesDir, 0o755);
    }
  });
});

describe("cmdBrainPageDedup --apply with a failing cluster", () => {
  test("the run completes, lists the failure, and exits 1", async () => {
    if (CHMOD_CANNOT_DENY) return;
    writePoolPage("preferences", "a", "topic-one", "the first rule", "see also [[pref-b]]");
    writePoolPage("preferences", "b", "topic-one", "the first rule");
    writePoolPage("retired", "c", "topic-two", "the second rule", "see also [[ret-d]]");
    writePoolPage("retired", "d", "topic-two", "the second rule");

    // The writes are atomic (temp file + rename into place), so the denial
    // that blocks a merge is the DIRECTORY write bit: a read-only
    // Brain/preferences fails exactly the first cluster while Brain/retired
    // stays writable.
    const prefsDir = join(vault, "Brain", "preferences");
    chmodSync(prefsDir, 0o555);
    try {
      const exit = await captureVerb(["--vault", vault, "--apply", "--yes", "--json"]);
      expect(exit.code).toBe(1);
      const payload = JSON.parse(exit.stdout) as {
        merged: number;
        failures: Array<{ key: string; message: string }>;
      };
      expect(payload.failures.length).toBe(1);
      expect(payload.failures[0]!.message).toContain("EACCES");
      expect(payload.merged).toBe(1);
      // The later cluster still applied, in its writable directory.
      expect(readFileSync(join(vault, "Brain", "retired", "ret-d.md"), "utf8")).toContain(
        "merged_into: ret-c",
      );
      // The blocked cluster is untouched.
      expect(readFileSync(join(vault, "Brain", "preferences", "pref-b.md"), "utf8")).not.toContain(
        "merged_into",
      );
    } finally {
      chmodSync(prefsDir, 0o755);
    }
  });
});

/** Run the verb in-process, capturing stdout and the returned exit code. */
async function captureVerb(argv: string[]): Promise<{ code: number; stdout: string }> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await cmdBrainPageDedup(argv);
    return { code, stdout: chunks.join("") };
  } finally {
    process.stdout.write = originalWrite;
  }
}
