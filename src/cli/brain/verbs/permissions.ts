import {
  loadPermissionsDocument,
  PermissionsDocumentError,
  type PermissionAction,
  type PermissionsDocument,
} from "../../../core/brain/permissions/document.ts";
import {
  queryDecisionLedger,
  type DecisionLedgerFilter,
  type DecisionLedgerRow,
} from "../../../core/brain/permissions/ledger.ts";
import { resolvePermission } from "../../../core/brain/permissions/resolve.ts";
import {
  brainVerbContext,
  fail,
  normalizeFlagString,
  ok,
  okJson,
  parse,
  usageError,
  type BrainVerbFlags,
} from "../helpers.ts";

/**
 * `o2b brain permissions` - the operator surface over the vault's trust
 * policy (write-side-trust, Task 4).
 *
 * Subcommands:
 *   show    render the effective document plus a dry-run decision table
 *           over the agents it declares
 *   ledger  list the decision ledger rows the gates appended
 *
 * `show` exists because `default_action: deny` is a foot-gun: a one-agent
 * document denies everything else by construction, and the table makes
 * that visible before the first refusal does. Both subcommands are pure
 * reads; neither mutates the vault.
 *
 * A document that cannot be read is never smoothed over: `show` fails
 * naming the field the loader refused, and `o2b brain doctor` reports the
 * same fault under `permissions-unreadable` - whose exit is this verb.
 */
export async function cmdBrainPermissions(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  const { flags } = parse(rest, {
    vault: { type: "string" },
    json: { type: "boolean" },
    actor: { type: "string" },
    action: { type: "string" },
    verdict: { type: "string" },
    since: { type: "string" },
    until: { type: "string" },
    limit: { type: "string" },
  });
  const json = flags["json"] === true;

  if (sub === "show") return show(flags, json);
  if (sub === "ledger") return ledger(flags, json);
  return usageError("brain permissions requires a subcommand: show | ledger");
}

// ----- show -----------------------------------------------------------------

/** The actions one dry-run row resolves, in the document's vocabulary order. */
const RESOLVED_ACTIONS: ReadonlyArray<PermissionAction> = ["write", "ingest", "owner_write"];

/** One resolved row of the dry-run decision table. */
interface DecisionTableRow {
  agent: string;
  role: string;
  action: PermissionAction;
  /** Empty for the blanket row; a declared target for the scoped rows. */
  target: string;
  verdict: string;
  source: string;
}

function show(flags: BrainVerbFlags, json: boolean): number {
  const { vault } = brainVerbContext(flags);
  try {
    const { document, path } = loadPermissionsDocument(vault);
    if (document === null) {
      if (json) {
        okJson({ document: null, path });
      } else {
        ok(`no permissions document at ${path} - every write is ungated`);
      }
      return 0;
    }
    const decisions = decisionTable(document);
    if (json) {
      okJson({ document: { ...document }, decisions });
    } else {
      for (const line of renderShow(path, document, decisions)) ok(line);
    }
    return 0;
  } catch (exc) {
    if (exc instanceof PermissionsDocumentError) return fail(exc.message);
    return fail(`failed to read the permissions document: ${(exc as Error).message}`);
  }
}

/**
 * Resolve every declared agent against every action - once as a blanket
 * query, and once per target the document's entries name for that agent,
 * because a target-scoped entry is exactly the rule a blanket row hides.
 * Rows are sorted by construction: agents sorted, actions in vocabulary
 * order, targets sorted within their action.
 */
function decisionTable(document: PermissionsDocument): DecisionTableRow[] {
  const rows: DecisionTableRow[] = [];
  for (const agent of Object.keys(document.agents).toSorted()) {
    const role = document.agents[agent]?.role ?? "";
    for (const action of RESOLVED_ACTIONS) {
      const blanket = resolvePermission(document, { agent, via: "operator" }, action);
      rows.push({
        agent,
        role,
        action,
        target: "",
        verdict: blanket.verdict,
        source: blanket.source,
      });
      for (const target of declaredTargets(document, agent, action)) {
        const scoped = resolvePermission(document, { agent, via: "operator" }, action, target);
        rows.push({
          agent,
          role,
          action,
          target,
          verdict: scoped.verdict,
          source: scoped.source,
        });
      }
    }
  }
  return rows;
}

/** The distinct targets the document's entries declare for one agent and action. */
function declaredTargets(
  document: PermissionsDocument,
  agent: string,
  action: PermissionAction,
): string[] {
  const targets = new Set<string>();
  for (const entry of document.entries) {
    if (entry.agent === agent && entry.action === action && entry.target !== undefined) {
      targets.add(entry.target);
    }
  }
  return [...targets].toSorted();
}

function renderShow(
  path: string,
  document: PermissionsDocument,
  decisions: DecisionTableRow[],
): string[] {
  const lines: string[] = [
    `permissions document: ${path} (version ${document.version})`,
    `default_action: ${document.default_action}`,
  ];
  const roleNames = Object.keys(document.roles).toSorted();
  if (roleNames.length > 0) {
    lines.push("roles:");
    for (const name of roleNames) {
      const actions = Object.entries(document.roles[name] ?? {})
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([action, verdict]) => `${action}=${verdict}`)
        .join(", ");
      const members = Object.keys(document.agents)
        .filter((agent) => document.agents[agent]?.role === name)
        .toSorted();
      lines.push(
        `  ${name}: ${actions === "" ? "(no action mapped)" : actions} ` +
          `(members: ${members.length > 0 ? members.join(", ") : "none"})`,
      );
    }
  }
  if (decisions.length === 0) {
    lines.push("no agents declared - the default_action decides every subject");
    return lines;
  }
  lines.push(`decision table (dry run, via=operator, ${decisions.length} rows):`);
  for (const row of decisions) {
    const target = row.target === "" ? "-" : row.target;
    lines.push(
      `  ${row.agent}  ${row.role === "" ? "-  " : `${row.role}  `}${row.action}  ` +
        `${target}  ${row.verdict}  ${row.source}`,
    );
  }
  return lines;
}

// ----- ledger ---------------------------------------------------------------

function ledger(flags: BrainVerbFlags, json: boolean): number {
  const { vault } = brainVerbContext(flags);
  const filter: DecisionLedgerFilter = {};
  for (const key of ["actor", "action", "verdict", "since", "until"] as const) {
    const value = normalizeFlagString(flags[key]);
    if (value !== null) filter[key] = value;
  }
  const limitRaw = normalizeFlagString(flags["limit"]);
  if (limitRaw !== null) {
    const limit = Number.parseInt(limitRaw, 10);
    if (!Number.isInteger(limit) || limit <= 0) {
      return usageError("brain permissions ledger --limit must be a positive integer");
    }
    filter.limit = limit;
  }

  try {
    const rows = queryDecisionLedger(vault, filter);
    if (json) {
      okJson({ rows });
      return 0;
    }
    if (rows.length === 0) {
      ok("no decision ledger rows");
      return 0;
    }
    for (const row of rows) ok(renderLedgerRow(row));
    return 0;
  } catch (exc) {
    return fail(`failed to read the decision ledger: ${(exc as Error).message}`);
  }
}

/** One row, fixed column order so a scan down the output stays aligned. */
function renderLedgerRow(row: DecisionLedgerRow): string {
  return [
    row.ts,
    row.actor,
    `via=${row.via}`,
    row.action,
    row.target,
    row.verdict,
    `source=${row.source}`,
    row.reason,
  ].join("  ");
}
