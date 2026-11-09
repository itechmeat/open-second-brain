/**
 * The git ingest watermark on a store-only machine (task 2.10, design D14
 * item 11): it lives in this machine's device-local state of the store
 * (`machineStatePath`), not in a folder every store on the machine
 * shares, and the ingest's rescan clear removes it there. Listing repositories
 * takes only repository folders.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  appendGitRecords,
  type GitCommitRecord,
  gitStatePath,
  listGitCommits,
  listGitTags,
  listGitRepos,
  readGitState,
  STATE_FILE_NAME,
  writeGitState,
} from "../../../../src/core/brain/git/store.ts";
import { machineStatePath } from "../../../../src/core/state/machine-state.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";
import { switchDevice } from "./fixtures.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

const SHA = "a".repeat(40);

describe("the git watermark once switched", () => {
  test("is kept in the store's device-local state and cleared there", () => {
    env = makeStoreEnv("osb-git-state-", { dualWrite: false });
    switchDevice(env.storeRoot);
    writeGitState(env.vault, "repo-1", { repoPath: "/r", lastSha: SHA, lastIngestedAt: "t" });
    const path = machineStatePath(env.vault, "Brain", "projects", "git", "repo-1", STATE_FILE_NAME);
    expect(existsSync(path)).toBe(true);
    expect(readGitState(env.vault, "repo-1").state?.lastSha).toBe(SHA);
    // A stray file beside the repository folders is no repository.
    writeFileSync(join(path, "..", "..", ".DS_Store"), "");
    expect(listGitRepos(env.vault).map((r) => r.key)).toEqual(["repo-1"]);
    expect(gitStatePath(env.vault, "repo-1")).toBe(path);
    rmSync(gitStatePath(env.vault, "repo-1"));
    expect(readGitState(env.vault, "repo-1").state).toBeNull();
  });
});

describe("the git timeline on both machines", () => {
  const commit = (n: number, committedAt: string): GitCommitRecord => ({
    kind: "commit",
    sha: String(n).repeat(40),
    authorName: "a",
    authorEmail: "a@example.com",
    committedAt,
    subject: `commit ${n}`,
    body: "",
    files: [],
    release: null,
  });

  /** One append, out of time order, with a tag that carries no time. */
  function timeline(mode: "legacy" | "switched") {
    env = makeStoreEnv(`osb-git-timeline-${mode}-`, { dualWrite: false });
    if (mode === "switched") switchDevice(env.storeRoot);
    appendGitRecords(env.vault, "repo-1", [
      commit(1, "2026-11-01T10:00:00Z"),
      commit(2, "2026-11-01T12:00:00Z"),
      { kind: "tag", name: "v1", targetSha: "2".repeat(40), createdAt: null },
      commit(3, "2026-11-01T11:00:00Z"),
    ]);
    const answer = {
      commits: listGitCommits(env.vault, "repo-1", {}).map((c) => c.subject),
      lastTwo: listGitCommits(env.vault, "repo-1", { limit: 2 }).map((c) => c.subject),
      tags: listGitTags(env.vault, "repo-1").map((t) => t.name),
    };
    env.cleanup();
    env = undefined;
    return answer;
  }

  test("keeps the append order and an untimed tag after its predecessor, as unswitched", () => {
    const legacy = timeline("legacy");
    expect(legacy.commits).toEqual(["commit 1", "commit 2", "commit 3"]);
    expect(timeline("switched")).toEqual(legacy);
  });
});
