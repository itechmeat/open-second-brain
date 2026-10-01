import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  COMMAND_PROBE_VERDICT,
  CommandProbeError,
  probeCommandResolvability,
} from "../../../src/core/install/command-probe.ts";

let tmp: string;
let binDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-command-probe-"));
  binDir = join(tmp, "bin");
  mkdirSync(binDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A probe context whose PATH sees only this test's bin dir. */
function ctx(): { env: Record<string, string>; cwd: string } {
  return { env: { PATH: binDir }, cwd: tmp };
}

describe("probeCommandResolvability - path-form commands", () => {
  test("an existing absolute path resolves", () => {
    const launcher = join(tmp, "launcher.sh");
    writeFileSync(launcher, "");
    const out = probeCommandResolvability(launcher, [], ctx());
    expect(out.verdict).toBe(COMMAND_PROBE_VERDICT.resolves);
    expect(out.detail).toContain(launcher);
  });

  test("a missing absolute path is proved absent, not unresolved", () => {
    const gone = join(tmp, "gone-o2b");
    const out = probeCommandResolvability(gone, [], ctx());
    expect(out.verdict).toBe(COMMAND_PROBE_VERDICT.absent);
    expect(out.detail).toContain(gone);
    expect(out.detail).not.toContain("spawn PATH");
  });

  test("a relative path is unresolved, never absent, and reports the probe cwd", () => {
    // The client resolves a relative word from its own working directory,
    // so neither a hit nor a miss under the doctor's cwd is a verdict.
    writeFileSync(join(binDir, "..", "rel-launcher"), "");
    const out = probeCommandResolvability("./rel-launcher", [], ctx());
    expect(out.verdict).toBe(COMMAND_PROBE_VERDICT.unresolved);
    expect(out.detail).toContain("exists");
    const missing = probeCommandResolvability("./no-such-launcher", [], ctx());
    expect(missing.verdict).toBe(COMMAND_PROBE_VERDICT.unresolved);
    expect(missing.detail).toContain("does not exist");
  });
});

describe("probeCommandResolvability - bare names", () => {
  test("a bare name on the probe PATH resolves", () => {
    writeFileSync(join(binDir, "o2b"), "");
    const out = probeCommandResolvability("o2b", [], ctx());
    expect(out.verdict).toBe(COMMAND_PROBE_VERDICT.resolves);
    expect(out.detail).toContain("o2b");
    expect(out.detail).toContain("PATH");
  });

  test("a bare name off the probe PATH is unresolved, never absent", () => {
    const out = probeCommandResolvability("no-such-bare-name", [], ctx());
    expect(out.verdict).toBe(COMMAND_PROBE_VERDICT.unresolved);
    expect(out.detail).toContain("spawn PATH");
  });

  test("an empty PATH leaves a bare name unresolved", () => {
    const out = probeCommandResolvability("o2b", [], { env: { PATH: "" }, cwd: tmp });
    expect(out.verdict).toBe(COMMAND_PROBE_VERDICT.unresolved);
  });

  test("the probe never searches the cwd for a bare name", () => {
    // The payload documents this posture for cmd.exe via
    // NoDefaultCurrentDirectoryInExePath (payload.ts): a bare name found
    // only in the current directory is NOT a resolution.
    writeFileSync(join(tmp, "cwdcmd"), "");
    const out = probeCommandResolvability("cwdcmd", [], ctx());
    expect(out.verdict).toBe(COMMAND_PROBE_VERDICT.unresolved);
  });
});

describe("probeCommandResolvability - runner script arguments", () => {
  test("a resolved runner with a missing script argument is one absent finding naming the script", () => {
    writeFileSync(join(binDir, "bun"), "");
    const script = join(tmp, "old-repo", "src", "cli", "main.ts");
    const out = probeCommandResolvability("bun", ["run", script], ctx());
    expect(out.verdict).toBe(COMMAND_PROBE_VERDICT.absent);
    expect(out.detail).toContain("bun");
    expect(out.detail).toContain(script);
  });

  test("a resolved runner with an existing script argument resolves", () => {
    writeFileSync(join(binDir, "bun"), "");
    const script = join(tmp, "src", "cli", "main.ts");
    mkdirSync(join(tmp, "src", "cli"), { recursive: true });
    writeFileSync(script, "");
    const out = probeCommandResolvability("bun", ["run", script], ctx());
    expect(out.verdict).toBe(COMMAND_PROBE_VERDICT.resolves);
    expect(out.detail).toContain(script);
  });

  test("a relative runner script argument is unresolved, never absent", () => {
    writeFileSync(join(binDir, "bun"), "");
    const out = probeCommandResolvability("bun", ["run", "./src/cli/missing.ts"], ctx());
    expect(out.verdict).toBe(COMMAND_PROBE_VERDICT.unresolved);
    expect(out.detail).toContain("relative path");
  });

  test("a bare runner script word is a package alias, not a file to check", () => {
    writeFileSync(join(binDir, "bun"), "");
    const out = probeCommandResolvability("bun", ["run", "dev"], ctx());
    expect(out.verdict).toBe(COMMAND_PROBE_VERDICT.resolves);
  });

  test("an unresolved runner stays unresolved without consulting the script", () => {
    const script = join(tmp, "src", "cli", "main.ts");
    const out = probeCommandResolvability("no-such-runner", ["run", script], ctx());
    expect(out.verdict).toBe(COMMAND_PROBE_VERDICT.unresolved);
  });
});

describe("probeCommandResolvability - windows launcher shape", () => {
  test("cmd /d /c wrapping probes the launcher word behind the prefix", () => {
    writeFileSync(join(binDir, "o2b"), "");
    const out = probeCommandResolvability("cmd", ["/d", "/c", "o2b", "mcp", "--vault", tmp], ctx());
    expect(out.verdict).toBe(COMMAND_PROBE_VERDICT.resolves);
    expect(out.detail).toContain("cmd");
    expect(out.detail).toContain("o2b");
  });

  test("a cmd-wrapped launcher that does not resolve stays unresolved, never absent", () => {
    const out = probeCommandResolvability("cmd", ["/d", "/c", "o2b", "mcp"], ctx());
    expect(out.verdict).toBe(COMMAND_PROBE_VERDICT.unresolved);
    expect(out.detail).toContain("spawn PATH");
  });

  test("win32-shaped input resolves a PATHEXT extension", () => {
    // The fixture uses the extension's recorded case: this host's
    // filesystem is case-sensitive, while a real win32 one folds it.
    writeFileSync(join(binDir, "o2b.CMD"), "");
    const out = probeCommandResolvability("o2b", [], {
      platform: "win32",
      env: { PATH: binDir, PATHEXT: ".COM;.CMD;.EXE" },
      cwd: tmp,
    });
    expect(out.verdict).toBe(COMMAND_PROBE_VERDICT.resolves);
    expect(out.detail).toContain("o2b.CMD");
  });

  test("win32-shaped input falls back to the default PATHEXT when unset", () => {
    writeFileSync(join(binDir, "o2b.EXE"), "");
    const out = probeCommandResolvability("o2b", [], {
      platform: "win32",
      env: { PATH: binDir },
      cwd: tmp,
    });
    expect(out.verdict).toBe(COMMAND_PROBE_VERDICT.resolves);
    expect(out.detail).toContain("o2b.EXE");
  });

  test("win32-shaped input with no PATHEXT match is unresolved", () => {
    writeFileSync(join(binDir, "o2b.txt"), "");
    const out = probeCommandResolvability("o2b", [], {
      platform: "win32",
      env: { PATH: binDir, PATHEXT: ".CMD;.EXE" },
      cwd: tmp,
    });
    expect(out.verdict).toBe(COMMAND_PROBE_VERDICT.unresolved);
  });
});

describe("probeCommandResolvability - input contract", () => {
  test("an empty command word is a named error", () => {
    expect(() => probeCommandResolvability("", [], ctx())).toThrow(CommandProbeError);
    try {
      probeCommandResolvability("   ", [], ctx());
      throw new Error("expected CommandProbeError");
    } catch (err) {
      expect(err).toBeInstanceOf(CommandProbeError);
      expect((err as Error).name).toBe("CommandProbeError");
    }
  });

  test("the verdict vocabulary is closed with distinct members", () => {
    const values = Object.values(COMMAND_PROBE_VERDICT);
    expect(new Set(values).size).toBe(values.length);
    expect([...values]).toEqual(["resolves", "absent", "unresolved"]);
  });
});
