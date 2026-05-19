import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
      'kind: open-second-brain-config',
      'schema_version: 1',
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
    writeFileSync(
      join(vault, "Brain", "log", "2026-05-01.md"),
      "---\ndate: 2026-05-01\n---\n",
    );
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
    expect(readdirSync(join(vault, "Brain", "preferences"))).toEqual([
      "pref-x.md",
    ]);
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
    // 3 baseline file entries (_brain.yaml, _BRAIN.md, AI Wiki overview)
    // plus 18 from the starter bundle.
    const starterEntries = r.created.filter((p) =>
      p.startsWith("Brain/preferences/")
      || p.startsWith("Brain/retired/")
      || p.startsWith("Brain/inbox/")
      || p.startsWith("Brain/log/"),
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
    bootstrapBrain(vault, { configPath: config, starter: true });
    const result = dream(vault, {
      now: new Date("2026-05-17T12:00:00Z"),
      dryRun: true,
    });
    expect(result.changed).toBe(false);
  });
});
