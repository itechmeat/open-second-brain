# Tasks: every writer of a vault stops while its migration holds the gate

Work in order. For every behaviour: write the failing test first, run it
and see it fail, then the code. Fixtures only, never a real vault; a test
that runs the CLI does so as a subprocess with every host home inside the
fixture.

## 1. Reproduce

- [x] 1.1 `o2b brain note` as a subprocess and `brain_note` through the MCP
  dispatch, with the gate held by a live holder of the fixture vault:
  both wrote into the legacy tree.

## 2. Census

- [x] 2.1 One table of every CLI verb, MCP tool, hook and background
  worker (`tests/core/architecture/migration-gate-census/table.ts`), each
  classified with its guard; the allowed writers listed with the reason.
- [x] 2.2 The table compared with the live surface in both directions, and
  every row driven under this vault's gate, another vault's gate and no
  gate, split across several files sharing one fixture.

## 3. The rule

- [x] 3.1 A device-local write after the last pass is lost after the
  switch: refusal on every lane.

## 4. The fix

- [x] 4.1 The guard asks the gate on both lanes; the snapshot passes inside
  the holder scope.
- [x] 4.2 Every writer outside the guard asks the gate; readers and hooks
  degrade without a write.
- [x] 4.3 The refusal names the run, since when, its progress and the
  recovery; the MCP refusal carries the same, also through a wrapped
  error.

## 5. Spec and docs

- [x] 5.1 The quiesce requirement of `brain-migration` and its scenarios;
  `docs/brain-store.md`, `docs/mcp.md`, `CHANGELOG.md`.
