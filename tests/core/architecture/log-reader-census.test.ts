/**
 * The log-reader census (change store-hardening, design D3; spec
 * `remote-log-reads`): every module that calls a log reader is classified,
 * so a new reader of the log cannot reach a remote caller without saying
 * whether it filters the events of the store's `private` partition.
 *
 * The walk finds every call of a log reader in `src/**\/*.ts` (read off the
 * code view, so a name inside a comment or a string is not a call, and a
 * `function <name>(` declaration is not one either), including a call
 * through a name a named import binds the reader to
 * (`import { storeLogDays as days }`) and requires each
 * calling module to be a key of {@link LOG_READERS}. A calling module the
 * table does not list fails, naming it; a table key that no longer calls a
 * reader fails as stale.
 *
 * The classes:
 * - `at-reach`: a surface below local reach reads it, and it leaves out
 *   the private events there. For the surfaces of design D1 and the D2
 *   rows, the behaviour is proved per surface in
 *   `tests/mcp/log-private-reach-surfaces.test.ts`; this census proves only
 *   that every other `at-reach` module is classified.
 * - `local-only`: only the operator's own shell reads it.
 * - `computation`: it defines a reader, or computes a result that is not
 *   an answer to a remote caller's read.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { lexCode } from "../../helpers/source-lexer.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const SRC_ROOT = join(REPO_ROOT, "src");

/** The log readers a call to which enrols a module. */
const LOG_READER_NAMES: ReadonlyArray<string> = Object.freeze([
  "logDayReader",
  "storeLogDays",
  "readStoreLogEvents",
  "readStoreLogEventsReport",
  "readLogEvents",
  "readLogEventsReport",
  "logDaysWithDevices",
  "readAllLogEntries",
  "buildTimelineIndex",
]);

/** A call of one of `names`, not its `function <name>(` declaration. */
function callPattern(names: ReadonlyArray<string>): RegExp {
  return new RegExp(`(?<!\\bfunction\\s+)\\b(?:${names.join("|")})\\s*\\(`);
}

/** A call of a reader under its own name. */
const LOG_READER_CALL_RE = callPattern(LOG_READER_NAMES);

/** The braces of a named import or re-export: `import { a as b, c } from`. */
const NAMED_IMPORT_RE = /\b(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\b/g;

/**
 * The local names `code` binds a reader to under another name
 * (`import { storeLogDays as days }`), so a call through the alias is
 * still a call of the reader.
 */
function readerAliases(code: string): string[] {
  const readers: ReadonlySet<string> = new Set(LOG_READER_NAMES);
  const aliases: string[] = [];
  for (const match of code.matchAll(NAMED_IMPORT_RE)) {
    for (const specifier of match[1]!.split(",")) {
      const parts = specifier
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/);
      if (parts.length === 2 && readers.has(parts[0]!) && /^[A-Za-z_$][\w$]*$/.test(parts[1]!)) {
        aliases.push(parts[1]!);
      }
    }
  }
  return aliases;
}

/** Whether `code` calls a reader, under its own name or an imported alias. */
function callsLogReader(code: string): boolean {
  if (LOG_READER_CALL_RE.test(code)) return true;
  const aliases = readerAliases(code);
  return aliases.length > 0 && callPattern(aliases).test(code);
}

type LogReaderClass = "at-reach" | "local-only" | "computation";

interface LogReaderRow {
  readonly class: LogReaderClass;
  readonly reason: string;
}

const DEFINES = "defines the reader";

function rows(
  modules: ReadonlyArray<string>,
  cls: LogReaderClass,
  reason: string,
): ReadonlyArray<readonly [string, LogReaderRow]> {
  return modules.map((m) => [`src/${m}`, { class: cls, reason }] as const);
}

/** Every module that calls a log reader, keyed by its `src/` path. */
const LOG_READERS: Readonly<Record<string, LogReaderRow>> = Object.freeze(
  Object.fromEntries([
    ...rows(
      [
        "cli/brain/verbs/temporal-daily.ts",
        "cli/brain/verbs/temporal-evolution.ts",
        "cli/brain/verbs/temporal-stale.ts",
        "cli/brain/verbs/temporal-timeline.ts",
        "cli/brain/verbs/temporal-weekly.ts",
      ],
      "local-only",
      "CLI",
    ),
    ...rows(["core/brain/agent-source/vault-provider.ts"], "at-reach", "D2 row 4"),
    ...rows(["core/brain/backlinks.ts"], "at-reach", "D2 row 5"),
    ...rows(
      ["core/brain/digest-agent-summary.ts", "core/brain/lessons.ts", "core/brain/event-trace.ts"],
      "at-reach",
      "`logEntryAtReach` with the caller's view",
    ),
    ...rows(
      ["core/brain/digest-collect.ts"],
      "at-reach",
      "`logEntryAtReach` with the caller's view; the digest's log window moved out of `digest.ts` in the 700-line split (task 3.19)",
    ),
    ...rows(
      ["core/brain/doctor/orphan-session-check.ts", "core/brain/doctor/records.ts"],
      "computation",
      "D2, settled rows",
    ),
    ...rows(
      ["core/brain/dream-refresh.ts", "core/brain/evidence.ts"],
      "computation",
      "dream and evidence (task 3.18)",
    ),
    ...rows(
      [
        "core/brain/governance/forget-plan.ts",
        "core/brain/profile-doc.ts",
        "core/brain/temporal/citations.ts",
        "core/discipline/log-counts.ts",
      ],
      "local-only",
      "CLI only",
    ),
    ...rows(
      ["core/brain/idea-lineage.ts", "core/brain/operator-snapshot.ts"],
      "at-reach",
      "D2 row 9",
    ),
    ...rows(
      [
        "core/brain/memory-cost-meter.ts",
        "core/brain/most-applied.ts",
        "core/brain/morning-brief.ts",
        "core/brain/status.ts",
        "core/brain/token-footprint.ts",
        "core/brain/notes/write-log.ts",
        "core/brain/notes/write-destinations.ts",
      ],
      "at-reach",
      "D2 rows 2, 3, 6, 7, 8, 10",
    ),
    ...rows(
      ["core/brain/monthly-review.ts", "core/brain/today-dashboard.ts"],
      "at-reach",
      "the caller's `eventAtReach` (D1)",
    ),
    ...rows(
      ["core/brain/portability/okf.ts"],
      "at-reach",
      "private events leave `log.md` (spec `okf-export`)",
    ),
    ...rows(["core/brain/query.ts"], "at-reach", "`brain_query` filters every mode (D2 row 1)"),
    ...rows(
      ["mcp/brain/analytics-tools.ts", "mcp/brain/brief-view-tools.ts"],
      "at-reach",
      "`requestRefView` (D1); derived rows: an index built withholding (D2 row 9); the brief views moved out of `brief-tools.ts` in the 700-line split (task 3.19)",
    ),
    ...rows(["mcp/brain/review-tools.ts"], "at-reach", "D2 row 9"),
    ...rows(
      ["mcp/resources-record-readers.ts"],
      "at-reach",
      "`osb://log` filters (D3 of `lane-pages-split`); the log reader moved out of `resources.ts` in the 700-line split (task 3.19)",
    ),
    ...rows(
      [
        "core/brain/log-days.ts",
        "core/store/read/log-events.ts",
        "core/brain/temporal/build-index.ts",
      ],
      "computation",
      DEFINES,
    ),
  ]),
);

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

/** Every `.ts` file under `src/`, as repo-relative path and text. */
function readSourceTree(): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith(".ts")) {
        files.push({
          path: relative(REPO_ROOT, abs).split("\\").join("/"),
          text: readFileSync(abs, "utf8"),
        });
      }
    }
  };
  walk(SRC_ROOT);
  return files.toSorted((a, b) => a.path.localeCompare(b.path));
}

/** The modules of `files` that call a log reader. */
function logReaderModules(files: ReadonlyArray<SourceFile>): string[] {
  return files.filter((f) => callsLogReader(lexCode(f.text))).map((f) => f.path);
}

/** The calling modules the table does not list. */
function unlisted(files: ReadonlyArray<SourceFile>): string[] {
  return logReaderModules(files).filter((path) => !(path in LOG_READERS));
}

const SOURCE_TREE = readSourceTree();

describe("log-reader census", () => {
  test("every module that calls a log reader is classified", () => {
    expect(unlisted(SOURCE_TREE)).toEqual([]);
  });

  test("no table key outlives the call it classifies", () => {
    const calling = new Set(logReaderModules(SOURCE_TREE));
    expect(Object.keys(LOG_READERS).filter((path) => !calling.has(path))).toEqual([]);
  });

  test("every row carries a class of the closed vocabulary and a reason", () => {
    const classes: ReadonlySet<string> = new Set(["at-reach", "local-only", "computation"]);
    for (const [path, row] of Object.entries(LOG_READERS)) {
      expect({ path, known: classes.has(row.class) }).toEqual({ path, known: true });
      expect(row.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("the census can fail", () => {
  const INTRUDER = "src/core/brain/synthetic-log-reader.ts";

  test("an unlisted module calling a log reader is reported", () => {
    const intruder = {
      path: INTRUDER,
      text: 'import { storeLogDays } from "./log-days.ts";\nexport const days = storeLogDays("v");\n',
    };
    expect(unlisted([...SOURCE_TREE, intruder])).toEqual([INTRUDER]);
  });

  test("a call through an aliased import of a reader is reported", () => {
    const intruder = {
      path: INTRUDER,
      text:
        'import { storeLogDays as days, type LogDay } from "./log-days.ts";\n' +
        'export const read: LogDay[] = days("v");\n',
    };
    expect(unlisted([...SOURCE_TREE, intruder])).toEqual([INTRUDER]);
  });

  test("an aliased import that is never called is not a call", () => {
    const intruder = {
      path: INTRUDER,
      text: 'import { storeLogDays as days } from "./log-days.ts";\nexport { days };\n',
    };
    expect(unlisted([intruder])).toEqual([]);
  });

  test("a declaration, a comment or a string naming a reader is not a call", () => {
    const intruder = {
      path: INTRUDER,
      text:
        "// storeLogDays(vault) in prose\n" +
        'const s = "buildTimelineIndex(vault)";\n' +
        "export function logDayReader(v: string): string {\n  return v + s;\n}\n",
    };
    expect(unlisted([intruder])).toEqual([]);
  });
});
