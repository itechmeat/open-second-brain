/**
 * `o2b brain dead-end <record|list>` (t_be62c62d): the negative-
 * knowledge surface. `record` persists one tried-and-failed approach
 * as a markdown note (bounded active set, overflow archives);
 * `list` renders the active registry newest first.
 *
 * Exit codes: 0 on success, 1 on an operational failure, 2 on usage
 * errors.
 */

import { DEAD_END_MAX_ACTIVE, listDeadEnds, recordDeadEnd } from "../../../core/brain/dead-ends.ts";
import { defaultConfigPath, resolveAgentName } from "../../../core/config.ts";
import { fail, ok, okJson, parse, resolveBrainVault } from "../helpers.ts";

const USAGE =
  "usage: o2b brain dead-end <record|list> " +
  "[--approach T --reason T [--context T]] [--max-active N] [--agent N] [--vault <path>] [--json]";

export async function cmdBrainDeadEnd(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    approach: { type: "string" },
    reason: { type: "string" },
    context: { type: "string" },
    "max-active": { type: "string" },
    agent: { type: "string" },
    json: { type: "boolean" },
  });
  const op = positional[0];
  if (op !== "record" && op !== "list") {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const asJson = flags["json"] === true;
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);

  try {
    if (op === "record") {
      const approach = flags["approach"] as string | undefined;
      const reason = flags["reason"] as string | undefined;
      if (!approach?.trim() || !reason?.trim()) {
        process.stderr.write(`brain dead-end record: --approach and --reason required\n${USAGE}\n`);
        return 2;
      }
      const maxRaw = flags["max-active"] as string | undefined;
      const maxActive = maxRaw !== undefined ? Number(maxRaw) : DEAD_END_MAX_ACTIVE;
      if (!Number.isInteger(maxActive) || maxActive < 1) {
        process.stderr.write(`brain dead-end record: --max-active must be a positive integer\n`);
        return 2;
      }
      const result = recordDeadEnd(vault, {
        approach,
        reason,
        ...(typeof flags["context"] === "string" ? { context: flags["context"] as string } : {}),
        agent: (flags["agent"] as string | undefined) ?? resolveAgentName(config),
        now: new Date(),
        maxActive,
      });
      if (asJson) {
        okJson({
          ok: true,
          id: result.entry.id,
          path: result.entry.path,
          archived: result.archived,
        });
      } else {
        ok(`dead-end recorded: ${result.entry.id}`);
        if (result.archived.length > 0) ok(`archived: ${result.archived.join(", ")}`);
      }
      return 0;
    }

    const { entries, warnings } = listDeadEnds(vault);
    if (asJson) {
      okJson({ entries, warnings });
    } else {
      ok(`dead-ends: ${entries.length} active`);
      for (const e of entries) {
        ok(`  ${e.created_at}  ${e.approach}`);
        ok(`    why: ${e.reason}`);
      }
      for (const w of warnings) ok(`  [warning] ${w.path}: ${w.message}`);
    }
    return 0;
  } catch (exc) {
    const message = `dead-end ${op} failed: ${(exc as Error).message ?? exc}`;
    if (asJson) {
      okJson({ ok: false, message });
      return 1;
    }
    return fail(message);
  }
}
