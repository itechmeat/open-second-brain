/**
 * Fail-closed session continuation (context-integrity-gates, Unit C /
 * Task 11).
 *
 * The interim crutch used to resolve a multi-candidate set by picking
 * the most recent predecessor, and to report every refusal as a bare
 * `null` that four distinct causes collapsed into. Both are pinned here
 * as defects: ambiguity must ABSTAIN, and every refusal must name its
 * own reason. Repo, branch and commit join `cwd` as required-match
 * predicates, captured through the hardened git argv reader under a
 * bounded timeout and canonicalized so a credential-bearing clone is
 * the same identity as a credential-free one - and so the credential
 * never reaches a recorded field.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEGRADATION_CODE,
  type DegradationNotice,
} from "../../../src/core/integrity/degradation.ts";
import {
  canonicalizeGitRemote,
  type GitWorkspaceIdentity,
  readGitWorkspaceIdentity,
} from "../../../src/core/brain/git/reader.ts";
import { CRUTCH_ABSTENTION, resolveCrutchLineage } from "../../../src/core/brain/lineage/crutch.ts";
import {
  CRUTCH_LINK_WINDOW_MS,
  LINEAGE_RECORD_STATUS,
  lineageGapSessionIds,
  readLineageLedger,
  recordLineageObservation,
  sessionLineageLedgerPath,
} from "../../../src/core/brain/lineage/ledger.ts";
import { acquireLockSync } from "../../../src/core/brain/sync-lockfile.ts";
import {
  resolveSessionLineage,
  resolveSessionLineageDetailed,
} from "../../../src/core/brain/lineage/resolve.ts";
import { captureSessionLifecycleEvent } from "../../../src/core/brain/session-lifecycle.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-continuation-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const T0 = Date.parse("2026-06-10T08:00:00Z");

// ----- git fixture ---------------------------------------------------------

/** A remote whose credentials must never survive canonicalization. */
const SECRET_REMOTE = "https://alice:s3cr3t-token@git.example.invalid:8443/org/repo.git/";
const SECRET_REMOTE_IDENTITY = "https://git.example.invalid/org/repo";

function git(dir: string, args: ReadonlyArray<string>): void {
  execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
}

function initRepo(dir: string, opts: { remote?: string; branch?: string } = {}): string {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "--quiet", `--initial-branch=${opts.branch ?? "main"}`, dir], {
    stdio: "ignore",
  });
  git(dir, ["config", "user.email", "fixture@example.invalid"]);
  git(dir, ["config", "user.name", "Fixture"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  if (opts.remote !== undefined) git(dir, ["remote", "add", "origin", opts.remote]);
  writeFileSync(join(dir, "a.txt"), "one\n", "utf8");
  git(dir, ["add", "a.txt"]);
  git(dir, ["commit", "--quiet", "--no-gpg-sign", "-m", "one"]);
  return dir;
}

function commitAgain(dir: string, text: string): void {
  writeFileSync(join(dir, "a.txt"), text, "utf8");
  git(dir, ["add", "a.txt"]);
  git(dir, ["commit", "--quiet", "--no-gpg-sign", "-m", text]);
}

// ----- the canonicalizer ---------------------------------------------------

describe("canonicalizeGitRemote — a comparable identity, not a redaction", () => {
  test("strips userinfo, port, .git suffix and trailing slash", () => {
    expect(canonicalizeGitRemote(SECRET_REMOTE)).toBe(SECRET_REMOTE_IDENTITY);
  });

  test("a credential-bearing clone is the SAME identity as a credential-free one", () => {
    const withCreds = canonicalizeGitRemote("https://u:tok@github.com/org/repo.git");
    const withOther = canonicalizeGitRemote("https://other:different@github.com/org/repo");
    const without = canonicalizeGitRemote("https://github.com/org/repo");
    expect(withCreds).toBe(without!);
    expect(withOther).toBe(without!);
  });

  test("never carries the credential through", () => {
    const out = canonicalizeGitRemote(SECRET_REMOTE)!;
    expect(out.includes("s3cr3t-token")).toBe(false);
    expect(out.includes("alice")).toBe(false);
    expect(out.includes("@")).toBe(false);
  });

  test("scp-style and ssh-url forms normalize to one identity", () => {
    const scp = canonicalizeGitRemote("git@github.com:org/repo.git");
    expect(scp).toBe("ssh://github.com/org/repo");
    expect(canonicalizeGitRemote("ssh://git@github.com:22/org/repo.git/")).toBe(scp!);
  });

  test("host case is normalized, path case is not", () => {
    expect(canonicalizeGitRemote("https://GitHub.COM/Org/Repo.git")).toBe(
      "https://github.com/Org/Repo",
    );
  });

  test("a local path remote becomes a file identity", () => {
    expect(canonicalizeGitRemote("/srv/git/thing.git/")).toBe("file:///srv/git/thing");
  });

  test("blank or hostless input is null, never a placeholder", () => {
    expect(canonicalizeGitRemote("")).toBeNull();
    expect(canonicalizeGitRemote("   ")).toBeNull();
    expect(canonicalizeGitRemote("https://")).toBeNull();
  });
});

// ----- the probe -----------------------------------------------------------

describe("readGitWorkspaceIdentity — hardened, bounded probe", () => {
  test("reads repo, branch and commit from a throwaway repository", () => {
    const repo = initRepo(join(tmp, "repo"), { remote: SECRET_REMOTE, branch: "trunk" });
    const identity = readGitWorkspaceIdentity(repo);
    expect(identity).not.toBeNull();
    expect(identity!.repo).toBe(SECRET_REMOTE_IDENTITY);
    expect(identity!.branch).toBe("trunk");
    expect(identity!.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  test("the recorded repo identity never carries the clone credential", () => {
    const repo = initRepo(join(tmp, "repo"), { remote: SECRET_REMOTE });
    const identity = readGitWorkspaceIdentity(repo)!;
    expect(JSON.stringify(identity).includes("s3cr3t-token")).toBe(false);
  });

  test("a SUBDIRECTORY of the repository resolves the same identity", () => {
    const repo = initRepo(join(tmp, "repo"), { remote: SECRET_REMOTE });
    const sub = join(repo, "src", "deep");
    mkdirSync(sub, { recursive: true });
    expect(readGitWorkspaceIdentity(sub)).toEqual(readGitWorkspaceIdentity(repo)!);
  });

  test("a new commit changes the identity", () => {
    const repo = initRepo(join(tmp, "repo"), { remote: SECRET_REMOTE });
    const before = readGitWorkspaceIdentity(repo)!;
    commitAgain(repo, "two\n");
    const after = readGitWorkspaceIdentity(repo)!;
    expect(after.commit).not.toBe(before.commit!);
    expect(after.repo).toBe(before.repo!);
  });

  test("a directory that is not a repository reads as no identity", () => {
    const plain = join(tmp, "plain");
    mkdirSync(plain, { recursive: true });
    expect(readGitWorkspaceIdentity(plain)).toBeNull();
    expect(readGitWorkspaceIdentity(join(tmp, "does-not-exist"))).toBeNull();
  });

  test("a repository with no remote still reports branch and commit", () => {
    const repo = initRepo(join(tmp, "bare-remote"));
    const identity = readGitWorkspaceIdentity(repo)!;
    expect(identity.repo).toBeNull();
    expect(identity.branch).toBe("main");
  });

  test("the probe is bounded: an exhausted budget yields no identity, never a hang", () => {
    const repo = initRepo(join(tmp, "repo"), { remote: SECRET_REMOTE });
    // An exhausted budget is stated, not approximated. This assertion
    // previously passed `1`, which leaves the first invocation a whole
    // millisecond of budget and so asserted only that this machine's git
    // is slower than that - true on a loaded developer box, false on a
    // fast runner, and a claim about hardware either way.
    expect(readGitWorkspaceIdentity(repo, { timeoutMs: 0 })).toBeNull();
    expect(readGitWorkspaceIdentity(repo, { timeoutMs: -1 })).toBeNull();
  });

  test("a budget that is not a number is a caller bug, and is named", () => {
    const repo = initRepo(join(tmp, "nan-budget"), { remote: SECRET_REMOTE });
    // Silently substituting the default would hand back a two-second
    // probe to a caller who believes it asked for something else.
    expect(() => readGitWorkspaceIdentity(repo, { timeoutMs: Number.NaN })).toThrow(/timeoutMs/);
  });
});

// ----- the resolver --------------------------------------------------------

function seed(opts: {
  sessionId: string;
  atMs?: number;
  cwd?: string;
  evidence?: boolean;
  workspace?: GitWorkspaceIdentity;
}): void {
  recordLineageObservation(tmp, {
    sessionId: opts.sessionId,
    at: new Date(opts.atMs ?? T0).toISOString(),
    cwd: opts.cwd ?? "/work",
    event: opts.evidence === false ? "Stop" : "PostCompact",
    ...(opts.evidence === false ? {} : { compressionEvidence: true }),
    ...(opts.workspace !== undefined ? { workspace: opts.workspace } : {}),
  });
}

const WS_MAIN: GitWorkspaceIdentity = {
  repo: "https://git.example.invalid/org/repo",
  branch: "main",
  commit: "a".repeat(40),
};

function outcome(
  sessionId: string,
  over: Partial<Parameters<typeof resolveCrutchLineage>[0]> = {},
) {
  return resolveCrutchLineage({
    sessionId,
    cwd: "/work",
    ledger: readLineageLedger(tmp),
    nowMs: T0 + 30_000,
    ...over,
  });
}

describe("resolveCrutchLineage — every refusal names itself", () => {
  test("links a single surviving candidate", () => {
    seed({ sessionId: "s-old" });
    const result = outcome("s-new");
    expect(result.kind).toBe("linked");
    if (result.kind !== "linked") throw new Error("unreachable");
    expect(result.lineage).toEqual({
      rootId: "s-old",
      parentId: "s-old",
      depth: 1,
      source: "crutch",
    });
  });

  test("TWO surviving candidates ABSTAIN instead of taking the most recent", () => {
    seed({ sessionId: "s-a", atMs: T0 });
    seed({ sessionId: "s-b", atMs: T0 + 10_000 });
    const result = outcome("s-new");
    expect(result.kind).toBe("abstained");
    if (result.kind !== "abstained") throw new Error("unreachable");
    expect(result.reason).toBe(CRUTCH_ABSTENTION.ambiguous);
    expect(result.considered).toBe(2);
    expect(result.detail.length).toBeGreaterThan(0);
  });

  test("no ledger at all abstains with no-candidate", () => {
    const result = outcome("s-new");
    expect(result).toMatchObject({ kind: "abstained", reason: CRUTCH_ABSTENTION.noCandidate });
  });

  test("a session with its own unlinked history abstains with self-known", () => {
    seed({ sessionId: "s-old" });
    seed({ sessionId: "s-new", atMs: T0 - 120_000, evidence: false });
    const result = outcome("s-new");
    expect(result).toMatchObject({ kind: "abstained", reason: CRUTCH_ABSTENTION.selfKnown });
  });

  test("an absent working directory abstains with no-workspace", () => {
    seed({ sessionId: "s-old" });
    expect(outcome("s-new", { cwd: undefined })).toMatchObject({
      kind: "abstained",
      reason: CRUTCH_ABSTENTION.noWorkspace,
    });
    expect(outcome("s-new", { cwd: "" })).toMatchObject({
      kind: "abstained",
      reason: CRUTCH_ABSTENTION.noWorkspace,
    });
  });

  test("a candidate outside the freshness window abstains with stale", () => {
    seed({ sessionId: "s-old" });
    const result = outcome("s-new", { nowMs: T0 + CRUTCH_LINK_WINDOW_MS + 1 });
    expect(result).toMatchObject({ kind: "abstained", reason: CRUTCH_ABSTENTION.stale });
  });

  test("a candidate without compression evidence abstains with evidence-missing", () => {
    seed({ sessionId: "s-old", evidence: false });
    const result = outcome("s-new");
    expect(result).toMatchObject({
      kind: "abstained",
      reason: CRUTCH_ABSTENTION.evidenceMissing,
    });
  });

  test("a candidate in another working directory is no-candidate, not a near miss", () => {
    seed({ sessionId: "s-old", cwd: "/elsewhere" });
    expect(outcome("s-new")).toMatchObject({
      kind: "abstained",
      reason: CRUTCH_ABSTENTION.noCandidate,
    });
  });

  test("a predecessor another session already continued from is not a candidate", () => {
    // A -> B is recorded; C must resolve to B alone, not read A and B
    // as an ambiguous pair. A compaction boundary has one successor.
    seed({ sessionId: "s-a", atMs: T0 });
    recordLineageObservation(tmp, {
      sessionId: "s-b",
      at: new Date(T0 + 10_000).toISOString(),
      cwd: "/work",
      event: "PostCompact",
      compressionEvidence: true,
      lineage: { rootId: "s-a", parentId: "s-a", depth: 1, source: "crutch" },
    });
    const result = outcome("s-c");
    expect(result.kind).toBe("linked");
    if (result.kind !== "linked") throw new Error("unreachable");
    expect(result.lineage).toEqual({
      rootId: "s-a",
      parentId: "s-b",
      depth: 2,
      source: "crutch",
    });
  });

  test("the nearest miss wins: evidence-missing outranks stale", () => {
    seed({ sessionId: "s-stale", atMs: T0 - CRUTCH_LINK_WINDOW_MS - 1 });
    seed({ sessionId: "s-noevidence", evidence: false });
    expect(outcome("s-new")).toMatchObject({
      kind: "abstained",
      reason: CRUTCH_ABSTENTION.evidenceMissing,
    });
  });
});

describe("resolveCrutchLineage — repo, branch and commit are match predicates", () => {
  test("an identical workspace identity links", () => {
    seed({ sessionId: "s-old", workspace: WS_MAIN });
    expect(outcome("s-new", { workspace: WS_MAIN }).kind).toBe("linked");
  });

  test("a different BRANCH does not link", () => {
    seed({ sessionId: "s-old", workspace: WS_MAIN });
    const result = outcome("s-new", { workspace: { ...WS_MAIN, branch: "feature" } });
    expect(result.kind).toBe("abstained");
  });

  test("a different COMMIT does not link", () => {
    seed({ sessionId: "s-old", workspace: WS_MAIN });
    const result = outcome("s-new", { workspace: { ...WS_MAIN, commit: "b".repeat(40) } });
    expect(result.kind).toBe("abstained");
  });

  test("a different REPO does not link", () => {
    seed({ sessionId: "s-old", workspace: WS_MAIN });
    const result = outcome("s-new", {
      workspace: { ...WS_MAIN, repo: "https://git.example.invalid/org/other" },
    });
    expect(result.kind).toBe("abstained");
  });

  test("an attested candidate against an unattested session abstains with evidence-missing", () => {
    seed({ sessionId: "s-old", workspace: WS_MAIN });
    expect(outcome("s-new")).toMatchObject({
      kind: "abstained",
      reason: CRUTCH_ABSTENTION.evidenceMissing,
    });
  });

  test("an unattested candidate against an attested session abstains with evidence-missing", () => {
    seed({ sessionId: "s-old" });
    expect(outcome("s-new", { workspace: WS_MAIN })).toMatchObject({
      kind: "abstained",
      reason: CRUTCH_ABSTENTION.evidenceMissing,
    });
  });

  test("two unattested sides still link — a non-git workspace is not a refusal", () => {
    seed({ sessionId: "s-old" });
    expect(outcome("s-new").kind).toBe("linked");
  });
});

// ----- the ledger carries the identity -------------------------------------

describe("lineage ledger — workspace identity round-trip", () => {
  test("records and reads back repo, branch and commit", () => {
    seed({ sessionId: "s-1", workspace: WS_MAIN });
    expect(readLineageLedger(tmp).get("s-1")?.workspace).toEqual(WS_MAIN);
  });

  test("compaction preserves the workspace identity", () => {
    // Compaction retains the most recent LINES verbatim, so the line
    // under test has to be inside the retention window when the rewrite
    // runs - which is the realistic case, the ledger being append-only.
    const filler = (from: number, count: number): void => {
      for (let i = from; i < from + count; i++) {
        recordLineageObservation(tmp, {
          sessionId: `filler-${i}`,
          at: new Date(T0 + i * 1_000).toISOString(),
          event: "Stop",
        });
      }
    };
    filler(0, 510);
    seed({ sessionId: "s-keep", atMs: T0 + 510_000, workspace: WS_MAIN });
    filler(511, 5); // crosses the cap and rewrites the file
    expect(readLineageLedger(tmp).get("s-keep")?.workspace).toEqual(WS_MAIN);
  });
});

// ----- resolution surface --------------------------------------------------

describe("resolveSessionLineageDetailed — the abstention reaches the caller", () => {
  test("carries the crutch outcome alongside the lineage", () => {
    seed({ sessionId: "s-a", atMs: T0 });
    seed({ sessionId: "s-b", atMs: T0 + 10_000 });
    const resolution = resolveSessionLineageDetailed(
      { sessionId: "s-new", cwd: "/work" },
      { ledger: readLineageLedger(tmp), nowMs: T0 + 30_000 },
    );
    expect(resolution.lineage.source).toBe("flat");
    expect(resolution.crutch).toMatchObject({
      kind: "abstained",
      reason: CRUTCH_ABSTENTION.ambiguous,
    });
  });

  test("an ambiguous abstention emits a sessionLinkAbstained notice", () => {
    seed({ sessionId: "s-a", atMs: T0 });
    seed({ sessionId: "s-b", atMs: T0 + 10_000 });
    const notices: DegradationNotice[] = [];
    resolveSessionLineageDetailed(
      { sessionId: "s-new", cwd: "/work" },
      { ledger: readLineageLedger(tmp), nowMs: T0 + 30_000, notices },
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]!.code).toBe(DEGRADATION_CODE.sessionLinkAbstained);
    expect(notices[0]!.detail).toContain(CRUTCH_ABSTENTION.ambiguous);
  });

  test("the ordinary flat path emits NO notice", () => {
    const notices: DegradationNotice[] = [];
    resolveSessionLineageDetailed(
      { sessionId: "s-new", cwd: "/work" },
      { ledger: readLineageLedger(tmp), nowMs: T0 + 30_000, notices },
    );
    expect(notices).toHaveLength(0);
  });

  test("a link emits no notice", () => {
    seed({ sessionId: "s-old" });
    const notices: DegradationNotice[] = [];
    const resolution = resolveSessionLineageDetailed(
      { sessionId: "s-new", cwd: "/work" },
      { ledger: readLineageLedger(tmp), nowMs: T0 + 30_000, notices },
    );
    expect(resolution.lineage.source).toBe("crutch");
    expect(notices).toHaveLength(0);
  });

  test("resolveSessionLineage stays flat on an abstention and never throws", () => {
    seed({ sessionId: "s-a", atMs: T0 });
    seed({ sessionId: "s-b", atMs: T0 + 10_000 });
    expect(
      resolveSessionLineage(
        { sessionId: "s-new", cwd: "/work" },
        { ledger: readLineageLedger(tmp), nowMs: T0 + 30_000 },
      ),
    ).toEqual({ rootId: "s-new", parentId: null, depth: 0, source: "flat" });
  });
});

// ----- a dropped observation is still the session's own history ------------

describe("resolveCrutchLineage — a DROPPED observation cannot become a FALSE STITCH", () => {
  /**
   * Rule 1 ("a session with its own ledger history is parallel, never a
   * continuation") is tested by the presence of the session's own ledger
   * line. A writer-lock drop removes exactly that evidence, so without
   * the gap sidecar the resolver reads a session that DID speak as one
   * that never has - and stitches it onto an unrelated parallel session.
   * A false stitch is strictly worse than a missed one, and the
   * anticipatory cache derives its file from the lineage root, so this
   * redirects one conversation's cache into another's.
   */
  function dropObservation(sessionId: string, atMs: number): void {
    const handle = acquireLockSync(sessionLineageLedgerPath(tmp));
    try {
      const result = recordLineageObservation(tmp, {
        sessionId,
        at: new Date(atMs).toISOString(),
        cwd: "/work",
        event: "Stop",
      });
      expect(result.status).toBe(LINEAGE_RECORD_STATUS.dropped);
    } finally {
      handle.release();
    }
  }

  test("a session whose only observation was dropped abstains with self-known", () => {
    seed({ sessionId: "s-parallel", atMs: T0 });
    dropObservation("s-spoke", T0 + 5_000);
    expect(readLineageLedger(tmp).has("s-spoke")).toBe(false);

    const result = outcome("s-spoke", { gapSessionIds: lineageGapSessionIds(tmp) });
    expect(result).toMatchObject({
      kind: "abstained",
      reason: CRUTCH_ABSTENTION.selfKnown,
    });
  });

  test("without the gap set the same ledger produces the false stitch", () => {
    // Pins WHY the observation has to be threaded: the ledger alone
    // cannot tell "never spoke" from "spoke and was dropped".
    seed({ sessionId: "s-parallel", atMs: T0 });
    dropObservation("s-spoke", T0 + 5_000);
    expect(outcome("s-spoke").kind).toBe("linked");
  });

  test("a session with no gap and no history still links normally", () => {
    seed({ sessionId: "s-parallel", atMs: T0 });
    dropObservation("s-spoke", T0 + 5_000);
    const result = outcome("s-fresh", { gapSessionIds: lineageGapSessionIds(tmp) });
    expect(result.kind).toBe("linked");
  });

  test("resolveSessionLineageDetailed threads the gap set through", () => {
    seed({ sessionId: "s-parallel", atMs: T0 });
    dropObservation("s-spoke", T0 + 5_000);
    const resolution = resolveSessionLineageDetailed(
      { sessionId: "s-spoke", cwd: "/work" },
      {
        ledger: readLineageLedger(tmp),
        gapSessionIds: lineageGapSessionIds(tmp),
        nowMs: T0 + 30_000,
      },
    );
    expect(resolution.lineage.source).toBe("flat");
    expect(resolution.crutch).toMatchObject({ reason: CRUTCH_ABSTENTION.selfKnown });
  });
});

// ----- the hook path -------------------------------------------------------

describe("captureSessionLifecycleEvent — fail-closed, fail-soft, credential-free", () => {
  let vault: string;
  let repo: string;

  beforeEach(() => {
    vault = join(tmp, "vault");
    mkdirSync(vault, { recursive: true });
    bootstrapBrain(vault);
    repo = initRepo(join(tmp, "repo"), { remote: SECRET_REMOTE });
  });

  test("stamps the canonical workspace identity onto the ledger observation", async () => {
    await captureSessionLifecycleEvent(
      vault,
      { hook_event_name: "UserPromptSubmit", session_id: "g-1", cwd: repo, prompt: "hi" },
      { agent: "tester", now: new Date(T0) },
    );
    const entry = readLineageLedger(vault).get("g-1");
    expect(entry?.workspace?.repo).toBe(SECRET_REMOTE_IDENTITY);
    expect(entry?.workspace?.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  test("the clone credential never reaches the ledger file", async () => {
    await captureSessionLifecycleEvent(
      vault,
      { hook_event_name: "UserPromptSubmit", session_id: "g-2", cwd: repo, prompt: "hi" },
      { agent: "tester", now: new Date(T0) },
    );
    const raw = readFileSync(sessionLineageLedgerPath(vault), "utf8");
    expect(raw.includes("s3cr3t-token")).toBe(false);
    expect(raw.includes("alice")).toBe(false);
  });

  test("stitches within one repository state and REFUSES after a new commit", async () => {
    await captureSessionLifecycleEvent(
      vault,
      { hook_event_name: "PostCompact", session_id: "g-old", cwd: repo },
      { agent: "tester", now: new Date(T0) },
    );
    const linked = await captureSessionLifecycleEvent(
      vault,
      { hook_event_name: "UserPromptSubmit", session_id: "g-mid", cwd: repo, prompt: "go" },
      { agent: "tester", now: new Date(T0 + 60_000) },
    );
    expect(linked.lineage?.source).toBe("crutch");

    await captureSessionLifecycleEvent(
      vault,
      { hook_event_name: "PostCompact", session_id: "g-mid", cwd: repo },
      { agent: "tester", now: new Date(T0 + 70_000) },
    );
    commitAgain(repo, "moved on\n");
    const refused = await captureSessionLifecycleEvent(
      vault,
      { hook_event_name: "UserPromptSubmit", session_id: "g-next", cwd: repo, prompt: "go" },
      { agent: "tester", now: new Date(T0 + 80_000) },
    );
    expect("lineage" in refused).toBe(false);
  });

  test("two concurrent sessions in one repository state both abstain", async () => {
    // Two conversations running side by side in one working tree: each
    // is already known to the ledger before either compacts, so neither
    // is the other's continuation, and both compact inside the window.
    // Sequential by construction: the ledger state each call observes is
    // the state the previous call left behind, so these cannot be
    // collapsed into a parallel await.
    const capture = (payload: Record<string, unknown>, atMs: number): Promise<unknown> =>
      captureSessionLifecycleEvent(vault, payload, {
        agent: "tester",
        now: new Date(atMs),
      });
    await capture(
      { hook_event_name: "UserPromptSubmit", session_id: "c-a", cwd: repo, prompt: "work" },
      T0,
    );
    await capture(
      { hook_event_name: "UserPromptSubmit", session_id: "c-b", cwd: repo, prompt: "work" },
      T0,
    );
    await capture({ hook_event_name: "PostCompact", session_id: "c-a", cwd: repo }, T0 + 10_000);
    await capture({ hook_event_name: "PostCompact", session_id: "c-b", cwd: repo }, T0 + 10_000);
    const result = await captureSessionLifecycleEvent(
      vault,
      { hook_event_name: "UserPromptSubmit", session_id: "c-new", cwd: repo, prompt: "go" },
      { agent: "tester", now: new Date(T0 + 60_000) },
    );
    expect("lineage" in result).toBe(false);
    // The refusal is not merely silent-and-flat: it is on the record.
    const audit = readFileSync(result.audit_path, "utf8");
    expect(audit).toContain(DEGRADATION_CODE.sessionLinkAbstained);
    expect(audit).toContain(CRUTCH_ABSTENTION.ambiguous);
  });

  test("a dropped observation reaches the audit record instead of being discarded", async () => {
    // `recordLineageObservation` returns a NAMED notice when the writer
    // lock refuses the append; the call site used to be a bare statement
    // that threw it away, which is a silent failure with extra steps.
    const handle = acquireLockSync(sessionLineageLedgerPath(vault));
    let result;
    try {
      result = await captureSessionLifecycleEvent(
        vault,
        { hook_event_name: "UserPromptSubmit", session_id: "d-1", cwd: repo, prompt: "hi" },
        { agent: "tester", now: new Date(T0) },
      );
    } finally {
      handle.release();
    }
    const audit = JSON.parse(
      readFileSync(result.audit_path, "utf8").trim().split("\n").at(-1)!,
    ) as { details: Record<string, unknown> };
    const dropped = audit.details["lineage_dropped"] as string[];
    expect(dropped).toBeDefined();
    expect(dropped[0]).toContain(DEGRADATION_CODE.lineageObservationDropped);
    expect(dropped[0]).toContain("d-1");
  });

  test("a successful append leaves the audit shape unchanged", async () => {
    const result = await captureSessionLifecycleEvent(
      vault,
      { hook_event_name: "UserPromptSubmit", session_id: "d-2", cwd: repo, prompt: "hi" },
      { agent: "tester", now: new Date(T0) },
    );
    expect(readFileSync(result.audit_path, "utf8")).not.toContain("lineage_dropped");
  });
});
