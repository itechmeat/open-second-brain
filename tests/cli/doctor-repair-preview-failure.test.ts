/**
 * M6: the consent PREVIEW of the interactive `doctor --repair --apply`
 * ladder sat outside the verb's try, so a fixer that throws while
 * drawing its preview escaped as an uncaught error instead of the
 * `repair failed:` answer every other repair failure produces.
 *
 * The throw is staged through the real code path: a dangling workrun
 * whose file is unreadable (mode 000) passes `existsSync` and then throws
 * EACCES when the wal-gap fixer's preview reads it. The verb must catch
 * that, name it on stderr, and return exit 1 - never an uncaught
 * rejection.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CHMOD_CANNOT_DENY } from "../helpers/platform.ts";

const bases: string[] = [];

afterEach(() => {
  for (const base of bases.splice(0)) {
    // The fixture leaves an unreadable file behind; restore it so the
    // recursive removal can walk the tree.
    try {
      chmodSync(join(base, "vault", "Brain", "log", "dream-runs", "run-locked.jsonl"), 0o644);
    } catch {
      /* already gone */
    }
    rmSync(base, { recursive: true, force: true });
  }
});

// The fixture's mode-000 denial builds nowhere chmod cannot deny (root,
// Windows), where the preview's read would succeed and the ladder would
// prompt instead of failing.
describe.skipIf(CHMOD_CANNOT_DENY)(
  "interactive doctor repair - preview failure is caught (M6)",
  () => {
    test("a preview-side error answers `repair failed:` with exit 1, not an uncaught error", async () => {
      const { cmdBrainDoctor } = await import("../../src/cli/brain/verbs/doctor.ts");
      const base = mkdtempSync(join(tmpdir(), "o2b-doctor-preview-fail-"));
      bases.push(base);
      const vault = join(base, "vault");
      const runs = join(vault, "Brain", "log", "dream-runs");
      mkdirSync(runs, { recursive: true });
      const wr = join(runs, "run-locked.jsonl");
      writeFileSync(
        wr,
        JSON.stringify({ phase: "started", at: "2026-07-18T00:00:00.000Z", run_id: "run-locked" }) +
          "\n",
        "utf8",
      );
      // Unreadable to the fixer's preview, still stat-able (existsSync
      // holds), so the plan names the fix and the preview's read throws.
      chmodSync(wr, 0o000);

      // Reach the interactive branch: fake a TTY (bun test stdin is never
      // one). The preview throws before any prompt is written.
      const stdin = process.stdin as unknown as { isTTY?: boolean };
      const saved = stdin.isTTY;
      Object.defineProperty(stdin, "isTTY", { value: true, configurable: true });
      const chunks: string[] = [];
      const realWrite = process.stderr.write.bind(process.stderr);
      (process.stderr as unknown as { write: (c: string) => boolean }).write = (c: string) => {
        chunks.push(c);
        return true;
      };
      try {
        const code = await cmdBrainDoctor(["--vault", vault, "--repair", "--apply"]);
        expect(code).toBe(1);
        const stderr = chunks.join("");
        expect(stderr).toContain("repair failed:");
        // The prompt never fired: the failure happened while drawing the
        // preview the prompt would have shown.
        expect(stderr).not.toContain("Proceed?");
      } finally {
        (process.stderr as unknown as { write: (c: string) => boolean }).write = realWrite;
        Object.defineProperty(stdin, "isTTY", { value: saved, configurable: true });
      }
    });
  },
);
