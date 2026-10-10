/**
 * Task 11 (write-side-trust wave): ambient consent and TTL.
 *
 * `guardrails.ambient_writeback` is the consent switch for the ambient
 * extraction lane (`routeExtractedFacts`): the keys absent keeps today's
 * behaviour byte-identical; an explicit `false` withholds the whole
 * capture behind ONE counted, logged `ambient-withheld` event per capture
 * and writes no signal. `guardrails.ambient_ttl_days: N` stamps
 * `expiration_date = created + N` on ambient-extracted signals through
 * the validated `writeSignal` chokepoint, so `filterExpired` drops them
 * at read. Both keys live in the vault `Brain/_brain.yaml` guardrails
 * block; a non-boolean consent or a negative TTL is a hard, field-named
 * config error.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";
import { readLogDay } from "../../../src/core/brain/log-jsonl.ts";
import { parseSignal } from "../../../src/core/brain/signal.ts";
import { applyPending, listPending } from "../../../src/core/brain/pending.ts";
import { filterExpired } from "../../../src/core/brain/expiration.ts";
import { routeExtractedFacts, type ExtractedFact } from "../../../src/core/brain/fact-extract.ts";
import {
  BRAIN_GUARDRAIL_DEFAULTS,
  BrainConfigError,
  resolveGuardrails,
  validateBrainConfigDetailed,
} from "../../../src/core/brain/policy.ts";
import { parseBrainYaml } from "../../../src/core/brain/yaml-parse.ts";
import type { DedupIndexEntry } from "../../../src/core/brain/dedup-hash.ts";

let vault: string;
let configHome: string;

const NOW = new Date("2026-07-18T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
/** `NOW + 30 days`, the instant a 30-day TTL from NOW stamps. */
const NOW_PLUS_30D = "2026-08-17T12:00:00Z";

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-ambient-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-ambient-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

/**
 * Overwrite the vault `_brain.yaml` with a minimal config carrying the
 * given guardrails sub-key lines (`key: value` shape, unprefixed).
 */
function writeVaultGuardrails(...subKeys: string[]): void {
  const lines = ["schema_version: 1", ""];
  if (subKeys.length > 0) {
    lines.push("guardrails:", ...subKeys.map((k) => `  ${k}`), "");
  }
  writeFileSync(join(vault, "Brain", "_brain.yaml"), lines.join("\n"), "utf8");
}

function validate(yaml: string) {
  return validateBrainConfigDetailed(parseBrainYaml(yaml), "<test>");
}

function inboxSignalNames(): string[] {
  return readdirSync(brainDirs(vault).inbox).filter(
    (f) => f.startsWith("sig-") && f.endsWith(".md"),
  );
}

function ambientWithheldEvents() {
  return readLogDay(vault, "2026-07-18").entries.filter((e) => e.eventType === "ambient-withheld");
}

const DURABLE_FACTS: ExtractedFact[] = [
  { family: "url", text: "https://techmeat.dev", line: 1 },
  { family: "email", text: "ada@example.com", line: 2 },
];

interface RouteOpts {
  readonly dryRun?: boolean;
  readonly ambientWriteback?: boolean;
  readonly ambientTtlDays?: number;
  readonly writeApprovalEnabled?: boolean;
}

function route(facts: ExtractedFact[], dedup: Map<string, DedupIndexEntry>, opts: RouteOpts = {}) {
  return routeExtractedFacts(vault, {
    facts,
    agent: "claude-dev-agent",
    now: NOW,
    sessionRef: "session#turn-1",
    dedup,
    ...opts,
  });
}

// ----- Config surface (guardrails block) -------------------------------------

describe("guardrails ambient keys - config surface", () => {
  test("keys absent resolve to today's behaviour: consent on, no stamp", () => {
    const { config } = validate("schema_version: 1\n");
    expect(config.guardrails).toBeUndefined();
    const resolved = resolveGuardrails(config);
    expect(resolved.ambient_writeback).toBe(true);
    expect(resolved.ambient_ttl_days).toBe(0);
    expect(BRAIN_GUARDRAIL_DEFAULTS.ambient_writeback).toBe(true);
    expect(BRAIN_GUARDRAIL_DEFAULTS.ambient_ttl_days).toBe(0);
  });

  test("ambient_writeback: false parses and resolves false", () => {
    const { config } = validate("schema_version: 1\nguardrails:\n  ambient_writeback: false\n");
    expect(config.guardrails?.ambient_writeback).toBe(false);
    expect(resolveGuardrails(config).ambient_writeback).toBe(false);
  });

  test("ambient_writeback: true parses and resolves true", () => {
    const { config } = validate("schema_version: 1\nguardrails:\n  ambient_writeback: true\n");
    expect(resolveGuardrails(config).ambient_writeback).toBe(true);
  });

  test("a non-boolean ambient_writeback is a hard field-named error", () => {
    for (const bad of [`"no"`, "1", "null"]) {
      const err = (() => {
        try {
          validate(`schema_version: 1\nguardrails:\n  ambient_writeback: ${bad}\n`);
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(BrainConfigError);
      expect((err as BrainConfigError).field).toBe("guardrails.ambient_writeback");
    }
  });

  test("ambient_ttl_days: 30 parses and resolves 30", () => {
    const { config } = validate("schema_version: 1\nguardrails:\n  ambient_ttl_days: 30\n");
    expect(config.guardrails?.ambient_ttl_days).toBe(30);
    expect(resolveGuardrails(config).ambient_ttl_days).toBe(30);
  });

  test("ambient_ttl_days: 0 is a valid non-negative integer (it means no stamp)", () => {
    const { config } = validate("schema_version: 1\nguardrails:\n  ambient_ttl_days: 0\n");
    expect(resolveGuardrails(config).ambient_ttl_days).toBe(0);
  });

  test("a negative ambient_ttl_days is a hard field-named error", () => {
    const err = (() => {
      try {
        validate("schema_version: 1\nguardrails:\n  ambient_ttl_days: -1\n");
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(BrainConfigError);
    expect((err as BrainConfigError).field).toBe("guardrails.ambient_ttl_days");
  });

  test("a non-integer ambient_ttl_days is a hard field-named error", () => {
    const err = (() => {
      try {
        validate("schema_version: 1\nguardrails:\n  ambient_ttl_days: 2.5\n");
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(BrainConfigError);
    expect((err as BrainConfigError).field).toBe("guardrails.ambient_ttl_days");
  });
});

// ----- Ambient consent (ambient_writeback) ------------------------------------

describe("routeExtractedFacts - ambient consent", () => {
  test("keys absent: the capture lane is unchanged, no ambient-withheld event", () => {
    const result = route(DURABLE_FACTS, new Map());
    expect(result.created).toBe(2);
    expect(result.ambientWithheld).toBe(0);
    expect(inboxSignalNames().length).toBe(2);
    expect(ambientWithheldEvents().length).toBe(0);
  });

  test("explicit false suppresses: no signal, one counted logged event per capture", () => {
    writeVaultGuardrails("ambient_writeback: false");
    const result = route(DURABLE_FACTS, new Map());
    expect(result.created).toBe(0);
    expect(result.ambientWithheld).toBe(2);
    expect(result.durabilityRejected).toBe(0);
    expect(inboxSignalNames().length).toBe(0);

    const events = ambientWithheldEvents();
    expect(events.length).toBe(1);
    const body = events[0]!.body;
    // Log payloads carry counters as strings (the scan-inline convention).
    expect(body["count"]).toBe("2");
    expect(body["agent"]).toBe("claude-dev-agent");
    expect(body["session_ref"]).toBe("session#turn-1");
    // Consent-off means the operator asked for the content not to be
    // captured: the event carries the count, never the fact text.
    // (`origin_channel` is folded in by the reader, not written by us.)
    expect(
      Object.keys(body)
        .filter((k) => k !== "origin_channel")
        .toSorted(),
    ).toEqual(["agent", "count", "session_ref"]);
  });

  test("one event per capture, not per fact, across two captures", () => {
    writeVaultGuardrails("ambient_writeback: false");
    route(DURABLE_FACTS, new Map());
    route([{ family: "url", text: "https://second.example", line: 1 }], new Map());
    expect(ambientWithheldEvents().length).toBe(2);
  });

  test("explicit true keeps the lane on", () => {
    writeVaultGuardrails("ambient_writeback: true");
    const result = route(DURABLE_FACTS, new Map());
    expect(result.created).toBe(2);
    expect(result.ambientWithheld).toBe(0);
    expect(ambientWithheldEvents().length).toBe(0);
  });

  test("a suppressed capture consumes no dedup entries, so later consent writes them", () => {
    writeVaultGuardrails("ambient_writeback: false");
    const dedup = new Map<string, DedupIndexEntry>();
    route(DURABLE_FACTS, dedup);
    expect(dedup.size).toBe(0);

    writeVaultGuardrails("ambient_writeback: true");
    const second = route(DURABLE_FACTS, dedup);
    expect(second.created).toBe(2);
    expect(dedup.size).toBe(2);
  });

  test("an injected ambientWriteback: false suppresses a dry run without logging", () => {
    const result = route(DURABLE_FACTS, new Map(), { dryRun: true, ambientWriteback: false });
    expect(result.created).toBe(0);
    expect(result.withheld).toBe(0);
    expect(result.ambientWithheld).toBe(2);
    expect(ambientWithheldEvents().length).toBe(0);
  });

  test("a config false also governs a dry run: the rehearsal forecasts nothing", () => {
    writeVaultGuardrails("ambient_writeback: false");
    const result = route(DURABLE_FACTS, new Map(), { dryRun: true });
    expect(result.withheld).toBe(0);
    expect(result.ambientWithheld).toBe(2);
    expect(ambientWithheldEvents().length).toBe(0);
  });

  test("an empty capture logs nothing even when suppressed", () => {
    writeVaultGuardrails("ambient_writeback: false");
    const result = route([], new Map());
    expect(result.ambientWithheld).toBe(0);
    expect(ambientWithheldEvents().length).toBe(0);
  });
});

// ----- Ambient TTL (ambient_ttl_days) -----------------------------------------

describe("routeExtractedFacts - ambient TTL", () => {
  test("ambient_ttl_days: 30 stamps expiration_date = created + 30 days", () => {
    writeVaultGuardrails("ambient_ttl_days: 30");
    const result = route(DURABLE_FACTS, new Map());
    expect(result.created).toBe(2);
    for (const name of inboxSignalNames()) {
      const parsed = parseSignal(join(brainDirs(vault).inbox, name));
      expect(parsed.expiration_date).toBe(NOW_PLUS_30D);
    }
  });

  test("filterExpired drops a TTL-stamped signal past its TTL and keeps it before", () => {
    writeVaultGuardrails("ambient_ttl_days: 30");
    route(DURABLE_FACTS, new Map());
    const parsed = parseSignal(join(brainDirs(vault).inbox, inboxSignalNames()[0]!));
    expect(filterExpired([parsed], { now: new Date(NOW.getTime() + 29 * DAY_MS) }).length).toBe(1);
    expect(filterExpired([parsed], { now: new Date(NOW.getTime() + 31 * DAY_MS) }).length).toBe(0);
  });

  test("no TTL writes no expiration_date (byte-identical)", () => {
    const result = route(DURABLE_FACTS, new Map());
    expect(result.created).toBe(2);
    for (const name of inboxSignalNames()) {
      const text = readFileSync(join(brainDirs(vault).inbox, name), "utf8");
      expect(text).not.toContain("expiration_date");
      expect(parseSignal(join(brainDirs(vault).inbox, name)).expiration_date).toBeUndefined();
    }
  });

  test("an injected ambientTtlDays wins over the config", () => {
    writeVaultGuardrails("ambient_ttl_days: 5");
    route(DURABLE_FACTS, new Map(), { ambientTtlDays: 30 });
    const parsed = parseSignal(join(brainDirs(vault).inbox, inboxSignalNames()[0]!));
    expect(parsed.expiration_date).toBe(NOW_PLUS_30D);
  });

  test("ambient_ttl_days: 0 means no stamp (documented disabled value)", () => {
    writeVaultGuardrails("ambient_ttl_days: 0");
    route(DURABLE_FACTS, new Map());
    const parsed = parseSignal(join(brainDirs(vault).inbox, inboxSignalNames()[0]!));
    expect(parsed.expiration_date).toBeUndefined();
  });

  test("staging composes: a TTL-stamped signal stages under the signals gate", () => {
    writeVaultGuardrails("ambient_ttl_days: 30");
    const result = route(DURABLE_FACTS, new Map(), { writeApprovalEnabled: true });
    expect(result.created).toBe(2);
    expect(result.ambientWithheld).toBe(0);
    expect(inboxSignalNames().length).toBe(0);
    const pending = listPending(vault);
    expect(pending.length).toBe(2);
    for (const entry of pending) {
      expect(parseSignal(entry.path).expiration_date).toBe(NOW_PLUS_30D);
    }
  });

  test("expiration survives apply verbatim", () => {
    writeVaultGuardrails("ambient_ttl_days: 30");
    route(DURABLE_FACTS, new Map(), { writeApprovalEnabled: true });
    const pending = listPending(vault).toSorted((a, b) => a.id.localeCompare(b.id));
    const applied = applyPending(vault, pending[0]!.id);
    expect(applied.path.startsWith(brainDirs(vault).inbox)).toBe(true);
    expect(parseSignal(applied.path).expiration_date).toBe(NOW_PLUS_30D);
  });
});
