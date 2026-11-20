/**
 * A project key the writer stamps (the scoped-rule key of the linked
 * directory's name: letters, marks and digits of every script) is accepted
 * and read back unchanged by every reader and validator on its path: the
 * session summary a checkpoint writes, the summary filters, and the
 * composite page scope that search filters and page dedup compare.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { writeVaultPointer } from "../../../src/core/brain/portability/pointer.ts";
import {
  getSessionSummary,
  listSessionSummaries,
} from "../../../src/core/brain/session-summary.ts";
import {
  compositeScopeKey,
  normalizeScopeFilter,
  scopeAxisReachable,
  scopeFromFrontmatter,
} from "../../../src/core/scope-key.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import type { Fleet } from "../store-migration/fixtures/fleet.ts";
import { callTool, serverIn, switchedMachine } from "../topics/fixtures/record-project.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.cleanup();
  fleet = null;
});

/** Linked directory name and the key the writer stamps for it. */
const PROJECTS = [
  { dir: "проект-тема", key: "проект-тема" },
  { dir: "Café", key: "café" },
  { dir: "日本語repo", key: "日本語repo" },
] as const;

function toolJson(result: unknown): Record<string, unknown> {
  const r = result as {
    structuredContent?: Record<string, unknown>;
    content?: Array<{ text?: string }>;
  };
  return (
    r.structuredContent ?? (JSON.parse(r.content?.[0]?.text ?? "{}") as Record<string, unknown>)
  );
}

test("a session checkpoint in a project named in any script writes its summary with that project", async () => {
  const made = switchedMachine();
  fleet = made.fleet;
  const a = made.machine;
  const outs = await Promise.all(
    PROJECTS.map((p, i) => {
      const dir = join(fleet!.parent, "work", p.dir);
      mkdirSync(dir, { recursive: true });
      writeVaultPointer(dir, a.vault);
      return callTool(serverIn(a, dir), "brain_session_checkpoint", {
        session_id: `session-${i}`,
        agent: "agent-one",
        request: `Ship the release of ${p.dir}`,
        decisions: ["Release notes list every step"],
        learnings: ["The checklist lives on one page"],
        next_steps: ["Tag the release"],
      });
    }),
  );
  for (const [i, p] of PROJECTS.entries()) {
    const out = toolJson(outs[i]);
    const sessionId = `session-${i}`;
    expect(out["partial"], p.dir).toEqual([]);
    expect(out["summary"], p.dir).not.toBeNull();
    expect(getSessionSummary(a.vault, sessionId)?.project, p.dir).toBe(p.key);
    // The summary filter takes the name as the directory spells it.
    const listed = listSessionSummaries(a.vault, { project: p.dir });
    expect(
      listed.map((d) => d.sessionId),
      p.dir,
    ).toEqual([sessionId]);
  }
});

test("brain_session_summary accepts a project scope named in any script", async () => {
  const made = switchedMachine();
  fleet = made.fleet;
  const a = made.machine;
  const s = serverIn(a, fleet.parent);
  const out = toolJson(
    await callTool(s, "brain_session_summary", {
      operation: "write",
      session_id: "session-x",
      decisions: ["Keep one checklist"],
      project_scope: "Проект-Тема",
    }),
  );
  expect((out["digest"] as Record<string, unknown>)["project"]).toBe("проект-тема");
});

test("the composite page scope keeps a project or session named in any script", () => {
  for (const p of PROJECTS) {
    const page = scopeFromFrontmatter({ project: p.key, session: `сессия-${p.key}` });
    expect(page.project).toBe(p.key);
    expect(page.session).toBe(`сессия-${p.key}`);
    // A search filter spelled as the directory reaches the page, and only it.
    const filter = normalizeScopeFilter({ project: p.dir });
    expect(scopeAxisReachable(page.project, filter.project)).toBe(true);
  }
  // Distinct names stay distinct scopes.
  const cafe = compositeScopeKey(scopeFromFrontmatter({ project: "cafe" }));
  const café = compositeScopeKey(scopeFromFrontmatter({ project: "café" }));
  expect(cafe).not.toBe(café);
  expect(scopeAxisReachable("cafe", normalizeScopeFilter({ project: "café" }).project)).toBe(false);
});
