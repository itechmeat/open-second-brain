/**
 * The opencode plugin's claim to carry the plugin's hooks, measured.
 *
 * The plugin relays a subset of the Claude Code hook layer through
 * single-file registrations that spawn the same `o2b-hook` shims. Until
 * now nothing checked that claim: a shim the plugin stopped spawning, or
 * a registration a refactor deleted, would silently narrow what an
 * opencode install carries while `hooks/hooks.json` (the source of
 * truth) kept promising the capability.
 *
 * Following the grok precedent, this census derives the required
 * `<event>:<hook>` row set from `hooks/hooks.json`, requires the plugin
 * source to cover every row - through an opencode carrier family whose
 * source markers must all be present - and forces every remaining gap
 * to be a written divergence with a reason. A stale divergence (the gap
 * closed, or the entry names nothing real) fails too, so the map cannot
 * become a list of things that used to be true, and non-vacuous size
 * floors keep a parser regression from passing over empty sets.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const PLUGIN_HOOKS_JSON = join(REPO_ROOT, "hooks", "hooks.json");
const PLUGIN_SOURCE_PATH = join(REPO_ROOT, "plugins", "opencode", "open-second-brain.ts");
const INSTALL_DOC_PATH = join(REPO_ROOT, "install", "opencode.md");

const PLUGIN_SOURCE = readFileSync(PLUGIN_SOURCE_PATH, "utf8");
const INSTALL_DOC = readFileSync(INSTALL_DOC_PATH, "utf8");

/**
 * Hooks the plugin deliberately does not carry, keyed `<event>:<hook>`,
 * each with the reason an operator would need. Two entries key
 * opencode-specific behavioral caveats rather than hooks.json rows
 * (`PreToolUse:nudge-channel`, `UserPromptSubmit:pre-admission-caveat`);
 * their staleness rule checks that the qualified mechanism is still
 * registered in the plugin source.
 *
 * A divergence is a written decision or it is a defect. A stale entry
 * fails too - see the tests below - so this cannot become a list of
 * things that used to be true.
 */
const DECLARED_OPENCODE_DIVERGENCES: Readonly<Record<string, string>> = Object.freeze({
  "Stop:stop-log-guardrail":
    "opencode exposes no blocking stop hook, so the veto that holds an unlogged artifact turn cannot be reproduced (documented known gap)",
  "Stop:answer-quote-check":
    "opencode exposes no stop hook to audit quoted spans against the turn's notes on turn end",
  "Stop:hygiene-digest":
    "opencode exposes no stop hook to surface pending hygiene findings on turn end",
  "SubagentStart:subagent-inject":
    "opencode has no subagent spawn hook; there is no subagent lifecycle event to deliver context to",
  "PreToolUse:nudge-channel":
    "opencode tool calls carry no additionalContext channel, so the orient allow-verdict nudge passes silently; only a structured deny is relayed",
  "UserPromptSubmit:pre-admission-caveat":
    "the prompt hook observes before durable prompt admission, so shim context rides the context hook's per-turn queue instead of the prompt event",
  "PostToolUse:subagent-inject":
    "opencode tool events carry no agent_id, so the subagent/main-thread discrimination the PostToolUse fallback carrier relies on does not exist",
  "PostToolUse:reground-deliver":
    "reground parts ride the prompt lane's per-turn queue; opencode has no per-tool-call context channel to re-deliver on",
  "SessionStart:gap-agenda":
    "opencode exposes no session-start hook to a loaded plugin; the opt-in recall-gap agenda shim has no carrier outside Claude Code / Codex",
  "SessionStart:backlog-nudge":
    "opencode exposes no session-start hook to a loaded plugin; the opt-in backlog nudge shim has no carrier outside Claude Code / Codex",
  "SessionStart:log-catchup":
    "opencode exposes no session-start hook to a loaded plugin; the opt-in log catch-up shim has no carrier outside Claude Code / Codex",
  "SessionEnd:gap-promote":
    "opencode exposes no session-end hook; gap promotion runs only where the Claude Code lane fires it",
  "SubagentStop:session-capture":
    "opencode has no subagent lifecycle events, so a delegated sub-agent's turns never enter a capturable session",
});

/** The divergence keys this lane froze in plan.md; pinned by name below. */
const FROZEN_DIVERGENCE_KEYS: ReadonlyArray<string> = [
  "Stop:stop-log-guardrail",
  "Stop:answer-quote-check",
  "Stop:hygiene-digest",
  "SubagentStart:subagent-inject",
  "PreToolUse:nudge-channel",
  "UserPromptSubmit:pre-admission-caveat",
];

/**
 * One opencode carrier family: the hooks.json rows it accounts for, and
 * the source markers that must ALL be present in the plugin for the
 * family to count as carried. Requiring the marker conjunction - not
 * just the shim names - is what makes removing an execute.before
 * registration fail the census even though the spawn literal survives.
 */
const COVERAGE_FAMILIES: ReadonlyArray<{
  readonly id: string;
  readonly rows: ReadonlyArray<string>;
  readonly markers: ReadonlyArray<RegExp>;
}> = [
  {
    id: "context inject (SessionStart/PostCompact active-inject)",
    rows: ["SessionStart:active-inject", "PostCompact:active-inject"],
    markers: [/"active-inject"/, /experimental\.chat\.system\.transform|session\.hook\("context"/],
  },
  {
    id: "tool gate (PreToolUse relay)",
    rows: ["PreToolUse:pretool-orient", "PreToolUse:pretool-host-backup"],
    markers: [/execute\.before/, /"pretool-orient"/, /"pretool-host-backup"/],
  },
  {
    id: "prompt lane (UserPromptSubmit relay)",
    rows: [
      "UserPromptSubmit:recall-inject",
      "UserPromptSubmit:nav-inject",
      "UserPromptSubmit:counterparty-brief",
      "UserPromptSubmit:reground-deliver",
    ],
    markers: [
      /chat\.message|session\.hook\("prompt"/,
      /"recall-inject"/,
      /"nav-inject"/,
      /"counterparty-brief"/,
      /"reground-deliver"/,
    ],
  },
  {
    id: "post-write reminder (PostToolUse write row)",
    rows: ["PostToolUse:post-write-reminder"],
    markers: [/execute\.after/, /POST_WRITE_NUDGE/],
  },
  {
    id: "session capture (turn-end spool snapshots)",
    rows: [
      "PostToolUse:session-capture",
      "SessionStart:session-capture",
      "UserPromptSubmit:session-capture",
      "Stop:session-capture",
      "SessionEnd:session-capture",
      "PostCompact:session-capture",
    ],
    markers: [/writeSpool/, /CAPTURE_EVENTS/],
  },
];

/**
 * Behavioral divergence keys and the source markers of the mechanism
 * each caveat qualifies. While the mechanism is registered the caveat
 * stands; when the mechanism disappears the entry is stale.
 */
const BEHAVIORAL_DIVERGENCE_SITES: Readonly<Record<string, ReadonlyArray<RegExp>>> = Object.freeze({
  "PreToolUse:nudge-channel": [/execute\.before/, /"pretool-orient"/],
  "UserPromptSubmit:pre-admission-caveat": [/chat\.message|session\.hook\("prompt"/],
});

/** `<event>:<hook-script-name>` for every hook one JSON hooks file registers. */
function parseHookRows(hooksJson: string): ReadonlySet<string> {
  const parsed = JSON.parse(hooksJson) as {
    hooks: Record<string, ReadonlyArray<{ hooks: ReadonlyArray<{ command: string }> }>>;
  };
  const out = new Set<string>();
  for (const [event, groups] of Object.entries(parsed.hooks)) {
    for (const group of groups) {
      for (const entry of group.hooks) {
        out.add(`${event}:${hookScriptName(entry.command)}`);
      }
    }
  }
  return out;
}

/** The real derivation: the same parse, refusing any command it cannot read. */
function registeredHooks(hooksJson: string): ReadonlySet<string> {
  const rows = parseHookRows(hooksJson);
  const unread = [...rows].filter((key) => key.endsWith(":<unrecognised>"));
  expect(unread).toEqual([]);
  return rows;
}

/**
 * The hook entry point a command invokes, in the shape this repo writes
 * it: the plugin's `o2b-hook <name>` shell line (Claude Code, Codex).
 */
function hookScriptName(command: string): string {
  const viaLauncher = /o2b-hook\s+([a-z0-9-]+)/.exec(command);
  if (viaLauncher?.[1] !== undefined) return viaLauncher[1];
  return "<unrecognised>";
}

/** Rows carried by every family whose markers are all present in `source`. */
function familyCoverage(source: string): ReadonlySet<string> {
  const covered = new Set<string>();
  for (const family of COVERAGE_FAMILIES) {
    if (family.markers.every((marker) => marker.test(source))) {
      for (const row of family.rows) covered.add(row);
    }
  }
  return covered;
}

/**
 * The census verdict over one (required, covered, declared, source)
 * tuple: which required rows have neither a carrier nor a declaration,
 * and which declarations have outlived their gap.
 */
function censusReport(input: {
  required: ReadonlySet<string>;
  covered: ReadonlySet<string>;
  declared: Readonly<Record<string, string>>;
  source: string;
}): { missing: string[]; stale: string[] } {
  const missing = [...input.required]
    .filter((key) => !input.covered.has(key) && !(key in input.declared))
    .toSorted();
  const stale = Object.keys(input.declared)
    .filter((key) => {
      if (input.required.has(key)) {
        // A real row: stale once a carrier covers it.
        return input.covered.has(key);
      }
      const site = BEHAVIORAL_DIVERGENCE_SITES[key];
      if (site === undefined) {
        // Names no hooks.json row and no known behavior: it excuses nothing.
        return true;
      }
      return !site.every((marker) => marker.test(input.source));
    })
    .toSorted();
  return { missing, stale };
}

describe("opencode plugin carries the plugin's hooks", () => {
  const required = registeredHooks(readFileSync(PLUGIN_HOOKS_JSON, "utf8"));
  const covered = familyCoverage(PLUGIN_SOURCE);
  const report = censusReport({
    required,
    covered,
    declared: DECLARED_OPENCODE_DIVERGENCES,
    source: PLUGIN_SOURCE,
  });

  test("the derivations read real sets, not empty ones", () => {
    // Floors sit well under the live measurements. Without them a parser
    // that stopped recognising commands would report a clean sweep over
    // empty sets, which is the failure mode this file exists to prevent.
    expect(required.size).toBeGreaterThan(10);
    expect(Object.keys(DECLARED_OPENCODE_DIVERGENCES).length).toBeGreaterThanOrEqual(6);
    expect(covered.size).toBeGreaterThan(5);
  });

  test("the parser reads the rows this lane is accountable for", () => {
    expect([...required].filter((key) => key.startsWith("SubagentStop:"))).toEqual([
      "SubagentStop:session-capture",
    ]);
    for (const key of [
      "PreToolUse:pretool-orient",
      "PreToolUse:pretool-host-backup",
      "UserPromptSubmit:recall-inject",
      "UserPromptSubmit:nav-inject",
      "UserPromptSubmit:counterparty-brief",
      "UserPromptSubmit:reground-deliver",
      "SessionStart:active-inject",
      "Stop:session-capture",
    ]) {
      expect(required.has(key)).toBe(true);
    }
  });

  test("every plugin hook is carried by the opencode source or declared as a divergence", () => {
    // Named, not counted: the failure has to say which row.
    expect(report.missing).toEqual([]);
  });

  test("no divergence outlives the gap it excuses", () => {
    expect(report.stale).toEqual([]);
  });

  test("the frozen divergence keys are all declared", () => {
    for (const key of FROZEN_DIVERGENCE_KEYS) {
      expect(key in DECLARED_OPENCODE_DIVERGENCES).toBe(true);
    }
  });

  test("every declared divergence carries a reason", () => {
    for (const [key, reason] of Object.entries(DECLARED_OPENCODE_DIVERGENCES)) {
      expect(`${key}: ${reason.trim().length > 0}`).toBe(`${key}: true`);
    }
  });

  test("the census families resolve against the real source, not vacuously", () => {
    // Each family's markers must match the shipped source individually:
    // a family whose markers went stale would silently stop covering its
    // rows and the missing test above would only catch it if no
    // divergence excused them.
    for (const family of COVERAGE_FAMILIES) {
      for (const marker of family.markers) {
        expect(`${family.id}: ${marker.test(PLUGIN_SOURCE)}`).toBe(`${family.id}: true`);
      }
    }
  });

  test("install/opencode.md names the gate, the prompt lane, and every divergence", () => {
    // The docs table is the operator-facing half of the census: the gate
    // and the prompt lane must be named capabilities, and every declared
    // divergence must appear verbatim so an operator can look each
    // decision up.
    const doc = INSTALL_DOC.toLowerCase();
    expect(doc).toContain("execute.before");
    expect(doc).toContain("tool gating");
    expect(doc).toContain("prompt-time injection");
    for (const shim of [
      "recall-inject",
      "nav-inject",
      "counterparty-brief",
      "reground-deliver",
      "pretool-orient",
      "pretool-host-backup",
    ]) {
      expect(INSTALL_DOC).toContain(shim);
    }
    for (const key of Object.keys(DECLARED_OPENCODE_DIVERGENCES)) {
      // Named, not boolean: the failure has to say which key is missing.
      const absent = INSTALL_DOC.includes(key) ? [] : [key];
      expect(absent).toEqual([]);
    }
    expect(/live verification/i.test(INSTALL_DOC)).toBe(true);
  });
});

describe("opencode parity census failure modes", () => {
  const required = registeredHooks(readFileSync(PLUGIN_HOOKS_JSON, "utf8"));
  const covered = familyCoverage(PLUGIN_SOURCE);

  test("removing an execute.before registration from the plugin source fails the census", () => {
    const doctored = PLUGIN_SOURCE.replaceAll("execute.before", "execute.never").replaceAll(
      "pretool-orient",
      "shim-removed",
    );
    const report = censusReport({
      required,
      covered: familyCoverage(doctored),
      declared: DECLARED_OPENCODE_DIVERGENCES,
      source: doctored,
    });
    expect(report.missing).toContain("PreToolUse:pretool-orient");
    expect(report.missing).toContain("PreToolUse:pretool-host-backup");
    // The nudge caveat qualifies the gate; the gate is gone, so the
    // caveat is stale in the same run.
    expect(report.stale).toContain("PreToolUse:nudge-channel");
  });

  test("removing a divergence entry while the gap persists fails the census", () => {
    const declared = { ...DECLARED_OPENCODE_DIVERGENCES };
    delete declared["Stop:stop-log-guardrail"];
    const report = censusReport({ required, covered, declared, source: PLUGIN_SOURCE });
    expect(report.missing).toContain("Stop:stop-log-guardrail");
  });

  test("adding a hooks.json row without an opencode decision fails the census", () => {
    const requiredWithNewRow = new Set(required).add("Stop:brand-new-guard");
    const report = censusReport({
      required: requiredWithNewRow,
      covered,
      declared: DECLARED_OPENCODE_DIVERGENCES,
      source: PLUGIN_SOURCE,
    });
    expect(report.missing).toContain("Stop:brand-new-guard");
  });

  test("a declared divergence a carrier has closed is stale", () => {
    const report = censusReport({
      required,
      covered,
      declared: { ...DECLARED_OPENCODE_DIVERGENCES, "SessionStart:active-inject": "excuse" },
      source: PLUGIN_SOURCE,
    });
    expect(report.stale).toContain("SessionStart:active-inject");
  });

  test("a divergence naming nothing real is stale", () => {
    const report = censusReport({
      required,
      covered,
      declared: { ...DECLARED_OPENCODE_DIVERGENCES, "Stop:hook-that-never-was": "excuse" },
      source: PLUGIN_SOURCE,
    });
    expect(report.stale).toContain("Stop:hook-that-never-was");
  });

  test("the pre-admission caveat goes stale when the prompt lane disappears", () => {
    const doctored = PLUGIN_SOURCE.replaceAll(
      'session.hook("prompt"',
      'session.hook("prompt-gone"',
    ).replaceAll("chat.message", "chat.gone");
    const report = censusReport({
      required,
      covered: familyCoverage(doctored),
      declared: DECLARED_OPENCODE_DIVERGENCES,
      source: doctored,
    });
    expect(report.stale).toContain("UserPromptSubmit:pre-admission-caveat");
    expect(report.missing).toContain("UserPromptSubmit:recall-inject");
  });

  test("the floors reject a vacuous pass after a parser regression", () => {
    // A parser that stopped recognising commands produces a set of
    // <unrecognised> rows and a census with nothing real to flag; the
    // size floors on the real derivation are the guard.
    const regressed = parseHookRows(
      '{"hooks":{"Stop":[{"matcher":"*","hooks":[{"type":"command","command":"echo nope"}]}]}}',
    );
    expect(regressed.has("Stop:<unrecognised>")).toBe(true);
    expect(regressed.size).toBeLessThan(11);
    expect(registeredHooks(readFileSync(PLUGIN_HOOKS_JSON, "utf8")).size).toBeGreaterThan(10);
  });
});
