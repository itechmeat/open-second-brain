/**
 * The migration-gate census: every CLI verb, MCP tool, hook and background
 * worker that can create, change or remove a file under `<vault>/Brain/`,
 * `<vault>/.open-second-brain/` or anywhere else in the vault on a machine
 * that has not switched to the brain store, classified once, with the guard
 * its writes pass through.
 *
 * The specification (brain-migration, "Quiesce and back up before moving")
 * refuses every write attempted on this machine while a migration of the
 * vault holds the gate. The guards that enforce it:
 *
 *  - {@link GUARD.vault}: the vault-identity write guard
 *    (`assertVaultIdentityForWrite` and its wrappers `brainDirsForWrite`,
 *    `assertLaneWrite`, `assertNoteVaultForWrite`), which asks the gate first,
 *    on both of its lanes;
 *  - {@link GUARD.gate}: the gate assertion itself (`assertNoMigrationInProgress`),
 *    asked directly by the writers that pass no vault guard (bootstrap, lock
 *    primitives, per-vault state outside `src/core/brain/`, fail-soft caches);
 *  - {@link GUARD.both}: a lock or cache asked directly, then the vault guard.
 *
 * Kinds:
 *
 *  - `writer`: driven with `argv` (after `prepare`, before the gate is
 *    taken). Without a gate it changes the vault; with the gate held by a
 *    live migration of this vault it is refused with the migration message
 *    and the vault is byte-identical; with the gate held for another vault
 *    it changes the vault again. A writer the fixture cannot drive names why
 *    in `undriven` ({@link UNDRIVEN}) and is still run under the gate, where
 *    it must leave the vault byte-identical.
 *  - `recorder`: a reader that also records a row or creates its own
 *    database; without a gate only paths matching `records` change, and with
 *    the gate it still answers (exit 0) and leaves the vault byte-identical.
 *  - `reader`: writes nothing, with or without a gate, and is never refused.
 *  - `outside`: writes only outside the vault (the brain store, device-local
 *    state, a host config, a path the caller names), so the gate does not
 *    concern it; driven ones must leave the vault byte-identical under the
 *    gate.
 *  - `allowed`: writes into the vault while a migration holds the gate, on
 *    purpose, with the reason ({@link ALLOWED_REASON}). Never by omission.
 *
 * Every table below is compared with the live surface in both directions
 * (`migration-gate-census.test.ts`): a verb, tool or hook added without a
 * row fails there, and so does a row whose subject is gone.
 */

/**
 * CLI writers whose every run generates a key or sets owner-only access on
 * a file (an `icacls` and a `whoami` per write on Windows), and so needs
 * more than a usual CLI call on a slow runner: each of their calls gets
 * {@link HEAVY_CALL_LIMIT_MS}, their test {@link HEAVY_ROW_BUDGET_MS}.
 */
export const HEAVY_CLI_ROWS: ReadonlySet<string> = new Set([
  "brain attest keygen",
  "brain attest sign",
  "brain secret",
  "mcp token mint",
  "mcp token rotate",
  "mcp token revoke",
]);

/** A heavy row's per-call limit (its four gate conditions run one after another). */
export const HEAVY_CALL_LIMIT_MS = 110_000;

/** A heavy row's test budget: its prepare steps and four calls, each at most the limit. */
export const HEAVY_ROW_BUDGET_MS = 6 * HEAVY_CALL_LIMIT_MS;

/** The guard a writer's first write into the vault passes. */
export const GUARD = Object.freeze({
  vault: "vault-guard",
  gate: "migration-gate",
  both: "migration-gate+vault-guard",
} as const);

export type Guard = (typeof GUARD)[keyof typeof GUARD];

/** Why a writer is classified but not driven against the census fixture. */
export const UNDRIVEN = Object.freeze({
  inputs:
    "needs inputs the census fixture does not build (a dataset, an export bundle, a session " +
    "file, an approval digest, an exact payload shape); its writes pass the vault guard like " +
    "the driven writers of the same lanes, and under the gate the verb leaves the vault as it was.",
  fixtureState:
    "has nothing to do on the census fixture (no finding, no stale page, no pending item, no " +
    "dead letter, no managed block); when it has, its writes pass the vault guard like the " +
    "driven writers, and under the gate the verb leaves the vault as it was.",
  schema:
    "writes a frontmatter field the schema pack must declare first; the fixture's pack declares " +
    "none, and the page write passes the vault guard like every driven page writer.",
  index:
    "needs a built search index; the index itself lives in the brain store's device-local " +
    "state once a store is in use (outside the vault), and the vault rows it records pass the " +
    "vault guard like the driven `search index`.",
  outsideTarget:
    "writes its pointer or source registration into a directory outside the vault, refusing a " +
    "target inside it; nothing it writes lands in the legacy tree.",
  network:
    "reaches a remote service before it writes; its capture pages pass the vault guard like " +
    "the driven `brain capture`.",
  host:
    "writes agent host configuration under the user's home directory, which a census run must " +
    "never touch; its per-vault receipts and manifests pass the vault guard.",
  mcpBridge:
    "calls one MCP tool by name; the MCP section of this census drives every tool and its " +
    "writes, through the same handlers and guards.",
} as const);

export type UndrivenReason = keyof typeof UNDRIVEN;

/** Why something writes only outside the vault. */
export const OUTSIDE = Object.freeze({
  deviceState:
    "writes this machine's device-local state of the automatic migration (its worker's log, " +
    "the record of a worker lost before it confirmed its claim), in the folder of all stores, " +
    "outside every vault.",
  checkout:
    "installs the checkout's own dependency tree, outside every vault, then runs the CLI with " +
    "the same arguments, whose writes are that verb's own and classified in CLI_CENSUS.",
  store:
    "writes records into the brain store, outside the vault; a migration appends to the same " +
    "store and other machines write to it during a migration too.",
  view:
    "renders or recovers the human view, which only a switched machine writes; on a machine " +
    "that has not switched it changes nothing in the vault.",
  dmState:
    "keeps its evaluations and thresholds in the decision-model state directory, device-local " +
    "and outside every vault.",
  outPath:
    "writes the export to the path the caller names (outside the vault in every census run) " +
    "and reads the vault only.",
  hostBin:
    "installs or updates the CLI launchers and the plugin outside any vault; it never opens " +
    "the legacy tree, and a census run never executes it.",
  config:
    "writes the machine config (a vault profile, the vault this server serves), outside the " +
    "vault; the vault's own tree is created by `brain init`, which asks the gate.",
  index:
    "writes beside the search index (the session focus), which lives in the brain store's " +
    "device-local state whenever a store is in use; a store always exists before a " +
    "migration takes the gate, so nothing it writes lands in the vault then.",
  stdout:
    "prints a script, a completion or a cron recipe on standard output for the caller to " +
    "install; it writes no file at all, in the vault or anywhere else.",
  server:
    "starts a long-running server or watcher whose index lives outside the vault; a census run " +
    "never starts one, and what it writes passes the same guards as the driven verbs.",
} as const);

export type OutsideReason = keyof typeof OUTSIDE;

/** Why a writer may write while a migration of its vault holds the gate. */
export const ALLOWED_REASON = Object.freeze({
  migration:
    "is the migration itself: the run that holds the gate, its resume, its rollback and the " +
    "removal of the legacy tree (each holds the gate), its journal and state (device-local), " +
    "its snapshot and the snapshot's log line (inside `asMigrationGateHolder`, the one exemption " +
    "of the guard); its dry run only reads. Another run under a live gate is refused as busy.",
} as const);

export type CliRow =
  | {
      readonly kind: "writer";
      readonly guard: Guard;
      readonly argv: ReadonlyArray<string>;
      /** CLI calls run before the gate is taken, to give the writer something to change. */
      readonly prepare?: ReadonlyArray<ReadonlyArray<string>>;
    }
  | { readonly kind: "writer"; readonly guard: Guard; readonly undriven: UndrivenReason }
  | {
      readonly kind: "recorder";
      readonly records: RegExp;
      readonly argv?: ReadonlyArray<string>;
      /**
       * CLI calls that give the recorder its real work first; a recorder
       * with a `prepare` must then record (a positive control).
       */
      readonly prepare?: ReadonlyArray<ReadonlyArray<string>>;
    }
  | { readonly kind: "reader"; readonly argv?: ReadonlyArray<string> }
  | { readonly kind: "outside"; readonly reason: OutsideReason }
  | { readonly kind: "allowed"; readonly reason: keyof typeof ALLOWED_REASON };

const V = GUARD.vault;
const G = GUARD.gate;
const B = GUARD.both;

function w(
  guard: Guard,
  argv: ReadonlyArray<string>,
  prepare?: ReadonlyArray<ReadonlyArray<string>>,
): CliRow {
  return prepare === undefined
    ? { kind: "writer", guard, argv }
    : { kind: "writer", guard, argv, prepare };
}
function u(reason: UndrivenReason, guard: Guard = V): CliRow {
  return { kind: "writer", guard, undriven: reason };
}
const r: CliRow = { kind: "reader" };
function o(reason: OutsideReason): CliRow {
  return { kind: "outside", reason };
}

/**
 * Every CLI leaf verb (`CLI_COMMAND_MANIFEST`). `{vault}` and `{dir}` in an
 * argv are the run's vault and its scratch directory outside the vault.
 */
export const CLI_CENSUS: Readonly<Record<string, CliRow>> = Object.freeze({
  "aider wrap": u("host"),
  bootstrap: u("host"),
  "brain actions": r,
  "brain activation": u("fixtureState"),
  "brain agenda": r,
  "brain agent-diff": r,
  "brain agent-query": r,
  "brain anticipate": w(V, ["brain", "anticipate", "--session", "s-census", "--refresh"]),
  "brain apply-evidence": w(V, [
    "brain",
    "apply-evidence",
    "--pref",
    "pref-shared",
    "--artifact",
    "[[notes/shared.md]]",
    "--result",
    "applied",
    "--agent",
    "census-agent",
  ]),
  "brain apply-markers": u("fixtureState"),
  "brain architect": u("inputs"),
  "brain attention-flows": u("inputs"),
  "brain attest keygen": w(V, ["brain", "attest", "keygen"]),
  "brain attest list": r,
  "brain attest sign": w(V, ["brain", "attest", "sign"], [["brain", "attest", "keygen"]]),
  "brain attest verify": r,
  "brain attr": u("schema"),
  "brain audit": r,
  "brain authored-at-backfill": u("fixtureState"),
  "brain backlinks": r,
  "brain bank-export": o("outPath"),
  "brain bank-import": u("inputs"),
  "brain batch-plan": r,
  "brain bench": u("inputs"),
  "brain benchmark": u("inputs"),
  "brain bridges": w(V, ["brain", "bridges", "accept", "notes/shared.md", "notes/typed.md"]),
  "brain capture": w(V, ["brain", "capture", "census capture text"]),
  "brain changes": { kind: "recorder", records: /^Brain\/metrics\// },
  "brain claims": r,
  "brain clusters": u("index"),
  "brain co-occurrence": r,
  "brain codec": r,
  "brain context-pack": r,
  "brain context-presets": r,
  "brain context-receipts": r,
  "brain continuity": o("outPath"),
  "brain daily": r,
  "brain dead-end": w(V, [
    "brain",
    "dead-end",
    "record",
    "--approach",
    "census approach",
    "--reason",
    "did not work",
  ]),
  "brain dead-letters list": r,
  "brain dead-letters recover": u("fixtureState"),
  "brain dead-letters show": r,
  "brain decision": w(V, [
    "brain",
    "decision",
    "record",
    "--title",
    "Census decision",
    "--chosen",
    "a",
    "--assumption",
    "b",
    "--review-date",
    "2027-01-01",
  ]),
  "brain deep-synthesis": r,
  "brain design-note": u("inputs"),
  "brain diarize": r,
  "brain digest": r,
  "brain distill": w(V, [
    "brain",
    "distill",
    "notes/shared.md",
    "--claims",
    '[{"text":"lattice widgets are shared","quote":"lattice widgets"}]',
  ]),
  "brain doctor": r,
  "brain dream": w(V, ["brain", "dream"]),
  "brain entity": w(V, ["brain", "entity", "set", "person", "Census Person"]),
  "brain event-trace": r,
  "brain evolution": r,
  "brain expire": w(V, ["brain", "expire", "pref-hub", "--expires", "2026-12-01"]),
  "brain explorer": o("server"),
  "brain export": o("outPath"),
  "brain extract": r,
  "brain extract-signals": u("inputs"),
  "brain facts": u("inputs"),
  "brain feedback": w(V, [
    "brain",
    "feedback",
    "--topic",
    "census",
    "--signal",
    "positive",
    "--principle",
    "Census principle",
    "--agent",
    "census-agent",
  ]),
  "brain file-context": r,
  "brain foresight": r,
  "brain forget-source": u("fixtureState"),
  "brain freeze": w(V, ["brain", "freeze", "--reason", "census"]),
  "brain generation-reports list": r,
  "brain generation-reports record": u("inputs"),
  "brain generation-reports show": r,
  "brain generation-reports summary": r,
  "brain git": u("inputs"),
  "brain graph-export": o("outPath"),
  "brain graph-import": u("inputs"),
  "brain hallways": w(V, ["brain", "hallways", "mine"]),
  "brain handoff": u("inputs"),
  "brain health": r,
  "brain health-baseline": w(V, ["brain", "health-baseline", "set", "now"]),
  "brain history": r,
  "brain hygiene": u("inputs"),
  "brain idea-lineage": r,
  "brain ideas": r,
  "brain import-claude-memory": u("inputs"),
  "brain import-session": u("inputs"),
  "brain inbox-drain": u("fixtureState"),
  "brain init": w(G, ["brain", "init"]),
  "brain intent-review": r,
  "brain intention": w(V, [
    "brain",
    "intention",
    "set",
    "--scope",
    "census",
    "--text",
    "census intention",
  ]),
  "brain knowledge-gaps": r,
  "brain knowledge-pack": o("outPath"),
  "brain label": u("schema"),
  "brain lessons approve": u("fixtureState"),
  "brain lessons candidates": r,
  "brain lessons deny": w(V, ["brain", "lessons", "deny", "pref-shared", "--apply", "--yes"]),
  "brain lessons refresh-blocks": u("fixtureState"),
  "brain lifecycle": w(V, [
    "brain",
    "lifecycle",
    "tombstone",
    "Brain/preferences/pref-hub.md",
    "--reason",
    "census",
  ]),
  "brain links": w(V, ["brain", "links", "normalize", "--mode", "full", "--write"]),
  "brain lint": u("fixtureState"),
  "brain log verify": r,
  "brain maintenance run": w(B, ["brain", "maintenance", "run", "--force"]),
  "brain maintenance status": {
    kind: "recorder",
    records: /^\.open-second-brain\/maintenance\.sqlite$/,
  },
  "brain mcp-landscape": r,
  "brain merge": w(V, ["brain", "merge", "pref-shared", "pref-shared-twin", "--force"]),
  "brain migrate-store": { kind: "allowed", reason: "migration" },
  "brain moc-audit": r,
  "brain monthly": r,
  "brain morning-brief": r,
  "brain note": w(V, ["brain", "note", "census note", "--agent", "census-agent"]),
  "brain note-history": r,
  "brain note-lifecycle": w(V, [
    "brain",
    "note-lifecycle",
    "rename",
    "notes/shared.md",
    "notes/shared-renamed.md",
    "--apply",
  ]),
  "brain obligation": w(V, [
    "brain",
    "obligation",
    "add",
    "--title",
    "Census duty",
    "--cadence",
    "weekly",
  ]),
  "brain okf-export": o("outPath"),
  "brain okf-import": u("inputs"),
  "brain orphan-repair": u("fixtureState"),
  "brain page-dedup": u("fixtureState"),
  "brain panel": w(V, ["brain", "panel", "open", "census topic"]),
  "brain payload gc": u("fixtureState"),
  "brain payload get": r,
  "brain payload list": r,
  "brain pending apply": u("fixtureState"),
  "brain pending list": r,
  "brain pending reject": u("fixtureState"),
  "brain permissions ledger": r,
  "brain permissions show": r,
  "brain pin": w(V, ["brain", "pin", "--id", "pref-shared"]),
  "brain post-compact-audit": r,
  "brain pre-compact-extract": u("inputs"),
  "brain pre-extract": r,
  "brain privacy-marker-restamp": u("fixtureState"),
  "brain procedural-graph": w(V, ["brain", "procedural-graph", "rebuild"]),
  "brain procedural-memory": w(V, ["brain", "procedural-memory", "reconcile"]),
  "brain profile": w(V, ["brain", "profile"]),
  "brain project": u("outsideTarget"),
  "brain protect": w(V, ["brain", "protect", "--target", "claudecode", "--apply", "--yes"]),
  "brain query": r,
  "brain recall-telemetry": r,
  "brain receipts": u("fixtureState"),
  "brain recurrence": u("inputs"),
  "brain refresh": u("fixtureState"),
  "brain reject": w(V, ["brain", "reject", "--id", "pref-hub", "--reason", "census"]),
  "brain repair-lane": w(V, ["brain", "repair-lane", "--apply", "--confirm", "apply repair"]),
  "brain retention": r,
  "brain rollback": u("inputs"),
  "brain scaffold-stub": w(V, ["brain", "scaffold-stub", "write", "[[Census Stub]]", "--apply"]),
  "brain scan-citations": u("fixtureState"),
  "brain scan-inline": { kind: "recorder", records: /^Brain\/log\// },
  "brain schema apply": u("inputs"),
  "brain schema explain": r,
  "brain schema graph": r,
  "brain schema lint": r,
  "brain schema orphans": r,
  "brain schema report": r,
  "brain schema stats": r,
  "brain schema sync": u("fixtureState"),
  "brain secret": w(V, ["brain", "secret", "set", "census", "--from-env", "CENSUS_SEALED_VALUE"]),
  "brain semantics-backfill": u("fixtureState"),
  "brain session": w(V, ["brain", "session", "open", "--target", "Brain/notes/census-session.md"]),
  "brain session-describe": r,
  "brain session-expand": r,
  "brain session-grep": r,
  "brain session-hook": w(V, ["brain", "session-hook"]),
  "brain session-summary": w(V, [
    "brain",
    "session-summary",
    "write",
    "--session",
    "s-census",
    "--request",
    "census",
  ]),
  "brain set-primary": w(V, ["brain", "set-primary", "census"]),
  "brain settings get": r,
  "brain settings list": r,
  "brain settings set": u("inputs"),
  "brain settings unset": u("inputs"),
  "brain sgrep": r,
  "brain signal": w(V, [
    "brain",
    "signal",
    "retire",
    "sig-2026-05-03-neutral-probe-signal",
    "--reason",
    "census",
  ]),
  "brain skill-proposals rewrite-plan": r,
  "brain skill-proposals rewrite-score": u("inputs"),
  "brain snapshot diff": r,
  "brain snapshot log": r,
  "brain source": u("outsideTarget"),
  "brain sources": r,
  "brain stale": r,
  "brain standing-rules clear": u("fixtureState"),
  "brain standing-rules set": u("inputs"),
  "brain standing-rules show": r,
  "brain state": w(V, ["brain", "state", "set", "--aspect", "census", "--value", "on"]),
  "brain status": r,
  "brain storage": { kind: "recorder", records: /^Brain\/metrics\// },
  "brain summary": r,
  "brain synthesise": r,
  "brain telegram-capture": u("network"),
  "brain tension": u("fixtureState"),
  "brain tiers": u("fixtureState"),
  "brain timeline": r,
  "brain today": r,
  "brain token-footprint": r,
  "brain trigger": w(V, ["brain", "trigger", "scan"]),
  "brain truth": w(V, [
    "brain",
    "truth",
    "ingest",
    "--entity",
    "Census",
    "--aspect",
    "owner",
    "--value",
    "fixture",
    "--source",
    "census",
  ]),
  "brain tune": u("inputs"),
  "brain unfreeze": w(V, ["brain", "unfreeze"], [["brain", "freeze", "--reason", "census"]]),
  "brain unlinked": r,
  "brain unpin": w(
    V,
    ["brain", "unpin", "--id", "pref-shared"],
    [["brain", "pin", "--id", "pref-shared"]],
  ),
  "brain unprotect": w(V, ["brain", "unprotect", "--target", "claudecode", "--apply", "--yes"]),
  "brain upgrade": u("inputs"),
  "brain validate": r,
  "brain vitals": { kind: "recorder", records: /^Brain\/metrics\// },
  "brain watchdog": w(V, ["brain", "watchdog"]),
  "brain weekly": r,
  "brain writes destinations": r,
  "brain writes list": r,
  "brain writes prune-images": u("fixtureState"),
  "brain writes revert": u("inputs"),
  completions: o("stdout"),
  "decision-model check": r,
  "decision-model eval list": r,
  "decision-model eval run": o("dmState"),
  "decision-model report": r,
  "decision-model thresholds fit": o("dmState"),
  "decision-model thresholds list": r,
  "decision-model thresholds set": o("dmState"),
  "discipline install": u("host"),
  "discipline report": r,
  "discipline uninstall": u("host"),
  doctor: r,
  "export-config": o("outPath"),
  help: r,
  index: w(V, ["index", "--vault", "{vault}"]),
  init: o("config"),
  install: u("host"),
  "install-cli": o("hostBin"),
  "mcp token list": r,
  "mcp token mint": w(V, [
    "mcp",
    "token",
    "mint",
    "--agent",
    "census-agent",
    "--name",
    "mcp_token_census",
  ]),
  "mcp token revoke": w(
    V,
    ["mcp", "token", "revoke", "--name", "mcp_token_census"],
    [["mcp", "token", "mint", "--agent", "census-agent", "--name", "mcp_token_census"]],
  ),
  "mcp token rotate": w(
    V,
    ["mcp", "token", "rotate", "--name", "mcp_token_census"],
    [["mcp", "token", "mint", "--agent", "census-agent", "--name", "mcp_token_census"]],
  ),
  onboarding: r,
  "partner codegraph report": r,
  "partner codegraph resync": o("stdout"),
  "search check": r,
  "search event-anchor-backfill": u("index"),
  "search expand": r,
  "search feedback": w(G, [
    "search",
    "feedback",
    "--query",
    "lattice",
    "--result",
    "notes/shared.md",
    "--verdict",
    "up",
  ]),
  "search focus": o("index"),
  "search index": { kind: "recorder", records: /^Brain\/metrics\// },
  "search plan": r,
  "search provider": w(G, [
    "search",
    "provider",
    "add",
    "census",
    "--base-url",
    "http://127.0.0.1:9/v1",
    "--env-key",
    "CENSUS_KEY",
  ]),
  "search query": r,
  // A real reindex (the index built first): the index lives in the store's
  // device-local state, the one vault write is its metrics row, which the
  // gate refuses while the reindex itself goes on. The self-heal reindex
  // worker runs this same command.
  "search reindex": {
    kind: "recorder",
    records: /^Brain\/metrics\//,
    argv: ["search", "reindex", "--json"],
    prepare: [["search", "index", "--json"]],
  },
  "search rerank-eval": r,
  "search rerank-fit": u("inputs", G),
  "search rerank-provider": w(G, [
    "search",
    "rerank-provider",
    "add",
    "census",
    "--base-url",
    "http://127.0.0.1:9/v1",
    "--model",
    "m",
    "--env-key",
    "CENSUS_KEY",
  ]),
  "search restamp": u("index"),
  "search schema": r,
  "search set-aside": u("index"),
  "search status": r,
  "search vector-backfill": u("index"),
  "search watch": o("server"),
  "search weights": w(
    G,
    ["search", "weights", "--reset"],
    [
      [
        "search",
        "feedback",
        "--query",
        "lattice",
        "--result",
        "notes/shared.md",
        "--verdict",
        "up",
      ],
    ],
  ),
  "secrets list": r,
  "secrets status": r,
  "state migrate": w(G, ["state", "migrate", "--to", "{dir}/moved-state", "--apply", "--yes"]),
  "state rollback": u("inputs", G),
  "state status": r,
  status: r,
  "store device list": r,
  "store device retire": o("store"),
  "dream owner": o("store"),
  "dream queue cancel": o("store"),
  "dream queue retry": o("store"),
  "store init": o("store"),
  "store partition leave": o("store"),
  "store path": r,
  "store shard list": r,
  "store shard quarantine": o("store"),
  "store shard release": o("store"),
  "tool-call": u("mcpBridge"),
  "topic archive": o("store"),
  "topic assign": o("store"),
  "topic create": o("store"),
  "topic goal": o("store"),
  "topic link": o("store"),
  "topic list": r,
  "topic merge": o("store"),
  "topic record": o("store"),
  "topic rename": o("store"),
  "topic review": r,
  "topic show": r,
  "topic split": o("store"),
  "topic status": o("store"),
  "topic unassign": o("store"),
  "topic undo": o("store"),
  uninstall: u("host"),
  update: o("hostBin"),
  "vault inspect": r,
  "vault map": r,
  "vault profile": r,
  "vault status": r,
  version: r,
  "view recover": o("view"),
  "view render": o("view"),
  "view writer": o("view"),
});

/** Why an MCP writer's probe recipes leave the census fixture unchanged. */
export const MCP_UNDRIVEN =
  "the probe catalogue's recipes for it (tests/helpers/tool-probe-catalogue.ts) stop before " +
  "their first write on the census fixture (an id the fixture lacks, nothing to do, a dry " +
  "run); every recipe is still driven under the gate, where it must leave the vault as it was.";

export type McpRow =
  | { readonly kind: "writer"; readonly guard: Guard; readonly undriven?: true }
  | { readonly kind: "reader" }
  | { readonly kind: "outside"; readonly reason: OutsideReason };

/**
 * Every tool of the full MCP table (`buildToolTable("full")`). A row's kind
 * is the tool's own declared `kind` (asserted), except where noted. Each
 * is driven with every recipe of the probe catalogue.
 */
export const MCP_CENSUS: Readonly<Record<string, McpRow>> = Object.freeze({
  brain_agenda: { kind: "reader" },
  brain_agent_diff: { kind: "reader" },
  brain_agent_query: { kind: "reader" },
  brain_analytics: { kind: "writer", guard: V },
  brain_anticipatory_context: { kind: "writer", guard: V, undriven: true },
  brain_append_note: { kind: "writer", guard: V },
  brain_apply_evidence: { kind: "writer", guard: V },
  brain_artifact_get: { kind: "reader" },
  brain_attestations: { kind: "reader" },
  brain_audit: { kind: "reader" },
  brain_backlinks: { kind: "reader" },
  brain_benchmark: { kind: "reader" },
  brain_bridges: { kind: "writer", guard: V },
  brain_brief: { kind: "writer", guard: V, undriven: true },
  brain_changes: { kind: "reader" },
  brain_claims: { kind: "writer", guard: V },
  brain_clusters: { kind: "writer", guard: V, undriven: true },
  brain_codegraph_report: { kind: "reader" },
  brain_context: { kind: "writer", guard: V, undriven: true },
  brain_context_pack: { kind: "reader" },
  brain_context_pack_outcome: { kind: "writer", guard: V, undriven: true },
  brain_context_presets: { kind: "reader" },
  brain_context_receipts: { kind: "reader" },
  brain_create_note: { kind: "writer", guard: V },
  brain_dead_ends: { kind: "writer", guard: V },
  brain_decision: { kind: "writer", guard: V, undriven: true },
  brain_deep_synthesis: { kind: "writer", guard: V, undriven: true },
  brain_delete_by_source: { kind: "writer", guard: V, undriven: true },
  brain_derive_fact: { kind: "writer", guard: V, undriven: true },
  brain_design_note: { kind: "writer", guard: V },
  brain_diarize: { kind: "reader" },
  brain_distill_source: { kind: "writer", guard: V, undriven: true },
  brain_doctor: { kind: "writer", guard: V, undriven: true },
  brain_dream: { kind: "writer", guard: V },
  brain_entity: { kind: "reader" },
  brain_eval: { kind: "reader" },
  brain_event_trace: { kind: "reader" },
  brain_expire: { kind: "writer", guard: V, undriven: true },
  brain_extract_signals: { kind: "writer", guard: V },
  brain_feedback: { kind: "writer", guard: V },
  brain_file_context: { kind: "reader" },
  brain_foresight: { kind: "reader" },
  brain_generation_reports: { kind: "writer", guard: V },
  brain_health: { kind: "reader" },
  brain_hygiene: { kind: "writer", guard: V, undriven: true },
  brain_idea_discovery: { kind: "writer", guard: V, undriven: true },
  brain_idea_lineage: { kind: "reader" },
  brain_ingest_batch_plan: { kind: "writer", guard: V, undriven: true },
  brain_ingest_source: { kind: "writer", guard: V, undriven: true },
  brain_intake_entities: { kind: "writer", guard: V, undriven: true },
  brain_intake_pledges: { kind: "writer", guard: V },
  brain_intent_review: { kind: "reader" },
  brain_intention: { kind: "writer", guard: V, undriven: true },
  brain_knowledge_gaps: { kind: "reader" },
  brain_labels: { kind: "writer", guard: V, undriven: true },
  brain_lifecycle: { kind: "writer", guard: V },
  brain_maintenance: { kind: "writer", guard: B, undriven: true },
  brain_mcp_landscape: { kind: "reader" },
  brain_memory_bridge: { kind: "writer", guard: V },
  brain_moc_audit: { kind: "reader" },
  brain_note: { kind: "writer", guard: V },
  brain_note_history: { kind: "reader" },
  brain_note_lifecycle: { kind: "writer", guard: V, undriven: true },
  brain_obligation: { kind: "writer", guard: V },
  brain_observed_use: { kind: "writer", guard: V, undriven: true },
  brain_pinned_context: { kind: "writer", guard: V },
  brain_pledge: { kind: "writer", guard: V },
  brain_pre_compact_extract: { kind: "writer", guard: V, undriven: true },
  brain_pre_compress_pack: { kind: "reader" },
  brain_procedural_graph: { kind: "writer", guard: V },
  brain_procedural_memory: { kind: "writer", guard: V },
  brain_query: { kind: "reader" },
  brain_recall_feedback: { kind: "writer", guard: G },
  brain_recall_gate: { kind: "reader" },
  brain_recall_telemetry: { kind: "reader" },
  brain_receipts: { kind: "writer", guard: V, undriven: true },
  brain_recurrence: { kind: "writer", guard: V },
  brain_research_report: { kind: "writer", guard: V, undriven: true },
  brain_retention: { kind: "reader" },
  brain_retrieval_plan: { kind: "reader" },
  brain_review_candidates: { kind: "reader" },
  brain_route_metrics: { kind: "reader" },
  brain_scaffold_stub: { kind: "writer", guard: V, undriven: true },
  brain_search: { kind: "writer", guard: V, undriven: true },
  brain_search_by_source: { kind: "reader" },
  brain_search_expand: { kind: "reader" },
  brain_secrets: { kind: "writer", guard: V, undriven: true },
  brain_session_checkpoint: { kind: "writer", guard: V, undriven: true },
  brain_session_describe: { kind: "reader" },
  brain_session_expand: { kind: "reader" },
  brain_session_grep: { kind: "reader" },
  brain_session_summary: { kind: "writer", guard: V },
  brain_settings: { kind: "writer", guard: V, undriven: true },
  // The dream owner role is three records in the store's shared settings.
  brain_dream_owner: { kind: "outside", reason: "store" },
  brain_skill_proposals: { kind: "writer", guard: V },
  brain_skill_rewrite_status: { kind: "reader" },
  brain_sources: { kind: "reader" },
  brain_stale_scan: { kind: "reader" },
  brain_status: { kind: "reader" },
  brain_storage: { kind: "reader" },
  brain_switch_vault: { kind: "outside", reason: "config" },
  brain_tension: { kind: "writer", guard: V, undriven: true },
  brain_tiers: { kind: "writer", guard: V, undriven: true },
  brain_token_impact: { kind: "writer", guard: V, undriven: true },
  brain_topic: { kind: "writer", guard: V, undriven: true },
  brain_trigger: { kind: "writer", guard: V },
  brain_truth: { kind: "writer", guard: V },
  brain_tune: { kind: "writer", guard: V, undriven: true },
  brain_unlinked_mentions: { kind: "reader" },
  brain_update_note: { kind: "writer", guard: V },
  brain_watchdog: { kind: "writer", guard: V },
  brain_write_batch: { kind: "writer", guard: V, undriven: true },
  brain_write_destinations: { kind: "reader" },
  brain_write_session: { kind: "writer", guard: V, undriven: true },
  brain_writes: { kind: "reader" },
  get_skill: { kind: "reader" },
  list_skills: { kind: "reader" },
  schema_apply_mutations: { kind: "writer", guard: V },
  schema_inspect: { kind: "reader" },
  second_brain_capabilities: { kind: "reader" },
  second_brain_query: { kind: "reader" },
  second_brain_status: { kind: "reader" },
  second_brain_wiring: { kind: "reader" },
  skills_attach: { kind: "reader" },
  tool_hydrate: { kind: "reader" },
  vault_health: { kind: "reader" },
});

export type HookRow =
  | { readonly kind: "writer"; readonly guard: Guard }
  | { readonly kind: "reader" };

/**
 * Every hook `hooks/hooks.json` runs, per event. A hook never fails a
 * session: under the gate it exits 0, prints at most one line on stderr,
 * and leaves the vault byte-identical; a writer is one that changes the
 * vault without a gate on the census payload.
 */
export const HOOK_CENSUS: Readonly<Record<string, HookRow>> = Object.freeze({
  "PostCompact:active-inject": { kind: "reader" },
  "PostCompact:session-capture": { kind: "writer", guard: V },
  "PostToolUse:post-write-reminder": { kind: "reader" },
  "PostToolUse:reground-deliver": { kind: "reader" },
  "PostToolUse:session-capture": { kind: "writer", guard: V },
  "PostToolUse:subagent-inject": { kind: "reader" },
  "PreToolUse:pretool-host-backup": { kind: "reader" },
  "PreToolUse:pretool-orient": { kind: "reader" },
  "SessionEnd:gap-promote": { kind: "reader" },
  "SessionEnd:session-capture": { kind: "writer", guard: V },
  "SessionStart:active-inject": { kind: "writer", guard: B },
  "SessionStart:backlog-nudge": { kind: "reader" },
  "SessionStart:gap-agenda": { kind: "reader" },
  "SessionStart:log-catchup": { kind: "reader" },
  "SessionStart:session-capture": { kind: "writer", guard: V },
  "SessionStart:view-render": { kind: "reader" },
  "Stop:answer-quote-check": { kind: "reader" },
  "Stop:hygiene-digest": { kind: "reader" },
  "Stop:session-capture": { kind: "writer", guard: V },
  "Stop:stop-advisory-deliver": { kind: "reader" },
  "Stop:stop-log-guardrail": { kind: "reader" },
  "SubagentStart:subagent-inject": { kind: "reader" },
  "SubagentStop:session-capture": { kind: "writer", guard: V },
  "UserPromptSubmit:counterparty-brief": { kind: "reader" },
  "UserPromptSubmit:nav-inject": { kind: "reader" },
  "UserPromptSubmit:neighbour-updates": { kind: "writer", guard: B },
  "UserPromptSubmit:recall-inject": { kind: "reader" },
  "UserPromptSubmit:reground-deliver": { kind: "reader" },
  "UserPromptSubmit:session-capture": { kind: "writer", guard: V },
});

export type WorkerRow =
  | { readonly kind: "writer"; readonly guard: Guard; readonly drive: "selfHealUpgrade" }
  | { readonly kind: "same-as"; readonly entry: string }
  | { readonly kind: "outside"; readonly reason: OutsideReason }
  | { readonly kind: "allowed"; readonly reason: keyof typeof ALLOWED_REASON };

/**
 * Every background worker a CLI start, a hook or the MCP server can leave
 * running, and the census entry that drives its writes. `same-as` names a
 * CLI verb (`cli:`) or a hook (`hook:`) running the same code in the
 * foreground: a census run spawns no worker of its own.
 */
export const WORKER_CENSUS: Readonly<Record<string, WorkerRow>> = Object.freeze({
  "automatic store migration (migrate-store --auto)": { kind: "allowed", reason: "migration" },
  "self-heal upgrade of the managed files": {
    kind: "writer",
    guard: B,
    drive: "selfHealUpgrade",
  },
  "self-heal search reindex": { kind: "same-as", entry: "cli:search reindex" },
  "deferred session capture": { kind: "same-as", entry: "hook:Stop:session-capture" },
  "freshen-on-read search index": { kind: "same-as", entry: "cli:search index" },
  "search writer-lock heartbeat thread": { kind: "outside", reason: "server" },
  "automatic store migration worker log": { kind: "outside", reason: "deviceState" },
  "lost automatic migration worker record": { kind: "outside", reason: "deviceState" },
  "dependency bootstrap of a self-spawn": { kind: "outside", reason: "checkout" },
});

/**
 * The files that start a background worker (a detached or unref'ed child
 * process or thread, or a call of the detached self-spawn helper), and the
 * workers each starts with what it records of them. A new spawn site, or
 * one gone, fails the census until this list says what it runs.
 */
export interface SpawnSite {
  /**
   * How many spawn call sites the file holds (a detached option, an
   * unref'ed child or thread, a call of the self-spawn helper, counted in
   * code, not comments): a second worker added to a listed file changes it.
   */
  readonly calls: number;
  readonly starts: ReadonlyArray<string>;
}

export const WORKER_SPAWN_SITES: Readonly<Record<string, SpawnSite>> = Object.freeze({
  "hooks/session-capture.ts": { calls: 1, starts: ["deferred session capture"] },
  "src/core/maintenance/ensure-current.ts": {
    // The self-heal upgrade, the self-heal reindex, the migration worker.
    calls: 3,
    starts: [
      "self-heal upgrade of the managed files",
      "automatic store migration (migrate-store --auto)",
      "self-heal search reindex",
      "lost automatic migration worker record",
    ],
  },
  // The one helper every self-spawn goes through: it hands the migration
  // worker its log, and starts the dependency bootstrap entry when the
  // checkout's tree is missing. Its own definition, its detached option (in
  // the type and the value) and the unref of the child it starts.
  "src/core/maintenance/o2b-command.ts": {
    calls: 4,
    starts: ["automatic store migration worker log", "dependency bootstrap of a self-spawn"],
  },
  "src/core/search/freshen.ts": { calls: 1, starts: ["freshen-on-read search index"] },
  "src/core/search/store/writer-lock.ts": {
    calls: 1,
    starts: ["search writer-lock heartbeat thread"],
  },
});

/**
 * The rows whose writes go to a destination the caller names (`outPath`),
 * and how each is driven with that destination (`{dest}`). The census
 * drives each with a destination inside the vault while its gate is held
 * (refused, the vault byte-identical) and with one outside it (it proceeds
 * and writes there): a user-given path is no way past the gate.
 */
export const DESTINATION_ARGV: Readonly<Record<string, ReadonlyArray<string>>> = Object.freeze({
  "export-config": ["export-config", "--output", "{dest}/config-export.json"],
  "brain export": ["brain", "export", "--format", "json", "--out", "{dest}/export.json"],
  "brain okf-export": ["brain", "okf-export", "--out", "{dest}/okf"],
  "brain knowledge-pack": [
    "brain",
    "knowledge-pack",
    "export",
    "--name",
    "census",
    "--select",
    "pref-shared",
    "--out",
    "{dest}/pack",
  ],
  "brain graph-export": ["brain", "graph-export", "--out", "{dest}/graph.json"],
  "brain bank-export": ["brain", "bank-export", "--out", "{dest}/bank.json"],
  "brain continuity": [
    "brain",
    "continuity",
    "export",
    "--format",
    "atof",
    "--out",
    "{dest}/continuity",
  ],
});

/**
 * The process entry points of the product besides the hooks: the CLI, whose
 * verbs are CLI_CENSUS, and every other file that runs `main()` as a process
 * of its own, named by its worker row.
 */
export const PROCESS_ENTRIES: Readonly<Record<string, string>> = Object.freeze({
  "src/cli/main.ts": "cli",
  "src/cli/deps-bootstrap.ts": "dependency bootstrap of a self-spawn",
});
