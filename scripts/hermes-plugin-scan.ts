#!/usr/bin/env bun
/**
 * Run Hermes' own plugin install scanner (`tools/plugin_guard.py`) over this
 * repository, the way `hermes plugins install itechmeat/open-second-brain`
 * does, and fail when it would block the install.
 *
 * Hermes scans the fresh clone before it installs anything and refuses a
 * `dangerous` verdict (any critical finding) outright - `--force` does not
 * override it (#188). The scanner reads every tracked file, docs and tests
 * included, so a threat-model sentence or a hardening comment can block the
 * install as surely as real code. This gate runs the same scanner here, so
 * the pull request that adds such a line is the one that goes red.
 *
 * The scanner is fetched from NousResearch/hermes-agent (MIT) at a pinned
 * commit and checked against pinned SHA-256 digests before it runs. It is
 * three stdlib-only Python modules; nothing else from Hermes is needed. To
 * move the pin: change HERMES_COMMIT, run with `--print-digests`, paste the
 * new digests, and re-check the verdict.
 *
 * Scanned trees (the tracked files only, exported to a temp dir, as a clone
 * would have them):
 *   - `.`               the documented install (`plugin.yaml` at the root)
 *   - `plugins/hermes`  a subdirectory install of the Python provider
 *
 * Usage:
 *   bun run scripts/hermes-plugin-scan.ts             # exit 1 on "dangerous"
 *   bun run scripts/hermes-plugin-scan.ts --verbose   # also list high findings
 *   bun run scripts/hermes-plugin-scan.ts --print-digests
 *
 * Env: PYTHON (default `python3`); GITHUB_TOKEN / GH_TOKEN (optional, lifts
 * the anonymous GitHub API rate limit).
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** hermes-agent v2026.9.24 (package 0.21.5, scanner `plugin-guard-v8`). */
const HERMES_REPO = "NousResearch/hermes-agent";
const HERMES_COMMIT = "f97608f178d1ffeca59860195ab7da295f7c8e5f";
const GUARD_FILES: Readonly<Record<string, string>> = {
  "tools/plugin_guard.py": "6fbece00d5e4f98a05231f958172539cf72cc2869745f1d39c4cd5f427b99573",
  "tools/plugin_guard_context.py":
    "0fd6c698926590b6d4464652b8857c4955795697af6d088452cc79f923eab7d8",
  "tools/skills_guard.py": "ad9d3616c67fa2f0707dd8c6007d652a0cb44ad6ae51eb5d888ed57be2230bd1",
};

const TARGETS: readonly string[] = [".", "plugins/hermes"];

const argv = new Set(process.argv.slice(2));
const verbose = argv.has("--verbose");
const printDigests = argv.has("--print-digests");

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function fetchGuardFile(path: string): Promise<Uint8Array> {
  const url = `https://api.github.com/repos/${HERMES_REPO}/contents/${path}?ref=${HERMES_COMMIT}`;
  const token = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.raw",
    "User-Agent": "open-second-brain-hermes-plugin-scan",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`fetch ${path}@${HERMES_COMMIT}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Write the scanner modules at the pinned commit, digest-checked, under `dir`. */
async function writeGuard(dir: string): Promise<void> {
  const files = await Promise.all(
    Object.entries(GUARD_FILES).map(async ([path, digest]) => ({
      path,
      digest,
      data: await fetchGuardFile(path),
    })),
  );
  for (const { path, digest, data } of files) {
    const actual = sha256(data);
    if (printDigests) {
      process.stdout.write(`${path} ${actual}\n`);
      continue;
    }
    if (actual !== digest) {
      throw new Error(`${path}@${HERMES_COMMIT}: sha256 ${actual}, expected ${digest}`);
    }
    const dest = join(dir, path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, data);
  }
}

/** Copy the tracked files (working-tree content) under `out`: what a clone holds. */
function exportTrackedTree(out: string): string {
  const ls = spawnSync("git", ["ls-files", "-z", "--cached"], { cwd: ROOT, encoding: "utf8" });
  if (ls.status !== 0) throw new Error(`git ls-files failed: ${ls.stderr}`);
  const tree = join(out, "open-second-brain");
  for (const rel of ls.stdout.split("\0")) {
    if (rel === "") continue;
    const src = join(ROOT, rel);
    if (!existsSync(src) && !isSymlink(src)) continue; // deleted in the working tree
    const dest = join(tree, rel);
    mkdirSync(dirname(dest), { recursive: true });
    if (isSymlink(src)) symlinkSync(readlinkSync(src), dest);
    else copyFileSync(src, dest);
  }
  return tree;
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

const DRIVER = `
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from tools.plugin_guard import scan_plugin, PLUGIN_SCANNER_VERSION
out = []
for target in sys.argv[2:]:
    r = scan_plugin(Path(target))
    out.append({"target": target, "verdict": r.verdict, "scanner": PLUGIN_SCANNER_VERSION,
                "findings": [{"severity": f.severity, "pattern": f.pattern_id, "file": f.file,
                              "line": f.line, "match": f.match} for f in r.findings]})
print(json.dumps(out))
`;

interface ScanFinding {
  severity: string;
  pattern: string;
  file: string;
  line: number;
  match: string;
}
interface ScanReport {
  target: string;
  verdict: string;
  scanner: string;
  findings: ScanFinding[];
}

async function main(): Promise<number> {
  // One scratch dir for the scanner and the exported tree, removed below:
  // the run leaves nothing on the machine.
  const scratch = mkdtempSync(join(tmpdir(), "osb-hermes-scan-"));
  try {
    const guard = join(scratch, "guard");
    await writeGuard(guard);
    if (printDigests) return 0;
    const tree = exportTrackedTree(scratch);
    const python = process.env["PYTHON"] ?? "python3";
    const run = spawnSync(python, ["-c", DRIVER, guard, ...TARGETS.map((t) => join(tree, t))], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    if (run.status !== 0) {
      process.stderr.write(run.stderr);
      throw new Error(`${python} exited ${String(run.status)}`);
    }
    const reports = JSON.parse(run.stdout) as ScanReport[];
    let blocked = false;
    for (const [i, report] of reports.entries()) {
      const counts = { critical: 0, high: 0, medium: 0, low: 0 } as Record<string, number>;
      for (const f of report.findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
      process.stdout.write(
        `hermes plugin scan (${report.scanner}, hermes-agent@${HERMES_COMMIT.slice(0, 12)}) ` +
          `${TARGETS[i] ?? report.target}: ${report.verdict} - ` +
          `critical ${counts["critical"]}, high ${counts["high"]}, ` +
          `medium ${counts["medium"]}, low ${counts["low"]}\n`,
      );
      const shown = report.findings.filter(
        (f) => f.severity === "critical" || (verbose && f.severity === "high"),
      );
      for (const f of shown) {
        process.stdout.write(`  [${f.severity}] ${f.pattern} ${f.file}:${f.line}  ${f.match}\n`);
      }
      if (report.verdict === "dangerous") blocked = true;
    }
    if (blocked) {
      process.stdout.write(
        "Hermes would BLOCK the install (a dangerous verdict cannot be forced). " +
          "Reword the critical lines above; JS/TS JSDoc lines are not treated as comments.\n",
      );
    }
    return blocked ? 1 : 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

process.exit(await main());
