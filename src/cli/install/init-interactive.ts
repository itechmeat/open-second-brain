/**
 * `o2b init --interactive` first-time-setup wizard.
 *
 * Composes the existing `o2b init`, `o2b brain init`, and per-target
 * `o2b install --target X --apply` commands behind a linear question-
 * answer flow. Input comes from stdin (or an injected reader for
 * tests); commands are dispatched via the same `main()` entry as a
 * real CLI invocation.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { validateTimezoneName } from "../../core/config.ts";
import { defaultRegistry } from "../../core/install/registry.ts";
import "../../core/install/adapters/aider.ts";
import "../../core/install/adapters/copilot-cli.ts";
import "../../core/install/adapters/cursor.ts";
import "../../core/install/adapters/gemini-cli.ts";
import "../../core/install/adapters/generic.ts";
import "../../core/install/adapters/grok.ts";
import "../../core/install/adapters/kiro.ts";
import "../../core/install/adapters/opencode.ts";
import "../../core/install/adapters/pi.ts";

export interface WizardReader {
  read(): Promise<string | null>;
}

export interface WizardRunner {
  (cmd: ReadonlyArray<string>): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface WizardOpts {
  reader: WizardReader;
  stdout: NodeJS.WriteStream | NodeJS.WritableStream;
  stderr: NodeJS.WriteStream | NodeJS.WritableStream;
  runner: WizardRunner;
}

export interface WizardResult {
  readonly exitCode: number;
  readonly actions: ReadonlyArray<ReadonlyArray<string>>;
}

// ---------- Defaults ----------

function defaultVaultCandidates(): string[] {
  const home = homedir();
  const cands: string[] = [];
  const dirs = [
    home,
    join(home, "Documents"),
    join(home, "Sync"),
    join(home, "Dropbox"),
    join(home, "Library", "Mobile Documents", "iCloud~md~obsidian", "Documents"),
    "/root/vault",
  ];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    try {
      if (existsSync(join(d, ".obsidian"))) cands.push(d);
      // also probe immediate children — many users keep multiple vaults
      if (statSync(d).isDirectory()) {
        for (const child of readdirSync(d)) {
          const full = join(d, child);
          if (existsSync(join(full, ".obsidian"))) cands.push(full);
        }
      }
    } catch {
      // ignore
    }
  }
  return Array.from(new Set(cands));
}

function hostName(): string {
  try {
    return process.env["HOSTNAME"] ?? "agent";
  } catch {
    return "agent";
  }
}

function tryNormaliseTz(input: string): string | null {
  if (!input || input.trim().length === 0) return null;
  const trimmed = input.trim();
  return validateTimezoneName(trimmed).ok ? trimmed : null;
}

// ---------- Default reader & runner ----------

export function makeStdinReader(stdin: NodeJS.ReadStream = process.stdin): WizardReader {
  // Naive line-buffered reader; sufficient for the wizard's terse Q/A.
  let buffer = "";
  let resolveNext: ((s: string | null) => void) | null = null;
  let ended = false;
  stdin.setEncoding?.("utf8");
  stdin.on?.("data", (chunk: string | Buffer) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString();
    while (resolveNext && buffer.includes("\n")) {
      const idx = buffer.indexOf("\n");
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      const r = resolveNext;
      resolveNext = null;
      r(line);
    }
  });
  stdin.on?.("end", () => {
    ended = true;
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r(buffer.length > 0 ? buffer : null);
    }
  });
  return {
    read(): Promise<string | null> {
      return new Promise((resolve) => {
        if (buffer.includes("\n")) {
          const idx = buffer.indexOf("\n");
          const line = buffer.slice(0, idx).replace(/\r$/, "");
          buffer = buffer.slice(idx + 1);
          resolve(line);
          return;
        }
        if (ended) {
          resolve(buffer.length > 0 ? buffer : null);
          buffer = "";
          return;
        }
        resolveNext = resolve;
      });
    },
  };
}

export function defaultRunner(): WizardRunner {
  return async (cmd) => {
    // Call back into `main()` to avoid spawning a subprocess.
    // Lazy-import to break the cycle between main.ts and this module.
    const { main } = await import("../main.ts");
    const exitCode = await main(cmd);
    return { exitCode, stdout: "", stderr: "" };
  };
}

// ---------- Wizard ----------

async function ask(opts: WizardOpts, label: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue !== undefined && defaultValue !== "" ? ` [${defaultValue}]: ` : ": ";
  opts.stdout.write(`${label}${suffix}`);
  const line = await opts.reader.read();
  if (line === null || line.trim().length === 0) {
    return defaultValue ?? "";
  }
  return line.trim();
}

export async function runWizard(opts: WizardOpts): Promise<WizardResult> {
  const actions: ReadonlyArray<string>[] = [];

  opts.stdout.write("\nOpen Second Brain — interactive setup\n");
  opts.stdout.write("=".repeat(40) + "\n\n");

  // 1. Vault path
  const cands = defaultVaultCandidates();
  if (cands.length > 0) {
    opts.stdout.write("Detected vault candidates:\n");
    for (const [i, c] of cands.entries()) {
      opts.stdout.write(`  ${i + 1}. ${c}\n`);
    }
    opts.stdout.write("  N. other path\n\n");
  }
  let vault = "";
  while (!vault) {
    const ans = await ask(opts, "Vault path (number or path)", cands[0]);
    if (/^\d+$/.test(ans)) {
      const idx = parseInt(ans, 10) - 1;
      if (idx >= 0 && idx < cands.length) vault = cands[idx]!;
    } else if (ans.length > 0) {
      vault = ans;
    }
    if (!vault) opts.stdout.write("  (enter a number or a path)\n");
  }

  // 2. Agent name
  const defaultAgent = `${hostName()}-agent`;
  const agentName = await ask(opts, "Agent name", defaultAgent);

  // 3. Timezone
  let tz: string | null = null;
  while (tz === null) {
    const ans = await ask(opts, "Timezone (IANA)", "UTC");
    tz = tryNormaliseTz(ans);
    if (tz === null) opts.stdout.write("  (invalid IANA name; try again, e.g. Europe/Belgrade)\n");
  }

  // 4. Language (optional)
  const lang = await ask(opts, "Language (ISO 639-1, optional)", "en");

  // 5. Runtimes
  const env = {
    vault,
    home: homedir(),
    cwd: process.cwd(),
    env: {
      ...process.env,
      VAULT_AGENT_NAME: agentName,
      VAULT_TIMEZONE: tz,
    } as Record<string, string>,
    now: new Date(),
  };
  const detected = defaultRegistry.detectAll(env);
  opts.stdout.write("\nKnown runtimes:\n");
  for (const [i, d] of detected.entries()) {
    opts.stdout.write(`  ${i + 1}. ${d.target.padEnd(14)} ${d.status}\n`);
  }
  opts.stdout.write("\n");
  const sel = await ask(
    opts,
    "Install for which runtimes? (comma-separated numbers, or 'none')",
    "none",
  );
  const selected: string[] = [];
  if (sel.toLowerCase() !== "none" && sel.length > 0) {
    for (const tok of sel
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)) {
      const idx = parseInt(tok, 10) - 1;
      if (idx >= 0 && idx < detected.length) selected.push(detected[idx]!.target);
    }
  }

  // 6. Brain init?
  const brainInit = (await ask(opts, "Scaffold Brain layer with `o2b brain init`?", "y"))
    .toLowerCase()
    .startsWith("y");
  const starter = brainInit
    ? (await ask(opts, "Include starter preferences (--starter)?", "n"))
        .toLowerCase()
        .startsWith("y")
    : false;

  // 7. Plan + confirm
  const initCmd = ["init", "--vault", vault, "--agent-name", agentName, "--timezone", tz];
  // language and name persisted via o2b init's --name? language isn't a real flag yet — record only.
  actions.push(initCmd);
  if (brainInit) {
    const cmd = ["brain", "init", "--vault", vault];
    if (starter) cmd.push("--starter");
    actions.push(cmd);
  }
  for (const t of selected) {
    actions.push(["install", "--target", t, "--apply"]);
  }
  actions.push(["install", "--check"]);

  opts.stdout.write("\nPlanned commands:\n");
  for (const c of actions) opts.stdout.write(`  o2b ${c.join(" ")}\n`);
  if (lang && lang !== "en") {
    opts.stdout.write(
      `  (language preference \`${lang}\` is not yet persisted; record it ` +
        `manually with \`o2b brain feedback --principle "respond in ${lang}" ` +
        `--signal positive --topic user-language --force-confirmed\` after init)\n`,
    );
  }
  opts.stdout.write("\n");
  const confirm = (await ask(opts, "Run these commands now? (yes/no)", "no")).toLowerCase();
  if (confirm !== "yes" && confirm !== "y") {
    opts.stdout.write("Aborted. No changes made.\n");
    return { exitCode: 0, actions: [] };
  }

  // 8. Execute
  for (const c of actions) {
    opts.stdout.write(`\n$ o2b ${c.join(" ")}\n`);
    const r = await opts.runner(c);
    if (r.exitCode !== 0) {
      opts.stderr.write(`error: command exited with code ${r.exitCode}\n`);
      return { exitCode: r.exitCode, actions };
    }
  }
  return { exitCode: 0, actions };
}

// ---------- CLI entry ----------

export async function cmdInitInteractive(_argv: string[]): Promise<number> {
  const opts: WizardOpts = {
    reader: makeStdinReader(process.stdin),
    stdout: process.stdout,
    stderr: process.stderr,
    runner: defaultRunner(),
  };
  const r = await runWizard(opts);
  return r.exitCode;
}
