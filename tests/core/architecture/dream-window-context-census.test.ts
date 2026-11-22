import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { lexSource } from "../../helpers/source-lexer.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
// The list is exactly the pass-rule modules in design D2. `dream.ts` owns
// context construction and the log read, while the replay boundary modules
// own the read implementation; those are allowed readers. Log writers and
// dates constructed from arguments remain allowed.
const MODULES = [
  "src/core/brain/dream-plan.ts",
  "src/core/brain/intent-review.ts",
  "src/core/brain/dream-plan-topics.ts",
  "src/core/brain/signal-archive.ts",
  "src/core/brain/reconcile-outcomes.ts",
  "src/core/brain/dream-plan-retires.ts",
  "src/core/brain/dream-apply.ts",
  "src/core/brain/confidence.ts",
  "src/core/brain/dream-refresh.ts",
  "src/core/brain/salience-gate.ts",
  "src/core/brain/dream-plan-cross-topic.ts",
  "src/core/brain/dream-report.ts",
] as const;

function offenders(): string[] {
  const found: string[] = [];
  for (const path of MODULES) {
    const source = lexSource(readFileSync(join(REPO_ROOT, path), "utf8"));
    const code = source.code;
    const imports = source.withoutComments;
    if (/\bDate\s*\.\s*now\s*\(/.test(code)) found.push(`${path}: Date.now`);
    if (/\bnew\s+Date\s*\(\s*\)/.test(code)) found.push(`${path}: new Date()`);
    for (const match of imports.matchAll(/\bimport\s+([\s\S]*?)\s+from\s*["']([^"']+)["']\s*;?/g)) {
      const clause = match[1] ?? "";
      const modulePath = match[2] ?? "";
      if (/\b(?:logDayReader|readStoreLogEvents)\b/.test(clause)) {
        found.push(`${path}: evidence log reader import`);
      }
      if (modulePath.endsWith("/evidence-read.ts")) found.push(`${path}: evidence-read import`);
    }
  }
  return found;
}

describe("dream window context census", () => {
  test("pass rules do not read the clock or evidence log directly", () => {
    expect(offenders()).toEqual([]);
  });
});
