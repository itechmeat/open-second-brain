/**
 * Per-repo git record store with watermark
 * (Project History Suite, t_c812752c).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendGitRecords,
  gitStoreDir,
  gitStoreRootDir,
  listGitCommits,
  listGitRepos,
  listGitTags,
  readGitState,
  writeGitState,
} from "../../../../src/core/brain/git/store.ts";
import type { GitCommitRecord, GitTagRecord } from "../../../../src/core/brain/git/store.ts";
import { acquireLockSync, LOCK_WAIT_BUDGET_ENV } from "../../../../src/core/brain/sync-lockfile.ts";
import { withDeviceId } from "../../../helpers/device-id.ts";
import { CHMOD_CANNOT_DENY } from "../../../helpers/platform.ts";

let tmp: string;
let vault: string;

const KEY = "fixture-repo-abcd1234";

function commit(sha: string, over: Partial<GitCommitRecord> = {}): GitCommitRecord {
  return {
    kind: "commit",
    sha,
    authorName: "Fixture Author",
    authorEmail: "fixture@example.com",
    committedAt: "2026-06-01T10:00:00+00:00",
    subject: "feat: default subject",
    body: "",
    files: ["src/a.ts"],
    release: null,
    ...over,
  };
}

function tag(name: string, targetSha: string): GitTagRecord {
  return { kind: "tag", name, targetSha, createdAt: "2026-06-02T10:00:00+00:00" };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-git-store-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("gitStoreDir nests under Brain/projects/git/<repo-key>", () => {
  expect(gitStoreDir(vault, KEY)).toBe(join(vault, "Brain", "projects", "git", KEY));
});

test("gitStoreRootDir is Brain/projects/git and the parent of every repo store", () => {
  expect(gitStoreRootDir(vault)).toBe(join(vault, "Brain", "projects", "git"));
  expect(gitStoreDir(vault, KEY)).toBe(join(gitStoreRootDir(vault), KEY));
});

test("append + list round-trips commits and tags, oldest-first", () => {
  const a = commit("a".repeat(40), { subject: "feat: first" });
  const b = commit("b".repeat(40), { subject: "fix: second", files: ["src/b.ts", "docs/x.md"] });
  const res = appendGitRecords(vault, KEY, [a, tag("v1.0.0", "b".repeat(40)), b]);
  expect(res.appended).toBe(3);
  expect(res.skipped).toBe(0);
  const commits = listGitCommits(vault, KEY);
  expect(commits.map((c) => c.subject)).toEqual(["feat: first", "fix: second"]);
  expect(commits[1]!.files).toEqual(["src/b.ts", "docs/x.md"]);
  const tags = listGitTags(vault, KEY);
  expect(tags).toHaveLength(1);
  expect(tags[0]!.name).toBe("v1.0.0");
});

test("append dedups commits by sha and tags by name across calls", () => {
  appendGitRecords(vault, KEY, [commit("a".repeat(40)), tag("v1.0.0", "a".repeat(40))]);
  const res = appendGitRecords(vault, KEY, [
    commit("a".repeat(40), { subject: "changed subject must not re-append" }),
    tag("v1.0.0", "a".repeat(40)),
    commit("c".repeat(40)),
  ]);
  expect(res.appended).toBe(1);
  expect(res.skipped).toBe(2);
  const commits = listGitCommits(vault, KEY);
  expect(commits).toHaveLength(2);
  expect(commits[0]!.subject).toBe("feat: default subject");
});

test("listGitCommits filters by file, author, text, time range, and limit keeps newest", () => {
  appendGitRecords(vault, KEY, [
    commit("a".repeat(40), {
      subject: "feat: alpha",
      files: ["src/a.ts"],
      committedAt: "2026-06-01T10:00:00+00:00",
    }),
    commit("b".repeat(40), {
      subject: "fix: beta touches a",
      files: ["src/a.ts", "src/b.ts"],
      committedAt: "2026-06-02T10:00:00+00:00",
      authorName: "Other Author",
    }),
    commit("c".repeat(40), {
      subject: "docs: gamma",
      body: "explains the alpha decision",
      files: ["docs/g.md"],
      committedAt: "2026-06-03T10:00:00+00:00",
    }),
  ]);
  expect(listGitCommits(vault, KEY, { file: "src/a.ts" })).toHaveLength(2);
  expect(listGitCommits(vault, KEY, { author: "other" })).toHaveLength(1);
  // text matches subject AND body, case-insensitive
  expect(listGitCommits(vault, KEY, { text: "ALPHA" }).map((c) => c.subject)).toEqual([
    "feat: alpha",
    "docs: gamma",
  ]);
  expect(listGitCommits(vault, KEY, { since: "2026-06-02T00:00:00Z" })).toHaveLength(2);
  expect(listGitCommits(vault, KEY, { until: "2026-06-01T23:59:59Z" })).toHaveLength(1);
  const limited = listGitCommits(vault, KEY, { limit: 2 });
  expect(limited.map((c) => c.subject)).toEqual(["fix: beta touches a", "docs: gamma"]);
});

test("a retargeted tag appends a fresh record and wins in listGitTags", () => {
  appendGitRecords(vault, KEY, [tag("v1.0.0", "a".repeat(40))]);
  // Same (name, target): dedup. New target for the same name: append.
  const res = appendGitRecords(vault, KEY, [
    tag("v1.0.0", "a".repeat(40)),
    tag("v1.0.0", "b".repeat(40)),
  ]);
  expect(res.skipped).toBe(1);
  expect(res.appendedTags).toBe(1);
  const tags = listGitTags(vault, KEY);
  expect(tags).toHaveLength(1);
  expect(tags[0]!.targetSha).toBe("b".repeat(40));
});

test("invalid since/until datetimes are rejected, not silently empty", () => {
  appendGitRecords(vault, KEY, [commit("a".repeat(40))]);
  expect(() => listGitCommits(vault, KEY, { since: "not-a-date" })).toThrow(/invalid 'since'/);
  expect(() => listGitCommits(vault, KEY, { until: "garbage" })).toThrow(/invalid 'until'/);
});

test("malformed JSONL lines are skipped, not fatal", () => {
  appendGitRecords(vault, KEY, [commit("a".repeat(40))]);
  const path = join(gitStoreDir(vault, KEY), "commits.jsonl");
  writeFileSync(path, `${readFileSync(path, "utf8")}not json\n{"kind":"junk"}\n`);
  appendGitRecords(vault, KEY, [commit("b".repeat(40))]);
  expect(listGitCommits(vault, KEY)).toHaveLength(2);
});

test("git state round-trips and validates the watermark sha", () => {
  expect(readGitState(vault, KEY)).toEqual({ state: null, error: null });
  writeGitState(vault, KEY, {
    repoPath: "/work/fixture-repo",
    lastSha: "d".repeat(40),
    lastIngestedAt: "2026-06-04T08:00:00Z",
  });
  const probe = readGitState(vault, KEY);
  expect(probe.error).toBeNull();
  expect(probe.state!.lastSha).toBe("d".repeat(40));
  expect(probe.state!.repoPath).toBe("/work/fixture-repo");
  expect(() =>
    writeGitState(vault, KEY, {
      repoPath: "/work/fixture-repo",
      lastSha: "HEAD",
      lastIngestedAt: "2026-06-04T08:00:00Z",
    }),
  ).toThrow(/full 40-hex/);
});

test("a corrupted state file reads as an error probe, never throws", () => {
  mkdirSync(gitStoreDir(vault, KEY), { recursive: true });
  writeFileSync(join(gitStoreDir(vault, KEY), "state.json"), "{broken");
  const probe = readGitState(vault, KEY);
  expect(probe.state).toBeNull();
  expect(probe.error).toMatch(/not valid JSON/);
  // Tampered watermark sha is rejected on read too.
  writeFileSync(
    join(gitStoreDir(vault, KEY), "state.json"),
    JSON.stringify({ repo_path: "/x", last_sha: "HEAD~1; evil", last_ingested_at: "t" }),
  );
  expect(readGitState(vault, KEY).error).toMatch(/full 40-hex/);
});

test("listGitRepos enumerates per-repo stores with their states", () => {
  expect(listGitRepos(vault)).toEqual([]);
  appendGitRecords(vault, KEY, [commit("a".repeat(40))]);
  writeGitState(vault, "other-repo-00000000", {
    repoPath: "/work/other",
    lastSha: "e".repeat(40),
    lastIngestedAt: "2026-06-04T08:00:00Z",
  });
  const repos = listGitRepos(vault);
  expect(repos.map((r) => r.key)).toEqual([KEY, "other-repo-00000000"]);
  expect(repos[0]!.state).toBeNull();
  expect(repos[1]!.state!.repoPath).toBe("/work/other");
  expect(existsSync(join(vault, "Brain", "projects", "git", KEY, "commits.jsonl"))).toBe(true);
});

test("listGitRepos skips an entry that vanished, a dangling link", () => {
  appendGitRecords(vault, KEY, [commit("a".repeat(40))]);
  symlinkSync(join(tmp, "nowhere"), join(gitStoreRootDir(vault), "dangling"));
  expect(listGitRepos(vault).map((r) => r.key)).toEqual([KEY]);
});

test.skipIf(CHMOD_CANNOT_DENY)(
  "listGitRepos surfaces an entry it cannot stat by its error code",
  () => {
    appendGitRecords(vault, KEY, [commit("a".repeat(40))]);
    const root = gitStoreRootDir(vault);
    // Readable but not searchable: the names list, every stat is refused.
    chmodSync(root, 0o444);
    try {
      expect(() => listGitRepos(vault)).toThrow(/EACCES/);
    } finally {
      chmodSync(root, 0o755);
    }
  },
);

test("two devices write their own commits shards and reads merge both (t_774dea61)", () => {
  const a = commit("c".repeat(40), { subject: "feat: from host a" });
  const b = commit("d".repeat(40), { subject: "fix: from host b" });
  withDeviceId("a", () => appendGitRecords(vault, KEY, [a]));
  withDeviceId("b", () => appendGitRecords(vault, KEY, [b]));
  const dir = gitStoreDir(vault, KEY);
  expect(existsSync(join(dir, "commits.a.jsonl"))).toBe(true);
  expect(existsSync(join(dir, "commits.b.jsonl"))).toBe(true);
  expect(existsSync(join(dir, "commits.jsonl"))).toBe(false);

  // Cross-device dedup: replaying host a's commit under host b is a no-op
  // because the dedup read spans every shard.
  const replay = withDeviceId("b", () => appendGitRecords(vault, KEY, [a]));
  expect(replay.appended).toBe(0);
  expect(
    listGitCommits(vault, KEY)
      .map((c) => c.subject)
      .toSorted(),
  ).toEqual(["feat: from host a", "fix: from host b"]);
});

test("the append lock is the device's own shard, not the legacy name (t_774dea61)", () => {
  const dir = gitStoreDir(vault, KEY);
  mkdirSync(dir, { recursive: true });
  const previousBudget = process.env[LOCK_WAIT_BUDGET_ENV];
  process.env[LOCK_WAIT_BUDGET_ENV] = "0";
  // Another writer holds the legacy file and device b's shard.
  const legacy = acquireLockSync(join(dir, "commits.jsonl"));
  const other = acquireLockSync(join(dir, "commits.b.jsonl"));
  try {
    const result = withDeviceId("a", () => appendGitRecords(vault, KEY, [commit("e".repeat(40))]));
    expect(result.appended).toBe(1);

    const own = acquireLockSync(join(dir, "commits.a.jsonl"));
    try {
      expect(() =>
        withDeviceId("a", () => appendGitRecords(vault, KEY, [commit("f".repeat(40))])),
      ).toThrow(/lock busy: .*commits\.a\.jsonl\.lock/);
    } finally {
      own.release();
    }
  } finally {
    legacy.release();
    other.release();
    if (previousBudget === undefined) delete process.env[LOCK_WAIT_BUDGET_ENV];
    else process.env[LOCK_WAIT_BUDGET_ENV] = previousBudget;
  }
});

test("commits from two devices list oldest-first by commit time (t_774dea61)", () => {
  // Device a ingested the newer range, device b the older one; a sorts
  // first by shard name, so a name-order merge listed b's old commits last
  // and a `limit` kept them as the "newest".
  withDeviceId("a", () =>
    appendGitRecords(vault, KEY, [
      commit("1".repeat(40), { subject: "a-new-1", committedAt: "2026-06-03T10:00:00+00:00" }),
      commit("2".repeat(40), { subject: "a-new-2", committedAt: "2026-06-04T10:00:00+00:00" }),
    ]),
  );
  withDeviceId("b", () =>
    appendGitRecords(vault, KEY, [
      commit("3".repeat(40), { subject: "b-old-1", committedAt: "2026-06-01T10:00:00+00:00" }),
      commit("4".repeat(40), { subject: "b-old-2", committedAt: "2026-06-02T10:00:00+00:00" }),
    ]),
  );

  expect(listGitCommits(vault, KEY).map((c) => c.subject)).toEqual([
    "b-old-1",
    "b-old-2",
    "a-new-1",
    "a-new-2",
  ]);
  expect(listGitCommits(vault, KEY, { limit: 1 }).map((c) => c.subject)).toEqual(["a-new-2"]);
});

test("a commit two devices both ingested before their shards synced lists once (t_774dea61)", () => {
  // Both devices found the sha absent and wrote it: device b's shard is a
  // byte copy of device a's, the state a pre-sync race leaves behind.
  withDeviceId("a", () =>
    appendGitRecords(vault, KEY, [
      commit("5".repeat(40), { subject: "both", committedAt: "2026-06-01T10:00:00+00:00" }),
      commit("6".repeat(40), { subject: "only-a", committedAt: "2026-06-02T10:00:00+00:00" }),
    ]),
  );
  const dir = gitStoreDir(vault, KEY);
  const firstLine = readFileSync(join(dir, "commits.a.jsonl"), "utf8").split("\n")[0]!;
  writeFileSync(join(dir, "commits.b.jsonl"), `${firstLine}\n`);

  expect(listGitCommits(vault, KEY).map((c) => c.subject)).toEqual(["both", "only-a"]);
  expect(listGitCommits(vault, KEY, { limit: 2 }).map((c) => c.subject)).toEqual([
    "both",
    "only-a",
  ]);
});
