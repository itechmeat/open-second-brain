#!/usr/bin/env bun
/**
 * Run Hermes' own plugin install scanner over this repository, the way
 * `hermes plugins install itechmeat/open-second-brain` does, and fail unless
 * the documented install would pass without a question.
 *
 * Hermes scans the fresh clone before it installs or updates a plugin. Its
 * verdict comes from the worst finding: any `critical` is `dangerous` and is
 * blocked outright (`--force` does not override it, #188); any `high` is
 * `caution`, which "requires confirmation", so a non-interactive install and
 * every unattended update stop there; `medium` and `low` findings alone are
 * `safe` and install. The scanner reads every tracked file, docs and tests
 * included, so a threat-model sentence or a hardening comment can stop the
 * install as surely as real code. This gate runs the same scanner here, so the
 * pull request that adds such a line is the one that goes red.
 *
 * The scanner is fetched from NousResearch/hermes-agent (MIT) at a pinned
 * commit and checked against pinned SHA-256 digests before it runs. Since
 * hermes-agent 0.23 the code lives in `hermes_cli/plugins_install_scan.py`
 * (`tools/plugin_guard.py` is a shim that needs the whole Hermes runtime), so
 * the gate fetches that module and every module it imports: five stdlib-only
 * files. One function among them, `model_provider_key_names`, lazily imports
 * Hermes' provider registry (and with it Hermes' third-party dependencies) to
 * learn which environment variables hold model-provider keys; the gate pins
 * that list instead (PROVIDER_KEY_NAMES) and hands it to the scanner. To move
 * the pin: change HERMES_COMMIT, run with `--print-digests`, paste the new
 * digests, refresh PROVIDER_KEY_NAMES (in a hermes-agent checkout at the new
 * commit, with its dependencies: `python -c "from tools.skills_guard_credentials
 * import model_provider_key_names as k; print(sorted(k()))"`), and re-check the
 * verdicts. A rate-limited (HTTP 429) or server-error response is retried a
 * bounded number of times with backoff; the last status is reported by name
 * once the attempts run out.
 *
 * Scanned trees (the tracked files only, exported to a temp dir, as a clone
 * would have them):
 *   - `.`               the documented install (`plugin.yaml` at the root);
 *                       the gate fails unless its verdict is `safe`
 *   - `plugins/hermes`  the Python provider alone, the tree a subdirectory
 *                       install (`itechmeat/open-second-brain/plugins/hermes`)
 *                       would hold; reported, and the gate fails only on
 *                       `dangerous` (it is not a supported install: the
 *                       provider reads `templates/` and the `o2b` wrapper from
 *                       the repository root)
 *
 * Usage:
 *   bun run scripts/hermes-plugin-scan.ts             # exit 1 unless the documented install is safe
 *   bun run scripts/hermes-plugin-scan.ts --verbose   # also list medium findings outside tests
 *   bun run scripts/hermes-plugin-scan.ts --print-digests
 *
 * Env: PYTHON (default `python3`, 3.11 or newer); GITHUB_TOKEN / GH_TOKEN
 * (optional, lifts the anonymous GitHub API rate limit).
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

/** hermes-agent v0.23.4 (scanner `plugin-guard-v15`). */
const HERMES_REPO = "NousResearch/hermes-agent";
const HERMES_VERSION = "v0.23.4";
const HERMES_COMMIT = "8fc0374447313e276f6b9a2764bfc750190c966a";
const GUARD_FILES: Readonly<Record<string, string>> = {
  "hermes_cli/plugins_install_scan.py":
    "a9686544782ac6fbdab3450f88a02b3cbf8af9e6d4e0b1df094980c3ea8d3888",
  "hermes_cli/plugins_install_scan_context.py":
    "0fae3156da7e02dbe518edfbaa5c0f4ebaf75f9427f5f0d22c40a97989d79688",
  "tools/skills_guard.py": "de9729f85ebc7821054aba59482787b42bbeaf3903a8bfa34b8354c03e09d7ff",
  "tools/skills_guard_credentials.py":
    "59c9554ac517e0e9d99aa6bd1c79220308017dcf0dfe35adc7a74c98453dd180",
  "tools/threat_patterns.py": "2339e0c9d0427b157cb37272b68fc674184fc8267db199aced2cc6464c3bd4dd",
};

/**
 * `model_provider_key_names()` at HERMES_COMMIT: the environment variables
 * that hold a Hermes model-provider key. A secret read naming one of them is
 * raised to a `high` finding (`provider_key_env_read`).
 */
const PROVIDER_KEY_NAMES: readonly string[] = [
  "ACTUAL_API_KEY",
  "AI_GATEWAY_API_KEY",
  "ALIBABA_CODING_PLAN_API_KEY",
  "ALIBABA_CODING_PLAN_CN_API_KEY",
  "ALIBABA_TOKEN_PLAN_API_KEY",
  "ALIBABA_TOKEN_PLAN_CN_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_TOKEN",
  "ARCEEAI_API_KEY",
  "AZURE_FOUNDRY_API_KEY",
  "COMMANDCODE_API_KEY",
  "DASHSCOPE_API_KEY",
  "DEEPINFRA_API_KEY",
  "DEEPSEEK_API_KEY",
  "FIREWORKS_API_KEY",
  "GEMINI_API_KEY",
  "GLM_API_KEY",
  "GMI_API_KEY",
  "GOOGLE_API_KEY",
  "HERMES_ANON_API_SECRET",
  "HF_TOKEN",
  "KILOCODE_API_KEY",
  "KIMI_API_KEY",
  "KIMI_CN_API_KEY",
  "KIMI_CODING_API_KEY",
  "LM_API_KEY",
  "META_API_KEY",
  "META_MODEL_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "MODEL_API_KEY",
  "NEBIUS_API_KEY",
  "NEBIUS_TOKEN_FACTORY_API_KEY",
  "NOVITA_API_KEY",
  "NVIDIA_API_KEY",
  "OLLAMA_API_KEY",
  "OPENAI_API_KEY",
  "OPENCODE_GO_API_KEY",
  "OPENCODE_ZEN_API_KEY",
  "OPENROUTER_API_KEY",
  "RAMP_ROUTER_API_KEY",
  "ROUTER_API_KEY",
  "STEPFUN_API_KEY",
  "TOKENHUB_API_KEY",
  "TOKENPLAN_API_KEY",
  "UPSTAGE_API_KEY",
  "XAI_API_KEY",
  "XIAOMI_API_KEY",
  "ZAI_API_KEY",
  "Z_AI_API_KEY",
];

export interface ScanTarget {
  /** Path inside the exported tree. */
  path: string;
  /** What the tree stands for, in the report. */
  label: string;
  /** The documented install: anything but `safe` fails the gate. */
  documented: boolean;
}

const TARGETS: readonly ScanTarget[] = [
  {
    path: ".",
    label: "documented install: hermes plugins install itechmeat/open-second-brain",
    documented: true,
  },
  {
    path: "plugins/hermes",
    label: "subdirectory plugins/hermes (not a supported install)",
    documented: false,
  },
];

const argv = new Set(process.argv.slice(2));
const verbose = argv.has("--verbose");
const printDigests = argv.has("--print-digests");

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Attempts per scanner file before a rate limit or server error is final. */
export const GUARD_FETCH_ATTEMPTS = 5;
/** Wait before the first retry; each later retry doubles it. */
export const GUARD_FETCH_BASE_DELAY_MS = 2000;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR_MIN = 500;
const MS_PER_SECOND = 1000;

/** The network and clock a fetch uses; tests pass stubs. */
export interface GuardFetchDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: GuardFetchDeps = {
  fetch: (url, init) => fetch(url, init),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
};

/** A shared runner can hit the API rate limit or a transient server error. */
function isRetryable(status: number): boolean {
  return status === HTTP_TOO_MANY_REQUESTS || status >= HTTP_SERVER_ERROR_MIN;
}

/** The wait the server asked for (`Retry-After` in seconds), else exponential backoff. */
function retryDelayMs(res: Response, retry: number): number {
  const seconds = Number(res.headers.get("Retry-After"));
  if (Number.isFinite(seconds) && seconds > 0) return seconds * MS_PER_SECOND;
  return GUARD_FETCH_BASE_DELAY_MS * 2 ** retry;
}

export async function fetchGuardFile(
  path: string,
  deps: GuardFetchDeps = defaultDeps,
): Promise<Uint8Array> {
  const url = `https://api.github.com/repos/${HERMES_REPO}/contents/${path}?ref=${HERMES_COMMIT}`;
  const token = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.raw",
    "User-Agent": "open-second-brain-hermes-plugin-scan",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  // Retries are sequential by design: each waits on the previous response.
  for (let attempt = 1; ; attempt++) {
    // oxlint-disable-next-line no-await-in-loop
    const res = await deps.fetch(url, { headers });
    // oxlint-disable-next-line no-await-in-loop
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
    if (!isRetryable(res.status) || attempt === GUARD_FETCH_ATTEMPTS) {
      const tries = `${attempt} attempt${attempt === 1 ? "" : "s"}`;
      throw new Error(`fetch ${path}@${HERMES_COMMIT}: HTTP ${res.status} after ${tries}`);
    }
    // oxlint-disable-next-line no-await-in-loop
    await deps.sleep(retryDelayMs(res, attempt - 1));
  }
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
  const ls = spawnSync("git", ["ls-files", "-z", "--cached"], {
    cwd: ROOT,
    encoding: "utf8",
  });
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

// The scanner's modules sit in namespace packages (no `__init__.py`), so
// nothing of Hermes runs but the scanner. The provider-key lookup is the one
// function that would import Hermes' runtime; it gets the pinned list.
const DRIVER = `
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import tools.skills_guard_credentials as credentials
_keys = frozenset(json.loads(sys.argv[2]))
credentials.model_provider_key_names = lambda: _keys
from hermes_cli.plugins_install_scan import scan_plugin, PLUGIN_SCANNER_VERSION
out = []
for target in sys.argv[3:]:
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

const SEVERITIES = ["critical", "high", "medium", "low"] as const;
const SEVERITY_RANK: Readonly<Record<string, number>> = { critical: 3, high: 2, medium: 1, low: 0 };

/** A path the scanner steps findings down for (`plugins_install_scan_context.is_test_tree`). */
function inTestTree(file: string): boolean {
  return file.startsWith("tests/") || file.startsWith("test/");
}

/** The report of one target: verdict line, counts by severity and by pattern, decisive findings. */
export function formatScanReport(
  target: ScanTarget,
  report: Pick<ScanReport, "verdict" | "findings">,
  options: { verbose: boolean },
): string {
  const bySeverity = new Map<string, number>(SEVERITIES.map((s) => [s, 0]));
  const byPattern = new Map<string, number>();
  for (const f of report.findings) {
    bySeverity.set(f.severity, (bySeverity.get(f.severity) ?? 0) + 1);
    const key = `${f.severity} ${f.pattern}`;
    byPattern.set(key, (byPattern.get(key) ?? 0) + 1);
  }
  const lines: string[] = [];
  const counts = SEVERITIES.map((s) => `${s} ${bySeverity.get(s) ?? 0}`).join(", ");
  lines.push(
    `${target.path} (${target.label}): ${report.verdict} - ` +
      `${report.findings.length} findings: ${counts}`,
  );
  const patterns = [...byPattern.entries()].toSorted(([a, na], [b, nb]) => {
    const rank =
      (SEVERITY_RANK[b.split(" ")[0] ?? ""] ?? 0) - (SEVERITY_RANK[a.split(" ")[0] ?? ""] ?? 0);
    return rank !== 0 ? rank : nb - na;
  });
  for (const [key, n] of patterns) {
    const [severity, pattern] = key.split(" ");
    lines.push(`    ${String(n).padStart(6)}  ${(severity ?? "").padEnd(8)} ${pattern ?? ""}`);
  }
  // `high` and `critical` decide the verdict, so every one is listed; with
  // --verbose, so is every `medium` outside the test trees.
  const shown = report.findings.filter(
    (f) =>
      (SEVERITY_RANK[f.severity] ?? 0) >= SEVERITY_RANK["high"]! ||
      (options.verbose && f.severity === "medium" && !inTestTree(f.file)),
  );
  for (const f of shown) {
    lines.push(`  [${f.severity}] ${f.pattern} ${f.file}:${f.line}  ${f.match}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Why the reports fail the gate, or an empty list when they pass. */
export function gateFailures(
  results: ReadonlyArray<{ target: ScanTarget; verdict: string }>,
): string[] {
  const failures: string[] = [];
  for (const { target, verdict } of results) {
    if (verdict === "dangerous") {
      failures.push(
        `${target.path}: dangerous - Hermes BLOCKS this install and --force does not override it`,
      );
    } else if (target.documented && verdict !== "safe") {
      failures.push(
        `${target.path}: ${verdict} - Hermes asks for confirmation, so a non-interactive install ` +
          "and every unattended update of the documented install stop",
      );
    }
  }
  return failures;
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
    const run = spawnSync(
      python,
      [
        "-I",
        "-c",
        DRIVER,
        guard,
        JSON.stringify(PROVIDER_KEY_NAMES),
        ...TARGETS.map((t) => join(tree, t.path)),
      ],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    );
    if (run.status !== 0) {
      process.stderr.write(run.stderr);
      throw new Error(`${python} exited ${String(run.status)}`);
    }
    const reports = JSON.parse(run.stdout) as ScanReport[];
    const scanner = reports[0]?.scanner ?? "unknown scanner";
    process.stdout.write(
      `hermes plugin scan (${scanner}, hermes-agent ${HERMES_VERSION} @${HERMES_COMMIT.slice(0, 12)})\n`,
    );
    const results = TARGETS.map((target, i) => {
      const report = reports[i];
      if (report === undefined) throw new Error(`no scan report for ${target.path}`);
      process.stdout.write(formatScanReport(target, report, { verbose }));
      return { target, verdict: report.verdict };
    });
    const failures = gateFailures(results);
    for (const failure of failures) process.stdout.write(`FAIL ${failure}\n`);
    if (failures.length > 0) {
      process.stdout.write(
        "Reword the high and critical lines listed above (docs and tests count too; " +
          "JS/TS JSDoc lines are not treated as comments).\n",
      );
    }
    return failures.length > 0 ? 1 : 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  process.exit(await main());
}
