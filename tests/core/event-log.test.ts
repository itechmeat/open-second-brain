import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendEvent,
  insertEventEntry,
  redactText,
  validateEventDate,
  validateEventTime,
} from "../../src/core/event-log.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-eventlog-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("redactText", () => {
  test("removes secret-like assignments", () => {
    expect(redactText("api_key=abc token: xyz password = qwerty")).toBe(
      "api_key=[REDACTED] token: [REDACTED] password = [REDACTED]",
    );
  });
});

describe("validateEventTime", () => {
  test("accepts HH:MM in 24-hour range", () => {
    expect(validateEventTime("00:00")).toBe("00:00");
    expect(validateEventTime("23:59")).toBe("23:59");
  });

  test("rejects malformed inputs", () => {
    for (const bad of ["9:00", "25:00", "bad", "10:60", "abc:de"]) {
      expect(() => validateEventTime(bad)).toThrow(/HH:MM/);
    }
  });
});

describe("validateEventDate", () => {
  test("accepts YYYY.MM.DD calendar dates", () => {
    expect(validateEventDate("2026.05.06")).toBe("2026.05.06");
    expect(validateEventDate("2024.02.29")).toBe("2024.02.29");
  });

  test("rejects malformed, impossible, or path-like inputs", () => {
    for (const bad of [
      "2026-05-06",
      "2026.5.6",
      "2026.13.01",
      "2026.02.30",
      "../AI Wiki/notes/pwn",
    ]) {
      expect(() => validateEventDate(bad)).toThrow(/YYYY\.MM\.DD/);
    }
  });
});

describe("insertEventEntry", () => {
  test("inserts at the end when no other events", () => {
    const out = insertEventEntry("# Day\n\n## Raw events\n\n", "- 09:30 — @x — first");
    expect(out).toBe("# Day\n\n## Raw events\n\n- 09:30 — @x — first\n");
  });

  test("preserves chronological order", () => {
    let content = "# Day\n\n## Raw events\n\n";
    content = insertEventEntry(content, "- 11:00 — @x — later");
    content = insertEventEntry(content, "- 09:00 — @x — earlier");
    expect(content.indexOf("09:00")).toBeLessThan(content.indexOf("11:00"));
  });
});

describe("appendEvent", () => {
  test("creates daily note with raw events section", async () => {
    const path = await appendEvent(tmp, "test-agent", "created project skeleton", {
      date: "2026.05.06",
      time: "09:30",
    });
    expect(path).toBe(join(tmp, "Daily", "2026.05.06.md"));
    const text = readFileSync(path, "utf8");
    expect(text).toBe(
      "---\nformatted: false\n---\n\n# 2026.05.06\n\n## Raw events\n\n- 09:30 — @test-agent — created project skeleton\n",
    );
  });

  test("preserves manual content above raw events", async () => {
    const daily = join(tmp, "Daily", "2026.05.06.md");
    mkdirSync(join(tmp, "Daily"), { recursive: true });
    writeFileSync(
      daily,
      "# 2026.05.06\n\nManual note.\n\n## Raw events\n\n- 08:00 — @old — old entry\n",
    );
    await appendEvent(tmp, "new", "new entry", { date: "2026.05.06", time: "09:00" });
    expect(readFileSync(daily, "utf8")).toBe(
      "# 2026.05.06\n\nManual note.\n\n## Raw events\n\n- 08:00 — @old — old entry\n- 09:00 — @new — new entry\n",
    );
  });

  test("rejects invalid explicit times", async () => {
    for (const bad of ["9:00", "25:00", "bad"]) {
      await expect(
        appendEvent(tmp, "agent", "msg", { date: "2026.05.06", time: bad }),
      ).rejects.toThrow(/HH:MM/);
    }
  });

  test("rejects invalid explicit dates before building the output path", async () => {
    for (const bad of ["2026-05-06", "2026.02.30", "../AI Wiki/notes/pwn"]) {
      await expect(
        appendEvent(tmp, "agent", "msg", { date: bad, time: "09:00" }),
      ).rejects.toThrow(/YYYY\.MM\.DD/);
    }
  });

  test("concurrent process appends keep all entries", async () => {
    const helper = join(import.meta.dir, "..", "helpers", "concurrent-append-runner.ts");
    const N = 12;
    const procs = Array.from({ length: N }, (_, i) =>
      Bun.spawn(["bun", "run", helper, tmp, String(i)], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const codes = await Promise.all(procs.map((p) => p.exited));
    for (let i = 0; i < N; i++) {
      if (codes[i] !== 0) {
        const stderr = await new Response(procs[i]!.stderr).text();
        throw new Error(`worker ${i} exited ${codes[i]}: ${stderr}`);
      }
    }
    const content = readFileSync(join(tmp, "Daily", "2026.05.06.md"), "utf8");
    for (let i = 0; i < N; i++) {
      const stamp = `- 10:${String(i).padStart(2, "0")} — @worker — entry ${i}`;
      expect(content).toContain(stamp);
    }
    const matches = content.match(/@worker — entry/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(N);
  }, 30_000);
});
