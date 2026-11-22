/**
 * A release step names the index the report names. A report made for
 * another index - `--db`, `--vault`, a config that names another one -
 * would otherwise print a command that acts on the default index, and a
 * copied command that releases nothing.
 *
 * The caller carries the target in; the wording module compares it with
 * the target a plain command acts on and prints only the flags that
 * differ, so the common case stays short.
 *
 * The named path is quoted for the shell that reads the copied command:
 * a path with a space in it is one argument, not two. A path that needs
 * no quoting is printed as it is.
 */

import { expect, test } from "bun:test";

import {
  parkedIndexReleaseStep,
  type ParkedIndexTarget,
  type ParkedIndexVerdict,
} from "../../../src/core/search/parked-index.ts";

const VAULT = "/vault";
const DB = "/vault/.open-second-brain/brain.sqlite";

/** The default index of the configured vault: what a plain command acts on. */
const DEFAULT_TARGET: ParkedIndexTarget = Object.freeze({
  dbPath: DB,
  vaultPath: VAULT,
  configPath: null,
  defaultDbPath: DB,
  defaultVaultPath: VAULT,
  defaultConfigPath: null,
});

/** A parked index the rule keeps, as the release step sees it. */
function verdict(
  reason: ParkedIndexVerdict["reason"],
  vectors: number | null = 0,
): ParkedIndexVerdict {
  return { path: DB + ".bak", reason, vectors };
}

test("the default index names the plain command", () => {
  const step = parkedIndexReleaseStep(verdict("unreadable", null), DEFAULT_TARGET);

  expect(step).toContain("o2b search set-aside bak --apply");
  expect(step).not.toContain("--db");
  expect(step).not.toContain("--vault");
});

test("an alternate index is named by the command that releases it", () => {
  const alternate = "/alternate/brain.sqlite";
  const step = parkedIndexReleaseStep(
    verdict("unreadable", null),
    Object.freeze({ ...DEFAULT_TARGET, dbPath: alternate }),
  );

  expect(step).toContain(`o2b search set-aside --db ${alternate} bak --apply`);
});

test("an alternate vault is named as well, and the index with it", () => {
  const step = parkedIndexReleaseStep(
    verdict("richer", 3),
    Object.freeze({
      dbPath: "/other/.open-second-brain/brain.sqlite",
      vaultPath: "/other",
      configPath: null,
      defaultDbPath: DB,
      defaultVaultPath: VAULT,
      defaultConfigPath: null,
    }),
  );

  expect(step).toContain("--vault /other");
  expect(step).toContain("--db /other/.open-second-brain/brain.sqlite");
});

test("the embeddings rebuild names the alternate index too", () => {
  const step = parkedIndexReleaseStep(
    verdict("richer", 3),
    Object.freeze({ ...DEFAULT_TARGET, dbPath: "/alternate/brain.sqlite" }),
  );

  expect(step).toContain("o2b search reindex --db /alternate/brain.sqlite --embeddings");
});

test("another machine config is named as well", () => {
  const step = parkedIndexReleaseStep(
    verdict("unreadable", null),
    Object.freeze({
      ...DEFAULT_TARGET,
      configPath: "/elsewhere/config.yaml",
      defaultConfigPath: "/default/config.yaml",
    }),
  );

  expect(step).toContain("--config /elsewhere/config.yaml");
});

test("a printed --config always carries --db: another config may name another index", () => {
  const step = parkedIndexReleaseStep(
    verdict("unreadable", null),
    Object.freeze({
      ...DEFAULT_TARGET,
      configPath: "/elsewhere/config.yaml",
      defaultConfigPath: "/default/config.yaml",
    }),
  );

  // The index is the default one here, and still named: the copied command
  // reads /elsewhere/config.yaml, which can resolve to another index.
  expect(step).toContain(`--config /elsewhere/config.yaml --db ${DB}`);
});

test("a printed --config always carries --vault too: another config may name another vault", () => {
  const step = parkedIndexReleaseStep(
    verdict("unreadable", null),
    Object.freeze({
      ...DEFAULT_TARGET,
      configPath: "/elsewhere/config.yaml",
      defaultConfigPath: "/default/config.yaml",
    }),
  );

  // The vault is the default one here, and still named: /elsewhere/config.yaml
  // may name another vault, and the rebuild would read that corpus instead.
  expect(step).toContain(`--config /elsewhere/config.yaml --db ${DB} --vault ${VAULT}`);
});

test("an empty parked index beside a live index that cannot be counted frees the blocked name first", () => {
  const step = parkedIndexReleaseStep(
    verdict("live-count-unknown", 0),
    DEFAULT_TARGET,
    DB + ".old",
  );

  // Both names stay held while the live count is unknown, so the rebuild
  // the step names cannot start until the unreadable one is set aside.
  expect(step).toMatch(
    /^set the parked index at \S+\.old aside first with: o2b search set-aside old/u,
  );
  expect(step).toContain("then run again: o2b search reindex");
});

test("a swap that stopped part way: the step restores the index first, set-aside would refuse", () => {
  const step = parkedIndexReleaseStep(
    { ...verdict("no-live-index", null), swapInterrupted: true },
    DEFAULT_TARGET,
  );

  expect(step).toMatch(/^a rebuild stopped part way through its swap/u);
  expect(step).toContain("run: o2b search reindex,");
  expect(step).toContain("then follow what o2b search status prints");
  expect(step).not.toContain("set-aside bak");
});

test("a path with a space is quoted, so the copied command acts on it", () => {
  const step = parkedIndexReleaseStep(
    verdict("unreadable", null),
    Object.freeze({ ...DEFAULT_TARGET, dbPath: "/data/My Notes/brain.sqlite" }),
    null,
    "linux",
  );

  expect(step).toContain("--db '/data/My Notes/brain.sqlite'");
});

test("a path with a quote in it is quoted for the shell that reads it", () => {
  const step = parkedIndexReleaseStep(
    verdict("unreadable", null),
    Object.freeze({ ...DEFAULT_TARGET, dbPath: "/data/O'Brien/brain.sqlite" }),
    null,
    "linux",
  );

  expect(step).toContain(`--db '/data/O'\\''Brien/brain.sqlite'`);
});

test("a simple path is printed as it is", () => {
  const step = parkedIndexReleaseStep(
    verdict("unreadable", null),
    Object.freeze({ ...DEFAULT_TARGET, dbPath: "/data/brain.sqlite" }),
    null,
    "linux",
  );

  expect(step).toContain("--db /data/brain.sqlite");
  expect(step).not.toContain("'");
});

test("the Windows command is double-quoted, for the shell that reads it there", () => {
  const step = parkedIndexReleaseStep(
    verdict("unreadable", null),
    Object.freeze({ ...DEFAULT_TARGET, dbPath: "C:\\My Notes\\brain.sqlite" }),
    null,
    "win32",
  );

  // cmd.exe passes a single-quoted word through with its quotes, so the
  // POSIX spelling would not read as the path it names.
  expect(step).toContain('--db "C:\\My Notes\\brain.sqlite"');
  expect(step).not.toContain("'");
});

test("a Windows path PowerShell would expand gets a line for each shell, each named", () => {
  const step = parkedIndexReleaseStep(
    verdict("unreadable", null),
    Object.freeze({ ...DEFAULT_TARGET, dbPath: "C:\\$Archive\\brain.sqlite" }),
    null,
    "win32",
  );

  // Inside double quotes PowerShell expands `$Archive`; cmd.exe passes
  // single quotes through. No one spelling is right in both, so each
  // shell gets its own, and the line says which is which.
  expect(step).toContain('--db "C:\\$Archive\\brain.sqlite" bak --apply (in cmd.exe;');
  expect(step).toContain(
    "in PowerShell: o2b search set-aside --db 'C:\\$Archive\\brain.sqlite' bak --apply)",
  );
});

test("a Windows path both shells read alike inside double quotes gets one line", () => {
  const step = parkedIndexReleaseStep(
    verdict("unreadable", null),
    Object.freeze({ ...DEFAULT_TARGET, dbPath: "C:\\My Notes\\brain.sqlite" }),
    null,
    "win32",
  );

  expect(step).not.toContain("PowerShell");
  expect(step).not.toContain("cmd.exe");
});

test("the Windows command keeps a simple path as it is", () => {
  const step = parkedIndexReleaseStep(
    verdict("unreadable", null),
    Object.freeze({ ...DEFAULT_TARGET, dbPath: "C:\\vault\\brain.sqlite" }),
    null,
    "win32",
  );

  expect(step).toContain("--db C:\\vault\\brain.sqlite");
});

test("a Windows path with a percent sign gets only the PowerShell line: cmd.exe expands it", () => {
  const step = parkedIndexReleaseStep(
    verdict("unreadable", null),
    Object.freeze({ ...DEFAULT_TARGET, dbPath: "C:\\%USERNAME%\\brain.sqlite" }),
    null,
    "win32",
  );

  // cmd.exe substitutes %USERNAME% even inside double quotes, so no
  // cmd.exe line names this path literally; only PowerShell's does.
  expect(step).toContain(
    "o2b search set-aside --db 'C:\\%USERNAME%\\brain.sqlite' bak --apply (in PowerShell; " +
      "cmd.exe cannot take this path literally)",
  );
  expect(step).not.toContain('"C:');
});

test("a Windows path with a typographic quote is single-quoted for PowerShell, the quote doubled", () => {
  const step = parkedIndexReleaseStep(
    verdict("unreadable", null),
    Object.freeze({ ...DEFAULT_TARGET, dbPath: "C:\\Ada’s “notes”\\brain.sqlite" }),
    null,
    "win32",
  );

  // PowerShell ends a double-quoted string at “ and a single-quoted one at
  // ’ unless it is doubled; cmd.exe reads neither as a quote.
  expect(step).toContain('--db "C:\\Ada’s “notes”\\brain.sqlite" bak --apply (in cmd.exe;');
  expect(step).toContain("--db 'C:\\Ada’’s “notes”\\brain.sqlite' bak --apply)");
});

test("a Windows path with an exclamation mark gets only the PowerShell line", () => {
  const step = parkedIndexReleaseStep(
    verdict("unreadable", null),
    Object.freeze({ ...DEFAULT_TARGET, dbPath: "C:\\!ARCHIVE!\\brain.sqlite" }),
    null,
    "win32",
  );

  expect(step).toContain(
    "o2b search set-aside --db 'C:\\!ARCHIVE!\\brain.sqlite' bak --apply (in PowerShell; " +
      "cmd.exe cannot take this path literally)",
  );
  expect(step).not.toContain('"C:');
});
