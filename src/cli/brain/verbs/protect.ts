import { defaultConfigPath } from "../../../core/config.ts";
import {
  applyProtect,
  BrainProtectError,
  isProtectTarget,
  printSnippet,
  PROTECT_TARGETS,
  unprotect,
} from "../../../core/brain/protect.ts";
import { parse, fail, ok, okJson, info, resolveBrainVault } from "../helpers.ts";

export async function cmdBrainProtect(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    target: { type: "string", required: true },
    vault: { type: "string" },
    apply: { type: "boolean" },
    json: { type: "boolean" },
  });
  const rawTarget = typeof flags["target"] === "string" ? flags["target"] : undefined;
  if (!isProtectTarget(rawTarget)) {
    return fail(
      `brain protect --target='${flags["target"]}' is unknown; supported targets: ${PROTECT_TARGETS.join(", ")}`,
    );
  }
  const target = rawTarget;
  const vault = resolveBrainVault(flags["vault"] as string | undefined, defaultConfigPath());

  try {
    if (flags["apply"]) {
      const result = applyProtect({ target, vault });
      if (flags["json"]) {
        okJson({
          target: result.target,
          destination: result.destination,
          changed: result.changed,
          backup: result.backupPath || null,
        });
        return 0;
      }
      const head = result.changed
        ? `brain protect: applied to ${result.destination}`
        : `brain protect: no changes (${result.destination} already current)`;
      ok(head);
      if (result.backupPath) ok(`  backup: ${result.backupPath}`);
      return 0;
    }
    const snippet = printSnippet({ target, vault });
    if (flags["json"]) {
      okJson({ target: snippet.target, destination: snippet.destination, body: snippet.body });
      return 0;
    }
    info(`# o2b brain protect --target ${target}`);
    info(`# destination: ${snippet.destination}`);
    info(`# preview only; re-run with --apply to write the file`);
    process.stdout.write(snippet.body);
    return 0;
  } catch (exc) {
    if (exc instanceof BrainProtectError) return fail(`brain protect failed: ${exc.message}`);
    throw exc;
  }
}

export async function cmdBrainUnprotect(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    target: { type: "string", required: true },
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const rawTarget = typeof flags["target"] === "string" ? flags["target"] : undefined;
  if (!isProtectTarget(rawTarget)) {
    return fail(
      `brain unprotect --target='${flags["target"]}' is unknown; supported targets: ${PROTECT_TARGETS.join(", ")}`,
    );
  }
  const target = rawTarget;
  const vault = resolveBrainVault(flags["vault"] as string | undefined, defaultConfigPath());

  try {
    unprotect({ target, vault });
  } catch (exc) {
    if (exc instanceof BrainProtectError) return fail(`brain unprotect failed: ${exc.message}`);
    throw exc;
  }

  if (flags["json"]) {
    okJson({ target, vault });
  } else {
    ok(`brain unprotect: removed OSB-managed rules for target=${target}`);
  }
  return 0;
}
