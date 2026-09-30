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
  isVaultBackingRemoteness,
  isVaultBackingState,
  isVaultBackingUndeterminedReason,
  probeVaultBacking,
  VAULT_BACKING,
  VAULT_BACKING_REMOTENESS,
  VAULT_BACKING_REMOTENESS_STATES,
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
const NFS = 0x6969;
const CIFS = 0xff534d42;
const FUSE = 0x65735546;

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

describe("the remoteness axis, beside durability", () => {
  test("named network filesystems classify remote without losing durability", () => {
    for (const [magic, name] of [
      [NFS, "nfs"],
      [CIFS, "cifs"],
    ] as const) {
      const verdict = probeVaultBacking("/vault", { platform: "linux", statfs: withFsType(magic) });
      expect(`${name} reads back as ${verdict.filesystem}`).toBe(`${name} reads back as ${name}`);
      expect(verdict.remoteness).toBe(VAULT_BACKING_REMOTENESS.remote);
      // The survival claim is unchanged: the bytes still outlive this
      // process and this reboot. Remoteness is a second axis answering a
      // different question (is this storage shared with other hosts), not
      // a different answer to the first.
      expect(verdict.state).toBe(VAULT_BACKING.durable);
    }
  });

  test("the other Linux network filesystems classify remote too", () => {
    // A modern `mount -t cifs` share reports SMB2_SUPER_MAGIC, not
    // CIFS_SUPER_MAGIC; ceph, afs, the legacy smbfs and 9p (WSL2 drvfs)
    // are cross-host storage in the same sense.
    for (const [magic, name] of [
      [0xfe534d42, "smb2"],
      [0x00c36400, "ceph"],
      [0x5346414f, "afs"],
      [0x6b414653, "afs"],
      [0x517b, "smbfs"],
      [0x01021997, "9p"],
    ] as const) {
      const verdict = probeVaultBacking("/vault", { platform: "linux", statfs: withFsType(magic) });
      expect(`${magic.toString(16)}: ${verdict.filesystem} ${verdict.remoteness}`).toBe(
        `${magic.toString(16)}: ${name} ${VAULT_BACKING_REMOTENESS.remote}`,
      );
      expect(verdict.state).toBe(VAULT_BACKING.durable);
    }
  });

  test("a Windows UNC path is remote without a statfs probe", () => {
    for (const path of [
      "\\\\server\\share\\vault\\.open-second-brain",
      "//server/share/vault",
      "\\\\?\\UNC\\server\\share\\vault",
    ]) {
      const verdict = probeVaultBacking(path, { platform: "win32" });
      expect(`${path}: ${verdict.remoteness}`).toBe(`${path}: ${VAULT_BACKING_REMOTENESS.remote}`);
      expect(verdict.filesystem).toBe("unc-share");
    }
    // A drive path and the extended-length local forms stay unprobed.
    for (const path of ["C:\\vault", "\\\\?\\C:\\vault", "\\\\.\\C:\\vault"]) {
      const verdict = probeVaultBacking(path, { platform: "win32" });
      expect(`${path}: ${verdict.reason}`).toBe(
        `${path}: ${VAULT_BACKING_UNDETERMINED_REASON.probeUnsupported}`,
      );
      expect(verdict.remoteness).toBe(VAULT_BACKING_REMOTENESS.nonRemote);
    }
    // A double slash on Linux is not a share.
    expect(
      probeVaultBacking("//server/share", { platform: "linux", statfs: withFsType(EXT4) })
        .remoteness,
    ).toBe(VAULT_BACKING_REMOTENESS.nonRemote);
  });

  test("fuse stays non-remote, and so does every disk and memory filesystem", () => {
    for (const magic of [FUSE, EXT4, TMPFS, OVERLAYFS]) {
      const verdict = probeVaultBacking("/vault", { platform: "linux", statfs: withFsType(magic) });
      expect(verdict.remoteness).toBe(VAULT_BACKING_REMOTENESS.nonRemote);
    }
  });

  test("probe-unsupported and fs-type-unknown stay silent and non-remote", () => {
    // Non-remote is the ABSENCE of a network finding, not a finding that
    // the storage is local: nothing was read, so nothing is claimed, and
    // a consumer keeps its default behaviour (WAL stays on).
    const unprobed = probeVaultBacking("/vault", { platform: "darwin", statfs: withFsType(NFS) });
    expect(unprobed.state).toBe(VAULT_BACKING.undetermined);
    expect(unprobed.reason).toBe(VAULT_BACKING_UNDETERMINED_REASON.probeUnsupported);
    expect(unprobed.remoteness).toBe(VAULT_BACKING_REMOTENESS.nonRemote);
    const unknown = probeVaultBacking("/vault", {
      platform: "linux",
      statfs: withFsType(UNRECOGNISED),
    });
    expect(unknown.reason).toBe(VAULT_BACKING_UNDETERMINED_REASON.fsTypeUnknown);
    expect(unknown.filesystem).toBeNull();
    expect(unknown.remoteness).toBe(VAULT_BACKING_REMOTENESS.nonRemote);
  });
});

describe("an injected statfs carries its own meaning", () => {
  test("it is honoured without an explicit platform, on any host", () => {
    // The platform veto exists because the DEFAULT statfsSync means
    // something else off Linux. A caller who injects a statfs vouches for
    // what it returns - the index open does exactly that to simulate a
    // network backing - so the injection implies the probeable platform.
    // This is the contract the Windows CI run turned on: there the veto
    // ran first, the injected nfs never applied, and the index opened
    // under WAL with no warning.
    const verdict = probeVaultBacking("/vault", { statfs: withFsType(NFS) });
    expect(verdict.filesystem).toBe("nfs");
    expect(verdict.remoteness).toBe(VAULT_BACKING_REMOTENESS.remote);
    expect(verdict.reason).toBeNull();
  });

  test("an explicitly pinned non-probeable platform still vetoes the injection", () => {
    // The guard on the rule above: an explicit `platform` is the caller
    // speaking about the host, and that word outranks any injection.
    const verdict = probeVaultBacking("/vault", {
      platform: "win32",
      statfs: withFsType(NFS),
    });
    expect(verdict.state).toBe(VAULT_BACKING.undetermined);
    expect(verdict.reason).toBe(VAULT_BACKING_UNDETERMINED_REASON.probeUnsupported);
    expect(verdict.remoteness).toBe(VAULT_BACKING_REMOTENESS.nonRemote);
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

  test("the remoteness vocabulary is closed and unreadable as the other axes", () => {
    expect(VAULT_BACKING_REMOTENESS_STATES).toContain(VAULT_BACKING_REMOTENESS.remote);
    expect(VAULT_BACKING_REMOTENESS_STATES).toContain(VAULT_BACKING_REMOTENESS.nonRemote);
    for (const state of VAULT_BACKING_STATES) {
      expect(`${state} is a remoteness: ${isVaultBackingRemoteness(state)}`).toBe(
        `${state} is a remoteness: false`,
      );
    }
    for (const reason of VAULT_BACKING_UNDETERMINED_REASONS) {
      expect(`${reason} is a remoteness: ${isVaultBackingRemoteness(reason)}`).toBe(
        `${reason} is a remoteness: false`,
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
