/**
 * The dream owner fold (design D1): every delivery order of the same
 * claim, request and release records names the same owner.
 */
import { describe, expect, test } from "bun:test";

import { buildRecord, type StoreRecord } from "../../../../src/core/store/envelope.ts";
import { foldDreamOwner } from "../../../../src/core/brain/dream-owner/fold.ts";
import { DREAM_OWNER_RECORD_KINDS } from "../../../../src/core/brain/dream-owner/constants.ts";
import { shippedFormatDoc } from "../../../../src/core/store/format-doc.ts";

let ms = 1_000;
function rec(device: string, kind: string, body: Record<string, unknown>, at?: number) {
  ms += 10;
  return buildRecord({
    hlc: { physical: at ?? ms, counter: 0 },
    device,
    agent: "t",
    kind,
    body,
  });
}
const claim = (device: string, agent: string, extra: Record<string, unknown> = {}, at?: number) =>
  rec(
    device,
    "dream-owner-claim",
    { authority: "agent", device, agent, force: false, ...extra },
    at,
  );
const request = (device: string, agent: string) =>
  rec(device, "dream-owner-request", { authority: "human", device, agent });
const release = (device: string, req: StoreRecord | null) =>
  rec(device, "dream-owner-released", {
    request: req?.id ?? null,
    device,
    to: req === null ? null : (req.body["device"] as string),
  });

function shuffled<T>(items: ReadonlyArray<T>, seed: number): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 48271) % 2147483647;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe("foldDreamOwner", () => {
  test("no records gives no owner", () => {
    const state = foldDreamOwner([]);
    expect(state.owner).toBeNull();
    expect(state.pending).toBeNull();
    expect(state.claims).toBe(0);
  });

  test("one claim gives its device and agent, with its clock as the revision", () => {
    const c = claim("dev-a", "claude");
    const state = foldDreamOwner([c]);
    expect(state.owner).toEqual({ device: "dev-a", agent: "claude", revision: c.hlc });
    expect(state.via).toBe("claim");
  });

  test("two claims resolve to the lower (clock, device) on any input order", () => {
    const b = claim("dev-b", "codex", {}, 5_000);
    const a = claim("dev-a", "claude", {}, 5_000);
    const later = claim("dev-c", "hermes", {}, 4_000);
    for (let seed = 1; seed <= 20; seed++) {
      const state = foldDreamOwner(shuffled([b, a, later], seed));
      expect(state.owner?.device).toBe("dev-c");
    }
    for (let seed = 1; seed <= 20; seed++) {
      expect(foldDreamOwner(shuffled([b, a], seed)).owner?.device).toBe("dev-a");
    }
  });

  test("a second claim on the owner's device changes the agent with a new revision", () => {
    const first = claim("dev-a", "claude");
    const second = claim("dev-a", "codex");
    const state = foldDreamOwner([second, first]);
    expect(state.owner).toEqual({ device: "dev-a", agent: "codex", revision: second.hlc });
    // The device still holds the role through its first claim.
    expect(state.since?.id).toBe(first.id);
  });

  test("a request leaves the owner and sets pending", () => {
    const c = claim("dev-a", "claude");
    const r = request("dev-b", "codex");
    const state = foldDreamOwner([r, c]);
    expect(state.owner?.device).toBe("dev-a");
    expect(state.pending).toMatchObject({ id: r.id, device: "dev-b", agent: "codex" });
    expect(state.requests.get("dev-b")).toEqual({ id: r.id, outcome: "pending" });
  });

  test("a release after a request makes the requester the owner", () => {
    const c = claim("dev-a", "claude");
    const r = request("dev-b", "codex");
    const rel = release("dev-a", r);
    for (let seed = 1; seed <= 10; seed++) {
      const state = foldDreamOwner(shuffled([c, r, rel], seed));
      expect(state.owner).toEqual({ device: "dev-b", agent: "codex", revision: rel.hlc });
      expect(state.via).toBe("release");
      expect(state.pending).toBeNull();
      expect(state.requests.get("dev-b")?.outcome).toBe("granted");
    }
  });

  test("a release with no request leaves no owner", () => {
    const c = claim("dev-a", "claude");
    const state = foldDreamOwner([c, release("dev-a", null)]);
    expect(state.owner).toBeNull();
    expect(state.via).toBe("release");
  });

  test("a release written by a device that is not the owner is ignored", () => {
    const c = claim("dev-a", "claude");
    const r = request("dev-b", "codex");
    const state = foldDreamOwner([c, r, release("dev-c", r)]);
    expect(state.owner?.device).toBe("dev-a");
  });

  test("two requests then a release name exactly one successor", () => {
    const c = claim("dev-a", "claude");
    const rb = request("dev-b", "codex");
    const rc = request("dev-c", "hermes");
    const rel = release("dev-a", rc);
    const staleRel = release("dev-a", rb);
    for (let seed = 1; seed <= 20; seed++) {
      const state = foldDreamOwner(shuffled([c, rb, rc, rel, staleRel], seed));
      expect(state.owner?.device).toBe("dev-c");
      expect(state.requests.get("dev-b")?.outcome).toBe("lost");
      expect(state.requests.get("dev-c")?.outcome).toBe("granted");
    }
  });

  test("a forced claim supersedes without a release", () => {
    const c = claim("dev-a", "claude");
    const r = request("dev-c", "hermes");
    const forced = claim("dev-b", "codex", { force: true });
    const state = foldDreamOwner([c, r, forced]);
    expect(state.owner).toEqual({ device: "dev-b", agent: "codex", revision: forced.hlc });
    expect(state.via).toBe("force");
    expect(state.pending).toBeNull();
    expect(state.requests.get("dev-c")?.outcome).toBe("lost");
  });

  test("a request on a brain with no owner takes the role at once", () => {
    const r = request("dev-b", "codex");
    const state = foldDreamOwner([r]);
    expect(state.owner?.device).toBe("dev-b");
    expect(state.via).toBe("request");
  });

  test("a malformed record is ignored and listed", () => {
    const c = claim("dev-a", "claude");
    const noAgent = rec("dev-b", "dream-owner-claim", {
      authority: "agent",
      device: "dev-b",
      force: false,
    });
    const forOther = rec("dev-b", "dream-owner-claim", {
      authority: "agent",
      device: "dev-c",
      agent: "x",
      force: false,
    });
    const noAuthority = rec("dev-b", "dream-owner-request", { device: "dev-b", agent: "x" });
    const badRelease = rec("dev-a", "dream-owner-released", {
      request: "nope",
      device: "dev-a",
      to: "dev-b",
    });
    const state = foldDreamOwner([noAgent, forOther, noAuthority, badRelease, c]);
    expect(state.owner?.device).toBe("dev-a");
    expect(state.rejected.map((r) => r.id).toSorted()).toEqual(
      [noAgent.id, forOther.id, noAuthority.id, badRelease.id].toSorted(),
    );
  });
});

describe("FORMAT.md", () => {
  test.each([...DREAM_OWNER_RECORD_KINDS])("documents the dream owner record kind %s", (kind) => {
    expect(shippedFormatDoc()).toMatch(new RegExp(`^- \`${kind}\`:`, "m"));
  });
});
