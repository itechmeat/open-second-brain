/**
 * `payload-json` (trust-surface-hardening, t_dac8bf7e): the strip-and-note
 * parser the four model-answer verbs share. Claims pinned here:
 *
 *  1. A clean payload parses as-is and carries NO strip fact - the strip
 *     fires only after a failed plain parse.
 *  2. A leading `<think>...</think>` block is stripped and the fact is
 *     always reported (`kind`, `prefixChars`), for the prose-prefixed and
 *     the fenced-body shapes.
 *  3. The strip never rescues genuinely malformed JSON: strip-then-still-
 *     invalid keeps the named error, and the message names the strip
 *     attempt; plain garbage keeps the plain refusal.
 *  4. Only ONE leading block is stripped, and only when it is leading.
 */

import { describe, expect, test } from "bun:test";

import {
  FENCED_THINK_BLOCK_STRIP_KIND,
  parsePayloadJson,
  PayloadJsonError,
  payloadStripNote,
  PAYLOAD_UNPARSEABLE_MESSAGE,
  THINK_BLOCK_STRIP_KIND,
} from "../../../src/core/brain/payload-json.ts";

function parseFailing(raw: string): PayloadJsonError {
  try {
    parsePayloadJson(raw);
  } catch (error) {
    if (error instanceof PayloadJsonError) return error;
    throw error;
  }
  throw new Error(`expected a PayloadJsonError for ${JSON.stringify(raw)}`);
}

describe("parsePayloadJson", () => {
  test("a clean payload parses as-is and carries no strip fact", () => {
    const parsed = parsePayloadJson('{"a":1}');
    expect(parsed.payload).toEqual({ a: 1 });
    expect("strip" in parsed).toBe(false);
  });

  test("the strip fires only after a failed plain parse", () => {
    // The think block sits INSIDE a valid JSON string: the plain parse
    // succeeds, so no strip may fire.
    const raw = JSON.stringify({ text: "<think>not stripped</think>" });
    const parsed = parsePayloadJson(raw);
    expect(parsed.payload).toEqual({ text: "<think>not stripped</think>" });
    expect("strip" in parsed).toBe(false);
  });

  test("a prose-prefixed think block is stripped and the fact named", () => {
    const think = "<think>reasoning about the answer</think>";
    const parsed = parsePayloadJson(`${think}{"a":1}`);
    expect(parsed.payload).toEqual({ a: 1 });
    expect(parsed.strip).toEqual({ kind: THINK_BLOCK_STRIP_KIND, prefixChars: think.length });
  });

  test("leading whitespace counts into the stripped prefix", () => {
    const head = "\n  <think>r</think>";
    const parsed = parsePayloadJson(`${head} {"a":1}`);
    expect(parsed.payload).toEqual({ a: 1 });
    expect(parsed.strip?.kind).toBe(THINK_BLOCK_STRIP_KIND);
    expect(parsed.strip?.prefixChars).toBe(head.length);
  });

  test("a think block ahead of a fenced body strips the prefix and names the fenced kind", () => {
    const think = "<think>deliberating</think>";
    const raw = `${think}\n\`\`\`json\n{"a":1}\n\`\`\`\n`;
    const parsed = parsePayloadJson(raw);
    expect(parsed.payload).toEqual({ a: 1 });
    expect(parsed.strip?.kind).toBe(FENCED_THINK_BLOCK_STRIP_KIND);
    // prefixChars counts every character removed before the JSON body.
    expect(parsed.strip?.prefixChars).toBe(raw.indexOf('{"a":1}'));
  });

  test("a multi-line think body stops at the first closing tag", () => {
    const think = '<think>line one\n{ "not": "json" }\nline two</think>';
    const parsed = parsePayloadJson(`${think}{"ok":true}`);
    expect(parsed.payload).toEqual({ ok: true });
    expect(parsed.strip?.prefixChars).toBe(think.length);
  });

  test("a fenced body with no think block is not this module's rescue", () => {
    // The module strips think blocks; a bare fenced payload was refused
    // before this module existed and still is, with the plain message.
    const error = parseFailing('```json\n{"a":1}\n```');
    expect(error.message).toBe(PAYLOAD_UNPARSEABLE_MESSAGE);
  });

  test("a think block that is not leading is not stripped", () => {
    const error = parseFailing('{"a":1}<think>x</think>');
    expect(error.message).toBe(PAYLOAD_UNPARSEABLE_MESSAGE);
  });

  test("strip-then-still-invalid keeps the named error and names the strip attempt", () => {
    const error = parseFailing("<think>reasoning</think>not json at all");
    expect(error.name).toBe("PayloadJsonError");
    expect(error.message).toContain(PAYLOAD_UNPARSEABLE_MESSAGE);
    expect(error.message).toContain("<think>");
  });

  test("plain garbage keeps the plain refusal with no strip mention", () => {
    const error = parseFailing("not json");
    expect(error.message).toBe(PAYLOAD_UNPARSEABLE_MESSAGE);
    expect(error.message).not.toContain("stripped");
  });

  test("only one leading block is stripped", () => {
    const error = parseFailing('<think>a</think><think>b</think>{"a":1}');
    expect(error.message).toContain("<think>");
  });
});

test("the strip note names the kind and the prefix size", () => {
  expect(payloadStripNote({ kind: THINK_BLOCK_STRIP_KIND, prefixChars: 24 })).toBe(
    "leading <think> block stripped before JSON parse (kind=think_block, prefix_chars=24)",
  );
});
