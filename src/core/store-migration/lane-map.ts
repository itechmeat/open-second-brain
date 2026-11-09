/**
 * Where the `Brain/` lanes outside `STATE_SURFACES` go (task 2.1). The
 * state catalogue lists state locations; the memory itself (signals,
 * preferences, pinned context) and the per-device ledgers it keeps beside
 * them live in lanes the catalogue does not list, and they are the bulk
 * of what a migration moves. Each lane has the same mapping shape as a
 * surface (`destinations.ts`).
 *
 * Only lanes with a decided destination are here. Every other entry of
 * the legacy tree (the Markdown entity lanes such as procedures, pledges
 * or obligations) is reported by the dry run as unmapped, which fails it,
 * until a later task gives it a record kind.
 */

import { join } from "node:path";

import { IDEMPOTENCY_GRAMMAR } from "../brain/idempotency-ledger.ts";
import { COMMITS_GRAMMAR, gitStoreRootDir } from "../brain/git/store.ts";
import { jsonlLedgerGrammar } from "../brain/ledger-shards.ts";
import { LOG_GRAMMAR } from "../brain/log-jsonl.ts";
import {
  BRAIN_ACTIVE_FILE,
  BRAIN_ARCHIVED_SIGNALS_REL,
  BRAIN_BASES_REL,
  BRAIN_CONFIG_FILE,
  BRAIN_INBOX_REL,
  BRAIN_INDEX_FILE,
  BRAIN_LESSONS_FILE,
  BRAIN_LOG_REL,
  BRAIN_MANUAL_FILE,
  BRAIN_PENDING_REL,
  BRAIN_PINNED_FILE,
  BRAIN_PREFERENCES_REL,
  BRAIN_PROCESSED_REL,
  BRAIN_RETIRED_REL,
  BRAIN_ROOT_REL,
  BRAIN_SCOPED_RULES_DIR,
  BRAIN_SKILL_PROPOSALS_REL,
  BRAIN_STANDING_RULES_FILE,
  VERIFIER_REJECTION_LEDGER_STEM,
} from "../brain/path-constants.ts";
import { CLAIMS_GRAMMAR, truthDir } from "../brain/truth/store.ts";
import { VAULT_IDENTITY_FILE } from "../brain/vault-identity.ts";
import { AUDIT_WEEK_SHARD_GRAMMAR } from "../reliability/audit.ts";
import {
  LEDGER_ROW_KIND,
  LEDGER_STREAM,
  PINNED_SET_KIND,
  PREFERENCE_SET_KIND,
  SIGNAL_KIND,
} from "../store/constants.ts";
import { DUAL_WRITE_LEDGERS } from "../store/dual-write-records.ts";
import { STANDING_RULE_LANE } from "../store/lane-records.ts";
import { DESTINATION_KIND, plain, rebuildable, type SurfaceMapping } from "./destinations.ts";
import { laneEntries } from "./surface-map.ts";
import {
  auditTrailRow,
  editHistoryRow,
  gitCommitRow,
  idempotencyRow,
  pinnedText,
  preferencePage,
  sharedUnlessNamed,
  signalPage,
  truthClaimRow,
} from "./row-records.ts";

/** One `Brain/` lane outside the state catalogue. */
export interface LegacyLane {
  /** A stable id, distinct from every `STATE_SURFACES` id. */
  readonly id: string;
  readonly label: string;
  /** The lane's location in a vault. */
  readonly root: (vault: string) => string;
  readonly mapping: SurfaceMapping;
  /**
   * The catch-all lane: its one `entries` locator takes every page and
   * JSON file below `root` that no other mapping reads. The catalogue
   * fills in what the others read (`exclude`).
   */
  readonly catchAll?: true;
}

/** The hidden folder agent write sessions keep their entries in. */
const WRITE_SESSIONS_DIR = ".sessions";

const at =
  (...rel: ReadonlyArray<string>) =>
  (vault: string): string =>
    join(vault, ...rel.flatMap((part) => part.split("/")));

/** `pref-<slug>.history[.<device>].jsonl` beside the preference pages. */
const EDIT_HISTORY_GRAMMAR = Object.freeze({
  base: "pref-.+?\\.history",
  extensions: Object.freeze(["jsonl"]),
});

/** The Markdown day pages of the Brain log, beside their JSONL rows. */
const LOG_DAY_PAGE_GRAMMAR = Object.freeze({
  base: LOG_GRAMMAR.base,
  extensions: Object.freeze(["md"]),
});

const NAMED = "private when a row names a private page or one that cannot be judged";

function eventsStream(
  kind: string,
  rule: string,
  record: Extract<SurfaceMapping["destination"], { to: "stream" }>["record"],
): SurfaceMapping["destination"] {
  return {
    to: DESTINATION_KIND.stream,
    stream: "events",
    ledger: null,
    kind,
    partition: "by-item",
    rule,
    record,
  };
}

function ledgerStream(
  ledger: string,
  rule: string,
  record: Extract<SurfaceMapping["destination"], { to: "stream" }>["record"],
  partition: "shared" | "private-when-held" = "shared",
): SurfaceMapping["destination"] {
  return {
    to: DESTINATION_KIND.stream,
    stream: LEDGER_STREAM,
    ledger,
    kind: LEDGER_ROW_KIND,
    partition,
    rule,
    record,
  };
}

const PAGE_RULE = "private when the page is private, or its fields name a private page";

/** Every mapped lane outside `STATE_SURFACES`. */
export const LEGACY_LANES: ReadonlyArray<LegacyLane> = Object.freeze([
  {
    id: "signals",
    label: "signals (inbox, processed, archived, pending)",
    root: at(BRAIN_INBOX_REL),
    mapping: {
      destination: eventsStream(
        SIGNAL_KIND,
        PAGE_RULE + " or carries a private region",
        signalPage,
      ),
      locate: (vault) =>
        [BRAIN_INBOX_REL, BRAIN_PROCESSED_REL, BRAIN_ARCHIVED_SIGNALS_REL, BRAIN_PENDING_REL].map(
          (rel) => ({ shape: "pages", dir: at(rel)(vault) }),
        ),
    },
  },
  {
    id: "preferences",
    label: "preferences, active and retired",
    root: at(BRAIN_PREFERENCES_REL),
    mapping: {
      destination: eventsStream(PREFERENCE_SET_KIND, PAGE_RULE, preferencePage),
      locate: (vault) =>
        [BRAIN_PREFERENCES_REL, BRAIN_RETIRED_REL].map((rel) => ({
          shape: "pages",
          dir: at(rel)(vault),
        })),
    },
  },
  {
    id: "preference_edit_history",
    label: "preference edit history",
    root: at(BRAIN_PREFERENCES_REL),
    mapping: {
      destination: ledgerStream(
        DUAL_WRITE_LEDGERS.editHistory,
        "private when the preference is private or the entry names a private page",
        editHistoryRow,
      ),
      locate: (_vault, primary) => [
        { shape: "jsonl", dir: primary, grammar: EDIT_HISTORY_GRAMMAR },
      ],
    },
  },
  {
    id: "pinned_context",
    label: "pinned context",
    root: at(BRAIN_ROOT_REL, BRAIN_PINNED_FILE),
    mapping: {
      destination: eventsStream(
        PINNED_SET_KIND,
        "private when this machine holds that partition, else shared; private only when the " +
          "text carries a private region or links a private page",
        pinnedText,
      ),
      locate: (_vault, primary) => [{ shape: "text", path: primary }],
    },
  },
  {
    id: "idempotency_ledger",
    label: "idempotency receipts",
    root: at(BRAIN_ROOT_REL, "logs", "idempotency"),
    mapping: {
      destination: ledgerStream(DUAL_WRITE_LEDGERS.idempotency, NAMED, idempotencyRow),
      locate: (_vault, primary) => [{ shape: "jsonl", dir: primary, grammar: IDEMPOTENCY_GRAMMAR }],
    },
  },
  {
    id: "truth_claims",
    label: "truth claims",
    root: truthDir,
    mapping: {
      destination: ledgerStream(
        DUAL_WRITE_LEDGERS.truthClaims,
        "private when this machine holds that partition, else shared; private only when the " +
          "claim's source is a private page",
        truthClaimRow,
        "private-when-held",
      ),
      locate: (_vault, primary) => [{ shape: "jsonl", dir: primary, grammar: CLAIMS_GRAMMAR }],
    },
  },
  {
    id: "verifier_rejections",
    label: "skill verifier rejections",
    root: at(BRAIN_SKILL_PROPOSALS_REL),
    mapping: {
      destination: ledgerStream(
        DUAL_WRITE_LEDGERS.verifierRejections,
        NAMED,
        sharedUnlessNamed(DUAL_WRITE_LEDGERS.verifierRejections),
      ),
      locate: (_vault, primary) => [
        {
          shape: "jsonl",
          dir: primary,
          grammar: jsonlLedgerGrammar(VERIFIER_REJECTION_LEDGER_STEM),
        },
      ],
    },
  },
  {
    id: "git_commits",
    label: "git commit ledgers",
    root: gitStoreRootDir,
    mapping: {
      destination: ledgerStream(
        DUAL_WRITE_LEDGERS.gitCommits,
        "private when this machine holds that partition, else shared",
        gitCommitRow,
        "private-when-held",
      ),
      locate: (_vault, primary) => [
        { shape: "jsonl", dir: primary, grammar: COMMITS_GRAMMAR, subdirs: true },
      ],
    },
  },
  {
    id: "log_audit_trails",
    label: "audit trails under the Brain log",
    root: at(BRAIN_LOG_REL),
    mapping: {
      destination: ledgerStream(
        DUAL_WRITE_LEDGERS.reliabilityAudit,
        "private when this machine holds that partition, else shared; " + NAMED,
        auditTrailRow,
        "private-when-held",
      ),
      locate: (_vault, primary) => [
        { shape: "jsonl", dir: primary, grammar: AUDIT_WEEK_SHARD_GRAMMAR, subdirs: true },
      ],
    },
  },
  {
    id: "log_day_pages",
    label: "Brain log day pages",
    root: at(BRAIN_LOG_REL),
    mapping: rebuildable({
      ...plain(
        DESTINATION_KIND.drop,
        "the readable copy of the JSONL rows beside it, which migrate; the history page " +
          "of the human view replaces it",
      ),
      locate: (_vault, primary) => [
        { shape: "tree", path: primary, grammar: LOG_DAY_PAGE_GRAMMAR },
      ],
    }),
  },
  {
    id: "brain_config",
    label: "Brain settings file",
    root: at(BRAIN_ROOT_REL, BRAIN_CONFIG_FILE),
    mapping: plain(
      DESTINATION_KIND.backup,
      "vault-level settings; keys every machine must agree on become shared settings records",
    ),
  },
  {
    id: "vault_identity",
    label: "vault identity marker",
    root: at(BRAIN_ROOT_REL, VAULT_IDENTITY_FILE),
    mapping: plain(
      DESTINATION_KIND.backup,
      "the vault id every dual-written record carries; kept so the vault stays recognisable",
    ),
  },
  {
    id: "standing_rules",
    label: "standing rules, global and scoped",
    root: at(BRAIN_ROOT_REL, BRAIN_STANDING_RULES_FILE),
    mapping: {
      ...laneEntries(STANDING_RULE_LANE),
      locate: (vault, primary) => [
        { shape: "entries", root: primary, lane: STANDING_RULE_LANE },
        {
          shape: "entries",
          root: at(BRAIN_ROOT_REL, BRAIN_SCOPED_RULES_DIR)(vault),
          lane: STANDING_RULE_LANE,
        },
      ],
    },
  },
  {
    id: "write_sessions",
    label: "agent write sessions",
    root: at(BRAIN_ROOT_REL, WRITE_SESSIONS_DIR),
    mapping: laneEntries("write-session"),
  },
  {
    id: "bases_views",
    label: "Obsidian Bases views",
    root: at(BRAIN_BASES_REL),
    mapping: rebuildable(
      plain(
        DESTINATION_KIND.drop,
        "generated view definitions; the vault adapter writes them again when a vault is configured",
      ),
    ),
  },
  {
    id: "compiled_pages",
    label: "compiled and release-owned pages",
    root: at(BRAIN_ROOT_REL, BRAIN_ACTIVE_FILE),
    mapping: rebuildable({
      ...plain(
        DESTINATION_KIND.drop,
        "generated from preferences or shipped with the release; written again after the switch",
      ),
      locate: (vault) =>
        [BRAIN_ACTIVE_FILE, BRAIN_LESSONS_FILE, BRAIN_MANUAL_FILE, BRAIN_INDEX_FILE].map(
          (name) => ({ shape: "tree", path: at(BRAIN_ROOT_REL, name)(vault) }),
        ),
    }),
  },
  {
    id: "skills",
    label: "accepted skills (SKILL.md files agents read)",
    root: at(BRAIN_ROOT_REL, "skills"),
    mapping: {
      ...plain(
        DESTINATION_KIND.vaultFiles,
        "files agents read, never store records: moved to the vault's skills/ folder, " +
          "outside the legacy tree (the switched machine's default skills directory)",
      ),
      locate: (_vault, primary) => [{ shape: "tree", path: primary }],
    },
  },
  {
    id: "record_lanes",
    label: "record lanes (one lane-entry per page, lane named by its folder)",
    root: at(BRAIN_ROOT_REL),
    catchAll: true,
    mapping: {
      ...laneEntries("brain"),
      locate: (_vault, primary) => [{ shape: "entries", root: primary, lane: null }],
    },
  },
]);
