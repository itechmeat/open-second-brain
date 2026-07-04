#!/usr/bin/env bun
/**
 * Hardcoded home / absolute path hygiene report.
 *
 * Scans OSB's shipped source, docs, generated examples, and plugin
 * config templates for concrete home paths (`/home/<user>`,
 * `/Users/<user>`, `X:\Users\<user>`) that would leak a private host
 * layout or hand a reader a copy-paste command that only works on the
 * author's machine. Placeholder segments (`user`, `you`, single-letter
 * stand-ins, …) pass; a line carrying `hygiene:allow-path` is skipped.
 *
 * Report-only by default: prints findings and always exits 0, so it can
 * ride in CI as an informational step without gating a merge. The
 * `hardcoded-paths.test.ts` suite is the enforcing gate.
 *
 * Usage:
 *   bun run scripts/check-hardcoded-paths.ts           # report, exit 0
 *   bun run scripts/check-hardcoded-paths.ts --strict  # exit 1 on findings
 *   bun run scripts/check-hardcoded-paths.ts --json    # machine-readable
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { formatFinding } from "../src/core/hygiene/hardcoded-paths.ts";
import { scanRepo } from "../src/core/hygiene/scan-repo.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const strict = argv.includes("--strict");
const json = argv.includes("--json");

const findings = scanRepo(ROOT);

if (json) {
  process.stdout.write(JSON.stringify({ findings }, null, 2) + "\n");
} else if (findings.length === 0) {
  process.stdout.write(
    "check-hardcoded-paths: clean — no hardcoded home paths in shipped surfaces\n",
  );
} else {
  for (const f of findings) process.stdout.write(`[hardcoded-path] ${formatFinding(f)}\n`);
  process.stdout.write(
    `check-hardcoded-paths: ${findings.length} finding(s). ` +
      "Use a placeholder (e.g. ~/vault, $HOME, /home/user) or annotate an " +
      "intentional path with a 'hygiene:allow-path' comment on the same line.\n",
  );
}

process.exit(strict && findings.length > 0 ? 1 : 0);
