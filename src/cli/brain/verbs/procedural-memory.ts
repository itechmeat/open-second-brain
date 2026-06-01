import { defaultConfigPath } from "../../../core/config.ts";
import {
  listProceduralMemory,
  markProceduralMemoryUsed,
  reconcileProceduralMemory,
} from "../../../core/brain/procedural-memory.ts";
import { CliError, parse, resolveBrainVault } from "../helpers.ts";
import { join } from "node:path";

export async function cmdBrainProceduralMemory(
  argv: string[],
): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "reconcile") return reconcile(rest);
  if (sub === "list") return list(rest);
  if (sub === "mark-used") return markUsed(rest);
  throw new CliError(
    "brain procedural-memory: expected reconcile, list, or mark-used",
  );
}

function reconcile(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    root: { type: "string-array" },
  });
  const vault = resolveBrainVault(
    flags["vault"] as string | undefined,
    defaultConfigPath(),
  );
  const roots = normalizeRoots(vault, flags["root"]);
  const result = reconcileProceduralMemory(vault, { roots });

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(
    `procedural-memory reconcile: total=${result.total} added=${result.added} updated=${result.updated} removed=${result.removed}\n`,
  );
  return 0;
}

function list(argv: string[]): number {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const vault = resolveBrainVault(
    flags["vault"] as string | undefined,
    defaultConfigPath(),
  );
  const entries = listProceduralMemory(vault);

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify({ total: entries.length, entries }, null, 2) + "\n",
    );
    return 0;
  }

  process.stdout.write(`${entries.length} procedural memory entr(y/ies):\n`);
  for (const item of entries) {
    process.stdout.write(
      `  ${item.id}  ${item.kind}  used=${item.usedCount}  ${item.sourcePath}  triggers=${item.triggers.join(",") || "-"}\n`,
    );
  }
  return 0;
}

function markUsed(argv: string[]): number {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const id = trim(positional[0]);
  if (!id)
    throw new CliError(
      "brain procedural-memory mark-used: entry id is required",
    );
  const vault = resolveBrainVault(
    flags["vault"] as string | undefined,
    defaultConfigPath(),
  );
  const updated = markProceduralMemoryUsed(vault, id);
  if (!updated)
    throw new CliError(
      `brain procedural-memory mark-used: unknown entry: ${id}`,
    );

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(updated, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(
    `marked used: ${updated.id} count=${updated.usedCount}\n`,
  );
  return 0;
}

function normalizeRoots(
  vault: string,
  raw: string | boolean | string[] | undefined,
): string[] {
  if (Array.isArray(raw)) {
    const roots = raw
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (roots.length > 0) return roots;
  }
  return [
    join(vault, "Brain", "procedures"),
    join(vault, "skills"),
    join(vault, "runbooks"),
  ];
}

function trim(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}
