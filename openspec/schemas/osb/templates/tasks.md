# Tasks: <!-- change title -->

Work in order, one section at a time. Before a section, read its part of
`design.md` and the spec delta it names. Tick each box (`- [x]`) as soon
as it is done, so an interrupted run can resume from the first open box.
Partial edits from an earlier attempt may already be in the tree: review
them, keep what is right, finish the rest.

For every behaviour: write the failing test first, run it and see it
fail, then write the code.

## Environment and rules

<!-- Shell setup (temp dir outside the checkout), executor rules (this checkout only; no real user state; no commit, push or pull request; no subagents; language rules), which tests to run during a section -->

## 0. Preconditions

- [ ] 0.1 <!-- Confirm the tree and take the test baseline; stop and report on a mismatch -->

## 1. <!-- Task group -->

- [ ] 1.1 <!-- Test first: file, cases; then the code; how it is verified -->

## N. The gate

- [ ] N.1 <!-- The full local gate of openspec/project.md, each command on its own, plus generated artifacts -->

## N+1. Report

- [ ] N+1.1 <!-- What the executor reports back -->

## Workflow follow-up

- Independent code review rounds, then archive the change inside its pull request.
