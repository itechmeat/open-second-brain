import { defaultConfigPath, resolveAgentName } from "../../../core/config.ts";
import { planMigration, applyMigration, MigrationError } from "../../../core/brain/migrate-frontmatter.ts";
import { appendLogEvent } from "../../../core/brain/log.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../../core/brain/types.ts";
import { isoSecond } from "../../../core/brain/time.ts";
import { parse, fail, ok, okJson, info, resolveBrainVault } from "../helpers.ts";

export async function cmdBrainMigrateFrontmatter(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    "dry-run": { type: "boolean" },
    apply: { type: "boolean" },
    yes: { type: "boolean" },
    json: { type: "boolean" },
  });
  const config = defaultConfigPath();
  const vault = resolveBrainVault(flags["vault"] as string | undefined, config);
  const agent = resolveAgentName(config);

  if (flags["dry-run"] && flags["apply"]) return fail("brain migrate-frontmatter: --dry-run and --apply are mutually exclusive");
  const apply = Boolean(flags["apply"]);

  if (apply && !flags["yes"] && (flags["json"] || !process.stdin.isTTY)) {
    return fail("brain migrate-frontmatter --apply requires --yes in non-interactive mode (--json or non-TTY stdin)");
  }

  if (!apply) {
    let plan;
    try { plan = planMigration(vault); }
    catch (exc) { return fail(`migrate-frontmatter plan failed: ${(exc as Error).message ?? exc}`); }
    if (flags["json"]) {
      okJson({
        files_scanned: plan.files_scanned,
        files_to_migrate: plan.files_to_migrate.length,
        files_already_new: plan.files_already_new.length,
        collisions: plan.collisions.length,
        collision_files: plan.collisions.map((c) => ({ path: c.path, field: c.field })),
      });
      return 0;
    }
    ok(`files_scanned: ${plan.files_scanned}`);
    ok(`files_to_migrate: ${plan.files_to_migrate.length}`);
    ok(`files_already_new: ${plan.files_already_new.length}`);
    ok(`collisions: ${plan.collisions.length}`);
    if (plan.collisions.length > 0) {
      info("Collisions (both legacy and '_'-prefixed shape present):");
      for (const c of plan.collisions) info(`  - ${c.path} (field: ${c.field})`);
    }
    if (plan.files_to_migrate.length === 0) ok("nothing to migrate; re-run with --apply --yes when there is.");
    else ok("re-run with --apply --yes to rewrite these files.");
    return 0;
  }

  let result;
  try { result = await applyMigration(vault, { snapshot: true, now: new Date() }); }
  catch (exc) {
    if (exc instanceof MigrationError) { process.stderr.write(`error: ${exc.message}\n`); return 1; }
    return fail(`migrate-frontmatter failed: ${(exc as Error).message ?? exc}`);
  }

  try {
    appendLogEvent(vault, {
      timestamp: isoSecond(new Date()),
      eventType: BRAIN_LOG_EVENT_KIND.migrateFrontmatter,
      body: {
        run_id: result.run_id, agent,
        snapshot: result.snapshot_path ?? "(none)",
        files_scanned: String(result.plan.files_scanned),
        files_migrated: String(result.files_migrated.length),
        files_already_new: String(result.plan.files_already_new.length),
        collisions: String(result.plan.collisions.length),
      },
    });
  } catch (err) { process.stderr.write(`warning: append migrate-frontmatter log failed: ${(err as Error).message}\n`); }

  if (flags["json"]) {
    okJson({
      run_id: result.run_id, snapshot_path: result.snapshot_path,
      files_scanned: result.plan.files_scanned,
      files_migrated: result.files_migrated.length,
      files_already_new: result.plan.files_already_new.length,
      collisions: result.plan.collisions.length,
    });
    return 0;
  }
  ok(`run_id: ${result.run_id}`);
  ok(`snapshot: ${result.snapshot_path ?? "(none)"}`);
  ok(`files_migrated: ${result.files_migrated.length}`);
  ok(`files_already_new: ${result.plan.files_already_new.length}`);
  return 0;
}
