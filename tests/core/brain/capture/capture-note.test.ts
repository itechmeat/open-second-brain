/**
 * Capture-note contract (Knowledge intake suite, seam 1, t_f8f5ef6a).
 *
 * The contract owns the staging vocabulary shared by the inbound Telegram
 * capture bot (writer) and the inbox-drain pass (reader): the frontmatter
 * kind, provenance (source, sender, capture timestamp), the staging and
 * archive path helpers, and the read/write/list/archive functions.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BRAIN_CAPTURE_KIND,
  CaptureContractError,
  archiveCapture,
  capturesSince,
  listStagedCaptures,
  readCaptureNote,
  readCatchupWatermark,
  writeCaptureNote,
  writeCatchupWatermark,
  type CaptureProvenance,
} from "../../../../src/core/brain/capture/capture-note.ts";
import { capturesDir, capturesProcessedDir } from "../../../../src/core/brain/paths.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-capture-note-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function prov(overrides: Partial<CaptureProvenance> = {}): CaptureProvenance {
  return {
    source: "telegram",
    sender: "12345",
    capturedAt: "2026-07-19T12:00:00Z",
    ...overrides,
  };
}

test("writeCaptureNote stamps kind, provenance, and timestamp into staging", () => {
  const note = writeCaptureNote(vault, { body: "capture a thought", provenance: prov() });
  expect(note.staged).toBe(true);
  expect(note.provenance.source).toBe("telegram");
  expect(note.provenance.sender).toBe("12345");
  expect(note.provenance.capturedAt).toBe("2026-07-19T12:00:00Z");
  expect(note.body).toBe("capture a thought");
  expect(existsSync(join(vault, note.path))).toBe(true);
  expect(note.path.startsWith("Brain/captures/")).toBe(true);
  expect(note.id.startsWith("cap-")).toBe(true);
});

test("BRAIN_CAPTURE_KIND is the frontmatter kind marker", () => {
  expect(BRAIN_CAPTURE_KIND).toBe("brain-capture");
});

test("writeCaptureNote refuses an empty body with a typed error", () => {
  expect(() => writeCaptureNote(vault, { body: "   ", provenance: prov() })).toThrow(
    CaptureContractError,
  );
});

test("writeCaptureNote refuses empty provenance identity with a typed error", () => {
  expect(() => writeCaptureNote(vault, { body: "x", provenance: prov({ sender: "" }) })).toThrow(
    CaptureContractError,
  );
  expect(() => writeCaptureNote(vault, { body: "x", provenance: prov({ source: "" }) })).toThrow(
    CaptureContractError,
  );
});

test("listStagedCaptures returns staged captures sorted chronologically", () => {
  writeCaptureNote(vault, {
    body: "second",
    provenance: prov({ capturedAt: "2026-07-19T12:00:02Z" }),
  });
  writeCaptureNote(vault, {
    body: "first",
    provenance: prov({ capturedAt: "2026-07-19T12:00:01Z" }),
  });
  const staged = listStagedCaptures(vault);
  expect(staged.map((c) => c.body)).toEqual(["first", "second"]);
  expect(staged.every((c) => c.staged)).toBe(true);
});

test("archiveCapture moves a staged capture into the processed area", () => {
  const note = writeCaptureNote(vault, { body: "drain me", provenance: prov() });
  const archived = archiveCapture(vault, note.id);
  expect(archived.staged).toBe(false);
  expect(existsSync(join(vault, note.path))).toBe(false);
  expect(existsSync(join(vault, archived.path))).toBe(true);
  expect(archived.path.startsWith("Brain/captures/processed/")).toBe(true);
  expect(listStagedCaptures(vault)).toHaveLength(0);
});

test("archiveCapture on an unknown id is a typed error", () => {
  expect(() => archiveCapture(vault, "cap-2026-07-19-000000-deadbeef")).toThrow(
    CaptureContractError,
  );
});

test("capturesSince honours the watermark across staging and archive", () => {
  const a = writeCaptureNote(vault, {
    body: "a",
    provenance: prov({ capturedAt: "2026-07-19T12:00:01Z" }),
  });
  const b = writeCaptureNote(vault, {
    body: "b",
    provenance: prov({ capturedAt: "2026-07-19T12:00:02Z" }),
  });
  // Archiving must not hide a capture from catchup.
  archiveCapture(vault, a.id);
  expect(capturesSince(vault, null).map((c) => c.body)).toEqual(["a", "b"]);
  expect(capturesSince(vault, a.id).map((c) => c.body)).toEqual(["b"]);
  expect(capturesSince(vault, b.id)).toHaveLength(0);
});

test("catchup watermark round-trips and is absent by default", () => {
  expect(readCatchupWatermark(vault)).toBeNull();
  writeCatchupWatermark(vault, "cap-2026-07-19-120000-abcdabcd");
  expect(readCatchupWatermark(vault)).toBe("cap-2026-07-19-120000-abcdabcd");
});

test("path helpers resolve inside the Brain captures tree", () => {
  expect(capturesDir(vault).endsWith(join("Brain", "captures"))).toBe(true);
  expect(capturesProcessedDir(vault).endsWith(join("Brain", "captures", "processed"))).toBe(true);
});

test("writeCaptureNote retries a name lost between the probe and the create", () => {
  // Learn the name this capture allocates, then re-plant it as a dangling
  // symlink: `existsSync` follows the link and reads the name as free,
  // `link(2)` does not follow it and reports EEXIST. That is the pair of
  // answers the loser of a concurrent capture gets.
  const input = { body: "a raced capture", provenance: prov() };
  const first = writeCaptureNote(vault, input);
  const taken = join(vault, first.path);
  unlinkSync(taken);
  symlinkSync(join(capturesDir(vault), "never-created"), taken);

  const second = writeCaptureNote(vault, input);

  expect(second.id).toBe(`${first.id}-2`);
  expect(existsSync(join(vault, second.path))).toBe(true);
});

/**
 * Per-capture guidance (unit 3b / t_5e338af1).
 *
 * Claims pinned below:
 *
 *  1. Guidance round-trips verbatim through the `## Guidance` body section
 *     without leaking into the captured body.
 *  2. Two captures differing ONLY in guidance are two captures: the id hash
 *     reads the field, so they do not collapse into the `-2` allocator.
 *  3. A capture written without guidance keeps the historical id, byte for
 *     byte - the field is additive and the hash segment is conditional.
 *  4. A body that itself ends in a `## Guidance` heading is still read back
 *     as body, because the split is gated on the frontmatter marker rather
 *     than on finding the heading - and when the capture DOES carry
 *     guidance, the split takes the last separator, so the quoted section
 *     stays in the body and the writer's own guidance comes back whole.
 *  5. Empty or whitespace-only guidance is refused by name, never stored as
 *     an empty section.
 */

test("guidance round-trips verbatim and stays out of the body", () => {
  const written = writeCaptureNote(vault, {
    body: "capture a thought",
    provenance: prov(),
    guidance: "file this under research, not tasks",
  });
  expect(written.guidance).toBe("file this under research, not tasks");
  expect(written.body).toBe("capture a thought");

  const read = readCaptureNote(vault, written.id);
  expect(read).not.toBeNull();
  expect(read!.guidance).toBe("file this under research, not tasks");
  expect(read!.body).toBe("capture a thought");
});

test("a capture with no guidance reads back with none", () => {
  const written = writeCaptureNote(vault, { body: "plain", provenance: prov() });
  expect(written.guidance).toBeNull();
  expect(readCaptureNote(vault, written.id)!.guidance).toBeNull();
});

test("two captures differing only in guidance get distinct ids", () => {
  const a = writeCaptureNote(vault, {
    body: "same text",
    provenance: prov(),
    guidance: "route to inbox",
  });
  const b = writeCaptureNote(vault, {
    body: "same text",
    provenance: prov(),
    guidance: "route to archive",
  });
  expect(a.id).not.toBe(b.id);
  // Distinct by HASH, not by the collision allocator's numeric suffix.
  expect(b.id.endsWith("-2")).toBe(false);
});

test("adding guidance does not move the id of a capture that has none", () => {
  const plain = writeCaptureNote(vault, { body: "same text", provenance: prov() });
  rmSync(join(vault, plain.path));
  const again = writeCaptureNote(vault, { body: "same text", provenance: prov() });
  expect(again.id).toBe(plain.id);
});

test("a body that ends in its own Guidance heading is still all body", () => {
  const body = "notes\n\n## Guidance\n\nquoted from somewhere else";
  const written = writeCaptureNote(vault, { body, provenance: prov() });
  const read = readCaptureNote(vault, written.id)!;
  expect(read.guidance).toBeNull();
  expect(read.body).toBe(body);
});

test("a quoted Guidance section inside the body does not steal the real guidance", () => {
  // Both halves are present here: the body quotes a document that has its
  // own `## Guidance` heading, AND the capture carries guidance of its
  // own. The split has to take the LAST separator - the one the writer
  // appended - or the quotation's head becomes the instruction and the
  // rest of the quotation is lost from the body.
  const body = "notes\n\n## Guidance\n\nquoted from somewhere else";
  const written = writeCaptureNote(vault, {
    body,
    provenance: prov(),
    guidance: "file this under research",
  });
  const read = readCaptureNote(vault, written.id)!;
  expect(read.guidance).toBe("file this under research");
  expect(read.body).toBe(body);
});

test("empty guidance is refused by name rather than stored as an empty section", () => {
  expect(() =>
    writeCaptureNote(vault, { body: "text", provenance: prov(), guidance: "   " }),
  ).toThrow(CaptureContractError);
});

// ── t_151a564c: the stamped kind obeys a declared page_types vocabulary ──────

describe("writeCaptureNote — declared page_types vocabulary (t_151a564c)", () => {
  function writeConfig(pageTypes: string[] | null): void {
    if (pageTypes === null) return;
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      `schema:\n  page_types: [${pageTypes.join(", ")}]\n`,
      "utf8",
    );
  }

  test("a pack declaring page_types without brain-capture refuses before any file exists and before a name is consumed", () => {
    writeConfig(["note"]);
    let thrown: unknown;
    try {
      writeCaptureNote(vault, { body: "capture a thought", provenance: prov() });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CaptureContractError);
    // The refusal precedes every filesystem effect: the captures directory
    // is never created, so no file landed and no allocator name was consumed.
    expect(existsSync(capturesDir(vault))).toBe(false);
  });

  test("the refusal leaves an existing staging area untouched", () => {
    writeCaptureNote(vault, { body: "earlier capture", provenance: prov() });
    writeConfig(["note"]);
    expect(() => writeCaptureNote(vault, { body: "a second capture", provenance: prov() })).toThrow(
      CaptureContractError,
    );
    const staged = listStagedCaptures(vault);
    expect(staged).toHaveLength(1);
    expect(staged[0]!.body).toBe("earlier capture");
  });

  test("the refusal names the kind, the declared set, and the remedy", () => {
    writeConfig(["note"]);
    let thrown: unknown;
    try {
      writeCaptureNote(vault, { body: "capture a thought", provenance: prov() });
    } catch (err) {
      thrown = err;
    }
    const message = (thrown as CaptureContractError).message;
    expect(message).toContain("brain-capture");
    expect(message).toContain("note");
    expect(message).toContain("_brain.yaml");
  });

  test("a declared set containing brain-capture passes", () => {
    writeConfig(["note", "brain-capture"]);
    const note = writeCaptureNote(vault, { body: "capture a thought", provenance: prov() });
    expect(listStagedCaptures(vault)).toHaveLength(1);
    expect(readCaptureNote(vault, note.id)!.body).toBe("capture a thought");
  });

  test("absent config fails open with byte-identical output", () => {
    writeConfig(null);
    const open = writeCaptureNote(vault, { body: "capture a thought", provenance: prov() });
    const declaredVault = mkdtempSync(join(tmpdir(), "osb-capture-note-declared-"));
    try {
      mkdirSync(join(declaredVault, "Brain"), { recursive: true });
      writeFileSync(
        join(declaredVault, "Brain", "_brain.yaml"),
        "schema:\n  page_types: [note, brain-capture]\n",
        "utf8",
      );
      const gated = writeCaptureNote(declaredVault, {
        body: "capture a thought",
        provenance: prov(),
      });
      expect(readFileSync(join(vault, open.path), "utf8")).toBe(
        readFileSync(join(declaredVault, gated.path), "utf8"),
      );
    } finally {
      rmSync(declaredVault, { recursive: true, force: true });
    }
  });

  test("a config without a page_types declaration fails open", () => {
    writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n", "utf8");
    const note = writeCaptureNote(vault, { body: "capture a thought", provenance: prov() });
    expect(readCaptureNote(vault, note.id)!.provenance.source).toBe("telegram");
  });

  test("the kind stays the frontmatter key and a refused-then-fixed capture reads back", () => {
    writeConfig(["note"]);
    expect(() =>
      writeCaptureNote(vault, { body: "capture a thought", provenance: prov() }),
    ).toThrow(CaptureContractError);
    // The operator declares the kind; the same capture now lands and the
    // contract's reader still round-trips it through the `kind` key.
    writeConfig(["note", "brain-capture"]);
    const note = writeCaptureNote(vault, { body: "capture a thought", provenance: prov() });
    const read = readCaptureNote(vault, note.id)!;
    expect(read.body).toBe("capture a thought");
    expect(read.provenance.capturedAt).toBe("2026-07-19T12:00:00Z");
  });
});

// ---------------------------------------------------------------------------
// Write-time marker neutralization (t_c2ac4fc8, lane A3). The capture seam
// neutralizes caller text under the gate's enforce mode and records the
// neutralized kinds in a conditional frontmatter key; off and shadow write
// byte-identical output.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import {
  MARKDOWN_NEUTRALIZE_MODE_ENV,
  MarkdownNeutralizeModeError,
  detectMarkdownStructure,
} from "../../../../src/core/brain/text/neutralize-markdown.ts";
import { BRAIN_CAPTURES_REL } from "../../../../src/core/brain/paths.ts";

/** Set the gate mode env twin for one test, restoring it afterwards. */
function withGateMode(mode: string, run: () => void): void {
  const saved = process.env[MARKDOWN_NEUTRALIZE_MODE_ENV];
  process.env[MARKDOWN_NEUTRALIZE_MODE_ENV] = mode;
  try {
    run();
  } finally {
    if (saved === undefined) delete process.env[MARKDOWN_NEUTRALIZE_MODE_ENV];
    else process.env[MARKDOWN_NEUTRALIZE_MODE_ENV] = saved;
  }
}

/**
 * The id a fresh-vault capture of this text derives (captureBaseId's
 * contract: sha256 over source, sender, the TRIMMED body and the optional
 * guidance, first 8 hex; prefix `cap-<date>` keeps the date's dashes).
 */
function expectedId(body: string, guidance: string | null): string {
  const hash = createHash("sha256")
    .update(
      `telegram\u0000` +
        `12345\u0000` +
        `${body.trim()}` +
        (guidance === null ? "" : `\u0000${guidance}`),
      "utf8",
    )
    .digest("hex")
    .slice(0, 8);
  return `cap-2026-07-19-120000-${hash}`;
}

const MARKER_BODY = [
  "## Quoted",
  "",
  "see [[pref-target]] and [[pref-other|The Other]]",
  "",
  "@osb set note=[[x]] field=a value=b",
].join("\n");

test("gate off: a body full of live markers persists byte-identical to the legacy shape", () => {
  const note = writeCaptureNote(vault, { body: MARKER_BODY, provenance: prov() });
  const id = expectedId(MARKER_BODY, null);
  expect(note.id).toBe(id);
  expect(readFileSync(join(vault, note.path), "utf8")).toBe(
    [
      "---",
      "kind: brain-capture",
      `id: ${id}`,
      "capture_source: telegram",
      "capture_sender: 12345",
      'captured_at: "2026-07-19T12:00:00Z"',
      "tags: [brain, brain/capture]",
      "---",
      "",
      MARKER_BODY,
    ].join("\n") + "\n",
  );
});

test("gate shadow: bytes are unchanged and no provenance key is written", () => {
  withGateMode("shadow", () => {
    const note = writeCaptureNote(vault, { body: MARKER_BODY, provenance: prov() });
    const id = expectedId(MARKER_BODY, null);
    expect(readFileSync(join(vault, note.path), "utf8")).toBe(
      [
        "---",
        "kind: brain-capture",
        `id: ${id}`,
        "capture_source: telegram",
        "capture_sender: 12345",
        'captured_at: "2026-07-19T12:00:00Z"',
        "tags: [brain, brain/capture]",
        "---",
        "",
        MARKER_BODY,
        "",
      ].join("\n"),
    );
  });
});

test("gate enforce: planted markers are inert on disk and the kinds are recorded", () => {
  withGateMode("enforce", () => {
    const note = writeCaptureNote(vault, { body: MARKER_BODY, provenance: prov() });
    const raw = readFileSync(join(vault, note.path), "utf8");
    // The stored body is the post-neutralize text: no live structure per a
    // fence-masked scan of the persisted bytes.
    expect(detectMarkdownStructure(raw)).toEqual([]);
    expect(raw).toContain("\\[\\[pref-target\\]\\]");
    expect(raw).toContain("\\[\\[pref-other|The Other\\]\\]");
    expect(raw).toContain("\\#\\# Quoted");
    expect(raw).toContain("\\@osb set note=");
    // The conditional provenance key names the neutralized kinds, sorted.
    expect(raw).toContain("neutralized_markers: [atx-heading, osb-inline, wikilink]");
    // The reader hands back what was persisted, rendered as literal text.
    const read = readCaptureNote(vault, note.id)!;
    expect(read.body).toContain("\\[\\[pref-target\\]\\]");
    // Identity follows the persisted bytes.
    expect(note.id).toBe(expectedId(read.body, read.guidance));
  });
});

test("gate enforce: the guidance tail is neutralized and the writer's own split still works", () => {
  withGateMode("enforce", () => {
    const note = writeCaptureNote(vault, {
      body: "quotes a document\n\n## Guidance\n\nthe quoted fake section",
      guidance: "route to [[pref-sink]]",
      provenance: prov(),
    });
    const raw = readFileSync(join(vault, note.path), "utf8");
    // The caller-authored halves are inert; the page's ONE live heading
    // is the writer's own renderer-authored section heading.
    expect(raw).toContain("\\#\\# Guidance");
    expect(raw).toContain("\n\n## Guidance\n\n");
    expect(raw).toContain("route to \\[\\[pref-sink\\]\\]");
    expect(raw).toContain("neutralized_markers: [atx-heading, wikilink]");
    const read = readCaptureNote(vault, note.id)!;
    expect(detectMarkdownStructure(read.body)).toEqual([]);
    expect(detectMarkdownStructure(read.guidance!)).toEqual([]);
    // The split fires on the writer-set marker and never on the escaped one.
    expect(read.body).toBe("quotes a document\n\n\\#\\# Guidance\n\nthe quoted fake section");
    expect(read.guidance).toBe("route to \\[\\[pref-sink\\]\\]");
  });
});

test("gate enforce: a clean body gains zero bytes", () => {
  withGateMode("enforce", () => {
    const note = writeCaptureNote(vault, { body: "capture a thought", provenance: prov() });
    const id = expectedId("capture a thought", null);
    expect(readFileSync(join(vault, note.path), "utf8")).toBe(
      [
        "---",
        "kind: brain-capture",
        `id: ${id}`,
        "capture_source: telegram",
        "capture_sender: 12345",
        'captured_at: "2026-07-19T12:00:00Z"',
        "tags: [brain, brain/capture]",
        "---",
        "",
        "capture a thought",
        "",
      ].join("\n"),
    );
    expect(rawHasNeutralizedKey(join(vault, note.path))).toBe(false);
  });
});

function rawHasNeutralizedKey(path: string): boolean {
  return readFileSync(path, "utf8").includes("neutralized_markers:");
}

test("gate enforce: re-capture of the same text under a stable gate is idempotent", () => {
  withGateMode("enforce", () => {
    const first = writeCaptureNote(vault, { body: MARKER_BODY, provenance: prov() });
    const second = writeCaptureNote(vault, { body: MARKER_BODY, provenance: prov() });
    // Same text, same provenance, same gate: the same derived stem - the
    // allocator's exclusive-create suffix is the only difference.
    expect(second.id.startsWith(`${first.id}-`)).toBe(true);
    const firstRaw = readFileSync(join(vault, first.path), "utf8");
    const secondRaw = readFileSync(join(vault, second.path), "utf8");
    expect(secondRaw).toBe(firstRaw.replace(`id: ${first.id}`, `id: ${second.id}`));
  });
});

test("a misconfigured gate mode is refused before any filesystem effect", () => {
  withGateMode("sometimes", () => {
    expect(() =>
      writeCaptureNote(vault, { body: "capture a thought", provenance: prov() }),
    ).toThrow(MarkdownNeutralizeModeError);
    expect(existsSync(join(vault, "Brain", "captures"))).toBe(false);
  });
});

test("the staging area is where neutralized captures land", () => {
  withGateMode("enforce", () => {
    const note = writeCaptureNote(vault, { body: MARKER_BODY, provenance: prov() });
    expect(note.path.startsWith(`${BRAIN_CAPTURES_REL}/`)).toBe(true);
    expect(note.staged).toBe(true);
  });
});
