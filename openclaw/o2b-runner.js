/**
 * Subprocess helper for calling the Open Second Brain Python CLI from
 * the OpenClaw JS plugin entry.
 *
 * Spawns `python3 -m open_second_brain.cli` with PYTHONPATH pointed at the
 * plugin's `src/` directory so the package is importable even when `o2b`
 * is not on PATH (e.g. after a `git:` or `npm-pack:` install).
 */

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");
const PYTHON_SRC = path.join(PLUGIN_ROOT, "src");

/**
 * Run a Python CLI command and return stdout.
 *
 * @param {string[]} args - Arguments forwarded to `python3 -m open_second_brain.cli`.
 * @param {number} [timeout=30000] - Maximum execution time in milliseconds.
 * @returns {Promise<string>} Trimmed stdout from the subprocess.
 */
export function runPython(args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PYTHONPATH: PYTHON_SRC };
    execFile(
      "python3",
      ["-m", "open_second_brain.cli", ...args],
      { env, timeout, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}
