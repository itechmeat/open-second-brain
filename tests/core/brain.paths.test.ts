import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  allocateSlug,
  brainConfigPath,
  brainDirs,
  brainManualPath,
  brainVaultRelative,
  logPath,
  preferencePath,
  processedSignalPath,
  retiredPath,
  signalPath,
  snapshotPath,
  snapshotsDir,
  validateIsoDate,
  validateRunId,
  validateSlug,
} from "../../src/core/brain/paths.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-brain-paths-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("brainDirs", () => {
  test("composes the canonical Brain/ layout", () => {
    const dirs = brainDirs("/vault");
    expect(dirs.brain).toBe(join("/vault", "Brain"));
    expect(dirs.inbox).toBe(join("/vault", "Brain", "inbox"));
    expect(dirs.processed).toBe(join("/vault", "Brain", "inbox", "processed"));
    expect(dirs.preferences).toBe(join("/vault", "Brain", "preferences"));
    expect(dirs.retired).toBe(join("/vault", "Brain", "retired"));
    expect(dirs.log).toBe(join("/vault", "Brain", "log"));
    expect(dirs.snapshots).toBe(join("/vault", "Brain", ".snapshots"));
  });
});

describe("path constructors", () => {
  test("brainConfigPath / brainManualPath", () => {
    expect(brainConfigPath("/v")).toBe(join("/v", "Brain", "_brain.yaml"));
    expect(brainManualPath("/v")).toBe(join("/v", "Brain", "_BRAIN.md"));
  });

  test("signalPath, processedSignalPath", () => {
    expect(signalPath("/v", "2026-05-14", "no-internal-abbrev")).toBe(
      join("/v", "Brain", "inbox", "sig-2026-05-14-no-internal-abbrev.md"),
    );
    expect(processedSignalPath("/v", "2026-05-14", "no-internal-abbrev")).toBe(
      join("/v", "Brain", "inbox", "processed", "sig-2026-05-14-no-internal-abbrev.md"),
    );
  });

  test("preferencePath / retiredPath / logPath / snapshotsDir / snapshotPath", () => {
    expect(preferencePath("/v", "no-internal-abbrev")).toBe(
      join("/v", "Brain", "preferences", "pref-no-internal-abbrev.md"),
    );
    expect(retiredPath("/v", "no-internal-abbrev")).toBe(
      join("/v", "Brain", "retired", "ret-no-internal-abbrev.md"),
    );
    expect(logPath("/v", "2026-05-14")).toBe(join("/v", "Brain", "log", "2026-05-14.md"));
    expect(snapshotsDir("/v")).toBe(join("/v", "Brain", ".snapshots"));
    expect(snapshotPath("/v", "dream-2026-05-14-104200")).toBe(
      join("/v", "Brain", ".snapshots", "dream-2026-05-14-104200.tar.zst"),
    );
  });

  test("signalPath validates date format", () => {
    expect(() => signalPath("/v", "2026.05.14", "slug")).toThrow();
    expect(() => signalPath("/v", "14-05-2026", "slug")).toThrow();
    expect(() => signalPath("/v", "2026-13-01", "slug")).toThrow();
  });

  test("logPath validates date", () => {
    expect(() => logPath("/v", "nope")).toThrow();
    expect(() => logPath("/v", "2025-02-29")).toThrow();
  });
});

describe("validateSlug", () => {
  test("accepts plain slugs", () => {
    expect(validateSlug("no-internal-abbrev")).toBe("no-internal-abbrev");
    expect(validateSlug("alpha_beta-2")).toBe("alpha_beta-2");
  });

  test("rejects path separators", () => {
    expect(() => validateSlug("a/b")).toThrow(/path separators/);
    expect(() => validateSlug("a\\b")).toThrow(/path separators/);
  });

  test("rejects traversal", () => {
    expect(() => validateSlug("..")).toThrow(/traversal/);
    expect(() => validateSlug("..-evil")).toThrow(/traversal/);
    expect(() => validateSlug("evil-..")).toThrow(/traversal/);
  });

  test("rejects empty", () => {
    expect(() => validateSlug("")).toThrow();
    expect(() => validateSlug("   ")).toThrow();
  });

  test("trims whitespace", () => {
    expect(validateSlug("  ok-slug  ")).toBe("ok-slug");
  });

  test("rejects Windows-reserved basenames", () => {
    expect(() => validateSlug("CON")).toThrow(/Windows-reserved/);
    expect(() => validateSlug("nul.md")).toThrow(/Windows-reserved/);
  });

  test("rejects Windows-invalid filename characters", () => {
    expect(() => validateSlug("slug:with-colon")).toThrow(/invalid character/);
    expect(() => validateSlug("slug*with-star")).toThrow(/invalid character/);
    expect(() => validateSlug('slug"quote')).toThrow(/invalid character/);
    expect(() => validateSlug("slug<lt")).toThrow(/invalid character/);
    expect(() => validateSlug("slug>gt")).toThrow(/invalid character/);
    expect(() => validateSlug("slug|pipe")).toThrow(/invalid character/);
    expect(() => validateSlug("slug?question")).toThrow(/invalid character/);
  });

  test("rejects ASCII control characters in slug", () => {
    expect(() => validateSlug("slug\x00null")).toThrow(/invalid character/);
    expect(() => validateSlug("slug\nnewline")).toThrow(/invalid character/);
    expect(() => validateSlug("slug\x1Fus")).toThrow(/invalid character/);
  });
});

describe("validateIsoDate", () => {
  test("accepts well-formed ISO dates", () => {
    expect(validateIsoDate("2026-05-14")).toBe("2026-05-14");
    expect(validateIsoDate("2024-02-29")).toBe("2024-02-29");
  });

  test("rejects bad shapes", () => {
    expect(() => validateIsoDate("nope")).toThrow(/format/);
    expect(() => validateIsoDate("2026/05/14")).toThrow();
  });

  test("rejects impossible calendar dates", () => {
    expect(() => validateIsoDate("2025-02-29")).toThrow(/valid calendar date/);
    expect(() => validateIsoDate("2026-13-01")).toThrow(/valid calendar date/);
  });
});

describe("validateRunId", () => {
  test("accepts dream run ids", () => {
    expect(validateRunId("dream-2026-05-14-104200")).toBe("dream-2026-05-14-104200");
  });

  test("rejects empty / separators / traversal", () => {
    expect(() => validateRunId("")).toThrow();
    expect(() => validateRunId("a/b")).toThrow();
    expect(() => validateRunId("..")).toThrow();
    expect(() => validateRunId("dream..2026")).toThrow();
  });

  test("rejects leading dot", () => {
    expect(() => validateRunId(".hidden")).toThrow();
  });

  test("rejects Windows-reserved", () => {
    expect(() => validateRunId("con")).toThrow(/Windows-reserved/);
  });
});

describe("path-safety", () => {
  test("signalPath rejects traversal slugs (defense in depth)", () => {
    expect(() => signalPath("/v", "2026-05-14", "../escape")).toThrow();
  });

  test("preferencePath rejects path-separator slug", () => {
    expect(() => preferencePath("/v", "a/b")).toThrow();
  });

  test("snapshotPath rejects bogus run_id", () => {
    expect(() => snapshotPath("/v", "../etc/passwd")).toThrow();
    expect(() => snapshotPath("/v", "")).toThrow();
  });
});

describe("brainVaultRelative", () => {
  test("renders posix-style relative path", () => {
    const abs = join("/vault", "Brain", "preferences", "pref-x.md");
    expect(brainVaultRelative(abs, "/vault")).toBe("Brain/preferences/pref-x.md");
  });
});

describe("allocateSlug — collision allocator", () => {
  test("returns bare slug when target is free", () => {
    const targetDir = join(tmp, "Brain", "inbox");
    mkdirSync(targetDir, { recursive: true });
    const result = allocateSlug({
      vault: tmp,
      targetDir,
      prefix: "sig-2026-05-14",
      slug: "no-internal-abbrev",
    });
    expect(result.slug).toBe("no-internal-abbrev");
    expect(result.suffix).toBeNull();
    expect(result.path).toBe(join(targetDir, "sig-2026-05-14-no-internal-abbrev.md"));
  });

  test("appends -2 on first collision", () => {
    const targetDir = join(tmp, "Brain", "inbox");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "sig-2026-05-14-no-internal-abbrev.md"), "stub", "utf8");

    const result = allocateSlug({
      vault: tmp,
      targetDir,
      prefix: "sig-2026-05-14",
      slug: "no-internal-abbrev",
    });
    expect(result.slug).toBe("no-internal-abbrev-2");
    expect(result.suffix).toBe(2);
    expect(result.path).toBe(join(targetDir, "sig-2026-05-14-no-internal-abbrev-2.md"));
  });

  test("appends -3 on second collision", () => {
    const targetDir = join(tmp, "Brain", "inbox");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "sig-2026-05-14-no-internal-abbrev.md"), "stub", "utf8");
    writeFileSync(join(targetDir, "sig-2026-05-14-no-internal-abbrev-2.md"), "stub", "utf8");

    const result = allocateSlug({
      vault: tmp,
      targetDir,
      prefix: "sig-2026-05-14",
      slug: "no-internal-abbrev",
    });
    expect(result.slug).toBe("no-internal-abbrev-3");
    expect(result.suffix).toBe(3);
  });

  test("each successive call increments deterministically", () => {
    const targetDir = join(tmp, "Brain", "preferences");
    mkdirSync(targetDir, { recursive: true });

    const expected: Array<readonly [string, number | null]> = [
      ["foo", null],
      ["foo-2", 2],
      ["foo-3", 3],
      ["foo-4", 4],
    ];
    for (const [slug, suffix] of expected) {
      const r = allocateSlug({
        vault: tmp,
        targetDir,
        prefix: "pref",
        slug: "foo",
      });
      expect(r.slug).toBe(slug);
      expect(r.suffix).toBe(suffix);
      // Create the file so the next iteration sees a collision.
      writeFileSync(r.path, "stub", "utf8");
    }
  });

  test("rejects slug with traversal up-front", () => {
    const targetDir = join(tmp, "Brain", "inbox");
    mkdirSync(targetDir, { recursive: true });
    expect(() =>
      allocateSlug({
        vault: tmp,
        targetDir,
        prefix: "sig-2026-05-14",
        slug: "..",
      }),
    ).toThrow();
  });

  test("rejects empty or path-dirty prefix", () => {
    const targetDir = join(tmp, "Brain", "inbox");
    mkdirSync(targetDir, { recursive: true });
    expect(() =>
      allocateSlug({
        vault: tmp,
        targetDir,
        prefix: "",
        slug: "ok",
      }),
    ).toThrow(/prefix/);
    expect(() =>
      allocateSlug({
        vault: tmp,
        targetDir,
        prefix: "evil/dir",
        slug: "ok",
      }),
    ).toThrow(/prefix/);
  });

  test("aborts when maxAttempts exhausted instead of looping forever", () => {
    const targetDir = join(tmp, "Brain", "inbox");
    mkdirSync(targetDir, { recursive: true });
    // Seed two collisions then cap at 2.
    writeFileSync(join(targetDir, "sig-stub-x.md"), "1", "utf8");
    writeFileSync(join(targetDir, "sig-stub-x-2.md"), "1", "utf8");
    expect(() =>
      allocateSlug({
        vault: tmp,
        targetDir,
        prefix: "sig-stub",
        slug: "x",
        maxAttempts: 2,
      }),
    ).toThrow(/could not find a free name/);
  });

  test("refuses a targetDir outside the vault", () => {
    // Pick a sibling path that exists (tmpdir itself) so the realpath
    // probe doesn't short-circuit before lexical comparison; the lexical
    // check still rejects it because it's not under tmp/.
    const outside = mkdtempSync(join(tmpdir(), "o2b-brain-outside-"));
    try {
      expect(() =>
        allocateSlug({
          vault: tmp,
          targetDir: outside,
          prefix: "sig",
          slug: "x",
        }),
      ).toThrow(/path escapes vault/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
