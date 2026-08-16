/**
 * Registry R2 - every path that writes vault content to a destination
 * outside the vault, measured rather than described.
 *
 * ## The defect
 *
 * `src/core/redactor.ts` is a mature structural redactor: credential
 * field identifiers across three assignment shapes, vendor key prefixes,
 * a pure character-class entropy detector, `<private>` region stripping,
 * and a fail-closed scan window. Eighteen modules import it. Before this
 * unit, FIVE of the six paths that hand vault bytes to a destination the
 * operator names never called it - `bank-export`, `graph-export`,
 * `okf-export`, `brain export`, and `export-config`, the last of which
 * used a private key-name-only copy that never inspected a value. A note
 * carrying a pasted API key left the machine byte for byte.
 *
 * Wiring five call sites fixes five call sites. What makes the sixth
 * impossible is a declared registry plus this census, the idiom this
 * repository already runs for raw `fs` write sites
 * (`write-site-census.test.ts`) and doctor exit codes
 * (`doctor-exit-census.test.ts`).
 *
 * ## The population, defined structurally
 *
 * Three rules. The first two are about a FILE destination, and differ
 * because one name means two different things depending on what the
 * module does with it. The third is about a NETWORK destination.
 *
 * 1. UNAMBIGUOUS: the module declares a string parameter whose name is
 *    one of {@link DESTINATION_FLAGS} (`out`, `outdir`, `dest`, …). Those
 *    names name a destination and nothing else, so the declaration alone
 *    puts the module in population. The rule deliberately does NOT
 *    require the module to call `fs` itself: `okf-export` delegates its
 *    writes to `writeOkfBundle`, and a rule keyed on the write call would
 *    have missed the widest directory export in the tree.
 *
 * 2. AMBIGUOUS NAME PLUS A WRITE: `--file`, `--path`, `--to`, `--report`
 *    are destinations in a writer and inputs in a reader - `brain facts
 *    --file` reads one. Admitting the name alone would drag fourteen
 *    read-only modules in and make the registry a list of every verb that
 *    takes a path; ignoring it left the reviewer's synthetic `--file`
 *    export invisible. So an ambiguous name counts when the SAME module
 *    also puts bytes on disk ({@link RAW_WRITE_RE}). This rule is what
 *    reaches the MCP surface at all: an MCP tool declares its destination
 *    as an `inputSchema` property, not a flag spec, and the property has
 *    the same `name: { type: "string" }` shape.
 *
 * Rule 2 adds no module today, which is the point - it is a tripwire, not
 * a backlog.
 *
 * 3. NETWORK DESTINATION: the module sends an HTTP request carrying a
 *    BODY ({@link NETWORK_POST_RE} inside a module that calls `fetch`).
 *    That is the network analogue of putting bytes on disk, and it is a
 *    SEPARATE rule rather than a widened rule 1 because the file rules
 *    read a declared destination PARAMETER, which a network caller does
 *    not have: its destination is an operator-configured URL resolved at
 *    construction time. Declaring the embedding endpoint under rule 1
 *    would have failed
 *    {@link "no declaration outlives the module it describes"}, since
 *    that assertion requires the declared module to be in a population
 *    derived from a parameter spec plus a raw file write.
 *
 * Rule 3 is what admits the largest and most continuous egress in the
 * product - every indexed chunk body, sent to whichever endpoint the
 * operator configured - which the file rules could not see at all.
 *
 * ## What it does not cover, stated rather than implied
 *
 * - A destination taken as a POSITIONAL argument, or a flag spec built
 *   dynamically instead of written as an object literal.
 * - A module that declares an ambiguous destination and DELEGATES the
 *   write to another module: rule 1 covers delegation only for the
 *   unambiguous names, and rule 2 needs the write in the same file. An
 *   MCP tool that handed `args.path` to a core helper that writes is the
 *   live shape of this gap.
 * - A plain helper with no parameter DECLARATION at all -
 *   `spillVault(destination, contents)`. Both rules read declared
 *   parameter specs; a function signature is not one. Nothing keys this
 *   census on `fs` reachability, because in-vault writers are what
 *   `write-site-census.test.ts` already measures and merging the two
 *   would make both unreadable.
 * - `process.stdout`. Every CLI verb writes there, so including it would
 *   make the population the whole CLI.
 * - A network destination reached by a method other than POST - vault
 *   content packed into a query string on a GET, say. Rule 3 reads the
 *   method because a body is what makes a request an egress rather than a
 *   lookup; a GET that smuggles content past it is the shape to add here
 *   the day one appears.
 * - Per-WRITE coverage. The guard is asserted per declared DESTINATION
 *   ({@link "every declared destination in a redacting module is matched
 *   by a guard call"}), which catches a new unguarded verb appended to an
 *   already-declared module - the hole the reviewer walked through by
 *   adding one to `src/cli/main.ts` - but two writes behind one
 *   declaration and one guard call still pass as a pair.
 *
 * {@link INTRUDER_SHAPES} is where a new source shape gets added the day
 * it appears.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  EGRESS_REDACTION,
  EGRESS_SITES,
  type EgressSite,
} from "../../../src/core/egress/registry.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/**
 * Where an operator is told what leaves the machine unscanned.
 *
 * The registry's `reason` fields are the decision record and live in
 * `src/`; this file is the surface someone configuring an endpoint
 * actually opens.
 */
const OPERATOR_EGRESS_DISCLOSURE_DOC = "docs/cli-reference.md";

/**
 * Flag names that name a destination the operator chose. `target` is
 * deliberately absent: `o2b install --target` names an ADAPTER, not a
 * path, and admitting it would put a name-selector in a destination
 * census.
 *
 * `export` is here because leaving it out is what hid the eighth site:
 * `o2b brain explorer --export <path>` wrote the whole preference graph,
 * principles verbatim, to an operator-named file with no scan, and this
 * census reported a clean sweep because the flag was spelled with a word
 * the list did not carry. It is unambiguous in the same way as `out` -
 * nothing reads FROM an `--export` - so it belongs in rule 1 rather than
 * beside the ambiguous names.
 */
const DESTINATION_FLAGS: ReadonlyArray<string> = Object.freeze([
  "out",
  "output",
  "outfile",
  "outdir",
  "out-dir",
  "dest",
  "destination",
  "export",
]);

/**
 * Names that MIGHT be a destination. `--file` is a destination in a
 * writer and an input in a reader (`brain facts --file` reads one), so
 * these count only alongside a write in the same module. `path` is here
 * rather than in {@link DESTINATION_FLAGS} for the same reason, and it is
 * also how an MCP `inputSchema` property reaches this census at all.
 */
const AMBIGUOUS_DESTINATION_NAMES: ReadonlyArray<string> = Object.freeze([
  "file",
  "path",
  "to",
  "report",
]);

/**
 * A parameter spec entry: `out: { type: "string" }`, optionally quoted,
 * with or without further properties - the same shape in a CLI flag spec
 * and in an MCP `inputSchema` property. The leading class rejects a
 * longer identifier ending in one of the names (`about:`, `stdout:`).
 */
function namedStringParamRe(names: ReadonlyArray<string>, flags: string): RegExp {
  return new RegExp(
    String.raw`(^|[^A-Za-z0-9_$"'\-])"?(${names.join("|")})"?\s*:\s*\{\s*type\s*:\s*"string"`,
    flags,
  );
}

const DESTINATION_FLAG_RE = namedStringParamRe(DESTINATION_FLAGS, "m");
const AMBIGUOUS_DESTINATION_RE = namedStringParamRe(AMBIGUOUS_DESTINATION_NAMES, "m");
const ANY_DESTINATION_G_RE = namedStringParamRe(
  [...DESTINATION_FLAGS, ...AMBIGUOUS_DESTINATION_NAMES],
  "gm",
);

/**
 * A call that puts file bytes on disk. Only what a CLI verb or an MCP
 * tool would reach for directly; the in-vault write surface is
 * `write-site-census.test.ts`'s subject, not this one's.
 */
const RAW_WRITE_RE =
  /\b(?:writeFileSync|appendFileSync|copyFileSync|cpSync|createWriteStream|atomicWriteFileSync|writeFile)\s*\(|\bBun\.write\s*\(/;

/**
 * An outbound HTTP request that carries a body, in the two shapes this
 * tree writes it: the request object literal (`method: "POST"`) and the
 * branch a delegating client takes before handing the request to an
 * injected transport (`method === "POST"`). The second form is not
 * decoration - without it `external-fetch.ts`, which is where every
 * research provider's POST actually reaches the network, is invisible
 * while the provider module that names the endpoint has no `fetch` of its
 * own. That pair is the network twin of the delegated-write gap this
 * census already states for files.
 *
 * Read alongside {@link NETWORK_FETCH_RE}, so a route table naming an
 * HTTP verb cannot enrol a module by itself. A server that both branches
 * on an inbound method and calls out with a body is in population by this
 * rule, which is the syntactic answer on purpose: deciding whether that
 * particular POST carries vault content is what a registry entry is for.
 */
const NETWORK_POST_RE = /\bmethod\s*(?::|===)\s*"POST"/;
const NETWORK_FETCH_RE = /\bfetch\s*\(/;

/** The shared egress guard. A module that calls it redacts on the way out. */
const EGRESS_GUARD_CALL_RE = /\bredactForEgress\s*\(/;
const EGRESS_GUARD_CALL_G_RE = /\bredactForEgress\s*\(/g;

/** Every `.ts` file under `src/`, as repo-relative POSIX path + text. */
function readSourceTree(): ReadonlyArray<{ path: string; text: string }> {
  const glob = new Bun.Glob("src/**/*.ts");
  const files: { path: string; text: string }[] = [];
  for (const rel of glob.scanSync({ cwd: REPO_ROOT })) {
    const path = rel.split("\\").join("/");
    files.push({ path, text: readFileSync(join(REPO_ROOT, path), "utf8") });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

/**
 * True when this module declares an operator-named output FILE: an
 * unambiguous destination name, or an ambiguous one in a module that also
 * writes bytes. Rules 1 and 2 in the docblock.
 */
function declaresFileDestination(text: string): boolean {
  if (DESTINATION_FLAG_RE.test(text)) return true;
  return AMBIGUOUS_DESTINATION_RE.test(text) && RAW_WRITE_RE.test(text);
}

/**
 * True when this module sends bytes to a NETWORK destination. Rule 3 in
 * the docblock: a body-carrying HTTP request in a module that fetches.
 */
function declaresNetworkDestination(text: string): boolean {
  return NETWORK_FETCH_RE.test(text) && NETWORK_POST_RE.test(text);
}

/** In population under any of the three rules. */
function declaresDestination(text: string): boolean {
  return declaresFileDestination(text) || declaresNetworkDestination(text);
}

function countMatches(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

/** One file as the census reads it: a repo-relative path and its bytes. */
interface CensusFile {
  readonly path: string;
  readonly text: string;
}

/**
 * The census itself, over whatever tree it is handed.
 *
 * Taking the tree as an ARGUMENT is what makes the synthetic controls
 * below able to fail. They used to append a fabricated path string to an
 * already-derived `POPULATION`, so the synthetic module's SOURCE never
 * reached this rule set: replacing the derivation with `[]` left both
 * "must be declared" tests green over a fully blinded census. Feeding the
 * intruder's real text through here is the shape
 * `write-site-census.test.ts` already uses for the same purpose.
 */
function census(files: ReadonlyArray<CensusFile>): ReadonlyArray<string> {
  return files.filter((f) => declaresDestination(f.text)).map((f) => f.path);
}

const SOURCE_TREE = readSourceTree();
const POPULATION: ReadonlyArray<string> = census(SOURCE_TREE);

const ENTRIES: ReadonlyArray<EgressSite> = Object.values(EGRESS_SITES);
const DECLARED_MODULES: ReadonlySet<string> = new Set(ENTRIES.map((e) => e.module));

function moduleText(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

describe("egress site census", () => {
  test("every module that names an output destination is declared", () => {
    // Named, not counted: the failure has to say which file.
    const unlisted = POPULATION.filter((path) => !DECLARED_MODULES.has(path));
    expect(unlisted).toEqual([]);
  });

  test("no declaration outlives the module it describes", () => {
    const stale = ENTRIES.filter(
      (entry) => !existsSync(join(REPO_ROOT, entry.module)) || !POPULATION.includes(entry.module),
    ).map((entry) => `${entry.id} -> ${entry.module}`);
    expect(stale).toEqual([]);
  });

  test("every entry declared as redacting actually calls the shared guard", () => {
    // The declaration is checked against the source, not trusted. A verb
    // that stops calling the guard fails here even though its registry
    // entry still claims coverage - which is the exact lie this census
    // exists to make impossible.
    const missing = ENTRIES.filter(
      (entry) =>
        entry.redaction === EGRESS_REDACTION.sharedRedactor &&
        !EGRESS_GUARD_CALL_RE.test(moduleText(entry.module)),
    ).map((entry) => entry.id);
    expect(missing).toEqual([]);
  });

  test("every declared destination in a redacting module is matched by a guard call", () => {
    // Presence of ONE guard call is not coverage of the module. A new
    // verb appended to `src/cli/main.ts` - the CLI dispatcher, the
    // natural home for a new top-level verb, and a module that already
    // contained a `redactForEgress` call - passed the presence check
    // while writing raw bytes to its own `--out`. Counting destinations
    // against guard calls closes that: a second destination needs a
    // second guard call.
    const uncovered = ENTRIES.filter((entry) => entry.redaction === EGRESS_REDACTION.sharedRedactor)
      .map((entry) => {
        const text = moduleText(entry.module);
        return {
          module: entry.module,
          destinations: countMatches(text, ANY_DESTINATION_G_RE),
          guards: countMatches(text, EGRESS_GUARD_CALL_G_RE),
        };
      })
      .filter((row) => row.guards < row.destinations)
      .map(
        (row) => `${row.module}: ${row.destinations} destination(s), ${row.guards} guard call(s)`,
      );
    expect(uncovered).toEqual([]);
  });

  test("no entry understates what its module does", () => {
    // The complement: a module that calls the guard but is declared as
    // something weaker would leave the registry describing a gap that is
    // no longer there, and the next reader would re-open a closed hole.
    //
    // This test once made a leak unfixable. `brain-continuity-export` was
    // declared `upstream_read_model` while its upstream redacted with the
    // redactor's DEFAULT options, and adding the guard call that closed
    // the leak failed HERE. The bug was never the assertion - it was
    // reading a failure as "remove the call" instead of "flip the
    // declaration". The unverifiable status is gone, so the only weaker
    // status left is `no_vault_content`, and a module that both composes
    // no vault content and scans it is a contradiction worth failing on.
    const understated = ENTRIES.filter(
      (entry) =>
        entry.redaction !== EGRESS_REDACTION.sharedRedactor &&
        EGRESS_GUARD_CALL_RE.test(moduleText(entry.module)),
    ).map((entry) => entry.id);
    expect(understated).toEqual([]);
  });

  test("every entry carries an id, a verb, and a non-empty reason", () => {
    for (const entry of ENTRIES) {
      expect(`${entry.id}: ${entry.verb.length > 0} ${entry.reason.trim().length > 0}`).toBe(
        `${entry.id}: true true`,
      );
    }
  });

  test("every unscanned network egress is disclosed where an operator reads", () => {
    // The registry is a source file. An operator deciding whether to point
    // an embedding endpoint at a vendor reads the CLI reference, and four
    // of the five unscanned network payloads appeared nowhere outside
    // `src/`. Keyed on the entry ID rather than on prose, so a new
    // declaration is undisclosed until someone writes the disclosure.
    const doc = readFileSync(join(REPO_ROOT, OPERATOR_EGRESS_DISCLOSURE_DOC), "utf8");
    const undisclosed = ENTRIES.filter(
      (entry) => entry.redaction === EGRESS_REDACTION.unscannedNetworkPayload,
    )
      .filter((entry) => !doc.includes(entry.id))
      .map((entry) => entry.id);
    expect(undisclosed).toEqual([]);
  });

  test("ids and module paths are unique", () => {
    expect(new Set(ENTRIES.map((e) => e.id)).size).toBe(ENTRIES.length);
    expect(DECLARED_MODULES.size).toBe(ENTRIES.length);
    // The record is keyed by id; a key that disagreed with its own entry
    // would make a refusal message name a site nobody can find.
    const mismatched = Object.entries(EGRESS_SITES)
      .filter(([key, entry]) => key !== entry.id)
      .map(([key]) => key);
    expect(mismatched).toEqual([]);
  });
});

describe("the census cannot pass by finding nothing", () => {
  /**
   * Run the REAL census over the real tree plus one synthetic module, and
   * report which of the resulting population nobody declared.
   *
   * The intruder arrives as a path AND its source, so the derivation is
   * what puts it in population. A control that appended the path alone
   * asserted a set operation over a constant and passed with the
   * derivation blinded to `[]`.
   */
  function unlistedWith(intruder: CensusFile): ReadonlyArray<string> {
    return census([...SOURCE_TREE, intruder]).filter((path) => !DECLARED_MODULES.has(path));
  }

  test("the detector still sees the sites it measures", () => {
    // A regex that stopped matching would report a clean sweep over an
    // empty set. Floors sit just under the live measurement, not an order
    // of magnitude under it.
    expect(POPULATION.length).toBeGreaterThan(10);
    expect(
      ENTRIES.filter((e) => e.redaction === EGRESS_REDACTION.sharedRedactor).length,
    ).toBeGreaterThan(4);
    expect(
      ENTRIES.filter((e) => e.redaction === EGRESS_REDACTION.unscannedNetworkPayload).length,
    ).toBeGreaterThan(3);
  });

  test("the five verbs this unit wired are all declared as redacting", () => {
    // Pinned by module path, because "five" is a number that goes stale
    // and a path is a fact.
    const redacting = new Set(
      ENTRIES.filter((e) => e.redaction === EGRESS_REDACTION.sharedRedactor).map((e) => e.module),
    );
    for (const path of [
      "src/cli/brain/verbs/bank-export.ts",
      "src/cli/brain/verbs/graph-export.ts",
      "src/cli/brain/verbs/okf-export.ts",
      "src/cli/brain/verbs/export.ts",
      "src/cli/main.ts",
    ]) {
      expect(`${path}: ${redacting.has(path)}`).toBe(`${path}: true`);
    }
  });

  /**
   * Every source shape a destination declaration can arrive in. Each must
   * be detected on its own, so a regex narrowed by a later edit shows up
   * here as a named failure rather than as a silently smaller population.
   */
  const INTRUDER_SHAPES: ReadonlyArray<readonly [string, string]> = Object.freeze([
    ["a spec entry on its own line", '  out: { type: "string" },\n'],
    [
      "a spec entry inline with others",
      'parse(argv, { vault: { type: "string" }, out: { type: "string" } });\n',
    ],
    ["a quoted flag name", '  "out-dir": { type: "string" },\n'],
    ["a longer destination name", '  destination: { type: "string" },\n'],
    ["extra properties after the type", '  output: { type: "string", required: true },\n'],
    [
      "a CLI verb whose destination flag is --file",
      'const { flags } = parse(argv, { file: { type: "string" } });\n' +
        '  writeFileSync(flags["file"] as string, body, "utf8");\n',
    ],
    [
      "an MCP tool taking its destination in args",
      'inputSchema: { properties: { path: { type: "string", description: "where to write" } } }\n' +
        "  writeFileSync(args.path as string, body);\n",
    ],
    [
      "a verb that delegates the write but names --outdir",
      '  outdir: { type: "string" },\n  writeBundle(outdir, plan);\n',
    ],
    [
      "a destination flag spelled --export",
      '  export: { type: "string" },\n  atomicWriteFileSync(exportPath, html);\n',
    ],
  ]);

  for (const [shape, source] of INTRUDER_SHAPES) {
    test(`a new export path using ${shape} is in population`, () => {
      expect(declaresFileDestination(source)).toBe(true);
    });
  }

  /**
   * The synthetic destination the file rule missed for a whole release.
   * `--export` reads as a mode name rather than a path name, which is
   * exactly why a hardcoded list of destination words is the same defect
   * class this census exists to catch, one level up.
   */
  test("a synthetic --export module is in population and must be declared", () => {
    const intruder: CensusFile = {
      path: "src/cli/brain/verbs/synthetic-export-flag.ts",
      text: 'export: { type: "string" },\n  atomicWriteFileSync(dest, body);\n',
    };
    expect(declaresFileDestination(intruder.text)).toBe(true);
    expect(unlistedWith(intruder)).toEqual([intruder.path]);
  });

  /**
   * Rule 3's own shapes. A network destination arrives as a `fetch` with a
   * body, never as a parameter spec, so none of the file shapes above can
   * stand in for these.
   */
  const NETWORK_INTRUDER_SHAPES: ReadonlyArray<readonly [string, string]> = Object.freeze([
    [
      "a provider client POSTing vault text to a configured endpoint",
      "const res = await fetch(this.http.url, {\n" +
        '  method: "POST",\n' +
        "  body: JSON.stringify({ input: texts }),\n" +
        "});\n",
    ],
    [
      "a bare POST helper with the url inline",
      'await fetch(`${base}/rerank`, { method: "POST", body });\n',
    ],
  ]);

  for (const [shape, source] of NETWORK_INTRUDER_SHAPES) {
    test(`${shape} is in population under the network rule`, () => {
      expect(declaresNetworkDestination(source)).toBe(true);
      // And not through a file rule, so the two populations stay legible.
      expect(declaresFileDestination(source)).toBe(false);
    });
  }

  test("a synthetic network-destination module must be declared too", () => {
    const intruder: CensusFile = {
      path: "src/core/search/embeddings/synthetic-provider.ts",
      text:
        "const response = await fetch(endpoint.url, {\n" +
        '  method: "POST",\n' +
        "  body: JSON.stringify({ input: chunkBodies }),\n" +
        "});\n",
    };
    expect(declaresDestination(intruder.text)).toBe(true);
    expect(unlistedWith(intruder)).toEqual([intruder.path]);
  });

  test("reading a URL is not egress", () => {
    // The rule is about bytes going UP. A GET, however many, is ingress.
    expect(declaresNetworkDestination("const r = await fetch(url);\n")).toBe(false);
    expect(declaresNetworkDestination('const r = await fetch(url, { method: "GET" });\n')).toBe(
      false,
    );
  });

  test("a POST that reaches no network is not this census's subject", () => {
    // A route table, or a server reading an inbound method, without a call
    // out. The pair of conditions is what keeps `src/mcp/http.ts` and the
    // explorer's own loopback server out of population.
    expect(declaresNetworkDestination('if (req.method === "POST") return handle(req);\n')).toBe(
      false,
    );
    expect(declaresNetworkDestination('const route = { method: "POST" };\n')).toBe(false);
    for (const path of ["src/mcp/http.ts", "src/core/brain/explorer.ts"]) {
      const text = moduleText(path);
      expect(`${path}: ${declaresNetworkDestination(text)}`).toBe(`${path}: false`);
    }
  });

  test("a client that delegates its POST to an injected transport is seen", () => {
    // The provider module names the endpoint and never calls `fetch`; the
    // transport calls `fetch` and takes the method as a variable. Reading
    // only the request-literal form leaves the pair invisible.
    expect(
      declaresNetworkDestination(
        'const body = method === "POST" ? JSON.stringify(req.body) : null;\n' +
          "  const res = await fetch(input.url, { method: input.method, body });\n",
      ),
    ).toBe(true);
  });

  test("the network rule finds the modules it was written for", () => {
    // Named rather than counted: a regex narrowed by a later edit shows up
    // as a missing path, not as a smaller number.
    const network = SOURCE_TREE.filter((f) => declaresNetworkDestination(f.text)).map(
      (f) => f.path,
    );
    expect(network).toContain("src/core/search/embeddings/openai-compat.ts");
    expect(network.length).toBeGreaterThan(2);
  });

  test("an identifier that merely ends in a destination name is not one", () => {
    expect(declaresDestination('  stdout: { type: "string" },\n')).toBe(false);
    expect(declaresDestination('  about: { type: "string" },\n')).toBe(false);
  });

  test("an ambiguous name without a write is a reader, not an egress path", () => {
    // `brain facts --file` reads a claims file. Admitting the name alone
    // would put fourteen read-only modules in population and make the
    // registry a list of every verb that takes a path.
    expect(
      declaresDestination('  file: { type: "string" },\n  readFileSync(flags["file"]);\n'),
    ).toBe(false);
    expect(declaresDestination('  path: { type: "string" },\n')).toBe(false);
  });

  test("the ambiguous-name rule adds nothing today, so it is a tripwire", () => {
    // If it ever starts adding modules, that is a real new egress path
    // and the failure above will name it. Pinned so the rule cannot be
    // widened into a backlog by accident.
    const byAmbiguousOnly = SOURCE_TREE.filter(
      (f) => !DESTINATION_FLAG_RE.test(f.text) && declaresFileDestination(f.text),
    ).map((f) => f.path);
    expect(byAmbiguousOnly).toEqual([]);
  });

  test("a non-string destination flag is not a path", () => {
    expect(declaresDestination('  out: { type: "boolean" },\n')).toBe(false);
  });

  test("an undeclared module in population is reported by name", () => {
    const intruder: CensusFile = {
      path: "src/cli/brain/verbs/synthetic-export.ts",
      text: '  out: { type: "string" },\n  writeFileSync(out, body, "utf8");\n',
    };
    expect(unlistedWith(intruder)).toEqual([intruder.path]);
  });
});
