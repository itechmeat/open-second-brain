/**
 * Census over the `vault_path` field every MCP tool response may carry.
 *
 * ## The defect
 *
 * `src/mcp/vault-path-field.ts` states the contract: an MCP response
 * lands in model context, so `vault_path` is the opaque store reference
 * `vault://<hex>` unless the operator has switched `expose_host_paths`
 * on, and a config that cannot be read makes the field report its reason
 * rather than degrade to the raw path. One function implements all of
 * that. Three sites called it. Forty-one returned `ctx.vault` - the
 * absolute host path - straight into the payload.
 *
 * That is this release's own thesis on the tool surface: a rule stated
 * once in prose, with nothing enumerating the sites it governs. Wiring
 * the forty-one fixes forty-one. What makes the forty-second impossible
 * is this file.
 *
 * ## Why here rather than beside the hardcoded-path scanner
 *
 * `tests/core/hygiene/hardcoded-paths.test.ts` gates the same class of
 * leak one layer up: a home path written INTO the source as a literal.
 * It cannot see this one, because nothing is hardcoded here - the path
 * is discovered at runtime and the source says only `ctx.vault`. The two
 * checks answer different questions over different populations (that one
 * scans shipped text including docs and templates; this one scans the
 * tool surface for a structural emission), so this is a sibling census,
 * not a rule to bolt onto that scanner.
 *
 * ## The population, defined structurally
 *
 * Every `.ts` module under {@link TOOL_SURFACE_ROOT} is read, lexed by
 * the shared {@link lexCode} view (comments and literal CONTENTS blanked,
 * so a `vault_path:` inside a docblock or a quoted example is not a
 * site), and every object property named `vault_path` is collected with
 * the expression it is assigned.
 *
 * Two dispositions, and no third:
 *
 *   - a value that is a JSON-SCHEMA NODE - inline (`{ type: "string" }`,
 *     recognised by the leading brace plus a `type:` member) or the
 *     shared {@link VAULT_PATH_SCHEMA_DESCRIPTOR} - is a DECLARATION of
 *     the field, not an emission of it. `outputSchema` blocks declare
 *     `vault_path` and emit nothing.
 *   - anything else is an EMISSION, and must be produced by
 *     {@link VAULT_PATH_PRODUCER}. Not "must not be `ctx.vault`": a rule
 *     that enumerated the wrong spellings would be the hand-kept list
 *     this census exists to replace, and the next site would find a
 *     forty-second way to say the same thing.
 *
 * A property whose value this file cannot classify is REPORTED, because
 * "I could not tell" is not a pass.
 *
 * ## What this census cannot see, stated rather than implied
 *
 *   - An emission assigned through a local variable
 *     (`const v = ctx.vault; return { vault_path: v }`) reads as an
 *     unclassified expression and is reported, which is the safe
 *     direction, but the report names the variable rather than the leak.
 *   - A field spread in from elsewhere (`...block`) carries no
 *     `vault_path:` property text and is invisible here. The payload
 *     assertions in `tests/mcp/mcp.test.ts` are what cover the value
 *     that actually ships.
 *   - The OpenClaw native runtime (`src/openclaw/index.ts`) registers
 *     three tools of its own that emit this field, and they are outside
 *     this population for one reason only: the scan is rooted at
 *     {@link TOOL_SURFACE_ROOT}, and that file is not under it. The
 *     earlier wording here said OpenClaw "cannot import from `src/mcp/`
 *     by construction", and this branch falsified it - `src/openclaw/
 *     index.ts:23` imports {@link VAULT_PATH_PRODUCER} from exactly
 *     there, which is what makes its three emissions correct.
 *
 *     Those three are covered, by the second `describe` below rather than
 *     by a widened root: it runs the same scanner over that one file and
 *     requires the same producer, while {@link TOOL_SURFACE_ROOT} keeps
 *     meaning "the modules that answer a `tools/call`". A count in a
 *     population of three is an equality, so a fourth emission - or a
 *     rewritten bundle that stops calling the producer - fails by name.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { lexCode } from "../../helpers/source-lexer.ts";

/** The MCP tool surface: every module that can answer a `tools/call`. */
const TOOL_SURFACE_ROOT = resolve(import.meta.dir, "..", "..", "..", "src", "mcp");

/** The field this census is about. */
const FIELD = "vault_path";

/** The one function permitted to produce an emitted {@link FIELD}. */
const VAULT_PATH_PRODUCER = "vaultPathField";

/** The one descriptor an `outputSchema` declares the field with. */
const VAULT_PATH_SCHEMA_DESCRIPTOR = "VAULT_PATH_OUTPUT_SCHEMA";

/**
 * The measured population, as an EQUALITY.
 *
 * It was a floor of 20 against a real 44, which is the shape this release
 * spent two other censuses removing: a floor that loose lets more than
 * half the scanner's reach disappear and still reports a pass, so the
 * one failure it exists to catch - a scanner that quietly stops matching
 * - is exactly the one it would sleep through.
 *
 * The number moves when the tool surface does, and that is the point: a
 * changed count is a fact about this release that someone states, in the
 * same commit, rather than a drift nobody sees. Re-measure it only after
 * deciding the move is intended.
 */
const EMITTING_SITES = 44;

/** One `vault_path:` property found in the source. */
interface FieldSite {
  /** Path relative to the repository root. */
  readonly file: string;
  /** 1-based line of the property. */
  readonly line: number;
  /** The assigned expression, whitespace-collapsed. */
  readonly expression: string;
}

/** Every `.ts` module under `dir`, recursively, in stable order. */
function modules(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...modules(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** Closing bracket for each opener the value walk tracks. */
const BRACKET_PAIRS: Readonly<Record<string, string>> = Object.freeze({
  "(": ")",
  "[": "]",
  "{": "}",
});

/**
 * The expression assigned at `from`, ending at the first `,` or closing
 * bracket that is not nested inside one the expression itself opened.
 */
function readValueExpression(code: string, from: number): string {
  const stack: string[] = [];
  let i = from;
  for (; i < code.length; i++) {
    const c = code[i]!;
    if (stack.length === 0 && (c === "," || c === ")" || c === "]" || c === "}")) break;
    const closer = BRACKET_PAIRS[c];
    if (closer !== undefined) stack.push(closer);
    else if (c === stack[stack.length - 1]) stack.pop();
  }
  return code.slice(from, i).trim().replace(/\s+/g, " ");
}

/**
 * Every `vault_path:` property in one module's source.
 *
 * `label` is the reported file name; `text` is the raw source, lexed
 * here so the caller cannot pass the wrong view by accident.
 */
function fieldSites(label: string, text: string): FieldSite[] {
  const code = lexCode(text);
  const probe = new RegExp(String.raw`(^|[^\w$.])${FIELD}\s*:`, "g");
  const sites: FieldSite[] = [];
  for (const match of code.matchAll(probe)) {
    const at = match.index + match[0].length;
    sites.push({
      file: label,
      line: code.slice(0, at).split("\n").length,
      // Read the value back out of the ORIGINAL text at the same offset:
      // the views share every offset, and the code view has blanked the
      // literal contents this census wants to see (`{ type: "string" }`).
      expression: readValueExpression(text, skipSpace(code, at)),
    });
  }
  return sites;
}

/** First non-space offset at or after `from`. */
function skipSpace(code: string, from: number): number {
  let i = from;
  while (i < code.length && /\s/.test(code[i]!)) i++;
  return i;
}

/** A JSON-schema node declaring the field, rather than emitting a value. */
function isSchemaDeclaration(expression: string): boolean {
  if (expression === VAULT_PATH_SCHEMA_DESCRIPTOR) return true;
  return expression.startsWith("{") && /\btype\s*:/.test(expression);
}

/** The sites that emit a value, i.e. everything that is not a declaration. */
function emittingSites(sites: ReadonlyArray<FieldSite>): FieldSite[] {
  return sites.filter((site) => !isSchemaDeclaration(site.expression));
}

/** The emitting sites that do not go through {@link VAULT_PATH_PRODUCER}. */
function offendingSites(sites: ReadonlyArray<FieldSite>): FieldSite[] {
  const producer = new RegExp(String.raw`^${VAULT_PATH_PRODUCER}\s*\(`);
  return emittingSites(sites).filter((site) => !producer.test(site.expression));
}

const ROOT = resolve(import.meta.dir, "..", "..", "..");
const ALL_SITES: ReadonlyArray<FieldSite> = modules(TOOL_SURFACE_ROOT).flatMap((path) =>
  fieldSites(relative(ROOT, path), readFileSync(path, "utf8")),
);

/** `src/mcp/x.ts:12 -> ctx.vault`, the form a failure is read in. */
function render(site: FieldSite): string {
  return `${site.file}:${site.line} -> ${site.expression}`;
}

describe("vault_path emission census", () => {
  test("the population is read off the tool surface, not remembered", () => {
    // A scanner that silently matched nothing would report a clean sweep
    // over a surface it never examined - the false-clean signature these
    // censuses exist to prevent.
    expect(emittingSites(ALL_SITES).length).toBe(EMITTING_SITES);
    // The three tools defined in the aggregator itself are in population.
    expect(ALL_SITES.some((site) => site.file === join("src", "mcp", "tools.ts"))).toBe(true);
    // …and so is at least one Brain domain module.
    expect(ALL_SITES.some((site) => site.file.includes(join("src", "mcp", "brain")))).toBe(true);
  });

  test("every emitted vault_path is produced by vaultPathField", () => {
    expect(offendingSites(ALL_SITES).map(render)).toEqual([]);
  });

  test("an outputSchema declaration of the field is not an emission", () => {
    for (const value of [`{ type: "string" }`, VAULT_PATH_SCHEMA_DESCRIPTOR]) {
      const declared = fieldSites(
        "synthetic.ts",
        `const s = { properties: { ${FIELD}: ${value} } };`,
      );
      expect(declared).toHaveLength(1);
      expect(emittingSites(declared)).toEqual([]);
    }
  });

  test("both declaring schemas use the shared descriptor", () => {
    const declarations = ALL_SITES.filter((site) => !emittingSites([site]).length);
    expect(declarations.length).toBeGreaterThan(0);
    expect(declarations.map((site) => site.expression)).toEqual(
      declarations.map(() => VAULT_PATH_SCHEMA_DESCRIPTOR),
    );
  });
});

describe("the census can fail", () => {
  /** Sources a reviewer dropped in; each must be answered, not walked past. */
  const cases: ReadonlyArray<readonly [string, string, boolean]> = [
    ["the raw host path", `return { ${FIELD}: ctx.vault };`, true],
    ["the producer", `return { ${FIELD}: ${VAULT_PATH_PRODUCER}(ctx) };`, false],
    [
      "a producer call carrying arguments",
      `return { ${FIELD}: ${VAULT_PATH_PRODUCER}(ctx, { reason: "x" }) };`,
      false,
    ],
    ["a lookalike helper", `return { ${FIELD}: vaultPathFieldish(ctx) };`, true],
    ["a hoisted local", `const v = ctx.vault; return { ${FIELD}: v };`, true],
    ["a template of the host path", `return { ${FIELD}: \`\${ctx.vault}\` };`, true],
    ["the last property in the object", `return { a: 1, ${FIELD}: ctx.vault };`, true],
  ];
  for (const [label, source, offends] of cases) {
    test(`${offends ? "reports" : "accepts"}: ${label}`, () => {
      expect(offendingSites(fieldSites("synthetic.ts", source)).length > 0).toBe(offends);
    });
  }

  test("a mention inside a comment or a string literal is not a site", () => {
    const source = [
      `// ${FIELD}: ctx.vault`,
      `/** ${FIELD}: ctx.vault */`,
      `const doc = "${FIELD}: ctx.vault";`,
      `const tpl = \`${FIELD}: ctx.vault\`;`,
    ].join("\n");
    expect(fieldSites("synthetic.ts", source)).toEqual([]);
  });

  test("a longer property name ending in the field name is not a site", () => {
    expect(fieldSites("synthetic.ts", `return { origin_${FIELD}: ctx.vault };`)).toEqual([]);
  });
});

/**
 * The OpenClaw native runtime, scanned by the same rule.
 *
 * It is a separate `describe` rather than a wider root because it is a
 * separate transport: {@link TOOL_SURFACE_ROOT} is the set of modules
 * that answer a `tools/call`, and widening it to keep one file in scope
 * would cost that root its meaning. What must not differ is the RULE, so
 * the same scanner and the same producer requirement run over it here.
 */
describe("vault_path emission census (OpenClaw runtime)", () => {
  const OPENCLAW_ENTRY = join("src", "openclaw", "index.ts");
  const OPENCLAW_SITES = fieldSites(
    OPENCLAW_ENTRY,
    readFileSync(resolve(ROOT, OPENCLAW_ENTRY), "utf8"),
  );

  /** Measured, and an equality: the runtime registers exactly three. */
  const OPENCLAW_EMITTING_SITES = 3;

  test("the three emissions are found and none is outside the producer", () => {
    expect(emittingSites(OPENCLAW_SITES).length).toBe(OPENCLAW_EMITTING_SITES);
    expect(offendingSites(OPENCLAW_SITES).map(render)).toEqual([]);
  });

  test("it reaches the producer by importing it, which is why it can", () => {
    // The docblock above used to give "cannot import from `src/mcp/` by
    // construction" as the exclusion reason. This is the line that
    // falsified it, asserted so the reason cannot be restated.
    const source = readFileSync(resolve(ROOT, OPENCLAW_ENTRY), "utf8");
    expect(source).toContain(`import { ${VAULT_PATH_PRODUCER} } from "../mcp/vault-path-field.ts"`);
  });
});
