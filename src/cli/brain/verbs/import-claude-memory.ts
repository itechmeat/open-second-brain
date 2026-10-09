import { defaultConfigPath } from "../../../core/config.ts";
import { importClaudeMemory, ConflictsError } from "../../../core/brain/import-claude-memory.ts";
import {
  getMemoryBackend,
  resolveMemoryBackend,
} from "../../../core/brain/agent-backend/registry.ts";
import { resolveBrainVault } from "../helpers.ts";

export async function cmdBrainImportClaudeMemory(argv: string[]): Promise<number> {
  const config = defaultConfigPath();

  let memory: string | null = null;
  let mode: "dry-run" | "apply" = "dry-run";
  let modeSet = false;
  let allowArbitrary = false;
  let yes = false;
  let asJson = false;
  let vaultFlag: string | undefined;
  let backendId: string | undefined;
  let approvalDigest: string | undefined;

  const consumeValue = (flag: string, next: string | undefined): string | null => {
    if (next === undefined || next.startsWith("--")) {
      process.stderr.write(`o2b brain import-claude-memory: ${flag} requires a value\n`);
      return null;
    }
    return next;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--vault") {
      const v = consumeValue("--vault", argv[++i]);
      if (v === null) return 2;
      vaultFlag = v;
      continue;
    }
    if (a === "--memory") {
      const v = consumeValue("--memory", argv[++i]);
      if (v === null) return 2;
      memory = v;
      continue;
    }
    if (a === "--from" || a === "--backend") {
      const v = consumeValue(a, argv[++i]);
      if (v === null) return 2;
      backendId = v;
      continue;
    }
    if (a === "--dry-run") {
      if (modeSet && mode !== "dry-run") {
        process.stderr.write(
          "o2b brain import-claude-memory: --apply and --dry-run are mutually exclusive\n",
        );
        return 2;
      }
      mode = "dry-run";
      modeSet = true;
      continue;
    }
    if (a === "--apply") {
      if (modeSet && mode !== "apply") {
        process.stderr.write(
          "o2b brain import-claude-memory: --apply and --dry-run are mutually exclusive\n",
        );
        return 2;
      }
      mode = "apply";
      modeSet = true;
      continue;
    }
    if (a === "--yes") {
      yes = true;
      continue;
    }
    if (a === "--approval-digest") {
      const v = consumeValue("--approval-digest", argv[++i]);
      if (v === null) return 2;
      approvalDigest = v;
      continue;
    }
    if (a === "--json") {
      asJson = true;
      continue;
    }
    if (a === "--allow-arbitrary-memory-path") {
      allowArbitrary = true;
      continue;
    }
    process.stderr.write(`o2b brain import-claude-memory: unknown flag ${a}\n`);
    return 2;
  }

  // A dry run COMPUTES a digest; it cannot consume one. A digest paired with
  // a dry run (the default mode included) is an operator mistake whose exit
  // code would otherwise suggest the value was honored when it was silently
  // dropped - refuse the pairing by name instead.
  if (mode !== "apply" && approvalDigest !== undefined) {
    process.stderr.write(
      "o2b brain import-claude-memory: --approval-digest applies to --apply; " +
        "a dry run computes a digest, it does not consume one\n",
    );
    return 2;
  }

  if (mode === "apply" && !yes && !process.stdin.isTTY) {
    process.stderr.write(
      "o2b brain import-claude-memory: --apply requires --yes in non-interactive mode\n",
    );
    return 2;
  }

  // t_18fda844: a script that applies must apply the plan it approved.
  // The digest comes from a prior `--dry-run`; an interactive operator
  // keeps the human escape hatch, exactly as with `--yes`.
  if (mode === "apply" && approvalDigest === undefined && !process.stdin.isTTY) {
    process.stderr.write(
      "o2b brain import-claude-memory: --apply requires --approval-digest in non-interactive " +
        "mode (run --dry-run first, then apply with the digest it prints)\n",
    );
    return 2;
  }

  const vault = resolveBrainVault(vaultFlag, config);

  try {
    // t_53f9f67f/t_ac9d2588: the memory-format backend is `--from`-selected,
    // else config-selected (`memory_backend`, default claude). Unknown ids fail
    // loudly with the registered list, before any filesystem work. mem0/generic
    // have no default location, so their `discoverMemoryDir` throws unless
    // `--memory` was given - caught here, not crashed.
    const backend =
      backendId !== undefined ? getMemoryBackend(backendId) : resolveMemoryBackend(config);
    const memDir = memory ?? backend.discoverMemoryDir(vault);
    const res = importClaudeMemory({
      vault,
      memoryDir: memDir,
      mode,
      allowArbitraryMemoryPath: allowArbitrary,
      approvalDigest,
      backend,
    });
    if (asJson) {
      process.stdout.write(JSON.stringify(res, null, 2) + "\n");
      return 0;
    }
    if (mode === "dry-run") {
      process.stdout.write(`plan: ${res.plans.length} actionable, ${res.skipped.length} skipped\n`);
      process.stdout.write(`approval-digest: ${res.digest}\n`);
      for (const p of res.plans)
        process.stdout.write(`  ${p.action} ${p.prefId} (${p.basename})\n`);
      for (const s of res.skipped) process.stdout.write(`  SKIP  ${s.basename}: ${s.reason}\n`);
      if (res.conflicts.length > 0) process.stdout.write(`conflicts: ${res.conflicts.length}\n`);
    } else {
      process.stdout.write(
        `applied: ${res.applied.length}; unchanged: ${res.skippedUnchanged.length}; skipped: ${res.skipped.length}\n`,
      );
      if (res.snapshotRunId) process.stdout.write(`snapshot: ${res.snapshotRunId}\n`);
    }
    return 0;
  } catch (err) {
    if (err instanceof ConflictsError) {
      process.stderr.write("conflicts:\n");
      for (const c of err.conflicts)
        process.stderr.write(
          `  ${c.prefId} already exists in Brain but is not in Brain/.imports/claude-memory.json\n`,
        );
      return 2;
    }
    process.stderr.write(`o2b brain import-claude-memory: ${(err as Error).message}\n`);
    return 1;
  }
}
