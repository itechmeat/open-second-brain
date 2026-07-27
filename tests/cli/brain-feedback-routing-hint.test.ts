/**
 * Unit 4 (t_75597bb9): the CLI surface of the unroutable-capture hint.
 *
 * `o2b brain feedback` without `--scope` records the signal exactly as
 * before and ADDITIONALLY reports the routing signal the capture lacked
 * plus the scope slugs this vault already uses. The forward pointer is
 * resolved through the advisory rail against the registered code - the
 * verb assembles no sentence of its own - and the machine stream carries
 * it as a field instead of a line.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { resolveNextStep } from "../../src/core/brain/next-step.ts";
import { CAPTURE_ROUTING_HINT_CODE } from "../../src/core/brain/write-advisory.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-feedback-routing-hint-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: test-agent\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: configPath });

/** The exact line the rail prints for the registered code - never retyped. */
const HINT_EXIT = `next: ${resolveNextStep(CAPTURE_ROUTING_HINT_CODE)?.nextCommand ?? "(unregistered)"}`;

async function seedScoped(topic: string, scope: string): Promise<void> {
  const out = await runCli(
    [
      "brain",
      "feedback",
      "--topic",
      topic,
      "--signal",
      "positive",
      "--principle",
      `principle for ${topic}`,
      "--scope",
      scope,
      "--force-confirmed",
    ],
    { env: env() },
  );
  expect(out.returncode).toBe(0);
}

async function record(
  extra: ReadonlyArray<string> = [],
): Promise<Awaited<ReturnType<typeof runCli>>> {
  return runCli(
    [
      "brain",
      "feedback",
      "--topic",
      "unrouted",
      "--signal",
      "positive",
      "--principle",
      "capture this without saying where it belongs",
      ...extra,
    ],
    { env: env() },
  );
}

interface RoutingHintPayload {
  readonly signal_path: string;
  readonly signal_id: string;
  readonly routing_hint?: {
    readonly missing_signal: string;
    readonly code: string;
    readonly candidates: ReadonlyArray<{ scope: string; documents: number }>;
    readonly next_command?: string;
  };
}

describe("o2b brain feedback - unroutable-capture routing hint", () => {
  test("a scope-less write on a scoped vault names the missing signal and the observed slugs", async () => {
    await seedScoped("tabs", "coding");
    await seedScoped("naming", "coding");
    await seedScoped("tone", "writing");

    const out = await record();

    expect(out.returncode).toBe(0);
    // The write landed, first and unconditionally.
    expect(out.stdout).toContain("signal: ");
    expect(out.stdout).toContain("id: sig-");
    // The missing routing signal and the vault's own slugs, ranked.
    expect(out.stdout).toContain("routing-hint: no scope");
    expect(out.stdout).toContain("coding");
    expect(out.stdout).toContain("writing");
    // The forward pointer came from the rail, against the registry.
    expect(out.stdout).toContain(`${HINT_EXIT}\n`);
  });

  test("the write lands identically whether or not the hint fires", async () => {
    // Silent vault: the write lands and nothing forward is printed.
    const withoutCorpus = await record();
    expect(withoutCorpus.returncode).toBe(0);
    expect(withoutCorpus.stdout).not.toContain("routing-hint:");
    expect(withoutCorpus.stdout).not.toContain(HINT_EXIT);
    const silent = signalBody(bareIdOf(withoutCorpus.stdout));

    // Same capture on a vault that HAS a scope corpus: the hint fires and
    // the signal file is the same document, modulo its identity fields.
    await seedScoped("tone", "writing");
    const withCorpus = await runCli(
      [
        "brain",
        "feedback",
        "--topic",
        "unrouted",
        "--signal",
        "positive",
        "--principle",
        "capture this without saying where it belongs",
        "--slug",
        "unrouted-again",
      ],
      { env: env() },
    );
    expect(withCorpus.returncode).toBe(0);
    expect(withCorpus.stdout).toContain(HINT_EXIT);
    const advised = signalBody(bareIdOf(withCorpus.stdout));

    // The hint never writes a scope onto the signal it advised about, and
    // never alters the recorded principle.
    for (const body of [silent, advised]) {
      expect(body).not.toContain("\nscope:");
      expect(body).toContain("capture this without saying where it belongs");
    }
  });

  test("an explicit --scope silences the hint", async () => {
    await seedScoped("tone", "writing");
    const out = await record(["--scope", "coding"]);
    expect(out.returncode).toBe(0);
    expect(out.stdout).not.toContain("routing-hint:");
    expect(out.stdout).not.toContain(HINT_EXIT);
  });

  test("the machine stream carries the hint as a field, never as a line", async () => {
    await seedScoped("tone", "writing");
    const out = await record(["--json"]);
    expect(out.returncode).toBe(0);
    expect(out.stdout).not.toContain("next: ");
    const payload = JSON.parse(out.stdout) as RoutingHintPayload;
    expect(payload.signal_id).toMatch(/^sig-/);
    expect(payload.routing_hint).toBeDefined();
    expect(payload.routing_hint!.missing_signal).toBe("scope");
    expect(payload.routing_hint!.code).toBe(CAPTURE_ROUTING_HINT_CODE);
    expect(payload.routing_hint!.candidates).toEqual([{ scope: "writing", documents: 2 }]);
    expect(payload.routing_hint!.next_command).toBe(
      resolveNextStep(CAPTURE_ROUTING_HINT_CODE)!.nextCommand,
    );
  });

  test("a vault with no scope corpus carries no hint key at all", async () => {
    const out = await record(["--json"]);
    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as RoutingHintPayload;
    expect(payload.signal_id).toMatch(/^sig-/);
    expect("routing_hint" in payload).toBe(false);
    expect(existsSync(join(vault, "Brain", "inbox"))).toBe(true);
  });
});

/** The `id: <sig-...>` line the verb prints, read back for file assertions. */
function bareIdOf(stdout: string): string {
  const match = /^id: (sig-[\w.-]+)$/m.exec(stdout);
  expect(match).not.toBeNull();
  return match![1]!;
}

/** The on-disk signal document for a printed id. */
function signalBody(id: string): string {
  return readFileSync(join(vault, "Brain", "inbox", `${id}.md`), "utf8");
}
