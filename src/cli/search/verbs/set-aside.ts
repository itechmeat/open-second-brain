/**
 * `o2b search set-aside bak|old` - move a parked index, with its `-wal`,
 * `-shm` and `-journal` files, out of its parked name into a new folder
 * under `<index folder>/set-aside/`. Dry run by default, as on the other
 * repair verbs of this family; `--apply` moves. Nothing is deleted.
 */

import { setAsideParkedIndex } from "../../../core/search/parked-set-aside.ts";
import { info, ok } from "../../output.ts";
import {
  CliError,
  flagBoolean,
  parseFlags,
  resolveConfig,
  resolveParkedTarget,
  VAULT_FLAGS,
} from "../helpers.ts";

export async function cmdSearchSetAside(argv: ReadonlyArray<string>): Promise<number> {
  const { flags, positional } = parseFlags(argv, {
    ...VAULT_FLAGS,
    apply: { type: "boolean" },
    json: { type: "boolean" },
  });
  const kind = positional[0];
  if ((kind !== "bak" && kind !== "old") || positional.length !== 1) {
    throw new CliError("search set-aside takes one parked name: bak or old");
  }
  const cfg = resolveConfig(flags);
  const r = await setAsideParkedIndex(
    cfg.dbPath,
    kind,
    flagBoolean(flags, "apply"),
    new Date(),
    resolveParkedTarget(cfg),
  );
  if (flagBoolean(flags, "json")) {
    process.stdout.write(
      JSON.stringify({ dry_run: !r.applied, from: r.from, folder: r.folder, files: r.files }) +
        "\n",
    );
    return 0;
  }
  ok(`${r.applied ? "set aside" : "set-aside dry-run"}: ${r.files.join(", ")} -> ${r.folder}`);
  if (!r.applied) info("  nothing was moved; pass --apply to move them");
  return 0;
}
