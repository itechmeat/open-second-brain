/**
 * What backs the vault path - and what this probe refuses to guess.
 *
 * The tempting shape here was a host classifier: local machine vs cloud
 * sandbox vs ephemeral container. Every signal that classifier would read
 * is ONE-WAY. `/.dockerenv` absent is the normal reading inside podman,
 * containerd, LXC and any image that deleted it; `/proc/1/cgroup` on a
 * cgroup v2 unified host is `0::/<path>` for a container and for a plain
 * systemd scope alike; and "containerised" is not "ephemeral" - a
 * bind-mounted volume in a container outlives a laptop's `/tmp`.
 *
 * So this file pins the narrow claim instead: which filesystem backs one
 * resolved path, and an explicit `undetermined` everywhere else. The last
 * describe block is the guard that keeps it narrow - it asserts the module
 * reads no container signal at all, because the failure this whole design
 * avoids is a NEGATIVE container signal being read back as a POSITIVE
 * verdict of durability.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isVaultBackingState,
  isVaultBackingUndeterminedReason,
  probeVaultBacking,
  VAULT_BACKING,
  VAULT_BACKING_STATES,
  VAULT_BACKING_UNDETERMINED_REASON,
  VAULT_BACKING_UNDETERMINED_REASONS,
} from "../../src/core/vault-backing.ts";
import { lexSource } from "../helpers/source-lexer.ts";

const EXT4 = 0xef53;
const TMPFS = 0x01021994;
const OVERLAYFS = 0x794c7630;
/** A magic number no released filesystem uses; stands for "not in the table". */
const UNRECOGNISED = 0x0badf00d;

function withFsType(type: number) {
  return () => ({ type });
}

describe("the filesystem under the vault path decides the state", () => {
  test("a journalling disk filesystem is durable and names itself", () => {
    const verdict = probeVaultBacking("/vault", { platform: "linux", statfs: withFsType(EXT4) });
    expect(verdict.state).toBe(VAULT_BACKING.durable);
    expect(verdict.filesystem).toBe("ext4");
    expect(verdict.reason).toBeNull();
  });

  test("a memory-backed filesystem is volatile - the one provable loss", () => {
    const verdict = probeVaultBacking("/vault", { platform: "linux", statfs: withFsType(TMPFS) });
    expect(verdict.state).toBe(VAULT_BACKING.volatile);
    expect(verdict.filesystem).toBe("tmpfs");
  });

  test("a container overlay is layered, never durable and never volatile", () => {
    const verdict = probeVaultBacking("/vault", {
      platform: "linux",
      statfs: withFsType(OVERLAYFS),
    });
    expect(verdict.state).toBe(VAULT_BACKING.layered);
    expect(verdict.state).not.toBe(VAULT_BACKING.durable);
    expect(verdict.state).not.toBe(VAULT_BACKING.volatile);
  });
});

describe("everything the probe cannot establish says so, with a reason", () => {
  test("an unrecognised magic number is undetermined, NOT durable", () => {
    const verdict = probeVaultBacking("/vault", {
      platform: "linux",
      statfs: withFsType(UNRECOGNISED),
    });
    expect(verdict.state).toBe(VAULT_BACKING.undetermined);
    expect(verdict.reason).toBe(VAULT_BACKING_UNDETERMINED_REASON.fsTypeUnknown);
    expect(verdict.filesystem).toBeNull();
    // The number is in the detail so a report names what it did not know.
    expect(verdict.detail).toContain("0xbadf00d");
  });

  test("a platform with no filesystem-type facility is undetermined, NOT durable", () => {
    for (const platform of ["darwin", "win32", "freebsd"]) {
      const verdict = probeVaultBacking("/vault", {
        platform,
        statfs: withFsType(EXT4),
      });
      expect(`${platform}: ${verdict.state}`).toBe(`${platform}: ${VAULT_BACKING.undetermined}`);
      expect(verdict.reason).toBe(VAULT_BACKING_UNDETERMINED_REASON.probeUnsupported);
    }
  });

  test("a path the probe cannot stat is undetermined, NOT durable", () => {
    const verdict = probeVaultBacking("/vault", {
      platform: "linux",
      statfs: () => {
        throw new Error("ENOENT: no such file or directory");
      },
    });
    expect(verdict.state).toBe(VAULT_BACKING.undetermined);
    expect(verdict.reason).toBe(VAULT_BACKING_UNDETERMINED_REASON.pathUnreadable);
    expect(verdict.detail).toContain("ENOENT");
  });

  test("the real host answers something, and never contradicts itself", () => {
    const verdict = probeVaultBacking(resolve(dirname(fileURLToPath(import.meta.url))));
    expect(isVaultBackingState(verdict.state)).toBe(true);
    expect(verdict.state === VAULT_BACKING.undetermined).toBe(verdict.reason !== null);
    expect(verdict.detail.length).toBeGreaterThan(0);
  });
});

describe("the vocabulary is closed and carries the could-not-tell member", () => {
  test("`undetermined` is a member, and no member claims to name a host class", () => {
    expect(VAULT_BACKING_STATES).toContain(VAULT_BACKING.undetermined);
    // No `local`, no `cloud_sandbox`, no `ephemeral`: two of those three are
    // unprovable from any signal this host exposes, and the third is a
    // property of a machine rather than of the path being probed.
    for (const forbidden of ["local", "cloud_sandbox", "ephemeral", "container"]) {
      expect(`${forbidden} is a member: ${isVaultBackingState(forbidden)}`).toBe(
        `${forbidden} is a member: false`,
      );
    }
  });

  test("a reason is never readable back as a state", () => {
    for (const reason of VAULT_BACKING_UNDETERMINED_REASONS) {
      expect(`${reason} is a state: ${isVaultBackingState(reason)}`).toBe(
        `${reason} is a state: false`,
      );
    }
    for (const state of VAULT_BACKING_STATES) {
      expect(`${state} is a reason: ${isVaultBackingUndeterminedReason(state)}`).toBe(
        `${state} is a reason: false`,
      );
    }
  });
});

describe("no container signal reaches this verdict", () => {
  const SOURCE = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "core", "vault-backing.ts"),
    "utf8",
  );

  /**
   * Comments stripped: the module docblock NAMES every marker below in
   * order to explain why it reads none of them, and a scan that counted
   * the explanation as a use would force the reasoning out of the file.
   */
  // The shared census lexer, not a pair of regexes: the old strip read
  // a `//` inside a string as a comment opener (hence the `[^:]` guard
  // for `https://`, which is one shape of that bug, not all of them).
  // `withoutComments`, because this scan reads STRING literals - a marker
  // path and an import specifier are both strings.
  const CODE = lexSource(SOURCE).withoutComments;

  test("the module never reads a one-way container marker", () => {
    // Naming them, not counting them: every one of these is evidence of a
    // container when PRESENT and evidence of nothing when absent, so a
    // verdict that consulted one would answer `durable` for every modern
    // container that simply does not ship the marker.
    const markers = ["/.dockerenv", "/run/.containerenv", "/proc/1/cgroup", "/proc/1/sched"];
    const found = markers.filter((marker) => CODE.includes(marker));
    expect(found.join("\n")).toBe("");
  });

  test("the only host facility it reaches for is statfs", () => {
    const fsImports = [...CODE.matchAll(/import \{([^}]*)\} from "node:fs"/g)].map((m) =>
      m[1]!.trim(),
    );
    expect(fsImports.join("\n")).toBe("statfsSync");
  });

  test("the verdict is a function of the filesystem alone", () => {
    // Same magic number, two unrelated call sites: nothing about the host
    // can move the answer, which is what makes the absence of a container
    // marker unable to purchase a durability claim.
    const first = probeVaultBacking("/one", {
      platform: "linux",
      statfs: withFsType(UNRECOGNISED),
    });
    const second = probeVaultBacking("/two", {
      platform: "linux",
      statfs: withFsType(UNRECOGNISED),
    });
    expect(first.state).toBe(second.state);
    expect(first.reason).toBe(second.reason);
  });
});
