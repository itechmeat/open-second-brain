/**
 * The CLI entry a self-spawn uses when this checkout's dependency tree is
 * missing (`o2b-command.ts`): it installs the tree as the launcher's
 * precheck would (`dependency-tree.ts`), with the runtime that runs it,
 * then runs the CLI with the same arguments. Imports nothing that needs the
 * tree before the install.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureDependencyTree } from "../core/maintenance/dependency-tree.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

try {
  ensureDependencyTree(ROOT, process.env);
} catch (e) {
  process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
const { main } = (await import(join(ROOT, "src", "cli", "main.ts"))) as {
  main: (argv: ReadonlyArray<string>) => Promise<number>;
};
const guard = (await import(join(ROOT, "src", "cli", "stdout-guard.ts"))) as {
  installStdoutEpipeGuard: () => void;
  isEpipeError: (err: unknown) => boolean;
  exitWhenFlushed: (code: number) => void;
};
// The same guard and exit as the main entry (`main.ts`), which installs
// them only when it is the entry itself.
guard.installStdoutEpipeGuard();
try {
  guard.exitWhenFlushed(await main(process.argv.slice(2)));
} catch (err) {
  if (guard.isEpipeError(err)) process.exit(0);
  throw err;
}
