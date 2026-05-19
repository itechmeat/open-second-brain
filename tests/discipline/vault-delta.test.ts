import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { vaultDelta } from "../../src/core/discipline/vault-delta.ts";

function touch(path: string, iso: string): void {
  const t = new Date(iso).getTime() / 1000;
  utimesSync(path, t, t);
}

describe("vaultDelta", () => {
  test("counts signal / preference / retired files inside window", () => {
    const v = mkdtempSync(join(tmpdir(), "o2b-disc-delta-"));
    mkdirSync(join(v, "Brain", "inbox"), { recursive: true });
    mkdirSync(join(v, "Brain", "preferences"), { recursive: true });
    mkdirSync(join(v, "Brain", "retired"), { recursive: true });
    writeFileSync(join(v, "Brain", "inbox", "sig-1.md"), "x");
    touch(join(v, "Brain", "inbox", "sig-1.md"), "2026-05-17T12:00:00Z");
    writeFileSync(join(v, "Brain", "inbox", "sig-2.md"), "x");
    touch(join(v, "Brain", "inbox", "sig-2.md"), "2026-05-17T13:00:00Z");
    writeFileSync(join(v, "Brain", "preferences", "pref-x.md"), "x");
    touch(join(v, "Brain", "preferences", "pref-x.md"), "2026-05-17T18:00:00Z");
    writeFileSync(join(v, "Brain", "retired", "pref-y.md"), "x");
    touch(join(v, "Brain", "retired", "pref-y.md"), "2026-05-16T10:00:00Z");

    const out = vaultDelta(v, {
      startUtc: new Date("2026-05-17T00:00:00Z"),
      endUtc: new Date("2026-05-18T00:00:00Z"),
    });
    expect(out.newSignals).toBe(2);
    expect(out.newPreferences).toBe(1);
    expect(out.newRetired).toBe(0);
    expect(out.total).toBe(3);
    rmSync(v, { recursive: true });
  });
});
