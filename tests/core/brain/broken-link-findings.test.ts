/**
 * Broken-link findings are machine-actionable (no-dead-ends, task 12).
 *
 * `broken-wikilink` carried the field name and the dead target only
 * inside its sentence, and `broken-backlinks` carried no `path` at all -
 * its referencing sources were joined into the message string. A consumer
 * that wanted to act on either had to regex prose, which is how a
 * detector and an applier end up disagreeing about what was detected.
 *
 * The data is now carried as fields. The message text is unchanged, byte
 * for byte, because a human surface reads it and this task is not a
 * rewording.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JSONRPC_VERSION, MCPServer, PROTOCOL_VERSION } from "../../../src/mcp/index.ts";
import { DIAGNOSTIC_SIGNALS } from "../../../src/core/brain/diagnostics.ts";
import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import type { DoctorIssue } from "../../../src/core/brain/types.ts";
import { resetVaultIdentityPins } from "../../../src/core/brain/vault-identity.ts";

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  resetVaultIdentityPins();
  tmp = mkdtempSync(join(tmpdir(), "o2b-broken-link-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: test-agent\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  resetVaultIdentityPins();
  rmSync(tmp, { recursive: true, force: true });
});

function seedPreference(
  slug: string,
  fields: Partial<Parameters<typeof writePreference>[1]>,
): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle: `principle for ${slug}`,
    created_at: "2026-05-14T10:00:00Z",
    unconfirmed_until: "2026-05-28T10:00:00Z",
    status: "unconfirmed",
    evidenced_by: [],
    ...fields,
  });
}

function findAll(issues: ReadonlyArray<DoctorIssue>, code: string): ReadonlyArray<DoctorIssue> {
  return issues.filter((issue) => issue.code === code);
}

describe("broken-wikilink carries its field and target", () => {
  test("an evidence pointer with no file exposes both without prose parsing", () => {
    seedPreference("dead-evidence", { evidenced_by: ["[[sig-does-not-exist]]"] });

    const report = runDoctor(vault);
    const hits = findAll(report.warnings, "broken-wikilink");
    expect(hits.length).toBe(1);
    const hit = hits[0]!;

    expect(hit.field).toBe("evidenced_by");
    expect(hit.target).toBe("sig-does-not-exist");
    expect(hit.path).toBe(join(vault, "Brain", "preferences", "pref-dead-evidence.md"));
    // The human sentence is untouched - this task adds fields, it does
    // not reword anything.
    expect(hit.message).toBe(
      "field 'evidenced_by' references missing basename 'sig-does-not-exist'",
    );
  });

  test("a structural lifecycle field is distinguishable from an evidence one", () => {
    seedPreference("dead-supersedes", { supersedes: "[[pref-never-existed]]" });

    const hits = findAll(runDoctor(vault).warnings, "broken-wikilink");
    expect(hits.length).toBe(1);
    // The whole point: an applier decides prune-vs-review from the field
    // name, and the field name is now a value rather than a substring.
    expect(hits[0]!.field).toBe("supersedes");
    expect(hits[0]!.target).toBe("pref-never-existed");
  });

  test("an issue of another code carries none of the new keys", () => {
    seedPreference("clean", {});
    const report = runDoctor(vault);
    for (const issue of [...report.errors, ...report.warnings]) {
      if (issue.code === "broken-wikilink" || issue.code === "broken-backlinks") continue;
      expect(Object.hasOwn(issue, "field")).toBe(false);
      expect(Object.hasOwn(issue, "target")).toBe(false);
      expect(Object.hasOwn(issue, "sources")).toBe(false);
    }
  });
});

/** Seed a preference whose BODY names `target`, producing a backlink. */
function seedBodyReference(slug: string, target: string): void {
  seedPreference(slug, {});
  const path = join(vault, "Brain", "preferences", `pref-${slug}.md`);
  appendFileSync(path, `\n## Notes\n\nsee [[${target}]]\n`, "utf8");
}

describe("broken-backlinks carries its target and its sources", () => {
  test("the referencing sources are a list, not a joined sentence", () => {
    seedBodyReference("src-a", "pref-vanished");
    seedBodyReference("src-b", "pref-vanished");

    const hits = findAll(runDoctor(vault).warnings, "broken-backlinks");
    expect(hits.length).toBe(1);
    const hit = hits[0]!;

    expect(hit.target).toBe("pref-vanished");
    expect(hit.sources).toEqual(["pref-src-a", "pref-src-b"]);
    // Unchanged message, including the joined source list it always had.
    expect(hit.message).toBe(
      "[[pref-vanished]] is referenced by 2 source(s) but no file with that " +
        "basename exists under Brain/: pref-src-a, pref-src-b",
    );
  });

  test("a consumer can act on the finding without touching the message", () => {
    seedBodyReference("src-a", "pref-vanished");

    const hit = findAll(runDoctor(vault).warnings, "broken-backlinks")[0]!;
    // A repair driver's whole input, derived from fields only.
    const work = (hit.sources ?? []).map((source) => ({ source, target: hit.target }));
    expect(work).toEqual([{ source: "pref-src-a", target: "pref-vanished" }]);
  });
});

describe("the MCP doctor surface carries the same fields", () => {
  /** `brain_doctor` over a live server, returning the parsed payload. */
  async function callDoctor(): Promise<Record<string, unknown>> {
    const server = new MCPServer({ vault, configPath });
    await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "broken-link-findings-test", version: "0" },
      },
    });
    await server.handleRequest({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
    const r = (await server.handleRequest({
      jsonrpc: JSONRPC_VERSION,
      id: 2,
      method: "tools/call",
      params: { name: "brain_doctor", arguments: {} },
    })) as { result: { content: ReadonlyArray<{ type: string; text: string }> } };
    return JSON.parse(r.result.content[0]!.text) as Record<string, unknown>;
  }

  test("both codes arrive with their fields, and next_command still resolves", async () => {
    seedPreference("dead-evidence", { evidenced_by: ["[[sig-does-not-exist]]"] });
    seedBodyReference("src-a", "pref-vanished");

    const warnings = ((await callDoctor())["warnings"] ?? []) as ReadonlyArray<
      Record<string, unknown>
    >;

    const wikilink = warnings.find((w) => w["code"] === "broken-wikilink")!;
    expect(wikilink["field"]).toBe("evidenced_by");
    expect(wikilink["target"]).toBe("sig-does-not-exist");
    // Task 4's field is untouched by task 12's additions.
    expect(wikilink["next_command"]).toBe(DIAGNOSTIC_SIGNALS.get("broken-wikilink")!.nextCommand);

    // The dead `evidenced_by` pointer is a backlink source too, so this
    // vault reports two `broken-backlinks` warnings. Selecting by the
    // structured target - rather than by position or by a substring of
    // the message - is itself the property under test.
    const backlinks = warnings.find(
      (w) => w["code"] === "broken-backlinks" && w["target"] === "pref-vanished",
    )!;
    expect(backlinks).toBeDefined();
    expect(backlinks["sources"]).toEqual(["pref-src-a"]);
    expect(backlinks["next_command"]).toBe(DIAGNOSTIC_SIGNALS.get("broken-backlinks")!.nextCommand);
  });

  test("an issue with none of the new data carries none of the new keys", async () => {
    seedPreference("clean", {});
    const payload = await callDoctor();
    for (const key of ["errors", "warnings"]) {
      for (const record of (payload[key] ?? []) as ReadonlyArray<Record<string, unknown>>) {
        if (record["code"] === "broken-wikilink" || record["code"] === "broken-backlinks") continue;
        expect(Object.hasOwn(record, "field")).toBe(false);
        expect(Object.hasOwn(record, "target")).toBe(false);
        expect(Object.hasOwn(record, "sources")).toBe(false);
      }
    }
  });
});
