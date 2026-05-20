#!/usr/bin/env -S bun
import { resolveVault } from "../src/core/config.ts";
import { runDisciplineReport } from "../src/core/discipline/report.ts";
import { renderDigest } from "../src/core/brain/digest.ts";
import { parseWindow } from "../src/cli/brain/verbs/digest.ts";

function parseArgs(): { vault: string; window: string | null } {
  const argv = process.argv.slice(2);
  let vault: string | undefined;
  let window: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--vault" && argv[i + 1]) {
      vault = argv[++i]!;
    } else if (argv[i] === "--window" && argv[i + 1]) {
      window = argv[++i]!;
    }
  }
  const v = vault ?? resolveVault();
  if (!v) {
    process.stderr.write(
      "o2b-discipline-report: no vault configured; set VAULT_DIR env or pass --vault <path>\n",
    );
    process.exit(2);
  }
  return { vault: v, window };
}

const { vault, window } = parseArgs();

if (window) {
  let days: number;
  try {
    days = parseWindow(window);
  } catch (e) {
    process.stderr.write(`o2b-discipline-report: invalid --window: ${window}\n`);
    process.exit(2);
  }
  const now = new Date();
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const result = renderDigest(vault, { since, until: now, format: "markdown" });
  process.stdout.write(result.content);
  if (!result.content.endsWith("\n")) process.stdout.write("\n");
} else {
  const res = runDisciplineReport({ vault });
  if (res.status === "disabled") {
    process.stderr.write("o2b-discipline-report: discipline_report disabled in Brain/_brain.yaml\n");
    process.exit(0);
  }
  process.stdout.write(res.text + "\n");
}
