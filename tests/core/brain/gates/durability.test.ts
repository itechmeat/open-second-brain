/**
 * A2 (t_375e98fd): deterministic durability gate. `classifyDurability` flags
 * transient operational content through STRUCTURAL signals only - zero
 * built-in natural-language word lists in any language. Each detector is
 * tested with positive and negative cases; the non-Latin cases prove the
 * classifier is language-agnostic (a plain sentence in any script that
 * carries no structural signal is durable).
 */

import { describe, expect, test } from "bun:test";

import {
  classifyDurability,
  compileDurabilityDenylist,
  hasExitStatusShape,
  hasMeasurementDominance,
  hasProgressCounter,
  hasRunIdShape,
  hasTempPath,
  type DurabilitySignal,
} from "../../../../src/core/brain/gates/durability.ts";

describe("classifyDurability - determinism (pure)", () => {
  test("same input yields the same verdict across repeated calls", () => {
    const samples = [
      "https://techmeat.dev",
      "ada@example.com",
      "/tmp/build-output.log",
      "loaded in 500ms render 200ms",
      "step 3/10 done",
      "run-20260718-120000",
      "process died with SIGKILL",
      "Это важное правило для команды",
      "重要な設計上の決定です",
    ];
    for (const s of samples) {
      const first = classifyDurability(s);
      for (let i = 0; i < 5; i++) {
        expect(classifyDurability(s)).toEqual(first);
      }
    }
  });
});

describe("temp-path detector", () => {
  test("positive: filesystem temp paths", () => {
    expect(hasTempPath("wrote /tmp/session.json")).toBe(true);
    expect(hasTempPath("/var/tmp/cache")).toBe(true);
    expect(hasTempPath("/var/folders/qx/abc/T/x")).toBe(true);
    expect(hasTempPath("output saved to report.tmp")).toBe(true);
    expect(hasTempPath("C:\\Users\\a\\AppData\\Local\\Temp\\x")).toBe(true);
    expect(hasTempPath("cleared %TEMP%")).toBe(true);
    expect(hasTempPath("in $TMPDIR")).toBe(true);
  });

  test("negative: durable text that merely mentions similar words", () => {
    // No temp-path SHAPE, just a prose noun - must not fire (no word lists).
    expect(hasTempPath("the temperature is stable")).toBe(false);
    expect(hasTempPath("https://example.com/attempts")).toBe(false);
    expect(hasTempPath("ada@example.com")).toBe(false);
  });
});

describe("progress-counter detector", () => {
  test("positive: N/M ratios and NN% percentages", () => {
    expect(hasProgressCounter("step 3/10")).toBe(true);
    expect(hasProgressCounter("42/100 complete")).toBe(true);
    expect(hasProgressCounter("done 87%")).toBe(true);
    expect(hasProgressCounter("50%")).toBe(true);
  });

  test("negative: durable text without a counter shape", () => {
    expect(hasProgressCounter("https://techmeat.dev/blog")).toBe(false);
    expect(hasProgressCounter("paid 120 USD")).toBe(false);
    expect(hasProgressCounter("ada@example.com")).toBe(false);
  });
});

describe("run-id / timestamp detector", () => {
  test("positive: run-id and timestamp shapes", () => {
    expect(hasRunIdShape("run-20260718-120000")).toBe(true);
    expect(hasRunIdShape("job_1721304000")).toBe(true);
    expect(hasRunIdShape("build-987654")).toBe(true);
    expect(hasRunIdShape("started at 2026-07-18T12:00:00Z")).toBe(true);
    expect(hasRunIdShape("epoch 1721304000")).toBe(true);
  });

  test("negative: durable text with short numbers only", () => {
    expect(hasRunIdShape("version 3 of the plan")).toBe(false);
    expect(hasRunIdShape("paid 120 USD")).toBe(false);
    expect(hasRunIdShape("ada@example.com")).toBe(false);
  });
});

describe("measurement-dominant detector", () => {
  test("positive: measurement tokens dominate the content", () => {
    expect(hasMeasurementDominance("500ms")).toBe(true);
    expect(hasMeasurementDominance("load 500ms render 200ms")).toBe(true);
    expect(hasMeasurementDominance("12MB 3s")).toBe(true);
  });

  test("negative: measurement is a minority token in durable prose", () => {
    expect(hasMeasurementDominance("it took 500ms to load the whole page")).toBe(false);
    expect(hasMeasurementDominance("budget is 3.5 USD per call")).toBe(false);
    expect(hasMeasurementDominance("ada@example.com")).toBe(false);
  });
});

describe("exit-status detector", () => {
  test("positive: POSIX signal identifiers and the shell exit-status var", () => {
    expect(hasExitStatusShape("process received SIGKILL")).toBe(true);
    expect(hasExitStatusShape("terminated by SIGTERM")).toBe(true);
    expect(hasExitStatusShape("check $? after the run")).toBe(true);
  });

  test("negative: durable prose without a status shape", () => {
    expect(hasExitStatusShape("the signal is strong")).toBe(false);
    expect(hasExitStatusShape("Signature verified")).toBe(false);
    expect(hasExitStatusShape("ada@example.com")).toBe(false);
  });
});

describe("classifyDurability - verdict + reason naming", () => {
  const cases: ReadonlyArray<readonly [string, DurabilitySignal]> = [
    ["/tmp/x.json", "temp-path"],
    ["step 3/10", "progress-counter"],
    ["run-20260718-120000", "run-id"],
    ["load 500ms render 200ms", "measurement-dominant"],
    ["died with SIGKILL", "exit-status"],
  ];
  for (const [text, reason] of cases) {
    test(`"${text}" is transient with reason ${reason}`, () => {
      const v = classifyDurability(text);
      expect(v.durable).toBe(false);
      expect(v.reason).toBe(reason);
    });
  }

  test("durable content returns durable:true, reason:null", () => {
    for (const s of ["https://techmeat.dev", "ada@example.com", "paid 120 USD"]) {
      expect(classifyDurability(s)).toEqual({ durable: true, reason: null });
    }
  });
});

describe("language agnosticism (no built-in word lists)", () => {
  test("plain non-Latin sentences carry no structural signal - durable", () => {
    const durableNonLatin = [
      "Это важное правило для нашей команды", // Russian
      "重要な設計上の決定を記録する", // Japanese
      "هذه قاعدة مهمة للفريق", // Arabic
      "이것은 팀을 위한 중요한 규칙입니다", // Korean
      "价格是一百二十美元", // Chinese prose (no digits)
    ];
    for (const s of durableNonLatin) {
      expect(classifyDurability(s)).toEqual({ durable: true, reason: null });
    }
  });

  test("structural signals fire regardless of surrounding script", () => {
    // The SAME structural shape embedded in non-Latin prose is still caught -
    // structure, not language, is what the gate reads.
    expect(classifyDurability("ログは /tmp/run.log にあります").durable).toBe(false);
    expect(classifyDurability("прогресс 3/10 готово").durable).toBe(false);
  });
});

describe("operator denylist (config regexes extend the gate)", () => {
  test("compileDurabilityDenylist parses a comma-separated regex list", () => {
    const res = compileDurabilityDenylist("^draft:, ^wip-");
    expect(res.length).toBe(2);
    expect(res[0]!.test("draft: throwaway")).toBe(true);
    expect(res[1]!.test("wip-experiment")).toBe(true);
  });

  test("compileDurabilityDenylist tolerates an invalid pattern (skips it)", () => {
    // An unparseable operator regex must never crash capture; it is skipped
    // like an invalid timezone. The valid sibling still compiles.
    const res = compileDurabilityDenylist("(unclosed, ^ok-");
    expect(res.length).toBe(1);
    expect(res[0]!.test("ok-fine")).toBe(true);
  });

  test("compileDurabilityDenylist on empty/absent yields no regexes", () => {
    expect(compileDurabilityDenylist(undefined)).toEqual([]);
    expect(compileDurabilityDenylist("")).toEqual([]);
    expect(compileDurabilityDenylist("  ,  ")).toEqual([]);
  });

  test("a denylist match flags otherwise-durable content as denylisted", () => {
    const denylist = compileDurabilityDenylist("^scratch:");
    const v = classifyDurability("scratch: nothing to keep", { denylist });
    expect(v.durable).toBe(false);
    expect(v.reason).toBe("denylisted");
  });

  test("built-in structural signal wins over the denylist reason (table order)", () => {
    // A temp path AND a denylist match: the built-in structural reason is
    // reported (detectors run before the denylist), keeping reasons stable.
    const denylist = compileDurabilityDenylist("keep");
    const v = classifyDurability("/tmp/keep.json", { denylist });
    expect(v.durable).toBe(false);
    expect(v.reason).toBe("temp-path");
  });

  test("a global-flag-shaped operator regex stays deterministic across calls", () => {
    // compileDurabilityDenylist must not carry statefulness into classify.
    const denylist = compileDurabilityDenylist("scratch");
    const text = "scratch pad";
    const first = classifyDurability(text, { denylist });
    for (let i = 0; i < 4; i++) {
      expect(classifyDurability(text, { denylist })).toEqual(first);
    }
  });
});
