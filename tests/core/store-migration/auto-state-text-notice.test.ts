/**
 * Two small properties of the automatic migration's device-local state:
 *
 *  1. A reason kept or shown has a known home directory reduced to `~`,
 *     whatever its case on Windows (its paths are not case-sensitive) and
 *     only as spelled on a case-sensitive platform. The platform and the
 *     homes are inputs of the pure redaction, so both rules run on every
 *     platform; nothing is read from the environment.
 *  2. Clearing a notice a session showed is idempotent: a second clear
 *     while the attempt is unfinished keeps the mark of the shown notice,
 *     so a pass that finishes the attempt does not publish it again.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  clearAutoMigrationNotice,
  readAutoMigrationNotice,
  recordAutoMigrationAttempt,
  recordAutoMigrationNotice,
  reportableTextFor,
} from "../../../src/core/store-migration/auto-state.ts";
import { makeMigrationBench, type MigrationBench } from "./fixtures/migration-env.ts";

describe("a home directory in a kept reason", () => {
  // The platform and the known homes are inputs, so each platform's rule
  // runs on every platform the suite runs on.
  const windowsHomes = ["D:\\Profiles\\Alice"];
  const posixHomes = ["/srv/people/alice"];

  test("a known home is reduced whatever its case on Windows", () => {
    for (const path of [
      "D:\\Profiles\\Alice\\vault",
      "d:\\profiles\\alice\\vault",
      "D:\\PROFILES\\ALICE\\vault",
    ]) {
      expect(reportableTextFor(`cannot open ${path}`, "win32", windowsHomes)).toBe(
        "cannot open ~\\vault",
      );
    }
  });

  test("a Windows users path is reduced by the fallback pattern whatever its case", () => {
    for (const path of ["C:\\USERS\\Bob\\vault", "c:\\users\\bob\\vault"]) {
      for (const platform of ["win32", "linux"] as const) {
        expect(reportableTextFor(`cannot open ${path}`, platform, [])).toBe("cannot open ~\\vault");
      }
    }
  });

  test("a known home on a case-sensitive platform matches only as spelled", () => {
    expect(reportableTextFor("at /srv/people/alice/x", "linux", posixHomes)).toBe("at ~/x");
    expect(reportableTextFor("at /SRV/PEOPLE/ALICE/x", "linux", posixHomes)).toBe(
      "at /SRV/PEOPLE/ALICE/x",
    );
    expect(reportableTextFor("at d:\\profiles\\alice\\x", "darwin", windowsHomes)).toBe(
      "at d:\\profiles\\alice\\x",
    );
  });

  test("the longest known home is reduced first", () => {
    expect(
      reportableTextFor("at /srv/people/alice/x", "linux", ["/srv/people", "/srv/people/alice"]),
    ).toBe("at ~/x");
  });
});

describe("a notice cleared twice while its attempt is unfinished", () => {
  let bench: MigrationBench;
  beforeEach(() => {
    bench = makeMigrationBench("osb-notice-clear-");
  });
  afterEach(() => bench.cleanup());

  test("keeps the mark of the shown notice, so it is not published again", () => {
    const now = new Date();
    recordAutoMigrationAttempt(bench.vault, now);
    recordAutoMigrationNotice(bench.vault, { snapshot: "snap-1", runId: "run-1" }, now);
    expect(readAutoMigrationNotice(bench.vault)).not.toBeNull();
    // Two sessions read the notice, then each clears it.
    clearAutoMigrationNotice(bench.vault);
    clearAutoMigrationNotice(bench.vault);
    // The pass that finishes the attempt writes its notice again.
    recordAutoMigrationNotice(bench.vault, { snapshot: "snap-1", runId: "run-1" }, now);
    expect(readAutoMigrationNotice(bench.vault)).toBeNull();
  });
});
