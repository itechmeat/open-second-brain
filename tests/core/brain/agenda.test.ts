import { test, expect } from "bun:test";

import { synthesizeAgenda, AgendaError } from "../../../src/core/brain/agenda.ts";

const EVENTS = [
  { id: "a", title: "Standup", start: "2026-06-19T09:00:00Z", end: "2026-06-19T09:30:00Z" },
  { id: "b", title: "Design", start: "2026-06-19T11:00:00Z", end: "2026-06-19T12:00:00Z" },
  { id: "c", title: "Overlap", start: "2026-06-19T11:30:00Z", end: "2026-06-19T12:30:00Z" },
];

test("normalizes and sorts events by start", () => {
  const snap = synthesizeAgenda([
    { title: "late", start: "2026-06-19T15:00:00Z", end: "2026-06-19T16:00:00Z" },
    { title: "early", start: "2026-06-19T08:00:00Z", end: "2026-06-19T09:00:00Z" },
  ]);
  expect(snap.events.map((e) => e.title)).toEqual(["early", "late"]);
  expect(snap.events[0]!.id).toBe("event-1"); // index preserved before sort
});

test("detects overlapping events as conflicts", () => {
  const snap = synthesizeAgenda(EVENTS);
  expect(snap.counts.conflicts).toBe(1);
  const conflict = snap.conflicts[0]!;
  expect(new Set([conflict.a.id, conflict.b.id])).toEqual(new Set(["b", "c"]));
  expect(conflict.overlapMinutes).toBe(30);
});

test("does not flag back-to-back events as conflicts", () => {
  const snap = synthesizeAgenda([
    { id: "a", start: "2026-06-19T09:00:00Z", end: "2026-06-19T10:00:00Z" },
    { id: "b", start: "2026-06-19T10:00:00Z", end: "2026-06-19T11:00:00Z" },
  ]);
  expect(snap.counts.conflicts).toBe(0);
});

test("finds free focus blocks between events", () => {
  const snap = synthesizeAgenda(EVENTS, { focusMinMinutes: 60 });
  // Gap between Standup (ends 09:30) and Design (starts 11:00) = 90m.
  expect(snap.focusBlocks.length).toBe(1);
  expect(snap.focusBlocks[0]!.minutes).toBe(90);
  expect(snap.focusBlocks[0]!.start).toBe("2026-06-19T09:30Z");
  expect(snap.focusBlocks[0]!.end).toBe("2026-06-19T11:00Z");
});

test("focus threshold filters out short gaps", () => {
  const snap = synthesizeAgenda(EVENTS, { focusMinMinutes: 120 });
  expect(snap.focusBlocks.length).toBe(0);
});

test("workday window clips focus blocks and surfaces pre/post gaps", () => {
  const snap = synthesizeAgenda(
    [{ id: "m", start: "2026-06-19T12:00:00Z", end: "2026-06-19T13:00:00Z" }],
    { focusMinMinutes: 60, workdayStart: "09:00", workdayEnd: "17:00" },
  );
  // 09:00–12:00 (180m) and 13:00–17:00 (240m) are both focus blocks.
  expect(snap.focusBlocks.map((b) => b.minutes)).toEqual([180, 240]);
});

test("flags external organizers by domain", () => {
  const snap = synthesizeAgenda(
    [
      {
        id: "x",
        title: "Internal",
        start: "2026-06-19T09:00:00Z",
        end: "2026-06-19T10:00:00Z",
        organizer: "me@acme.io",
      },
      {
        id: "y",
        title: "Vendor",
        start: "2026-06-19T11:00:00Z",
        end: "2026-06-19T12:00:00Z",
        organizer: "rep@vendor.com",
      },
    ],
    { ownerDomains: ["acme.io"] },
  );
  expect(snap.counts.externalOrganizers).toBe(1);
  expect(snap.externalOrganizers[0]!.id).toBe("y");
  expect(snap.externalOrganizers[0]!.domain).toBe("vendor.com");
});

test("external-organizer detection is disabled without owner domains", () => {
  const snap = synthesizeAgenda([
    {
      id: "y",
      start: "2026-06-19T11:00:00Z",
      end: "2026-06-19T12:00:00Z",
      organizer: "rep@vendor.com",
    },
  ]);
  expect(snap.counts.externalOrganizers).toBe(0);
});

test("rejects unparseable timestamps and inverted intervals", () => {
  expect(() => synthesizeAgenda([{ start: "not-a-date", end: "2026-06-19T10:00:00Z" }])).toThrow(
    AgendaError,
  );
  expect(() =>
    synthesizeAgenda([{ start: "2026-06-19T10:00:00Z", end: "2026-06-19T09:00:00Z" }]),
  ).toThrow(/ends before it starts/);
});

test("empty agenda yields empty everything", () => {
  const snap = synthesizeAgenda([]);
  expect(snap.counts).toEqual({ events: 0, conflicts: 0, focusBlocks: 0, externalOrganizers: 0 });
});

test("is deterministic for the same input", () => {
  expect(synthesizeAgenda(EVENTS)).toEqual(synthesizeAgenda(EVENTS));
});
