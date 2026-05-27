/**
 * `o2b init-pay-memory` — bootstrap pay-memory directory layout.
 */

import { existsSync, mkdirSync } from "node:fs";

import { defaultConfigPath, resolveAgentName } from "../../../core/config.ts";
import {
  payMemoryDirs,
  vaultRelativePath,
  writePolicyIfMissing,
} from "../../../core/pay-memory/index.ts";
import { requireVault, sortedReplacer } from "../../helpers.ts";
import { parseFlags } from "../../argparse.ts";

export async function cmdInitPayMemory(argv: string[]): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    agent: { type: "string" },
    overwrite: { type: "boolean" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = requireVault(flags["vault"] as string | undefined, config);
  const agent = (flags["agent"] as string | undefined) ?? resolveAgentName(config);

  const dirs = payMemoryDirs(vault);
  const dirList = [dirs.policies, dirs.payments, dirs.assets, dirs.drafts, dirs.reports];
  const created: string[] = [];
  const skipped: string[] = [];
  for (const dir of dirList) {
    const existed = existsSync(dir);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (exc) {
      process.stderr.write(`error: failed to create ${dir}: ${(exc as Error).message ?? exc}\n`);
      return 1;
    }
    (existed ? skipped : created).push(vaultRelativePath(dir, vault));
  }

  let policy;
  try {
    policy = writePolicyIfMissing(vault, { overwrite: Boolean(flags["overwrite"]) });
  } catch (exc) {
    process.stderr.write(`error: failed to write policy: ${(exc as Error).message ?? exc}\n`);
    return 1;
  }
  const policyRel = vaultRelativePath(policy.path, vault);
  const policyStatus = policy.status;

  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify(
        {
          vault_path: vault,
          agent,
          created,
          skipped,
          policy_path: policyRel,
          policy_status: policyStatus,
        },
        sortedReplacer,
        2,
      ) + "\n",
    );
    return 0;
  }

  process.stdout.write(`pay-memory layout initialized: ${vault}\n`);
  for (const rel of created) process.stdout.write(`  created: ${rel}\n`);
  for (const rel of skipped) process.stdout.write(`  exists: ${rel}\n`);
  process.stdout.write(`  ${policyStatus}: ${policyRel}\n`);
  process.stdout.write(`agent: ${agent}\n`);
  return 0;
}
