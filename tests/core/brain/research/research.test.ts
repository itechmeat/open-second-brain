/**
 * Parameterized research pipeline (Knowledge Provenance suite). N sources plus
 * an agent synthesis become one dated, cited report page; each finding cites
 * the source that flagged it. OSB runs no model and rejects any uncited claim.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { setSecret } from "../../../../src/core/brain/secrets/store.ts";
import { SecretReferenceError } from "../../../../src/core/secret-ref.ts";
import {
  writeResearchReport,
  reportSlotLockTarget,
  ResearchValidationError,
  resolveResearchPoolEnv,
  BRAVE_API_KEY_ENV,
  TAVILY_API_KEY_ENV,
} from "../../../../src/core/brain/research/research.ts";
import { fakeCredential } from "../../../helpers/fake-credentials.ts";
import { acquireDirLock, STORE_LOCK_STALE_MS } from "../../../../src/core/store/local-lock.ts";

let vault: string;
let configHome: string;

const NOW = new Date("2026-06-13T12:00:00Z");
const LATER = new Date("2026-06-13T18:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-research-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-research-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

const INPUT = {
  title: "Restaking risk survey",
  sources: ["Articles/a.md", "Articles/b.md"],
  findings: [
    { statement: "Slashing risk compounds across AVSs", sources: ["Articles/a.md"] },
    {
      statement: "Withdrawal queues lengthen under stress",
      sources: ["Articles/a.md", "Articles/b.md"],
    },
  ],
};

describe("writeResearchReport", () => {
  test("a title spelled like another report's digest page never takes that page", () => {
    // "Обзор release" takes release-<digest> once "Отчёт release" holds
    // release; a report titled release-<digest> has that page as its base,
    // so the two contend for one page.
    const digest = createHash("sha256").update("Обзор release", "utf8").digest("hex").slice(0, 8);
    const spelled = `release-${digest}`;
    writeResearchReport(vault, { ...INPUT, title: "Отчёт release" }, { agent: "claude", now: NOW });
    const b = writeResearchReport(
      vault,
      { ...INPUT, title: "Обзор release" },
      { agent: "claude", now: NOW },
    );
    expect(b.reportPath).toBe(`Brain/reports/2026-06-13-${spelled}.md`);
    const c = writeResearchReport(
      vault,
      { ...INPUT, title: spelled },
      { agent: "claude", now: NOW },
    );
    expect(c.reportPath).not.toBe(b.reportPath);
    expect(readFileSync(join(vault, b.reportPath), "utf8")).toContain("# Обзор release");
    expect(readFileSync(join(vault, c.reportPath), "utf8")).toContain(`# ${spelled}`);
  });

  test("every report of one date takes one lock, so overlapping candidate pages serialize", () => {
    const digest = createHash("sha256").update("Обзор release", "utf8").digest("hex").slice(0, 8);
    const lockTarget = reportSlotLockTarget(vault, "2026-06-13");
    mkdirSync(dirname(lockTarget), { recursive: true });
    const release = acquireDirLock(lockTarget, {
      staleMs: STORE_LOCK_STALE_MS,
      budgetMs: 1000,
      label: "test",
      remedy: "none",
    });
    const before = process.env["OPEN_SECOND_BRAIN_LOCK_WAIT_MS"];
    process.env["OPEN_SECOND_BRAIN_LOCK_WAIT_MS"] = "50";
    try {
      // Both writers of the pair whose candidate pages overlap wait on it.
      for (const title of ["Обзор release", `release-${digest}`]) {
        expect(() =>
          writeResearchReport(vault, { ...INPUT, title }, { agent: "claude", now: NOW }),
        ).toThrow(/busy/);
      }
    } finally {
      if (before === undefined) delete process.env["OPEN_SECOND_BRAIN_LOCK_WAIT_MS"];
      else process.env["OPEN_SECOND_BRAIN_LOCK_WAIT_MS"] = before;
      release();
    }
  });

  test("a re-run finds its digest page after the base page is gone", () => {
    const first = { ...INPUT, title: "Отчёт release" };
    const second = { ...INPUT, title: "Обзор release" };
    const a = writeResearchReport(vault, first, { agent: "claude", now: NOW });
    const b = writeResearchReport(vault, second, { agent: "claude", now: NOW });
    rmSync(join(vault, a.reportPath));
    const again = writeResearchReport(vault, second, { agent: "claude", now: LATER });
    expect(again.reportPath).toBe(b.reportPath);
    expect(again.created).toBe(false);
  });

  test("choosing the page and writing it wait for the report's slot lock", () => {
    const title = "Отчёт release";
    const lockTarget = reportSlotLockTarget(vault, "2026-06-13");
    mkdirSync(dirname(lockTarget), { recursive: true });
    const release = acquireDirLock(lockTarget, {
      staleMs: STORE_LOCK_STALE_MS,
      budgetMs: 1000,
      label: "test",
      remedy: "none",
    });
    const before = process.env["OPEN_SECOND_BRAIN_LOCK_WAIT_MS"];
    process.env["OPEN_SECOND_BRAIN_LOCK_WAIT_MS"] = "50";
    try {
      // A second title of the same slug contends for the same lock, so it
      // cannot choose a page while another report holds it.
      expect(() =>
        writeResearchReport(
          vault,
          { ...INPUT, title: "Обзор release" },
          { agent: "claude", now: NOW },
        ),
      ).toThrow(/busy/);
      expect(existsSync(join(vault, "Brain/reports/2026-06-13-release.md"))).toBe(false);
    } finally {
      if (before === undefined) delete process.env["OPEN_SECOND_BRAIN_LOCK_WAIT_MS"];
      else process.env["OPEN_SECOND_BRAIN_LOCK_WAIT_MS"] = before;
      release();
    }
    expect(
      writeResearchReport(vault, { ...INPUT, title }, { agent: "claude", now: NOW }).created,
    ).toBe(true);
  });

  test("two titles that share only their Latin words keep two reports on one day", () => {
    const first = { ...INPUT, title: "Отчёт release" };
    const second = { ...INPUT, title: "Обзор release" };
    const a = writeResearchReport(vault, first, { agent: "claude", now: NOW });
    const b = writeResearchReport(vault, second, { agent: "claude", now: LATER });
    expect(b.reportPath).not.toBe(a.reportPath);
    expect(b.created).toBe(true);
    expect(readFileSync(join(vault, a.reportPath), "utf8")).toContain("# Отчёт release");
    expect(readFileSync(join(vault, b.reportPath), "utf8")).toContain("# Обзор release");
    // A re-run of either title still rewrites its own page in place.
    const again = writeResearchReport(vault, second, { agent: "claude", now: LATER });
    expect(again.reportPath).toBe(b.reportPath);
    expect(again.created).toBe(false);
    expect(writeResearchReport(vault, first, { agent: "claude", now: LATER }).reportPath).toBe(
      a.reportPath,
    );
  });

  test("writes a dated report page with per-finding citations and a Sources section", () => {
    const res = writeResearchReport(vault, INPUT, { agent: "claude", now: NOW });
    expect(res.created).toBe(true);
    expect(res.findingCount).toBe(2);
    expect(res.reportPath).toContain("2026-06-13");

    const md = readFileSync(join(vault, res.reportPath), "utf8");
    expect(md).toContain("kind: brain-report");
    expect(md).toContain("# Restaking risk survey");
    expect(md).toContain("## Findings");
    expect(md).toContain("Slashing risk compounds across AVSs (cites: [[Articles/a.md]])");
    expect(md).toContain("## Sources");
    expect(md).toContain("[[Articles/b.md]]");
  });

  test("rejects a finding with no source (no uncited claims) and writes nothing", () => {
    const bad = {
      title: "x",
      sources: ["Articles/a.md"],
      findings: [{ statement: "unsupported claim", sources: [] }],
    };
    expect(() => writeResearchReport(vault, bad, { agent: "claude", now: NOW })).toThrow(
      ResearchValidationError,
    );
  });

  test("rejects a finding citing a source that was not consulted", () => {
    const bad = {
      title: "x",
      sources: ["Articles/a.md"],
      findings: [{ statement: "claim", sources: ["Articles/ghost.md"] }],
    };
    expect(() => writeResearchReport(vault, bad, { agent: "claude", now: NOW })).toThrow(
      ResearchValidationError,
    );
  });

  test("rejects a title that spans more than one line and writes nothing", () => {
    for (const title of ["one\n## Sources", "one\rtwo"]) {
      const bad = { ...INPUT, title };
      expect(() => writeResearchReport(vault, bad, { agent: "claude", now: NOW })).toThrow(
        "report title spans more than one line; a title is one line",
      );
    }
    expect(existsSync(join(vault, "Brain", "reports"))).toBe(false);
  });

  test("is idempotent on date+title: a re-run rewrites the same report page", () => {
    const first = writeResearchReport(vault, INPUT, { agent: "claude", now: NOW });
    const second = writeResearchReport(vault, INPUT, { agent: "claude", now: LATER });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.reportPath).toBe(first.reportPath);
  });
});

// ----- Provider keys through the custody store (t_e5807974 / B2) -------------
//
// A provider key env value may be a `$secret:NAME` reference; with the
// custody vault passed it resolves store-first at pool wiring time. Plain
// env values keep today's path byte-identically, and an unresolvable
// reference surfaces the named resolver error instead of quietly yielding
// an empty pool.

describe("resolveResearchPoolEnv", () => {
  const STORED_BRAVE_KEY = fakeCredential("stored-", "brave-5f9a");
  const NOW = new Date("2026-06-13T12:00:00Z");

  test("a reference as a provider key resolves through the custody store", () => {
    setSecret(vault, { name: "brave_key", value: STORED_BRAVE_KEY, agent: "tester", now: NOW });
    const resolved = resolveResearchPoolEnv(
      { [BRAVE_API_KEY_ENV]: "$secret:brave_key", [TAVILY_API_KEY_ENV]: "" },
      vault,
    );
    expect(resolved.braveApiKey).toBe(STORED_BRAVE_KEY);
    expect(resolved.tavilyApiKey).toBeNull();
  });

  test("plain env values pass through byte-identically", () => {
    const resolved = resolveResearchPoolEnv(
      { [BRAVE_API_KEY_ENV]: "  b  ", [TAVILY_API_KEY_ENV]: "t" },
      vault,
    );
    expect(resolved).toEqual({ braveApiKey: "b", tavilyApiKey: "t" });
  });

  test("an unresolvable reference throws the named resolver error", () => {
    expect(() =>
      resolveResearchPoolEnv({ [BRAVE_API_KEY_ENV]: "$secret:absent_name" }, vault),
    ).toThrow(SecretReferenceError);
  });
});
