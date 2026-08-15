import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bootstrapBrain,
  BrainStarterError,
  copyStarterBundle,
} from "../../../src/core/brain/init.ts";
import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { dream } from "../../../src/core/brain/dream.ts";

const tmpRoots: string[] = [];

function mkVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "osb-starter-"));
  tmpRoots.push(dir);
  return dir;
}

function withRegisteredConfig(): { vault: string; config: string } {
  const tmp = mkdtempSync(join(tmpdir(), "osb-starter-cfg-"));
  tmpRoots.push(tmp);
  const vault = join(tmp, "vault");
  const config = join(tmp, "config.yaml");
  mkdirSync(vault, { recursive: true });
  writeFileSync(
    config,
    [
      "kind: open-second-brain-config",
      "schema_version: 1",
      `vault: ${JSON.stringify(vault)}`,
      'agent_name: "starter-test-agent"',
      "",
    ].join("\n"),
    "utf8",
  );
  return { vault, config };
}

afterEach(() => {
  for (const d of tmpRoots.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe("copyStarterBundle", () => {
  test("copies the 18 starter files into an empty Brain", () => {
    const vault = mkVault();
    for (const sub of ["preferences", "retired", "inbox", "log"]) {
      mkdirSync(join(vault, "Brain", sub), { recursive: true });
    }
    const result = copyStarterBundle(vault);
    expect(result.copied).toHaveLength(18);
    expect(readdirSync(join(vault, "Brain", "preferences"))).toHaveLength(8);
    expect(readdirSync(join(vault, "Brain", "retired"))).toHaveLength(3);
    expect(readdirSync(join(vault, "Brain", "inbox"))).toHaveLength(1);
    expect(readdirSync(join(vault, "Brain", "log"))).toHaveLength(6);
  });

  test("refuses to copy when preferences/ already has a file", () => {
    const vault = mkVault();
    for (const sub of ["preferences", "retired", "inbox", "log"]) {
      mkdirSync(join(vault, "Brain", sub), { recursive: true });
    }
    writeFileSync(
      join(vault, "Brain", "preferences", "pref-existing.md"),
      "---\nkind: brain-preference\nid: pref-existing\n---\n",
    );
    expect(() => copyStarterBundle(vault)).toThrow(BrainStarterError);
    // Refusal is total: no other directory was touched.
    expect(readdirSync(join(vault, "Brain", "retired"))).toEqual([]);
    expect(readdirSync(join(vault, "Brain", "inbox"))).toEqual([]);
    expect(readdirSync(join(vault, "Brain", "log"))).toEqual([]);
  });

  test("refuses when log/ already has a file (symmetric across subdirs)", () => {
    const vault = mkVault();
    for (const sub of ["preferences", "retired", "inbox", "log"]) {
      mkdirSync(join(vault, "Brain", sub), { recursive: true });
    }
    writeFileSync(join(vault, "Brain", "log", "2026-05-01.md"), "---\ndate: 2026-05-01\n---\n");
    expect(() => copyStarterBundle(vault)).toThrow(BrainStarterError);
  });

  test("custom --starter-path resolves relative to cwd", () => {
    const vault = mkVault();
    for (const sub of ["preferences", "retired", "inbox", "log"]) {
      mkdirSync(join(vault, "Brain", sub), { recursive: true });
    }
    const custom = mkdtempSync(join(tmpdir(), "osb-starter-src-"));
    tmpRoots.push(custom);
    for (const sub of ["preferences", "retired", "inbox", "log"]) {
      mkdirSync(join(custom, sub), { recursive: true });
    }
    writeFileSync(
      join(custom, "preferences", "pref-x.md"),
      "---\nkind: brain-preference\nid: pref-x\n---\n",
    );
    const result = copyStarterBundle(vault, { starterPath: custom });
    expect(result.copied).toHaveLength(1);
    expect(readdirSync(join(vault, "Brain", "preferences"))).toEqual(["pref-x.md"]);
  });

  test("ages a custom bundle that nests a subtree instead of failing on it", () => {
    // The copy is recursive, so a top-level entry can be a directory. Reading
    // one as a file is `EISDIR` and would take the whole install down with it.
    const vault = mkVault();
    for (const sub of ["preferences", "retired", "inbox", "log"]) {
      mkdirSync(join(vault, "Brain", sub), { recursive: true });
    }
    const custom = mkdtempSync(join(tmpdir(), "osb-starter-src-"));
    tmpRoots.push(custom);
    for (const sub of ["preferences", "retired", "inbox", "log"]) {
      mkdirSync(join(custom, sub), { recursive: true });
    }
    mkdirSync(join(custom, "preferences", "2026-05-16-nested"), { recursive: true });
    writeFileSync(join(custom, "log", "2026-05-16.md"), "---\ndate: 2026-05-16\n---\n");
    writeFileSync(
      join(custom, "preferences", "2026-05-16-nested", "pref-y.md"),
      "---\nkind: brain-preference\nid: pref-y\ncreated_at: 2026-05-15T09:00:00Z\n---\n",
    );

    const result = copyStarterBundle(vault, {
      starterPath: custom,
      now: new Date("2026-05-18T00:00:00Z"),
    });

    // Anchor is the bundle's newest log day (05-16), so everything moves two
    // days - the nested directory's own name included.
    expect(result.copied).toContain(join("Brain", "log", "2026-05-18.md"));
    expect(readdirSync(join(vault, "Brain", "preferences"))).toEqual(["2026-05-18-nested"]);
    expect(
      readFileSync(join(vault, "Brain", "preferences", "2026-05-18-nested", "pref-y.md"), "utf8"),
    ).toContain("created_at: 2026-05-17T09:00:00Z");
  });

  test("rejects a starter path that does not exist", () => {
    const vault = mkVault();
    for (const sub of ["preferences", "retired", "inbox", "log"]) {
      mkdirSync(join(vault, "Brain", sub), { recursive: true });
    }
    expect(() =>
      copyStarterBundle(vault, {
        starterPath: "/definitely/not/a/real/path",
      }),
    ).toThrow(BrainStarterError);
  });
});

describe("bootstrapBrain --starter", () => {
  test("running through bootstrap drops the bundle and produces a doctor-clean Brain", () => {
    const { vault, config } = withRegisteredConfig();
    const r = bootstrapBrain(vault, {
      configPath: config,
      starter: true,
    });
    // 2 baseline file entries (_brain.yaml, _BRAIN.md) plus 18 from
    // the starter bundle.
    const starterEntries = r.created.filter(
      (p) =>
        p.startsWith("Brain/preferences/") ||
        p.startsWith("Brain/retired/") ||
        p.startsWith("Brain/inbox/") ||
        p.startsWith("Brain/log/"),
    );
    expect(starterEntries).toHaveLength(18);

    const doctor = runDoctor(vault);
    expect(doctor.errors).toEqual([]);
    // The starter must not raise lint warnings — drift would surface as
    // broken-backlinks, low-evidence-confirmed, etc.
    expect(doctor.warnings).toEqual([]);
  });

  test("dream is a no-op on the fresh starter at a fixed --now", () => {
    const { vault, config } = withRegisteredConfig();
    // Both instants are the bundle's own anchor day, so it is dropped
    // with a zero shift - byte-identical to the authored source - and
    // dream then reads it as of the same day the history ends on.
    const now = new Date("2026-05-17T12:00:00Z");
    bootstrapBrain(vault, { configPath: config, starter: true, now });
    const result = dream(vault, { now, dryRun: true });
    expect(result.changed).toBe(false);
  });

  test("the dropped bundle's history ends on the day it was dropped", () => {
    // The authored bundle goes stale ninety days after it was written:
    // a `pinned` preference whose evidence is fixed in May 2026 trips
    // `pinned-without-recent-evidence` on every vault initialised from
    // mid-August 2026 on. Ageing the copy is what keeps a freshly
    // initialised Brain doctor-clean at any point in the future.
    const { vault, config } = withRegisteredConfig();
    const now = new Date("2027-11-02T08:30:00Z");
    bootstrapBrain(vault, { configPath: config, starter: true, now });

    const days = readdirSync(join(vault, "Brain", "log")).sort();
    expect(days.at(-1)).toBe("2027-11-02.md");
    // Five consecutive days of log, and the intervals inside the bundle
    // are preserved rather than collapsed.
    expect(days).toHaveLength(6);
    expect(days[0]).toBe("2027-10-28.md");

    const pinned = readFileSync(
      join(vault, "Brain", "preferences", "pref-no-unexplained-abbreviations.md"),
      "utf8",
    );
    expect(pinned).toContain('_last_evidence_at: "2027-10-31T10:05:00Z"');
    expect(pinned).not.toContain("2026-05");

    // Read as of the same instant it was installed at. Letting the wall
    // clock in here would rebuild the time bomb this test exists to
    // prove gone: the fixture would age past the freshness window and
    // the assertion would fail on a date rather than on a regression.
    const doctor = runDoctor(vault, { now });
    expect(doctor.errors).toEqual([]);
    expect(doctor.warnings).toEqual([]);
  });
});
