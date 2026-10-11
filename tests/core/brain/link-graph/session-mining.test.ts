/**
 * Session-entity mining (recall-quality wave, Lane B / t_13a82a31).
 *
 * The miner is the precision-biased inverse of fact extraction: where
 * `extractFacts` strips code spans before matching, mining treats them as
 * the HIGHEST-precision source, because an identifier someone wrapped in
 * backticks is an identifier on purpose. Every family below is a
 * structural shape - no natural-language word list in any language - and
 * every side key is family-scoped and CASE-PRESERVING (NFC + trim only),
 * because symbols and paths are case-sensitive and the entity kernel's
 * lowercase fold is promotion's business, not the ledger's.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  FAKE_QUERY_KEY,
  FAKE_VENDOR_KEY,
  fakeCredential,
} from "../../../helpers/fake-credentials.ts";
import { extractFacts } from "../../../../src/core/brain/fact-extract.ts";
import { continuityLogDir } from "../../../../src/core/brain/continuity/store.ts";
import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import {
  MAX_MINED_KEYS_PER_SESSION,
  MINED_KEY_MAX_LENGTH,
  SESSION_ENTITY_MENTION_KIND,
  SESSION_MINING_FAMILIES,
  isSecretShapedMention,
  mineAndRecordTurn,
  mineTurnEntities,
  miningDedupeId,
  miningKey,
} from "../../../../src/core/brain/link-graph/session-mining.ts";

/** Flat list of (family, key) pairs, for order-insensitive assertions. */
function mined(text: string): ReadonlyArray<readonly [string, string]> {
  return mineTurnEntities(text).map((m) => [m.family, m.key] as const);
}

describe("session-mining families", () => {
  test("the family set is exactly the four precision families", () => {
    expect([...SESSION_MINING_FAMILIES].toSorted()).toEqual([
      "path",
      "qualified-ident",
      "symbol",
      "url",
    ]);
  });

  test("symbol: inline code spans yield their identifier-shaped content", () => {
    const out = mined("call `SessionStore` and `foo_bar` from `FTS5`.");
    expect(out).toContainEqual(["symbol", "SessionStore"]);
    expect(out).toContainEqual(["symbol", "foo_bar"]);
    expect(out).toContainEqual(["symbol", "FTS5"]);
  });

  test("symbol: fenced code blocks are harvested token by token", () => {
    const text = ["```ts", "const store = new MyClass();", "load_tree(path);", "```"].join("\n");
    const out = mined(text);
    expect(out).toContainEqual(["symbol", "MyClass"]);
    expect(out).toContainEqual(["symbol", "load_tree"]);
  });

  test("symbol: prose without code spans is never mined as a symbol", () => {
    expect(mined("the SessionStore class and foo_bar live in prose")).toEqual([]);
  });

  test("symbol: a non-identifier code span (prose in backticks) is refused", () => {
    expect(mined("the rule is `keep it simple` today")).toEqual([]);
  });

  test("the code cue is canonical's: $HOME and MCP::SERVER are not symbols", () => {
    // The two code-shape definitions must agree. canonical.ts's
    // CODE_SHAPE_CHAR_RE is `[_./\p{N}]` and its camel-hump test wants a
    // lowercase-LETTER predecessor, so `$HOME` and `MCP::SERVER` carry no
    // code shape there - the doctor's shouted-heading verdict rejects
    // them, and a mined key the doctor rejects defeats the promotion
    // bypass mining was meant to feed.
    expect(mined("export `$HOME` and point `MCP::SERVER` at it")).toEqual([]);
    // The cue the canonical class does carry keeps mining.
    expect(mined("wire `MCP_Server` up today")).toContainEqual(["symbol", "MCP_Server"]);
  });

  test("qualified-ident: dotted and double-colon shapes of two or more segments", () => {
    const out = mined("wire osb.core.SessionStore through my_pkg::loader next");
    expect(out).toContainEqual(["qualified-ident", "osb.core.SessionStore"]);
    expect(out).toContainEqual(["qualified-ident", "my_pkg::loader"]);
  });

  test("qualified-ident: a shape needs a structural cue, plain prose pairs stay out", () => {
    // `alpha.beta` carries no digit, underscore or internal uppercase, so
    // it is indistinguishable from a name - refused. A third segment, a
    // digit, an underscore or a camel hump is the cue.
    expect(mined("read alpha.beta today")).toEqual([]);
    expect(mined("read alpha.beta.gamma today")).toContainEqual([
      "qualified-ident",
      "alpha.beta.gamma",
    ]);
    expect(mined("see Module2.method here")).toContainEqual(["qualified-ident", "Module2.method"]);
  });

  test("qualified-ident: one-letter segments stay out (no e.g / i.e captures)", () => {
    expect(mined("arrive e.g. today, i.e. tomorrow")).toEqual([]);
  });

  test("url: the fact-extract URL family is reproduced exactly on prose", () => {
    const text = "pin https://osb.example/run?dry=1 and http://intra.internal:8080/status";
    const factUrls = extractFacts(text)
      .filter((f) => f.family === "url")
      .map((f) => f.text)
      .toSorted();
    const minedUrls = mined(text)
      .filter(([family]) => family === "url")
      .map(([, key]) => key)
      .toSorted();
    expect(minedUrls).toEqual(factUrls);
    expect(minedUrls.length).toBe(2);
  });

  test("path: both slash directions with an extension", () => {
    const out = mined("edit src/core/store.ts then .\\notes\\idea.md and /usr/local/bin/run.sh");
    expect(out).toContainEqual(["path", "src/core/store.ts"]);
    expect(out).toContainEqual(["path", ".\\notes\\idea.md"]);
    expect(out).toContainEqual(["path", "/usr/local/bin/run.sh"]);
  });

  test("path: a separator without an extension is not a path", () => {
    expect(mined("look in src/core for it")).toEqual([]);
  });

  test("path: a host home path mines home-relative, never with the username", () => {
    // The design's "never a host absolute path" rule: a username in a
    // mined key reaches hallways.md and promoted pages, so the home
    // directory is replaced by `~` before the key is minted.
    const home = homedir();
    const out = mined(
      `see ${home}/notes/todo.md, /home/alice/notes/x.md and C:\\Users\\bob\\docs\\plan.md`,
    );
    expect(out).toContainEqual(["path", "~/notes/todo.md"]);
    expect(out).toContainEqual(["path", "~/notes/x.md"]);
    expect(out).toContainEqual(["path", "~\\docs\\plan.md"]);
    expect(out.some(([, key]) => key.includes("alice") || key.includes("bob"))).toBe(false);
    expect(out.some(([, key]) => key.startsWith("/home/") || key.includes("\\Users\\"))).toBe(
      false,
    );
  });

  test("path: a non-home path keeps its form", () => {
    const out = mined("edit src/core/store.ts and /usr/local/bin/run.sh today");
    expect(out).toContainEqual(["path", "src/core/store.ts"]);
    expect(out).toContainEqual(["path", "/usr/local/bin/run.sh"]);
  });

  test("families do not re-read inside each other: a URL is one mention, not three", () => {
    const out = mined("clone https://osb.example/repo.git now");
    expect(out).toEqual([["url", "https://osb.example/repo.git"]]);
  });

  test("span offsets stay aligned across a long turn: the URL claim lands where it must", () => {
    // A long turn pushes the URL (and the code span beside it) far past the
    // first line, so the claimed-range bookkeeping must hold its
    // lines->joined offsets over hundreds of lines: a drifted offset would
    // misplace the URL's claim and let the prose passes re-read inside it
    // or swallow the code span.
    const filler = Array.from({ length: 400 }, (_, i) => `filler line ${i} of plain prose`);
    const text = [
      ...filler,
      "see https://osb.example/deep/link and `OffsetPinStore`",
      ...filler,
    ].join("\n");
    const out = mined(text);
    expect(out).toContainEqual(["url", "https://osb.example/deep/link"]);
    expect(out).toContainEqual(["symbol", "OffsetPinStore"]);
    expect(out.filter(([family]) => family === "url")).toHaveLength(1);
  });

  test("code spans own their content: a path in a code span is a symbol, not a path", () => {
    const out = mined("run `src/core/store.ts` first");
    expect(out).toEqual([["symbol", "src/core/store.ts"]]);
  });

  test("mentions are deduped within a turn and deterministic", () => {
    const text = "use `SessionStore` twice `SessionStore` and once more";
    const first = mineTurnEntities(text);
    const second = mineTurnEntities(text);
    expect([...first]).toEqual([...second]);
    expect(first.filter((m) => m.key === "SessionStore").length).toBe(1);
  });

  test("oversized lines are capped, never scanned in full", () => {
    const blob = `x`.repeat(20000);
    const out = mined(`see ${blob}/evil.ts here`);
    expect(out).toEqual([]);
  });
});

describe("mining keys", () => {
  test("case is preserved: two casings of one symbol are two keys", () => {
    expect(miningKey("SessionStore")).toBe("SessionStore");
    expect(miningKey("sessionstore")).toBe("sessionstore");
    expect(miningKey("SessionStore")).not.toBe(miningKey("sessionstore"));
  });

  test("keys normalize to NFC and trim, nothing else", () => {
    const composed = "caf\u00e9";
    const decomposed = "cafe\u0301";
    expect(miningKey(decomposed)).toBe(miningKey(composed));
    expect(miningKey("  MyClass  ")).toBe("MyClass");
  });

  test("keys are length-capped, not unbounded", () => {
    expect(miningKey("A".repeat(5000)).length).toBeLessThanOrEqual(MINED_KEY_MAX_LENGTH);
  });
});

describe("secret-shaped refusal", () => {
  test("a vendor-prefixed key inside a code span is refused", () => {
    const text = `the key is \`${FAKE_VENDOR_KEY}\` in the config`;
    expect(isSecretShapedMention("symbol", FAKE_VENDOR_KEY)).toBe(true);
    expect(mined(text)).toEqual([]);
  });

  test("a credential URL (user:pass@host) is refused", () => {
    const pass = fakeCredential("hu", "nter2");
    const url = `https://deploy:${pass}@osb.example/repo.git`;
    expect(isSecretShapedMention("url", url)).toBe(true);
    expect(mined(`clone ${url} now`)).toEqual([]);
  });

  test("a token query form is refused", () => {
    const tok = fakeCredential("tok", "en-9f8e7d6c5b");
    const url = `https://osb.example/pull?token=${tok}`;
    expect(isSecretShapedMention("url", url)).toBe(true);
    expect(mined(`fetch ${url} today`)).toEqual([]);
  });

  test("a credential query parameter refuses the URL whole, by name", () => {
    // The redactor's exact-name pass catches `token=`/`key=`; the sibling
    // spellings a mined URL meets in the wild must refuse too - the ledger
    // keeps the mention id verbatim in sourceRefs[].id, so the
    // credential-bearing URL must never be minted at all.
    const url = `https://osb.example/v1/data?api_key=${FAKE_QUERY_KEY}&dry=1`;
    expect(isSecretShapedMention("url", url)).toBe(true);
    expect(mined(`fetch ${url} today`)).toEqual([]);
  });

  test("the sibling credential spellings refuse too: apikey, api-key, access_token, auth_token", () => {
    for (const name of ["apikey", "api-key", "access_token", "auth_token"]) {
      const url = `https://osb.example/v1/data?${name}=${FAKE_QUERY_KEY}`;
      expect(isSecretShapedMention("url", url)).toBe(true);
      expect(mined(`fetch ${url} today`)).toEqual([]);
    }
  });

  test("the credential-param refusal is case-insensitive", () => {
    expect(isSecretShapedMention("url", `https://osb.example/?API_KEY=${FAKE_QUERY_KEY}`)).toBe(
      true,
    );
    expect(isSecretShapedMention("url", `https://osb.example/?Auth-Token=${FAKE_QUERY_KEY}`)).toBe(
      true,
    );
  });

  test("a name-shaped path or parameter is not a credential: no over-refusal", () => {
    expect(isSecretShapedMention("url", "https://osb.example/settings/api_keys?page=2")).toBe(
      false,
    );
    expect(isSecretShapedMention("url", "https://osb.example/?api_key_version=2")).toBe(false);
    expect(isSecretShapedMention("url", "https://osb.example/run?dry=1")).toBe(false);
  });

  test("a credential URL with the token in its PATH is refused: Telegram bot shape", () => {
    // The ledger keeps a mention's sourceRefs[].id verbatim, so a
    // credential-bearing URL must never be minted at all - whichever
    // segment carries the credential. A bot token lives in the path.
    const bot = fakeCredential("123456789:", "AAHxyzABCdefGHIjklMNOpqrsTUVwxyz12345");
    const url = `https://api.telegram.org/bot${bot}/sendMessage`;
    expect(isSecretShapedMention("url", url)).toBe(true);
    expect(mined(`post ${url} now`)).toEqual([]);
  });

  test("a vendor webhook URL is refused: Slack incoming-hook shape", () => {
    const hook = fakeCredential("Xx1", "9f8e7d6c5b4a3210011223344");
    const url = `https://hooks.slack.com/services/T0000000/B0000000/${hook}`;
    expect(isSecretShapedMention("url", url)).toBe(true);
    expect(mined(`post ${url} now`)).toEqual([]);
  });

  test("credential query spellings refuse too: private_token and client_secret", () => {
    for (const name of ["private_token", "client_secret"]) {
      const url = `https://osb.example/v1/data?${name}=${FAKE_QUERY_KEY}`;
      expect(isSecretShapedMention("url", url)).toBe(true);
      expect(mined(`fetch ${url} today`)).toEqual([]);
    }
  });

  test("a fragment parameter refuses the URL: the implicit-flow shape", () => {
    // `#access_token=...` never reaches the query-pass boundary (`?`/`&`),
    // so the fragment separator is a boundary too.
    const url = `https://app.example.com/cb#access_token=${FAKE_QUERY_KEY}`;
    expect(isSecretShapedMention("url", url)).toBe(true);
    expect(mined(`open ${url} today`)).toEqual([]);
  });

  test("a fragment that names no credential keeps the URL: no over-refusal", () => {
    expect(isSecretShapedMention("url", "https://osb.example/docs#section-2")).toBe(false);
    expect(isSecretShapedMention("url", "https://osb.example/run?dry=1#top")).toBe(false);
  });

  test("a plain public URL is not refused", () => {
    expect(isSecretShapedMention("url", "https://osb.example/run?dry=1")).toBe(false);
  });

  test("ordinary identifiers are not refused", () => {
    expect(isSecretShapedMention("symbol", "SessionStore")).toBe(false);
    expect(isSecretShapedMention("symbol", "foo_bar")).toBe(false);
    expect(isSecretShapedMention("path", "src/core/store.ts")).toBe(false);
  });
});

describe("dedupe granularity", () => {
  test("the dedupe id is (family, key, sessionRef) - same key, other session, other id", () => {
    const a = miningDedupeId("symbol", "SessionStore", "s1.jsonl");
    expect(miningDedupeId("symbol", "SessionStore", "s1.jsonl")).toBe(a);
    expect(miningDedupeId("symbol", "SessionStore", "s2.jsonl")).not.toBe(a);
    expect(miningDedupeId("path", "SessionStore", "s1.jsonl")).not.toBe(a);
  });
});

describe("mineAndRecordTurn", () => {
  // bootstrapBrain(vault) bare is the shape the sibling link-graph tests use.
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "o2b-mine-record-"));
    bootstrapBrain(vault);
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  const NOW = new Date("2026-06-13T12:00:00Z");

  function input(
    overrides: Partial<Parameters<typeof mineAndRecordTurn>[1]> = {},
  ): Parameters<typeof mineAndRecordTurn>[1] {
    return {
      vault,
      text: "touch `SessionStore` and src/core/store.ts today",
      sessionRef: "s1.jsonl",
      turnId: "t1",
      now: NOW,
      seen: new Set(),
      ...overrides,
    };
  }

  function ledgerLines(): number {
    const dir = continuityLogDir(vault);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) return 0;
    let count = 0;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".jsonl")) continue;
      count += readFileSync(join(dir, entry), "utf8").trim().split("\n").filter(Boolean).length;
    }
    return count;
  }

  test("an applied turn writes its mentions and counts them extracted", () => {
    const seen = new Set<string>();
    const out = mineAndRecordTurn(vault, input({ seen }));
    expect(out.extracted).toBe(2);
    expect(out.ledgerFailed).toBe(0);
    expect(out.secretRefused).toBe(0);
    expect(ledgerLines()).toBe(2);
    // The written mentions are marked seen, so a re-fold dedupes.
    expect(seen.size).toBe(2);
  });

  test("a fresh run seeds its dedupe set from the ledger: a re-import dedupes", () => {
    // A re-import starts from an empty caller-owned set - the shape every
    // new process has. The first turn of the run reads the existing
    // mention rows once and seeds the set from them, so the re-import
    // folds to dedupe counters instead of appending duplicate rows.
    mineAndRecordTurn(vault, input());
    expect(ledgerLines()).toBe(2);

    const reimport = mineAndRecordTurn(vault, input({ seen: new Set() }));
    expect(reimport.extracted).toBe(0);
    expect(reimport.deduped).toBe(2);
    expect(ledgerLines()).toBe(2);
  });

  test("a failed ledger append is counted by name, never silent", () => {
    // Sabotage: a regular file where the continuity ledger's directory must
    // be, so every append throws. The telemetry-grade tolerance holds - the
    // turn must never fail - but the never-silent convention demands the
    // failures be COUNTED, not swallowed.
    writeFileSync(continuityLogDir(vault), "not a directory\n");
    const out = mineAndRecordTurn(vault, input());
    expect(out.extracted).toBe(0);
    expect(out.ledgerFailed).toBe(2);
    expect(ledgerLines()).toBe(0);
  });

  test("a failed append leaves the mention unseen, so it re-folds on a later run", () => {
    writeFileSync(continuityLogDir(vault), "not a directory\n");
    const seen = new Set<string>();
    mineAndRecordTurn(vault, input({ seen }));
    expect(seen.size).toBe(0);
    // Repair the ledger: the same mention re-folds and lands.
    rmSync(continuityLogDir(vault), { force: true });
    const retried = mineAndRecordTurn(vault, input({ seen }));
    expect(retried.extracted).toBe(2);
    expect(retried.ledgerFailed).toBe(0);
  });

  test("a fence holding a refused URL still mines the symbols around it", () => {
    // The old fence pass skipped a block WHOLE when the URL pass claimed
    // anything inside it, so one link silently deleted every symbol in the
    // fence. The URL stays the URL pass's - refused here, counted - and
    // the tokens around it are still mined, with the URL's own text masked
    // out so a refusal cannot re-enter the ledger as a symbol key.
    const text = [
      "```",
      "const hook = loadWebhook();",
      `see https://osb.example/pull?token=${FAKE_QUERY_KEY} inside`,
      "```",
    ].join("\n");
    const seen = new Set<string>();
    const out = mineAndRecordTurn(vault, input({ text, seen }));
    expect(out.secretRefused).toBe(1);
    expect(out.extracted).toBe(1);
    expect(mined(text)).toEqual([["symbol", "loadWebhook"]]);
  });
});

describe("the per-session key cap", () => {
  // Same harness shape as the mineAndRecordTurn block above.
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "o2b-mining-cap-"));
    bootstrapBrain(vault);
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  const NOW = new Date("2026-06-13T12:00:00Z");

  function ledgerMentionRows(): number {
    const dir = continuityLogDir(vault);
    let count = 0;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".jsonl")) continue;
      for (const line of readFileSync(join(dir, entry), "utf8").trim().split("\n")) {
        if (line.includes(SESSION_ENTITY_MENTION_KIND)) count++;
      }
    }
    return count;
  }

  test("an over-cap session stops minting and counts the overflow, never silently", () => {
    const seen = new Set<string>();
    // One hostile turn carrying more distinct keys than a session may
    // hold, one span per line (each line stays under the per-line scan
    // cap, so every span is really scanned).
    const overCap = MAX_MINED_KEYS_PER_SESSION + 10;
    const text = Array.from({ length: overCap }, (_, i) => `\`Cap_key_${i}\``).join("\n");
    const first = mineAndRecordTurn(vault, {
      vault,
      text,
      sessionRef: "hostile.jsonl",
      turnId: "u-1",
      now: NOW,
      seen,
    });
    expect(first.extracted).toBe(MAX_MINED_KEYS_PER_SESSION);
    expect(first.capOverflow).toBe(10);
    expect(ledgerMentionRows()).toBe(MAX_MINED_KEYS_PER_SESSION);

    // A later turn of the SAME session mints nothing: every fresh key is
    // overflow now, counted by name.
    const second = mineAndRecordTurn(vault, {
      vault,
      text: "`Cap_after_a` `Cap_after_b`",
      sessionRef: "hostile.jsonl",
      turnId: "u-2",
      now: NOW,
      seen,
    });
    expect(second.extracted).toBe(0);
    expect(second.capOverflow).toBe(2);
    expect(ledgerMentionRows()).toBe(MAX_MINED_KEYS_PER_SESSION);
  });

  test("the cap is per session: another session in the run keeps its own budget", () => {
    const seen = new Set<string>();
    const hostile = Array.from(
      { length: MAX_MINED_KEYS_PER_SESSION },
      (_, i) => `\`Cap_full_${i}\``,
    ).join("\n");
    mineAndRecordTurn(vault, {
      vault,
      text: hostile,
      sessionRef: "hostile.jsonl",
      turnId: "u-1",
      now: NOW,
      seen,
    });
    const other = mineAndRecordTurn(vault, {
      vault,
      text: "`Cap_calm_key`",
      sessionRef: "calm.jsonl",
      turnId: "u-1",
      now: NOW,
      seen,
    });
    expect(other.extracted).toBe(1);
    expect(other.capOverflow).toBe(0);
  });
});
