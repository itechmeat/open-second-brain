/**
 * Doctor exit census (no-dead-ends, phase 3, item 2).
 *
 * `o2b brain doctor` printed a `next:` line under some findings and
 * nothing under others, and there was no way to tell the two apart. Both
 * look identical from outside: silence is what an unregistered code
 * produces AND what a code nobody has got round to registering produces.
 * This census removes the second reading. Every code the doctor can emit
 * is either registered in `DIAGNOSTIC_SIGNALS` with a structural command,
 * or listed in `DOCTOR_EXIT_EXCLUSIONS` with a written reason there is
 * none - never both, never neither.
 *
 * ## Enumerated from the detector, never from the tables
 *
 * `DoctorIssue.code` is a free string, so the population is read out of
 * the doctor's own source and the tables are asked to account for it.
 * That source is `doctor.ts` - the registry - plus every check module
 * under `doctor/`, and the directory is ENUMERATED RECURSIVELY rather
 * than listed: a check module added tomorrow is swept by this census the
 * moment it exists, wherever under that directory it is put, which is
 * the property a hand-maintained list could not have. The enumeration
 * was flat before, so a check family moved into a subdirectory would
 * have dropped out of the population without failing anything.
 * Two shapes carry a code in those modules and the census reads both:
 *
 *   - `code: "<literal>"` at a push site;
 *   - `const <NAME>_CODE = "<literal>"` hoisted to a module constant.
 *
 * A third shape would be invisible to both, so a separate test guards it:
 * every `code:` value that is not a string literal must be either a
 * `*_CODE` constant the scan already read, or an entry in
 * {@link NON_LITERAL_CODE_SITES} saying what it can produce. A future
 * computed code fails there rather than slipping past unclassified.
 *
 * ## The boundary, stated rather than discovered
 *
 * The population is what the doctor SPELLS. Five sites forward
 * `notice.code` from the closed `DEGRADATION_CODE` vocabulary, whose
 * members are enumerated in `src/core/integrity/degradation.ts` and
 * minted nowhere else. Two of them are classified in
 * `applier-capability.ts` - a table that answers the REPAIR question,
 * not this one - and the rest reach the `uncertain` stream with no exit
 * of either kind. That gap is stated in {@link NON_LITERAL_CODE_SITES}
 * rather than hidden: closing it needs one entry per code in
 * `doctor-exits.ts`, which is a decision per condition rather than a
 * mechanical sweep.
 *
 * A code this module CONSTRUCTS is not in that boundary, however closed
 * the vocabulary it comes from: `doctor/unreadable-path.ts` raises
 * `vault-walk-entry-skipped` itself, so it is spelled there, read by the
 * scan below, and classified like every other doctor code.
 *
 * Modelled on `tests/core/brain/vault-guard-census.test.ts` and the
 * terminal-state census: detect the property syntactically, keep one
 * explicit inventory, one entry one reason, and pin the measurement so a
 * regex that stopped matching cannot report a clean sweep over an empty
 * set.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { DIAGNOSTIC_SIGNALS } from "../../../src/core/brain/diagnostics.ts";
import {
  DOCTOR_EXIT_EXCLUSIONS,
  doctorExitReason,
  noExitReasons,
} from "../../../src/core/brain/doctor-exits.ts";

const BRAIN_DIR = join(import.meta.dir, "..", "..", "..", "src", "core", "brain");
const CHECKS_DIR = join(BRAIN_DIR, "doctor");

/** Every `.ts` file under `dir`, at any depth, in a stable order. */
function checkModules(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...checkModules(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

/**
 * An import statement that pulls a `*_CODE` identifier in from another
 * module, capturing that module's relative path so the scan can follow it.
 */
const IMPORTED_CODE_RE = /import \{[^}]*[A-Z0-9_]*CODE[A-Z0-9_]*[^}]*\} from "(\.[^"]+)";/gs;

/**
 * A check module may emit a code whose constant is declared elsewhere -
 * an import cycle can force the declaration into a leaf module the check
 * imports from. Those declaring modules are FOLLOWED from the check's own
 * import statements rather than listed here, for the same reason the
 * check directory is enumerated: a hand-maintained second list drifts,
 * and a code the census cannot read is a code it cannot account for.
 */
function codeConstantSources(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  const followed = new Set<string>();
  for (const path of paths) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(IMPORTED_CODE_RE)) {
      const resolved = join(dirname(path), match[1]!);
      if (existsSync(resolved)) followed.add(resolved);
    }
  }
  return [...followed].toSorted();
}

/** The registry plus every check module it runs, enumerated from disk. */
const DOCTOR_CHECK_PATHS: ReadonlyArray<string> = [
  join(BRAIN_DIR, "doctor.ts"),
  ...checkModules(CHECKS_DIR),
];

const DOCTOR_SOURCE_PATHS: ReadonlyArray<string> = [
  ...DOCTOR_CHECK_PATHS,
  ...codeConstantSources(DOCTOR_CHECK_PATHS),
];

const DOCTOR_SOURCE = DOCTOR_SOURCE_PATHS.map((path) => readFileSync(path, "utf8")).join("\n");

/** `code: "<literal>"` - the shape most of the doctor's codes take. */
const LITERAL_CODE_RE = /\bcode: "([^"]+)"/g;

/** `const <NAME>_CODE = "<literal>";` - a code hoisted to a constant. */
const CONSTANT_CODE_RE = /^(?:export )?const [A-Z0-9_]*CODE[A-Z0-9_]* = "([^"]+)";$/gm;

/** Any `code:` property, for the shape guard below. */
const CODE_SITE_RE = /^\s*code: (.+?),?$/gm;

/** A `*_CODE` identifier used directly as the property value. */
const CODE_IDENTIFIER_RE = /^[A-Z0-9_]*CODE[A-Z0-9_]*$/;

/**
 * `code:` values that are neither a string literal nor a `*_CODE`
 * identifier. Each entry must say WHERE the codes that value can hold are
 * enumerated instead - a site may only sit here because its codes are
 * already accounted for somewhere, never because writing them out was
 * inconvenient.
 */
const NON_LITERAL_CODE_SITES: Readonly<Record<string, string>> = Object.freeze({
  "notice.code":
    "forwards a code from the closed DEGRADATION_CODE vocabulary owned by vault.ts, " +
    "vault-identity.ts and the lineage verifier. Its members are enumerated in " +
    "src/core/integrity/degradation.ts and minted nowhere else, so the values this expression can " +
    "hold are readable there. Their EXITS are not all accounted for: vault-marker-absent and " +
    "frontmatter-line-dropped sit in applier-capability.ts (a table answering the repair " +
    "question), vault-walk-entry-skipped is registered in DIAGNOSTIC_SIGNALS because this pass " +
    "constructs it, and the lineage and frontmatter-unreadable members reach the uncertain stream " +
    "with neither a command nor a written reason. Closing that needs an entry per code in " +
    "doctor-exits.ts and a judgement per condition, which this census names rather than performs.",
  "parseErrorCode(kindPrefix, msg)":
    "returns one of the four parse-error constants declared beside it, every one of which the " +
    "*_CODE scan above already reads. The function exists so the choice between them is made in " +
    "one named place rather than by concatenating a prefix onto a suffix, which is what made " +
    "those four codes unreadable from this module's source at all.",
});

/**
 * Every doctor code whose exit is a REGISTERED command, pinned.
 *
 * The exclusion table is already guarded in both directions - a code
 * with no reason fails, and a reason outliving its code fails. The
 * registry could not be: it holds far more than the doctor's codes
 * (terminal states, runtime notices, the O3 snapshot classes), so
 * nothing derivable from it says which entries the doctor still spells.
 * Deleting a whole check module therefore satisfied every floor below
 * while the doctor silently stopped checking backlinks.
 *
 * Adding a doctor code with a command, or retiring one, edits this list
 * in the same commit - which is the review this census exists to force.
 */
const DOCTOR_REGISTERED_CODES: ReadonlyArray<string> = [
  "brain-root-absent",
  "broken-backlinks",
  "broken-wikilink",
  "config-invalid",
  "config-missing",
  "content-hash-drift",
  "contradictory-preferences",
  "dangling-workrun",
  "duplicate-preferences",
  "entity-label-malformed",
  "entity-quote-variant-collision",
  "low-evidence-confirmed",
  "orphan-evidence",
  "principle-corrupted",
  "schema-version-unknown",
  "stale-claim",
  "stale-dependency",
  "sync-conflict-log",
  "tier-drift",
  "vault-walk-entry-skipped",
];

/** A reason has to say something; a placeholder cannot reach this. */
const MIN_REASON_LENGTH = 80;

/** This tool's own invocation - a reason may never contain one. */
const INVOCATION_RE = /\bo2b\s+[a-z]/;

/** Lines that mention `code:` without being a push site. */
function isCodeSite(line: string): boolean {
  const trimmed = line.trim();
  return !trimmed.startsWith("*") && !trimmed.startsWith("readonly ");
}

function literalCodes(): ReadonlySet<string> {
  return new Set([...DOCTOR_SOURCE.matchAll(LITERAL_CODE_RE)].map((m) => m[1]!));
}

function constantCodes(): ReadonlySet<string> {
  return new Set([...DOCTOR_SOURCE.matchAll(CONSTANT_CODE_RE)].map((m) => m[1]!));
}

/** Every code `doctor.ts` spells, from both shapes. */
function doctorCodes(): ReadonlyArray<string> {
  return [...new Set([...literalCodes(), ...constantCodes()])].toSorted();
}

/** The value text of every `code:` property in the module. */
function codeSiteValues(): ReadonlyArray<string> {
  return [...DOCTOR_SOURCE.matchAll(CODE_SITE_RE)]
    .filter((m) => isCodeSite(m[0]!))
    .map((m) => m[1]!.trim());
}

describe("every doctor code is classified", () => {
  test("no code is left without either a command or a written reason", () => {
    const unclassified = doctorCodes().filter(
      (code) => !DIAGNOSTIC_SIGNALS.has(code) && !DOCTOR_EXIT_EXCLUSIONS.has(code),
    );
    // Named, not counted: the failure message is the work to be done.
    expect(unclassified.join("\n")).toBe("");
  });

  test("no code claims both a command and a reason it has none", () => {
    const both = doctorCodes().filter(
      (code) => DIAGNOSTIC_SIGNALS.has(code) && DOCTOR_EXIT_EXCLUSIONS.has(code),
    );
    expect(both.join("\n")).toBe("");
  });

  test("no registration outlives the check module that spelled its code", () => {
    // Named, not counted, in both directions: a code that vanished from
    // the doctor and a code that appeared in it are different work.
    expect(
      doctorCodes()
        .filter((code) => DIAGNOSTIC_SIGNALS.has(code))
        .join("\n"),
    ).toBe([...DOCTOR_REGISTERED_CODES].toSorted().join("\n"));
  });

  test("no exclusion outlives the code it explains", () => {
    const codes = new Set(doctorCodes());
    const orphans = [...DOCTOR_EXIT_EXCLUSIONS.keys()].filter((code) => !codes.has(code));
    expect(orphans.toSorted().join("\n")).toBe("");
  });

  test("every reason is specific", () => {
    for (const [code, reason] of DOCTOR_EXIT_EXCLUSIONS) {
      expect(`${code} reason is specific: ${reason.trim().length >= MIN_REASON_LENGTH}`).toBe(
        `${code} reason is specific: true`,
      );
    }
  });

  test("no reason names a command - a code with one belongs in the registry", () => {
    const offenders = [...DOCTOR_EXIT_EXCLUSIONS.entries()]
      .filter(([, reason]) => INVOCATION_RE.test(reason))
      .map(([code]) => code);
    expect(offenders.toSorted().join("\n")).toBe("");
  });

  test("the census is not vacuous", () => {
    const codes = doctorCodes();
    // A sweep that lost the check modules - a renamed directory, a check
    // family moved out of it - would shrink the population without
    // failing any assertion below.
    expect(DOCTOR_SOURCE_PATHS.length).toBeGreaterThan(10);
    // A regex that stopped matching would sweep an empty set clean.
    expect(codes.length).toBeGreaterThan(35);
    expect(constantCodes().size).toBeGreaterThan(3);
    expect(codes.filter((c) => DIAGNOSTIC_SIGNALS.has(c)).length).toBeGreaterThan(14);
    expect(codes.filter((c) => DOCTOR_EXIT_EXCLUSIONS.has(c)).length).toBeGreaterThan(20);
  });
});

describe("every code site is readable from the source", () => {
  test("no `code:` value escapes both scans without a declared expansion", () => {
    const opaque = codeSiteValues().filter((value) => {
      if (value.startsWith('"')) return false;
      if (CODE_IDENTIFIER_RE.test(value)) return false;
      return NON_LITERAL_CODE_SITES[value] === undefined;
    });
    expect([...new Set(opaque)].toSorted().join("\n")).toBe("");
  });

  test("every `*_CODE` identifier used as a value was read by the constant scan", () => {
    const constants = constantCodes();
    const unresolved = codeSiteValues()
      .filter((value) => CODE_IDENTIFIER_RE.test(value))
      .filter((value) => {
        const declared = DOCTOR_SOURCE.match(
          new RegExp(`^(?:export )?const ${value} = "([^"]+)";$`, "m"),
        )?.[1];
        return declared === undefined || !constants.has(declared);
      });
    expect([...new Set(unresolved)].toSorted().join("\n")).toBe("");
  });

  test("every declared site is still there, and says where its codes live", () => {
    const values = new Set(codeSiteValues());
    for (const [site, reason] of Object.entries(NON_LITERAL_CODE_SITES)) {
      expect(`${site} is present: ${values.has(site)}`).toBe(`${site} is present: true`);
      expect(`${site} reason is specific: ${reason.trim().length >= MIN_REASON_LENGTH}`).toBe(
        `${site} reason is specific: true`,
      );
    }
  });

  test("the shape guard is not vacuous - it still sees the sites it allows", () => {
    const values = codeSiteValues();
    expect(values.filter((v) => v.startsWith('"')).length).toBeGreaterThan(30);
    expect(values.filter((v) => CODE_IDENTIFIER_RE.test(v)).length).toBeGreaterThan(2);
  });
});

describe("the classification is readable at runtime, not only by this test", () => {
  test("an excluded code resolves to its reason and a registered one to none", () => {
    expect(doctorExitReason("iso-invalid")).toBe(DOCTOR_EXIT_EXCLUSIONS.get("iso-invalid")!);
    expect(doctorExitReason("config-missing")).toBeNull();
    expect(doctorExitReason("not-a-doctor-code")).toBeNull();
  });

  test("reasons are collected once per code, in the order the codes were reported", () => {
    const reasons = noExitReasons([
      "config-missing",
      "iso-invalid",
      "symlink-escape",
      "iso-invalid",
      "not-a-doctor-code",
    ]);
    // A registered code contributes nothing; an unknown one invents nothing.
    expect([...reasons.keys()]).toEqual(["iso-invalid", "symlink-escape"]);
  });

  test("an empty report produces an empty map, so the surfaces stay byte-identical", () => {
    expect(noExitReasons([]).size).toBe(0);
    expect(noExitReasons(["config-missing", "broken-wikilink"]).size).toBe(0);
  });
});
