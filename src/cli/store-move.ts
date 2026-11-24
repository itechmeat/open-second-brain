/**
 * `o2b store move-into-vault` (patch 2.0.1): move a brain store that
 * release 2.0.0 left at the per-user default, outside the vault, into the
 * vault's hidden `.open-second-brain-store/` folder, where the vault's
 * sync carries it to the other machines. A person runs it with the agent
 * sessions of this machine closed; nothing runs it by itself. The work
 * lives in `core/store-migration/move-into-vault.ts`; this file parses
 * flags and renders.
 *
 * `--dry-run` prints the plan and writes nothing. `--carry` only carries
 * over what a process of an older release wrote to the old folder after
 * the move (a plain run on a machine whose store moved does the same).
 *
 * Exit codes: 0 when the store moved, late writes were carried, or there
 * was nothing to do; 1 when the run was refused (not eligible, a writer
 * runs, another run holds the lock) or failed; 2 for a broken argv.
 */

import {
  moveStoreIntoVault,
  planMoveIntoVault,
  type MoveIntoVaultPlan,
  type MoveIntoVaultResult,
} from "../core/store-migration/move-into-vault.ts";
import { MOVE_INTO_VAULT_COMMAND, STORE_VAULT_DIR } from "../core/store/constants.ts";
import { CliError, parseFlags } from "./argparse.ts";
import { sortedReplacer } from "./helpers.ts";

export const STORE_MOVE_USAGE =
  "usage: o2b store move-into-vault [--dry-run] [--carry] [--config <file>] [--json]";

const EXIT = Object.freeze({ ok: 0, refused: 1, usage: 2 } as const);

function mib(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KiB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function renderPlan(plan: MoveIntoVaultPlan): string {
  switch (plan.kind) {
    case "refused":
      return `Nothing would be moved: ${plan.reason}.\n`;
    case "nothing":
      return `Nothing to do: ${plan.reason}.\n`;
    case "carry": {
      const lines = [
        `This machine's brain store moved into ${plan.to} already.`,
        `A run would carry over what an older process wrote to ${plan.from} after the move.`,
      ];
      if (plan.writers.length > 0) lines.push(refusalForWriters(plan.writers));
      return `${lines.join("\n")}\n`;
    }
    case "move": {
      const lines = [
        "Plan (nothing was written):",
        `  from:        ${plan.from} (outside the vault; kept as a recovery copy)`,
        `  to:          ${plan.to}`,
        `  store id:    ${plan.storeId ?? "none"} (kept, with every record id and the device id)`,
        `  partitions:  ${plan.partitions.join(", ") || "none"}`,
        `  files:       ${plan.files} (${mib(plan.bytes)})`,
        `  vault folder holds: ${plan.destination}`,
        "Steps: take the relocation lock, refuse while anything writes the store, copy, " +
          "verify, bind this machine to the new folder, verify again, commit.",
      ];
      if (plan.writers.length > 0) lines.push(refusalForWriters(plan.writers));
      else lines.push(`Run ${MOVE_INTO_VAULT_COMMAND} to move it.`);
      return `${lines.join("\n")}\n`;
    }
  }
}

/** What writes the store now, and what to do about it. */
function writersAdvice(writers: ReadonlyArray<string>): string {
  return (
    `something writes the store on this machine (${writers.join("; ")}). Close every agent ` +
    "session on this machine (Claude Code, Codex, Hermes, OpenClaw and any other client that " +
    "runs Open Second Brain), wait for running o2b commands to finish, then run " +
    `${MOVE_INTO_VAULT_COMMAND} again.`
  );
}

function refusalForWriters(writers: ReadonlyArray<string>): string {
  return `A run now would refuse: ${writersAdvice(writers)}`;
}

function carryLine(
  carry: { readonly carried: number; readonly waiting: number } | { readonly error: string },
): string | null {
  if ("error" in carry) {
    return (
      `Carrying what an older process wrote to the old folder after the move failed: ` +
      `${carry.error}. Run ${MOVE_INTO_VAULT_COMMAND} again to retry.`
    );
  }
  const parts: string[] = [];
  if (carry.carried > 0) {
    parts.push(
      `Carried over ${carry.carried} file(s) an older process wrote to the old folder after the move.`,
    );
  }
  if (carry.waiting > 0) {
    parts.push(
      `${carry.waiting} file(s) still wait in the old folder: the vault's store folder did not ` +
        `hold this store when they were to be written. Run ${MOVE_INTO_VAULT_COMMAND} again once ` +
        "it does.",
    );
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * What to do with the recovery copy. Late writes that still wait there (a
 * carry that failed or left files) exist nowhere else, so its removal is
 * never advised then; otherwise only once no process started before the
 * move runs, a carry finds nothing waiting, and the other machines have
 * the store.
 */
function recoveryCopyLine(
  from: string,
  carry: { readonly carried: number; readonly waiting: number } | { readonly error: string },
): string {
  const kept = `Recovery copy: ${from} is kept as it was and is no longer written.`;
  if ("error" in carry || carry.waiting > 0) {
    return (
      `${kept} Keep it: records an older process wrote there after the move are not in the ` +
      `vault yet. Remove it only after a run of ${MOVE_INTO_VAULT_COMMAND} --carry says nothing ` +
      "waits there, and every machine of the vault has received the store."
    );
  }
  return (
    `${kept} Remove it once every agent session that ran before the move has ended, a run of ` +
    `${MOVE_INTO_VAULT_COMMAND} --carry says nothing waits there, and every machine of the vault ` +
    "has received the store."
  );
}

function renderResult(result: MoveIntoVaultResult): string {
  switch (result.kind) {
    case "moved": {
      const seconds = (result.durationMs / 1000).toFixed(1);
      const lines = [
        `Moved the brain store into the vault in ${seconds} s.`,
        `  from:      ${result.from}`,
        `  to:        ${result.to}`,
        `  store id:  ${result.storeId} (kept, with every record id and the device id)`,
        recoveryCopyLine(result.from, result.carry),
        `Other machines receive the store with the vault's sync, in the hidden ${STORE_VAULT_DIR}/ ` +
          "folder: the sync tool must carry hidden folders.",
      ];
      const carry = carryLine(result.carry);
      if (carry !== null) lines.push(carry);
      return `${lines.join("\n")}\n`;
    }
    case "carried": {
      const carry = carryLine(result.carry);
      return `${carry ?? `Nothing waited in ${result.from}.`}\n`;
    }
    case "nothing":
      return `Nothing to do: ${result.reason}.\n`;
    default:
      return "";
  }
}

function failureText(result: MoveIntoVaultResult): string | null {
  switch (result.kind) {
    case "refused":
      return `the brain store was not moved: ${result.reason}`;
    case "failed":
      return (
        `the move stopped and nothing was committed: ${result.reason}. ` +
        `${result.from ?? "The old folder"} is still the store; run ${MOVE_INTO_VAULT_COMMAND} again`
      );
    case "live":
      return `the brain store was not moved, and nothing was copied: ${writersAdvice(result.writers)}`;
    case "busy":
      return `another run of ${MOVE_INTO_VAULT_COMMAND} holds the relocation lock on this machine; wait for it to finish`;
    default:
      return null;
  }
}

export function cmdStoreMoveIntoVault(argv: ReadonlyArray<string>): number {
  let configPath: string | undefined;
  let dryRun: boolean;
  let carry: boolean;
  let json: boolean;
  try {
    const { flags, positional } = parseFlags(argv, {
      "dry-run": { type: "boolean" },
      carry: { type: "boolean" },
      config: { type: "string" },
      json: { type: "boolean" },
    });
    if (positional.length > 0) throw new CliError(`unexpected argument: ${positional[0]}`);
    configPath = flags["config"] as string | undefined;
    dryRun = flags["dry-run"] === true;
    carry = flags["carry"] === true;
    json = flags["json"] === true;
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    process.stderr.write(`error: ${err.message}\n${STORE_MOVE_USAGE}\n`);
    return EXIT.usage;
  }
  const opts = {
    ...(configPath !== undefined ? { configPath } : {}),
    carryOnly: carry,
  };

  if (dryRun) {
    const plan = planMoveIntoVault(opts);
    process.stdout.write(
      json
        ? `${JSON.stringify({ ok: plan.kind !== "refused", dry_run: true, ...plan }, sortedReplacer, 2)}\n`
        : renderPlan(plan),
    );
    return plan.kind === "refused" ? EXIT.refused : EXIT.ok;
  }

  const result = moveStoreIntoVault(opts);
  const failure = failureText(result);
  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        { ok: failure === null, ...result, ...(failure !== null ? { message: failure } : {}) },
        sortedReplacer,
        2,
      )}\n`,
    );
  } else if (failure === null) {
    process.stdout.write(renderResult(result));
  }
  if (failure !== null) {
    process.stderr.write(`error: ${failure}\n`);
    return EXIT.refused;
  }
  return EXIT.ok;
}
