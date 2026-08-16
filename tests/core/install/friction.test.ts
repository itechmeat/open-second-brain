/**
 * The per-host friction matrix, and the end of the blanket no-handshake
 * claim.
 *
 * Two properties this file exists to hold:
 *
 *   1. The matrix is DERIVED. Its rows come from the live adapter
 *      registry and its cells from `RUNTIME_FACTS`, so a runtime added to
 *      the fact table and the registry appears here without a line of
 *      this file changing. Every cell assertion below reads its expected
 *      value out of the same fact row the implementation reads, never out
 *      of a literal copied from it - a test that pins "cursor: 40" passes
 *      for a matrix that ignores the table entirely.
 *   2. A target whose fact row declares a host probe no longer prints the
 *      blanket "no MCP handshake attempted" note. Both probe branches -
 *      the binary answering and the binary being absent - are driven
 *      through a real plan+apply into a temp home, because a probe that
 *      reports `ok` when it could not run is the misleading default this
 *      whole release removes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { registerAllAdapters } from "../../../src/core/install/adapters/all.ts";
import {
  resetCodexRunner,
  setCodexRunner,
  type CodexRunner,
} from "../../../src/core/install/adapters/codex.ts";
import {
  resetCopilotRunner,
  setCopilotRunner,
  type CopilotRunner,
} from "../../../src/core/install/adapters/copilot-cli.ts";
import {
  buildFrictionMatrix,
  diffFrictionRows,
  FRICTION_DIMENSION,
  FRICTION_DIMENSIONS,
  frictionRowFor,
  type FrictionInput,
  type FrictionRow,
} from "../../../src/core/install/friction.ts";
import {
  hostProbeCommand,
  NO_HANDSHAKE_NOTE,
  resetHostProbeRunner,
  setHostProbeRunner,
  type HostProbeRunner,
} from "../../../src/core/install/host-probe.ts";
import { OSB_KEY_FULL, OSB_KEY_WRITER } from "../../../src/core/install/json-merge.ts";
import {
  carriesHostDimensions,
  payloadForHost,
  TOOL_PROFILE_FLAG,
} from "../../../src/core/install/payload-host.ts";
import { buildPayload } from "../../../src/core/install/payload.ts";
import {
  INSTALL_TARGET_IDS,
  RUNTIME_FACTS,
  TOOL_CEILING_KIND,
  type InstallTargetId,
} from "../../../src/core/runtime/host-facts.ts";
import type {
  ApplyOpts,
  InstallAdapter,
  InstallEnv,
  SessionPathsResult,
} from "../../../src/core/install/types.ts";

let vault: string;
let home: string;

/**
 * The apply below is REAL, and every mutation seam an adapter owns must be
 * injected before it runs. The rule, not the instance: the host probe is a
 * read-only seam this suite stages per case, but each subprocess-driven
 * adapter carries a SEPARATE seam for the commands that CHANGE the
 * machine, and any of those left on its default runner will spawn the
 * operator's real host binary against the operator's real registration.
 *
 * That is not hypothetical. `codex` was pinned here and `copilot` was not,
 * so on a machine with the Copilot CLI installed this file ran four rounds
 * of `copilot mcp remove` + `copilot mcp add` against the developer's own
 * registration, pointing it at a `/tmp/osb-friction-v-*` vault that
 * `afterEach` then deleted - and CI, where no `copilot` exists, reported
 * a clean pass.
 *
 * Pinning them absent also makes the suite deterministic: a runner that
 * exists on some developer machines and on no CI runner would exercise the
 * subprocess branch here and the file-fallback branch there and report
 * both as the same pass. Both branches have their own coverage in the
 * adapters' own suites; this one pins the fallback so the friction matrix
 * is the only variable.
 */
const ABSENT_CODEX: CodexRunner = {
  available: () => false,
  run: () => ({ exitCode: 1, stdout: "", stderr: "codex is not on PATH" }),
};

const ABSENT_COPILOT: CopilotRunner = {
  available: () => false,
  run: () => ({ exitCode: 1, stdout: "", stderr: "copilot is not on PATH" }),
  list: () => ({ ok: false, names: [] }),
};

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-friction-v-"));
  home = mkdtempSync(join(tmpdir(), "osb-friction-h-"));
  setCodexRunner(ABSENT_CODEX);
  setCopilotRunner(ABSENT_COPILOT);
});

afterEach(() => {
  resetHostProbeRunner();
  resetCodexRunner();
  resetCopilotRunner();
  for (const dir of [vault, home]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // temp cleanup is best-effort
    }
  }
});

function sink(): NodeJS.WriteStream {
  return new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
}

function installEnv(): InstallEnv {
  return {
    vault,
    home,
    cwd: home,
    env: { VAULT_AGENT_NAME: "claude-vps", VAULT_TIMEZONE: "UTC" },
    now: new Date("2026-05-20T12:00:00.000Z"),
  };
}

function applyOpts(): ApplyOpts {
  return { dryRun: false, force: false, stdout: sink(), stderr: sink() };
}

function input(): FrictionInput {
  const env = installEnv();
  return {
    env,
    payload: buildPayload({ vault, agent_name: "claude-vps", timezone: "UTC" }),
    adapters: registerAllAdapters().list(),
  };
}

/** The one cell of `row` for `dimension`; the row is total over the set. */
function cell(row: FrictionRow, dimension: string) {
  const found = row.cells.find((c) => c.dimension === dimension);
  expect(`${row.target} answers ${dimension}: ${found !== undefined}`).toBe(
    `${row.target} answers ${dimension}: true`,
  );
  return found!;
}

describe("the friction matrix is derived, not written", () => {
  test("the row population is the fact table's, in both directions", () => {
    const rows = buildFrictionMatrix(input()).rows;
    expect(rows.map((r) => r.target).toSorted()).toEqual(
      Object.keys(RUNTIME_FACTS).toSorted() as InstallTargetId[],
    );
    // A matrix over an empty registry would satisfy the equality above if
    // the fact table were ever emptied too.
    expect(rows.length).toBeGreaterThan(5);
  });

  test("every row answers every dimension exactly once, in the declared order", () => {
    for (const row of buildFrictionMatrix(input()).rows) {
      expect(`${row.target}: ${row.cells.map((c) => c.dimension).join(",")}`).toBe(
        `${row.target}: ${FRICTION_DIMENSIONS.join(",")}`,
      );
      const empty = row.cells.filter((c) => c.value.trim().length === 0);
      expect(`${row.target} cells with no answer: ${empty.length}`).toBe(
        `${row.target} cells with no answer: 0`,
      );
    }
  });

  test("the ceiling cell carries the fact row's own number and its citation", () => {
    for (const row of buildFrictionMatrix(input()).rows) {
      const ceiling = RUNTIME_FACTS[row.target].toolCeiling;
      const answer = cell(row, FRICTION_DIMENSION.toolCeiling);
      expect(answer.value).toContain(ceiling.kind);
      if (ceiling.kind === TOOL_CEILING_KIND.declared) {
        expect(answer.value).toContain(String(ceiling.maxTools));
        expect(answer.detail).toBe(ceiling.source);
      } else if (ceiling.kind === TOOL_CEILING_KIND.unknown) {
        expect(answer.detail).toBe(ceiling.reason);
      }
    }
  });

  test("the verify-evidence cell names the declared probe, and the blanket note survives only without one", () => {
    for (const row of buildFrictionMatrix(input()).rows) {
      const probe = RUNTIME_FACTS[row.target].hostProbe;
      const answer = cell(row, FRICTION_DIMENSION.verifyEvidence);
      if (probe === null) {
        expect(`${row.target}: ${answer.detail}`).toBe(`${row.target}: ${NO_HANDSHAKE_NOTE}`);
      } else {
        expect(answer.value).toContain(hostProbeCommand(probe));
        expect(answer.detail).toBe(probe.answers);
      }
    }
  });

  test("the session cells report what the fact row declares, not what is on this machine", () => {
    for (const row of buildFrictionMatrix(input()).rows) {
      const facts = RUNTIME_FACTS[row.target];
      const roots = cell(row, FRICTION_DIMENSION.sessionTranscripts);
      if (facts.sessionRoots.length === 0) {
        expect(roots.detail).toBeNull();
      } else {
        expect(roots.value).toContain(String(facts.sessionRoots.length));
        for (const root of facts.sessionRoots) {
          expect(roots.detail ?? "").toContain(root.resolve({ home, env: {} }));
        }
      }
      // The parser cell, on EVERY row. Guarding it behind
      // `sessionAdapter !== null` ran it for three of the ten and left
      // nothing pinning what the other seven say - the rows where the
      // answer is "none ships", which is the answer an operator reads to
      // decide whether importing this host's transcripts is possible at
      // all. The expected value is derived from the row's own roots, the
      // same input the cell is built from.
      const parser = cell(row, FRICTION_DIMENSION.sessionParser);
      const parsers = [
        ...new Set(facts.sessionRoots.map((root) => root.adapter).filter((a) => a !== null)),
      ].toSorted();
      expect(`${row.target}: ${parser.value}`).toBe(
        `${row.target}: ${parsers.length > 0 ? parsers.join(", ") : "none ships"}`,
      );
      if (parsers.length === 0) {
        // Roots in a format nothing reads are named, so "none ships" is a
        // measured answer rather than a shrug; no roots at all is silence.
        for (const format of new Set(facts.sessionRoots.map((root) => root.format))) {
          expect(`${row.target}: ${parser.detail ?? ""}`).toContain(format);
        }
        if (facts.sessionRoots.length === 0) expect(parser.detail).toBeNull();
      }
    }
  });

  test("the mechanism cell is the live adapter's own plan", () => {
    const shared = input();
    for (const adapter of shared.adapters) {
      const kinds = new Set(adapter.plan(shared.payload, shared.env).steps.map((s) => s.kind));
      const answer = cell(frictionRowFor(adapter.target, shared), FRICTION_DIMENSION.mechanism);
      expect(`${adapter.target}: ${answer.value}`).toBe(
        `${adapter.target}: ${[...kinds].toSorted().join(", ")}`,
      );
    }
  });

  test("an unknown target is refused by name, with the known list", () => {
    let message = "";
    try {
      frictionRowFor("claude-code" as InstallTargetId, input());
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("claude-code");
    for (const known of INSTALL_TARGET_IDS) expect(message).toContain(known);
  });
});

describe("a diff names the dimensions that differ and stays silent about the rest", () => {
  test("the differing set is exactly the set of unequal cells, over every pair", () => {
    const rows = buildFrictionMatrix(input()).rows;
    const wrong: string[] = [];
    for (const base of rows) {
      for (const compare of rows) {
        const named = new Set(diffFrictionRows(base, compare).differing.map((d) => d.dimension));
        for (const dimension of FRICTION_DIMENSIONS) {
          const differs = cell(base, dimension).value !== cell(compare, dimension).value;
          if (differs !== named.has(dimension)) {
            wrong.push(`${base.target} vs ${compare.target}: ${dimension}`);
          }
        }
      }
    }
    expect(wrong.join("\n")).toBe("");
  });

  test("a row against itself names nothing, and two unlike hosts name something", () => {
    const rows = buildFrictionMatrix(input()).rows;
    const cursor = rows.find((r) => r.target === "cursor")!;
    const pi = rows.find((r) => r.target === "pi")!;
    expect(diffFrictionRows(cursor, cursor).differing).toEqual([]);
    expect(diffFrictionRows(cursor, cursor).shared).toBe(FRICTION_DIMENSIONS.length);
    expect(diffFrictionRows(cursor, pi).differing.length).toBeGreaterThan(0);
    expect(
      diffFrictionRows(cursor, pi).differing.length + diffFrictionRows(cursor, pi).shared,
    ).toBe(FRICTION_DIMENSIONS.length);
  });
});

// ---------- The probe, on both branches ----------

/** Every target whose fact row declares a host probe. Derived. */
const PROBE_BEARING: ReadonlyArray<InstallTargetId> = INSTALL_TARGET_IDS.filter(
  (target) => RUNTIME_FACTS[target].hostProbe !== null,
);

/** A runner whose binary is present and prints `registered`, one per line. */
function answeringRunner(registered: ReadonlyArray<string>): HostProbeRunner {
  return {
    available: () => true,
    run: () => ({ exitCode: 0, stdout: registered.join("\n") + "\n", stderr: "" }),
  };
}

/** Install `target` for real, then verify it, and return the printed details. */
function detailsAfterInstall(target: InstallTargetId): {
  readonly status: string;
  readonly details: string;
} {
  const adapter = registerAllAdapters().get(target)!;
  const env = installEnv();
  const payload = buildPayload({ vault, agent_name: "claude-vps", timezone: "UTC" });
  adapter.apply(adapter.plan(payload, env), payload, env, applyOpts());
  const result = adapter.verify(env);
  return { status: result.status, details: result.details.join("; ") };
}

describe("a target that declares a host probe stops claiming a handshake it never attempts", () => {
  test("the probe-bearing population is not empty", () => {
    // Every case below iterates it; an empty list would pass them all.
    expect(PROBE_BEARING.length).toBeGreaterThan(0);
  });

  test("the binary answers: verify names the probe and never the blanket note", () => {
    for (const target of PROBE_BEARING) {
      setHostProbeRunner(answeringRunner([OSB_KEY_FULL, OSB_KEY_WRITER]));
      const { status, details } = detailsAfterInstall(target);
      expect(`${target}: ${status}`).toBe(`${target}: ok`);
      expect(details).toContain(hostProbeCommand(RUNTIME_FACTS[target].hostProbe!));
      expect(details).not.toContain(NO_HANDSHAKE_NOTE);
    }
  });

  test("the binary is absent: verify names the skip reason and never the blanket note", () => {
    for (const target of PROBE_BEARING) {
      const bin = RUNTIME_FACTS[target].hostProbe!.bin;
      setHostProbeRunner({
        available: () => false,
        run: () => {
          throw new Error(`the runner must not spawn ${bin} when it is not on PATH`);
        },
      });
      const { details } = detailsAfterInstall(target);
      expect(details).toContain(bin);
      expect(details).toContain("not on PATH");
      expect(details).not.toContain(NO_HANDSHAKE_NOTE);
    }
  });

  test("the binary refuses: the non-zero exit is named, not swallowed", () => {
    for (const target of PROBE_BEARING) {
      setHostProbeRunner({
        available: () => true,
        run: () => ({ exitCode: 3, stdout: "", stderr: "not authenticated\n" }),
      });
      const { details } = detailsAfterInstall(target);
      expect(details).toContain("3");
      expect(details).toContain("not authenticated");
      expect(details).not.toContain(NO_HANDSHAKE_NOTE);
    }
  });

  test("the binary answers but the host has nothing registered: that is not ok", () => {
    // Every mutation runner is pinned absent above, so each of these
    // installs landed in its adapter's FILE fallback and that file was
    // just compared and found correct. The shared rule
    // (`probeRefutedVerdict`) reads a refuting probe over a matching
    // artifact as a host that has not reloaded it, so the verdict is
    // `mcp-unreachable` and the repair is a restart - never `drift`,
    // which would tell the operator to rewrite bytes that are already
    // right. The host-is-the-only-record half of that rule is driven in
    // `tests/core/install/adapters/copilot-cli.test.ts`, where the
    // subprocess branch has an artifact-free registration to refute.
    for (const target of PROBE_BEARING) {
      setHostProbeRunner(answeringRunner([]));
      const { status, details } = detailsAfterInstall(target);
      expect(`${target}: ${status}`).toBe(`${target}: mcp-unreachable`);
      expect(details).toContain(OSB_KEY_FULL);
    }
  });

  test("a target with no probe keeps the blanket note, because it is the true answer", () => {
    setHostProbeRunner(answeringRunner([OSB_KEY_FULL, OSB_KEY_WRITER]));
    const { details } = detailsAfterInstall("cursor");
    expect(details).toContain(NO_HANDSHAKE_NOTE);
  });
});

// ---------- The cells that must describe the real artifact ----------

describe("the tool-profile cell describes the registration this target writes", () => {
  /** Targets whose generated registration carries no MCP command line. */
  const NOT_CARRIED: ReadonlyArray<InstallTargetId> = INSTALL_TARGET_IDS.filter(
    (target) => !carriesHostDimensions(target),
  );

  test("the population is not empty, and it is the declared one", () => {
    // Derived from the declaration the write path uses, so a target that
    // starts routing through `payloadForHost` moves between the two cases
    // below rather than escaping both.
    expect(NOT_CARRIED.toSorted()).toEqual(["aider", "generic", "pi"]);
  });

  test("a target that writes no command line says so instead of naming a profile", () => {
    // It used to resolve the ladder anyway and print, for example,
    // `generic tool-profile minimal / resolved from user-config` beside a
    // `--target generic --apply` whose args carry no `--tool-profile` at
    // all - a cell contradicting the artifact it claims to describe.
    for (const target of NOT_CARRIED) {
      const answer = cell(frictionRowFor(target, input()), FRICTION_DIMENSION.toolProfile);
      expect(`${target}: ${answer.value}`).toBe(`${target}: not carried`);
      expect(answer.detail ?? "").toContain("no MCP command line");
    }
  });

  test("a target that does write one names the profile its payload carries", () => {
    const shared = input();
    for (const target of INSTALL_TARGET_IDS.filter(carriesHostDimensions)) {
      const answer = cell(frictionRowFor(target, shared), FRICTION_DIMENSION.toolProfile);
      const written = payloadForHost(target, shared.payload, shared.env);
      const index = written.full.args.indexOf(TOOL_PROFILE_FLAG);
      const carried = index === -1 ? "none" : written.full.args[index + 1];
      expect(`${target}: ${answer.value}`).toBe(`${target}: ${carried}`);
    }
  });
});

describe("the session cells ask the adapter, not the fact table", () => {
  /** An adapter that answers a DIFFERENT session store than its row. */
  function withSessionPaths(
    adapter: InstallAdapter,
    answer: SessionPathsResult | null,
  ): InstallAdapter {
    return { ...adapter, sessionPaths: () => answer };
  }

  test("an adapter that answers null is reported as declaring nothing", () => {
    // `codex` declares four roots in `RUNTIME_FACTS`. A matrix reading the
    // table directly would print them however the adapter answered, which
    // is what made `InstallAdapter.sessionPaths` a required member with
    // ten implementations and no caller anywhere in `src/`.
    const shared = input();
    const codex = shared.adapters.find((a) => a.target === "codex")!;
    const silent = withSessionPaths(codex, null);
    const row = frictionRowFor("codex", { ...shared, adapters: [silent] });
    expect(cell(row, FRICTION_DIMENSION.sessionTranscripts).value).toBe("none declared");
    expect(cell(row, FRICTION_DIMENSION.sessionParser).value).toBe("none ships");
  });

  test("the roots printed are the ones the adapter resolved", () => {
    const shared = input();
    for (const adapter of shared.adapters) {
      const answered = adapter.sessionPaths(shared.env);
      const roots = cell(
        frictionRowFor(adapter.target, shared),
        FRICTION_DIMENSION.sessionTranscripts,
      );
      if (answered === null) {
        expect(`${adapter.target}: ${roots.value}`).toBe(`${adapter.target}: none declared`);
        continue;
      }
      for (const root of answered.roots) expect(roots.detail ?? "").toContain(root.path);
    }
  });
});

describe("an unreadable _brain.yaml is reported, not thrown", () => {
  beforeEach(() => {
    mkdirSync(join(vault, "Brain"), { recursive: true });
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      "schema_version: 1\ninstall:\n  tool_profile: [broken\n",
    );
  });

  test("the matrix still answers every row, and names the refusal in the cells", () => {
    // `--friction` is documented as a report that never exits non-zero.
    // Once `plan()` began resolving the tool profile, a vault whose config
    // will not parse turned it into an uncaught `BrainConfigError` stack
    // trace - `runFriction` catches only usage and payload errors.
    const rows = buildFrictionMatrix(input()).rows;
    expect(rows.length).toBe(INSTALL_TARGET_IDS.length);
    const unresolved = rows.filter((row) => row.cells.some((c) => c.value === "unresolved"));
    expect(unresolved.length).toBeGreaterThan(0);
    for (const row of unresolved) {
      const named = row.cells.filter((c) => c.value === "unresolved");
      for (const c of named) expect(c.detail ?? "").toContain("_brain.yaml");
    }
  });

  test("the refusal is stated, never replaced by a default profile", () => {
    const row = frictionRowFor("cursor", input());
    const profile = cell(row, FRICTION_DIMENSION.toolProfile);
    expect(profile.value).toBe("unresolved");
    expect(profile.value).not.toBe("catalog");
  });
});
