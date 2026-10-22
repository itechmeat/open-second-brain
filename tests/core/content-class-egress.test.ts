/**
 * The content-class egress policy (F5, task E3).
 *
 * The default at every shared export is exclusion: a page whose
 * `content_class` frontmatter carries the reserved `prompt-derived`
 * value is absent from the export, and every omission is NAMED on stderr
 * in the shape the knowledge pack's `blocked` list established. The
 * per-verb `--include-prompt-derived` override carries the pages back in
 * and says so. The transcript format has a contract to export session
 * material, so it never applies the default silently: marked records are
 * omitted and named, and a corpus the policy would empty is a refusal,
 * never an empty file.
 *
 * The vault pages here carry the class because they were WRITTEN with it
 * - the same bytes the deterministic prompt-derived writers put on disk.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";
import {
  EGRESS_CONTENT_CLASS_INCLUDE_NOTICE,
  contentClassOmissionNotice,
  egressContentClassSplit,
} from "../../src/core/egress/guard.ts";
import {
  CONTENT_CLASS,
  CONTENT_CLASS_FIELD,
  treeCarriesPromptDerived,
} from "../../src/core/brain/provenance/content-class.ts";
import { spoolTranscriptCorpus, type SpoolOutcome } from "../../src/cli/brain/verbs/export.ts";

let tmp: string;
let vault: string;
let config: string;
const env = (): { OPEN_SECOND_BRAIN_CONFIG: string } => ({ OPEN_SECOND_BRAIN_CONFIG: config });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-class-egress-"));
  vault = join(tmp, "vault");
  config = join(tmp, "config.yaml");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

async function bootstrap(): Promise<void> {
  expect((await runCli(["init", "--vault", vault, "--name", "T"], { env: env() })).returncode).toBe(
    0,
  );
  expect((await runCli(["brain", "init", "--vault", vault], { env: env() })).returncode).toBe(0);
  writeFileSync(
    join(vault, "Operator Page.md"),
    "---\ntitle: Operator Page\n---\n\nWritten by the operator.\n",
    "utf8",
  );
  writeFileSync(
    join(vault, "Agent Page.md"),
    `---\ntitle: Agent Page\n${CONTENT_CLASS_FIELD}: ${CONTENT_CLASS.promptDerived}\n---\n\nSynthesised from a prompt.\n`,
    "utf8",
  );
}

const MARKED = "Agent Page.md";

/**
 * A log day the bundle can fold into `log.md`; the export reads the
 * markdown shards of `Brain/log/` raw, so the block is written in the
 * shape `renderLogEntryBlock` produces.
 */
function seedLogDay(): void {
  const logDir = join(vault, "Brain", "log");
  mkdirSync(logDir, { recursive: true });
  writeFileSync(
    join(logDir, "2026-06-13.md"),
    "## 12:00:00Z — note\n- text: bundle fixture day\n- agent: test\n",
    "utf8",
  );
}

/**
 * A log day with one entry of each shape: an agent-channel narrative
 * line, a write event whose target is the left-out page, and an
 * operator-channel entry that must ride the bundle byte-exactly. The
 * blocks are written in the shape `renderLogEntryBlock` produces.
 */
function seedMixedLogDay(): void {
  const logDir = join(vault, "Brain", "log");
  mkdirSync(logDir, { recursive: true });
  writeFileSync(
    join(logDir, "2026-06-13.md"),
    [
      "## 12:00:00Z — note",
      "- text: agent narrative line",
      "- agent: claude",
      "- origin_channel: mcp-tool",
      "",
      "## 12:00:01Z — note-write",
      "- write_id: nw_20260613_1",
      "- op: create",
      "- target: Agent Page.md",
      "- origin_channel: cli",
      "",
      "## 12:00:02Z — note",
      "- text: operator narrative line",
      "- agent: operator",
      "- origin_channel: cli",
      "",
    ].join("\n"),
    "utf8",
  );
}

describe("the guard seam", () => {
  const items = ["a.md", "b.md", "c.md"];

  test("the default split excludes marked items and names each omission", () => {
    const split = egressContentClassSplit(
      items,
      {},
      {
        name: (entry) => entry,
        isPromptDerived: (entry) => entry === "b.md",
      },
    );
    expect(split.kept).toEqual(["a.md", "c.md"]);
    expect(split.omitted).toEqual(["b.md"]);
  });

  test("the override split is the identity with nothing to name", () => {
    const split = egressContentClassSplit(
      items,
      { contentClass: { include: true } },
      {
        name: (entry) => entry,
        isPromptDerived: () => true,
      },
    );
    expect(split.kept).toEqual(items);
    expect(split.omitted).toEqual([]);
  });

  test("the omission notice names every item with its reason and the flag", () => {
    const notice = contentClassOmissionNotice(["Notes/A.md", "Reports/B.md"]);
    expect(notice).toContain("2 item(s) left out as prompt-derived");
    expect(notice).toContain("Notes/A.md (content_class: prompt-derived)");
    expect(notice).toContain("Reports/B.md (content_class: prompt-derived)");
    expect(notice).toContain("--include-prompt-derived");
    expect(notice.endsWith("\n")).toBe(true);
  });
});

describe("okf-export applies the default and the override", () => {
  test("a marked page is absent from the bundle and named on stderr", async () => {
    await bootstrap();
    const out = join(tmp, "bundle");
    const r = await runCli(["brain", "okf-export", "--out", out], { env: env() });
    expect(r.returncode).toBe(0);
    expect(readdirSync(join(out, "concepts"))).toEqual(["Operator Page.md"]);
    expect(existsSync(join(out, "concepts", "Agent Page.md"))).toBe(false);
    expect(r.stderr).toContain(contentClassOmissionNotice([MARKED]));
    expect(r.stderr).not.toContain(EGRESS_CONTENT_CLASS_INCLUDE_NOTICE);
  });

  test("the override carries the marked page and says so", async () => {
    await bootstrap();
    const out = join(tmp, "bundle-override");
    const r = await runCli(["brain", "okf-export", "--out", out, "--include-prompt-derived"], {
      env: env(),
    });
    expect(r.returncode).toBe(0);
    expect(readFileSync(join(out, "concepts", "Agent Page.md"), "utf8")).toContain(
      "Synthesised from a prompt.",
    );
    expect(r.stderr).toContain(EGRESS_CONTENT_CLASS_INCLUDE_NOTICE);
  });

  test("a marked ingested source page is left out of the references lane and named", async () => {
    await bootstrap();
    const sourcesDir = join(vault, "Brain", "sources");
    mkdirSync(sourcesDir, { recursive: true });
    writeFileSync(
      join(sourcesDir, "src-stamped.md"),
      `---\ntitle: Ingested Source\nkind: brain-source\n${CONTENT_CLASS_FIELD}: ${CONTENT_CLASS.promptDerived}\n---\n\nAgent-written summary prose.\n`,
      "utf8",
    );
    const out = join(tmp, "bundle-sources");
    const r = await runCli(["brain", "okf-export", "--out", out], { env: env() });
    expect(r.returncode).toBe(0);
    expect(existsSync(join(out, "references", "src-stamped.md"))).toBe(false);
    expect(r.stderr).toContain("Brain/sources/src-stamped.md (content_class: prompt-derived)");
  });
});

describe("okf-export applies the class policy to the change log", () => {
  test("agent-channel entries and entries naming a left-out page leave log.md, counted", async () => {
    await bootstrap();
    seedMixedLogDay();
    const out = join(tmp, "bundle-log");
    const r = await runCli(["brain", "okf-export", "--out", out], { env: env() });
    expect(r.returncode).toBe(0);
    const log = readFileSync(join(out, "log.md"), "utf8");
    expect(log).not.toContain("agent narrative line");
    expect(log).not.toContain("Agent Page.md");
    expect(log).not.toContain("12:00:00Z");
    expect(log).not.toContain("12:00:01Z");
    // The kept entry rides byte-exactly: no reformatting of what stays.
    expect(log).toContain(
      "## 12:00:02Z — note\n- text: operator narrative line\n- agent: operator\n- origin_channel: cli",
    );
    expect(r.stderr).toContain("2 log line(s) left out by the same policy");
    expect(r.stderr).toContain(contentClassOmissionNotice([MARKED]));
  });

  test("a day whose every entry leaves stops counting as a log day", async () => {
    await bootstrap();
    const logDir = join(vault, "Brain", "log");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(
      join(logDir, "2026-06-14.md"),
      "## 09:00:00Z — note\n- text: only agent words\n- agent: claude\n- origin_channel: mcp-tool\n",
      "utf8",
    );
    const out = join(tmp, "bundle-log-empty");
    const r = await runCli(["brain", "okf-export", "--out", out], { env: env() });
    expect(r.returncode).toBe(0);
    expect(readFileSync(join(out, "log.md"), "utf8")).not.toContain("2026-06-14");
    expect(readFileSync(join(out, "log.md"), "utf8")).not.toContain("only agent words");
    expect(r.stdout).toContain("0 log day(s)");
  });

  test("the override keeps the log whole and names no log omission", async () => {
    await bootstrap();
    seedMixedLogDay();
    const out = join(tmp, "bundle-log-override");
    const r = await runCli(["brain", "okf-export", "--out", out, "--include-prompt-derived"], {
      env: env(),
    });
    expect(r.returncode).toBe(0);
    const log = readFileSync(join(out, "log.md"), "utf8");
    expect(log).toContain("agent narrative line");
    expect(log).toContain("target: Agent Page.md");
    expect(log).toContain("operator narrative line");
    expect(r.stderr).toContain(EGRESS_CONTENT_CLASS_INCLUDE_NOTICE);
    expect(r.stderr).not.toContain("log line(s) left out");
  });
});

describe("okf-export drops kept pages' manifest citations to left-out pages", () => {
  test("the citation leaves the manifest, counted; the page prose is untouched", async () => {
    await bootstrap();
    writeFileSync(
      join(vault, "Operator Page.md"),
      '---\ntitle: Operator Page\nrelated: "[[Agent Page]]"\n---\n\nSee [[Agent Page]] and [[https://example.org/one]].\n',
      "utf8",
    );
    const out = join(tmp, "bundle-citations");
    const r = await runCli(["brain", "okf-export", "--out", out], { env: env() });
    expect(r.returncode).toBe(0);
    const manifest = JSON.parse(readFileSync(join(out, "okf.json"), "utf8")) as {
      pages: ReadonlyArray<{ path: string; citations: ReadonlyArray<string> }>;
    };
    const operator = manifest.pages.find((p) => p.path === "Operator Page.md");
    expect(operator?.citations).toEqual(["https://example.org/one"]);
    // The page body is not prose-edited: the link the operator wrote stays.
    const page = readFileSync(join(out, "concepts", "Operator Page.md"), "utf8");
    expect(page).toContain("See [[Agent Page]] and [[https://example.org/one]].");
    expect(r.stderr).toContain("1 citation(s) to left-out page(s) dropped");
  });

  test("the override keeps the citations", async () => {
    await bootstrap();
    writeFileSync(
      join(vault, "Operator Page.md"),
      "---\ntitle: Operator Page\n---\n\nSee [[Agent Page]].\n",
      "utf8",
    );
    const out = join(tmp, "bundle-citations-override");
    const r = await runCli(["brain", "okf-export", "--out", out, "--include-prompt-derived"], {
      env: env(),
    });
    expect(r.returncode).toBe(0);
    const manifest = JSON.parse(readFileSync(join(out, "okf.json"), "utf8")) as {
      pages: ReadonlyArray<{ path: string; citations: ReadonlyArray<string> }>;
    };
    const operator = manifest.pages.find((p) => p.path === "Operator Page.md");
    expect(operator?.citations).toEqual(["Agent Page"]);
    expect(r.stderr).not.toContain("citation(s) to left-out page(s) dropped");
  });
});

describe("okf-export writes the reserved bundle files", () => {
  test("a vault with zero prompt-derived pages still exports okf.json, index.md and log.md", async () => {
    await bootstrap();
    rmSync(join(vault, "Agent Page.md"));
    seedLogDay();
    const out = join(tmp, "bundle-plain");
    const r = await runCli(["brain", "okf-export", "--out", out], { env: env() });
    expect(r.returncode).toBe(0);
    // The reserved bundle-root files ride every bundle: the manifest, the
    // version-declaring index and the change log are the three files an
    // OKF reader expects at the root before it reads any page.
    expect(existsSync(join(out, "okf.json"))).toBe(true);
    expect(existsSync(join(out, "index.md"))).toBe(true);
    expect(existsSync(join(out, "log.md"))).toBe(true);
    expect(readFileSync(join(out, "log.md"), "utf8")).toContain("bundle fixture day");
    // The stdout page/log-day line stays truthful.
    expect(r.stdout).toContain("1 page(s), 1 log day(s)");
  });

  test("a vault with some prompt-derived pages exports them too, and the index lists only carried pages", async () => {
    await bootstrap();
    seedLogDay();
    const omitted = join(tmp, "bundle-default");
    const r = await runCli(["brain", "okf-export", "--out", omitted], { env: env() });
    expect(r.returncode).toBe(0);
    expect(existsSync(join(omitted, "okf.json"))).toBe(true);
    expect(existsSync(join(omitted, "index.md"))).toBe(true);
    expect(existsSync(join(omitted, "log.md"))).toBe(true);
    const index = readFileSync(join(omitted, "index.md"), "utf8");
    expect(index).toContain("concepts/Operator Page.md");
    expect(index).not.toContain("Agent");
    expect(r.stderr).toContain(contentClassOmissionNotice([MARKED]));

    const carried = join(tmp, "bundle-override");
    const ro = await runCli(["brain", "okf-export", "--out", carried, "--include-prompt-derived"], {
      env: env(),
    });
    expect(ro.returncode).toBe(0);
    expect(existsSync(join(carried, "okf.json"))).toBe(true);
    expect(existsSync(join(carried, "index.md"))).toBe(true);
    expect(existsSync(join(carried, "log.md"))).toBe(true);
    const indexBoth = readFileSync(join(carried, "index.md"), "utf8");
    expect(indexBoth).toContain("concepts/Operator Page.md");
    expect(indexBoth).toContain("concepts/Agent Page.md");
  });
});

describe("graph-export applies the default and the override", () => {
  test("a marked page has no node, and the omission is named", async () => {
    await bootstrap();
    const out = join(tmp, "graph.json");
    const r = await runCli(["brain", "graph-export", "--out", out], { env: env() });
    expect(r.returncode).toBe(0);
    const graph = JSON.parse(readFileSync(out, "utf8")) as {
      nodes: ReadonlyArray<{ path: string }>;
    };
    expect(graph.nodes.map((n) => n.path)).toEqual(["Operator Page.md"]);
    expect(r.stderr).toContain(contentClassOmissionNotice([MARKED]));
  });

  test("the override keeps the node and notices", async () => {
    await bootstrap();
    const out = join(tmp, "graph-override.json");
    const r = await runCli(["brain", "graph-export", "--out", out, "--include-prompt-derived"], {
      env: env(),
    });
    expect(r.returncode).toBe(0);
    const graph = JSON.parse(readFileSync(out, "utf8")) as {
      nodes: ReadonlyArray<{ path: string }>;
    };
    expect(graph.nodes.map((n) => n.path).toSorted()).toEqual([
      "Agent Page.md",
      "Operator Page.md",
    ]);
    expect(r.stderr).toContain(EGRESS_CONTENT_CLASS_INCLUDE_NOTICE);
  });
});

describe("graph-export drops kept nodes' references to left-out pages", () => {
  test("links and relation targets naming a left-out page leave the node, counted", async () => {
    await bootstrap();
    writeFileSync(
      join(vault, "Operator Page.md"),
      '---\ntitle: Operator Page\nrelated: "[[Agent Page]]"\n---\n\nSee [[Agent Page]] and [[Operator Journal]].\n',
      "utf8",
    );
    writeFileSync(
      join(vault, "Operator Journal.md"),
      "---\ntitle: Operator Journal\n---\n\nOperator words.\n",
      "utf8",
    );
    const out = join(tmp, "graph-refs.json");
    const r = await runCli(["brain", "graph-export", "--out", out], { env: env() });
    expect(r.returncode).toBe(0);
    const graph = JSON.parse(readFileSync(out, "utf8")) as {
      nodes: ReadonlyArray<{
        path: string;
        links: ReadonlyArray<string>;
        relations: Readonly<Record<string, ReadonlyArray<string>>>;
      }>;
    };
    const operator = graph.nodes.find((n) => n.path === "Operator Page.md");
    expect(operator?.links).toEqual(["Operator Journal"]);
    // The relation left with no targets drops with them, matching the
    // exporter's own shape of carrying only non-empty relation fields.
    expect(operator?.relations).toEqual({});
    expect(r.stderr).toContain(contentClassOmissionNotice([MARKED]));
    expect(r.stderr).toContain(
      "2 link/relation target(s) to left-out page(s) dropped from kept nodes",
    );
  });

  test("the override keeps every target", async () => {
    await bootstrap();
    writeFileSync(
      join(vault, "Operator Page.md"),
      "---\ntitle: Operator Page\n---\n\nSee [[Agent Page]].\n",
      "utf8",
    );
    const out = join(tmp, "graph-refs-override.json");
    const r = await runCli(["brain", "graph-export", "--out", out, "--include-prompt-derived"], {
      env: env(),
    });
    expect(r.returncode).toBe(0);
    const graph = JSON.parse(readFileSync(out, "utf8")) as {
      nodes: ReadonlyArray<{ path: string; links: ReadonlyArray<string> }>;
    };
    const operator = graph.nodes.find((n) => n.path === "Operator Page.md");
    expect(operator?.links).toEqual(["Agent Page"]);
    expect(r.stderr).not.toContain("link/relation target(s) to left-out page(s) dropped");
  });
});

describe("bank-export applies the default and the override", () => {
  test("a marked page leaves both page sections, named once", async () => {
    await bootstrap();
    const out = join(tmp, "bank.json");
    const r = await runCli(["brain", "bank-export", "--out", out], { env: env() });
    expect(r.returncode).toBe(0);
    const bundle = JSON.parse(readFileSync(out, "utf8")) as {
      graph: { nodes: ReadonlyArray<{ path: string }> };
      pages: ReadonlyArray<{ path: string }>;
    };
    expect(bundle.graph.nodes.map((n) => n.path)).toEqual(["Operator Page.md"]);
    expect(bundle.pages.map((p) => p.path)).toEqual(["Operator Page.md"]);
    // One page omitted from two sections is ONE disclosure.
    expect(r.stderr.split(contentClassOmissionNotice([MARKED])).length - 1).toBe(1);
  });

  test("the override keeps both sections and notices", async () => {
    await bootstrap();
    const out = join(tmp, "bank-override.json");
    const r = await runCli(["brain", "bank-export", "--out", out, "--include-prompt-derived"], {
      env: env(),
    });
    expect(r.returncode).toBe(0);
    const bundle = JSON.parse(readFileSync(out, "utf8")) as {
      graph: { nodes: ReadonlyArray<{ path: string }> };
      pages: ReadonlyArray<{ path: string }>;
    };
    expect(bundle.graph.nodes).toHaveLength(2);
    expect(bundle.pages).toHaveLength(2);
    expect(r.stderr).toContain(EGRESS_CONTENT_CLASS_INCLUDE_NOTICE);
  });
});

describe("bank-export drops kept pages' structured references to left-out pages", () => {
  test("graph links, relation targets and contract citations leave, counted", async () => {
    await bootstrap();
    writeFileSync(
      join(vault, "Operator Page.md"),
      '---\ntitle: Operator Page\nrelated: "[[Agent Page]]"\n---\n\nSee [[Agent Page]].\n',
      "utf8",
    );
    const out = join(tmp, "bank-refs.json");
    const r = await runCli(["brain", "bank-export", "--out", out], { env: env() });
    expect(r.returncode).toBe(0);
    const bundle = JSON.parse(readFileSync(out, "utf8")) as {
      graph: {
        nodes: ReadonlyArray<{
          links: ReadonlyArray<string>;
          relations: Readonly<Record<string, ReadonlyArray<string>>>;
        }>;
      };
      pages: ReadonlyArray<{ citations: ReadonlyArray<string> }>;
    };
    expect(bundle.graph.nodes[0]?.links).toEqual([]);
    expect(bundle.graph.nodes[0]?.relations).toEqual({});
    expect(bundle.pages[0]?.citations).toEqual([]);
    // One body link, one relation target on the graph node, and one
    // de-duplicated citation on the contract.
    expect(r.stderr).toContain(
      "3 link/relation/citation target(s) to left-out page(s) dropped from kept pages' structured references",
    );
  });

  test("the override keeps every structured reference", async () => {
    await bootstrap();
    writeFileSync(
      join(vault, "Operator Page.md"),
      "---\ntitle: Operator Page\n---\n\nSee [[Agent Page]].\n",
      "utf8",
    );
    const out = join(tmp, "bank-refs-override.json");
    const r = await runCli(["brain", "bank-export", "--out", out, "--include-prompt-derived"], {
      env: env(),
    });
    expect(r.returncode).toBe(0);
    const bundle = JSON.parse(readFileSync(out, "utf8")) as {
      graph: { nodes: ReadonlyArray<{ path: string; links: ReadonlyArray<string> }> };
      pages: ReadonlyArray<{ path: string; citations: ReadonlyArray<string> }>;
    };
    const operatorNode = bundle.graph.nodes.find((n) => n.path === "Operator Page.md");
    expect(operatorNode?.links).toEqual(["Agent Page"]);
    const operatorPage = bundle.pages.find((p) => p.path === "Operator Page.md");
    expect(operatorPage?.citations).toEqual(["Agent Page"]);
    expect(r.stderr).not.toContain("dropped from kept pages' structured references");
  });
});

/**
 * A stand-in corpus stream: the real one reads runtime session
 * directories; the loop under test only consumes records and a summary.
 */
async function* corpus(values: readonly unknown[]): AsyncGenerator<never, { scanned: number }> {
  for (const value of values) yield value as never;
  return { scanned: values.length };
}

async function collect(
  values: readonly unknown[],
  opts?: { readonly includePromptDerived?: boolean },
): Promise<{ outcome: SpoolOutcome; lines: string[] }> {
  const lines: string[] = [];
  const outcome = await spoolTranscriptCorpus(
    corpus(values) as unknown as Parameters<typeof spoolTranscriptCorpus>[0],
    (line: string) => lines.push(line),
    opts,
  );
  return { outcome, lines };
}

describe("the transcript corpus refuses or names, never silently empties", () => {
  const plainRecord = {
    session_id: "plain.jsonl",
    runtime: "claude",
    messages: [{ role: "user", content: "hello" }],
  };
  const markedRecord = {
    session_id: "marked.jsonl",
    runtime: "claude",
    provenance: { [CONTENT_CLASS_FIELD]: CONTENT_CLASS.promptDerived },
    messages: [{ role: "user", content: "from a prompt" }],
  };

  test("a marked record is omitted from the corpus and named", async () => {
    const { outcome, lines } = await collect([plainRecord, markedRecord]);
    expect(outcome.kind).toBe("written");
    if (outcome.kind !== "written") return;
    expect(outcome.written).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("plain.jsonl");
    expect(outcome.promptDerivedOmitted).toEqual(["marked.jsonl"]);
  });

  test("a corpus the policy would empty is a refusal that names what it held back", async () => {
    const { outcome, lines } = await collect([markedRecord]);
    expect(lines).toEqual([]);
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.detail).toContain("content_class: prompt-derived");
    expect(outcome.detail).toContain("marked.jsonl");
    expect(outcome.detail).toContain("--include-prompt-derived");
  });

  test("the override carries every record", async () => {
    const { outcome, lines } = await collect([plainRecord, markedRecord], {
      includePromptDerived: true,
    });
    expect(outcome.kind).toBe("written");
    if (outcome.kind !== "written") return;
    expect(outcome.written).toBe(2);
    expect(outcome.promptDerivedOmitted).toEqual([]);
    expect(lines).toHaveLength(2);
  });
});

describe("the record tripwire", () => {
  test("finds a class mapping at any reasonable depth, and nothing else", () => {
    expect(treeCarriesPromptDerived({ [CONTENT_CLASS_FIELD]: CONTENT_CLASS.promptDerived })).toBe(
      true,
    );
    expect(
      treeCarriesPromptDerived({ a: [{ b: { [CONTENT_CLASS_FIELD]: "prompt-derived" } }] }),
    ).toBe(true);
    // A bare string that happens to spell the value is content, not a
    // claim about itself.
    expect(treeCarriesPromptDerived({ messages: ["prompt-derived"] })).toBe(false);
    expect(treeCarriesPromptDerived({ [CONTENT_CLASS_FIELD]: "hand-written" })).toBe(false);
    expect(treeCarriesPromptDerived("prompt-derived")).toBe(false);
    // Absence of the key - every pre-stamp-era record - marks nothing.
    expect(treeCarriesPromptDerived({})).toBe(false);
  });
});
