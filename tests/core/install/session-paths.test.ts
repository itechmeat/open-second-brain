/**
 * `InstallAdapter.sessionPaths` over the whole registered population.
 *
 * The member shipped as an optional one with zero implementations and
 * zero call sites, carrying a `format` union
 * (`"claude-jsonl" | "codex-json" | "cursor-sqlite" | "unknown"`) that no
 * other module in the tree used and that named none of the adapters
 * `src/core/brain/sessions/` actually ships. An optional member nobody
 * implements is indistinguishable from one nobody needs, and that is what
 * this file changes: the answer is REQUIRED, so a runtime storing no
 * session logs has to say `null` rather than say nothing.
 *
 * The population is derived from `registerAllAdapters()` for the same
 * reason `host-facts-census.test.ts` derives its own: a hand-listed set of
 * adapters vouches only for the adapters somebody remembered.
 */

import { describe, expect, test } from "bun:test";

import { registerAllAdapters } from "../../../src/core/install/adapters/all.ts";
import { sessionPathsFor } from "../../../src/core/install/session-paths.ts";
import type { InstallEnv } from "../../../src/core/install/types.ts";
import {
  isInstallTargetId,
  isSessionRuntimeId,
  resolveSessionRootsFor,
  RUNTIME_FACTS,
  SESSION_ROOTS,
  SESSION_RUNTIME_ID,
  type InstallTargetId,
} from "../../../src/core/runtime/host-facts.ts";
import { isSessionAdapterId } from "../../../src/core/brain/sessions/types.ts";

const HOME = "/home/operator";

function envFor(extra: Readonly<Record<string, string>> = {}): InstallEnv {
  return {
    vault: "/srv/vaults/example",
    home: HOME,
    cwd: "/srv/projects/example",
    env: extra,
    now: new Date("2026-08-16T09:00:00.000Z"),
  };
}

const ADAPTERS = registerAllAdapters().list();

describe("every adapter answers where its sessions live", () => {
  test("the population is the registered one, and every target is a vocabulary member", () => {
    // A registry that stopped registering would make every assertion
    // below pass over nothing.
    expect(ADAPTERS.length).toBe(10);
    const strangers = ADAPTERS.map((a) => a.target).filter((t) => !isInstallTargetId(t));
    expect(strangers.join("\n")).toBe("");
  });

  test("no adapter leaves the member absent", () => {
    const silent = ADAPTERS.filter((a) => typeof a.sessionPaths !== "function").map(
      (a) => a.target,
    );
    expect(silent.toSorted().join("\n")).toBe("");
  });

  test("a runtime that stores no session logs answers null, and says so on purpose", () => {
    const quiet: ReadonlyArray<string> = ADAPTERS.filter(
      (a) => a.sessionPaths(envFor()) === null,
    ).map((a) => a.target);
    expect(quiet.toSorted()).toEqual(
      ["aider", "copilot-cli", "gemini-cli", "generic", "kiro", "pi"].toSorted(),
    );
  });

  test("a runtime that stores session logs answers the fact table's roots, resolved", () => {
    // The declaration is reached through the RUNTIME-keyed lookup
    // (`resolveSessionRootsFor` over `SESSION_ROOTS`), not the
    // target-keyed one. Comparing `adapter.sessionPaths()` against
    // `resolveSessionRoots(target)` was a tautology: both read
    // `RUNTIME_FACTS[target].sessionRoots`, so the assertion held for any
    // value that field could contain. Going through the other lookup is
    // what makes a row naming one runtime while carrying another's roots
    // fail here.
    const drifted: string[] = [];
    for (const adapter of ADAPTERS) {
      const target = adapter.target as InstallTargetId;
      const runtime = RUNTIME_FACTS[target].sessionRuntime;
      const declared =
        runtime === null ? [] : resolveSessionRootsFor(runtime, { home: HOME, env: {} });
      const answered = adapter.sessionPaths(envFor());
      if (declared.length === 0) {
        if (answered !== null) drifted.push(`${target}: roots with no declaration`);
        continue;
      }
      if (answered === null) {
        drifted.push(`${target}: declared roots but answered null`);
        continue;
      }
      if (JSON.stringify(answered.roots) !== JSON.stringify(declared)) {
        drifted.push(`${target}: answered roots differ from the declaration`);
      }
      if (answered.target !== target) drifted.push(`${target}: answered for ${answered.target}`);
      if (!isSessionRuntimeId(answered.runtime)) {
        drifted.push(`${target}: runtime ${String(answered.runtime)} is not a session runtime`);
      }
    }
    expect(drifted.toSorted().join("\n")).toBe("");
  });

  test("each root names a session adapter, or names the format no adapter reads", () => {
    const defects: string[] = [];
    for (const adapter of ADAPTERS) {
      const answered = adapter.sessionPaths(envFor());
      if (answered === null) continue;
      for (const root of answered.roots) {
        if (root.adapter === null) {
          // The stated non-session format. `format` is what makes the
          // null a fact rather than a shrug.
          if (root.format.trim() === "") defects.push(`${answered.target}/${root.id}: no format`);
          continue;
        }
        if (!isSessionAdapterId(root.adapter)) {
          defects.push(`${answered.target}/${root.id}: adapter ${root.adapter}`);
        }
      }
    }
    expect(defects.toSorted().join("\n")).toBe("");
  });

  test("the answer follows the injected environment, not this machine", () => {
    const relocated = sessionPathsFor("codex", envFor({ CODEX_HOME: "/mnt/elsewhere/codex" }));
    expect(relocated).not.toBeNull();
    expect(relocated!.roots.map((r) => r.path)).toEqual([
      "/mnt/elsewhere/codex/sessions",
      "/mnt/elsewhere/codex/session",
      "/mnt/elsewhere/codex/history",
      "/mnt/elsewhere/codex/.tmp",
    ]);
  });

  test("cursor answers the runtime whose logs no adapter in this build reads", () => {
    const cursor = sessionPathsFor("cursor", envFor());
    expect(cursor).not.toBeNull();
    expect(cursor!.runtime).toBe(SESSION_RUNTIME_ID.cursor);
    expect(cursor!.roots.every((r) => r.adapter === null)).toBe(true);
    expect([...new Set(cursor!.roots.map((r) => r.format))]).toEqual(["cursor-state-vscdb"]);
  });

  test("the row's declared session runtime and its declared roots agree", () => {
    // Two fields could disagree, and the comparison has to be BETWEEN
    // them: a row naming `grok` while carrying Cursor's roots would make
    // the discovery join silently wrong - a sweep keyed on the runtime id
    // would attribute Cursor's `state.vscdb` files to grok - and the
    // shapes match, so nothing about the types objects to it. Counting
    // roots against runtime-is-not-null could not see it: both sides stay
    // true. The row's roots must BE the entry its declared runtime names,
    // by identity, because `SESSION_ROOTS` is the one declaration and a
    // row that copied the array instead of pointing at it is a second one.
    const drifted: string[] = [];
    for (const row of Object.values(RUNTIME_FACTS)) {
      if (row.sessionRuntime === null) {
        if (row.sessionRoots.length > 0) {
          drifted.push(`${row.target}: ${row.sessionRoots.length} roots but no session runtime`);
        }
        continue;
      }
      const declared = SESSION_ROOTS[row.sessionRuntime];
      if (row.sessionRoots !== declared) {
        drifted.push(
          `${row.target}: sessionRoots are not SESSION_ROOTS[${row.sessionRuntime}] ` +
            `(ids ${row.sessionRoots.map((r) => r.id).join(",")} vs ` +
            `${declared.map((r) => r.id).join(",")})`,
        );
      }
      if (row.sessionRoots.length === 0) {
        drifted.push(`${row.target}: names runtime ${row.sessionRuntime} and declares no roots`);
      }
    }
    expect(drifted.toSorted().join("\n")).toBe("");
  });
});
