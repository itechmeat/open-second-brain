/**
 * The Brain log appender writes one event as one append.
 *
 * It used to read the whole `<date>[.<device>].jsonl` shard and its
 * markdown twin and rewrite both through a temp file and a rename for
 * every event, so each event cost the size of the day file (about 5k
 * events a day per device). These tests pin what the append has to keep:
 * the per-shard hash chain, today's handling of a torn last line, the
 * markdown view's bytes, and correctness under concurrent processes.
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyLogChain } from "../../../src/core/brain/log-chain.ts";
import { readLogDay } from "../../../src/core/brain/log-jsonl.ts";
import { appendLogEvent, LOG_CHAIN_FIELDS } from "../../../src/core/brain/log.ts";
import { logJsonlPath, logPath } from "../../../src/core/brain/paths.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const DATE = "2026-06-01";
const SPAWN_TIMEOUT_MS = 60_000;
const BARRIER_LEAD_MS = 1_500;

let root: string;
let vault: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "o2b-log-append-"));
  vault = join(root, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function stamp(i: number): string {
  const s = i % 60;
  const m = Math.floor(i / 60) % 60;
  const h = 10 + Math.floor(i / 3600);
  return `${DATE}T${pad(h)}:${pad(m)}:${pad(s)}Z`;
}

function append(i: number, text = `event ${i}`): void {
  appendLogEvent(
    vault,
    { timestamp: stamp(i), eventType: "note", body: { text, agent: "@tester" } },
    { deviceId: "" },
  );
}

function jsonlLines(): string[] {
  return readFileSync(logJsonlPath(vault, DATE), "utf8").split("\n");
}

describe("log append", () => {
  test("the hash chain stays valid over many appends", () => {
    const count = 300;
    for (let i = 0; i < count; i++) append(i);

    const result = verifyLogChain(vault);
    expect(result.ok).toBe(true);
    expect(result.shards[0]).toMatchObject({ chained: count, legacy: 0, firstBreak: null });
    expect(readLogDay(vault, DATE).entries).toHaveLength(count);
    // One line per event, one trailing newline.
    expect(readFileSync(logJsonlPath(vault, DATE), "utf8").endsWith("}\n")).toBe(true);
  });

  test("the markdown view keeps its exact shape", () => {
    append(0, "first");
    append(1, "second");

    const md = readFileSync(logPath(vault, DATE), "utf8");
    // The channel depends on the host running the suite; the line carrying
    // it is pinned, and every event of one process names the same one.
    const channel = /^- origin_channel: (\S+)$/m.exec(md)?.[1];
    expect(channel).toBeDefined();
    expect(md).toBe(
      [
        "---",
        "kind: brain-log",
        `date: ${DATE}`,
        "tags: [brain, brain/log]",
        "---",
        "",
        `# Brain log — ${DATE}`,
        "",
        "## 10:00:00Z — note",
        "- text: first",
        "- agent: @tester",
        `- origin_channel: ${channel}`,
        "",
        "## 10:00:01Z — note",
        "- text: second",
        "- agent: @tester",
        `- origin_channel: ${channel}`,
        "",
      ].join("\n"),
    );
  });

  test("an append does not replace the shard file", () => {
    append(0);
    const before = statSync(logJsonlPath(vault, DATE));
    const mdBefore = statSync(logPath(vault, DATE));
    append(1);
    const after = statSync(logJsonlPath(vault, DATE));
    const mdAfter = statSync(logPath(vault, DATE));
    // A rewrite renames a new inode into place; an append keeps the file.
    // Windows reports a zero inode on some file systems, so compare only
    // when the platform gives one.
    if (before.ino !== 0) {
      expect(after.ino).toBe(before.ino);
      expect(mdAfter.ino).toBe(mdBefore.ino);
    }
    expect(after.size).toBeGreaterThan(before.size);
  });

  test("a torn last line stays its own line and the chain links past it", () => {
    append(0);
    append(1);
    const path = logJsonlPath(vault, DATE);
    const intact = readFileSync(path, "utf8");
    const torn = '{"ts":"2026-06-01T10:00:0';
    appendFileSync(path, torn);

    append(2);

    const lines = jsonlLines();
    // Two intact rows, the torn fragment untouched on its own line, the
    // new row, and the trailing newline.
    expect(lines).toHaveLength(5);
    expect(lines.slice(0, 2).join("\n") + "\n").toBe(intact);
    expect(lines[2]).toBe(torn);
    expect(lines[4]).toBe("");
    const second = JSON.parse(lines[1]!) as Record<string, unknown>;
    const added = JSON.parse(lines[3]!) as Record<string, unknown>;
    expect(added[LOG_CHAIN_FIELDS.prev]).toBe(second[LOG_CHAIN_FIELDS.h]);

    // The reader skips the fragment with a warning and keeps every event.
    const day = readLogDay(vault, DATE);
    expect(day.entries).toHaveLength(3);
    expect(day.warnings.some((w) => w.message.includes("malformed JSONL line"))).toBe(true);
  });

  test("a complete last line without a trailing newline gets one before the next row", () => {
    append(0);
    const path = logJsonlPath(vault, DATE);
    writeFileSync(path, readFileSync(path, "utf8").replace(/\n$/, ""));

    append(1);

    const lines = jsonlLines();
    expect(lines).toHaveLength(3);
    expect(verifyLogChain(vault).ok).toBe(true);
  });

  test("trailing blank lines are collapsed exactly as the rewrite did", () => {
    append(0);
    const path = logJsonlPath(vault, DATE);
    appendFileSync(path, "\n\n  \n");
    const md = logPath(vault, DATE);
    appendFileSync(md, "\n\n\n");

    append(1);

    expect(jsonlLines()).toHaveLength(3);
    expect(verifyLogChain(vault).ok).toBe(true);
    expect(readFileSync(md, "utf8")).not.toContain("\n\n\n");
    expect(readFileSync(md, "utf8").endsWith("\n")).toBe(true);
  });

  test(
    "concurrent appends from child processes all land with a valid chain",
    async () => {
      const writers = 4;
      const perWriter = 25;
      const script = join(root, "log-writer.ts");
      const logModule = join(import.meta.dir, "../../../src/core/brain/log.ts");
      writeFileSync(
        script,
        [
          `import { appendLogEvent } from ${JSON.stringify(logModule)};`,
          "const [vault, tag, count, startAt] = process.argv.slice(2);",
          "while (Date.now() < Number(startAt)) Bun.sleepSync(1);",
          // Four writers each firing 25 appends back to back is far more
          // contention than the log lock's two-second wait is sized for
          // (several agents, not a tight loop), and on a slow Windows disk a
          // writer lost every round past it with ELOCKED. The refusal tells
          // the caller to retry the write, so the writer does, within a
          // bound: what this test proves is the chain under concurrency.
          "const RETRY_UNTIL_MS = 30_000;",
          "for (let i = 0; i < Number(count); i++) {",
          "  const giveUpAt = Date.now() + RETRY_UNTIL_MS;",
          "  for (;;) {",
          "    try {",
          "      appendLogEvent(",
          "        vault,",
          `        { timestamp: "${DATE}T11:00:00Z", eventType: "note", body: { text: \`\${tag}-\${i}\` } },`,
          '        { deviceId: "" },',
          "      );",
          "      break;",
          "    } catch (err) {",
          '      if (err?.code !== "ELOCKED" || Date.now() > giveUpAt) throw err;',
          "    }",
          "  }",
          "}",
        ].join("\n"),
        "utf8",
      );
      const startAt = String(Date.now() + BARRIER_LEAD_MS);
      const procs = Array.from({ length: writers }, (_, index) =>
        Bun.spawn([process.execPath, script, vault, `w${index}`, String(perWriter), startAt], {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env },
        }),
      );
      const failures: string[] = [];
      await Promise.all(
        procs.map(async (proc) => {
          const err = await new Response(proc.stderr).text();
          const code = await proc.exited;
          if (code !== 0) failures.push(`exit ${code}: ${err.trim()}`);
        }),
      );
      expect(failures).toEqual([]);

      const total = writers * perWriter;
      const result = verifyLogChain(vault);
      expect(result.ok).toBe(true);
      expect(result.shards[0]).toMatchObject({ chained: total, firstBreak: null });
      const texts = readLogDay(vault, DATE).entries.map((e) => e.body["text"]);
      for (let w = 0; w < writers; w++) {
        for (let i = 0; i < perWriter; i++) expect(texts).toContain(`w${w}-${i}`);
      }
      const md = readFileSync(logPath(vault, DATE), "utf8");
      expect(md.match(/^## /gm)?.length).toBe(total);
    },
    SPAWN_TIMEOUT_MS,
  );
});
