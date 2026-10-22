/**
 * Help text for the write-honesty surfaces (F4, t_fb442a24; F1 restamp).
 *
 * `o2b brain <verb> --help` prints `VERB_HELP[verb]` and exits 0; a verb
 * with no entry dumps the whole `BRAIN_HELP` and exits 2, which reads as a
 * usage error. Both defects pinned here were discoverability dead ends:
 * the claims surface said nothing about the `undated-quantity` finding it
 * is the exit for, and `privacy-marker-restamp` had no entry at all.
 */

import { describe, expect, test } from "bun:test";

import { runCli } from "../helpers/run-cli.ts";

describe("o2b brain claims --help", () => {
  test("names the undated-quantity finding class and its structural hatches", async () => {
    const res = await runCli(["brain", "claims", "--help"]);
    expect(res.returncode).toBe(0);
    expect(res.stdout.startsWith("usage:")).toBe(true);
    expect(res.stdout).toContain("undated-quantity");
    expect(res.stdout).toContain("valid_from");
    expect(res.stdout).toContain("[Source:");
    expect(res.stdout).not.toContain("!");
  });
});

describe("o2b brain privacy-marker-restamp --help", () => {
  test("has its own entry rather than the whole brain help", async () => {
    const res = await runCli(["brain", "privacy-marker-restamp", "--help"]);
    expect(res.returncode).toBe(0);
    expect(res.stdout.startsWith("usage: o2b brain privacy-marker-restamp")).toBe(true);
    // Dry-run default, the applying flag, and the reserve token contract.
    expect(res.stdout).toContain("--apply");
    expect(res.stdout).toContain("dry-run");
    expect(res.stdout).toContain("visibility:");
    expect(res.stdout).toContain("idempotent");
    expect(res.stdout).toContain("never removes");
    // The three informal markers the verb looks for, named factually.
    expect(res.stdout).toContain("access");
    expect(res.stdout).toContain("confidentiality");
    expect(res.stdout).toContain("sensitivity");
    expect(res.stdout).not.toContain("!");
  });

  test("o2b brain --help lists the verb", async () => {
    const res = await runCli(["brain", "--help"]);
    expect(res.returncode).toBe(0);
    expect(res.stdout).toContain("privacy-marker-restamp");
  });
});
