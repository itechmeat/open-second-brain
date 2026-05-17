---
kind: brain-signal
id: sig-2026-05-10-strict-types
created_at: "2026-05-10T15:30:00Z"
tags: [brain, brain/signal, brain/topic/strict-types-in-public-api, brain/scope/coding]
topic: strict-types-in-public-api
signal: positive
agent: starter-author
principle: "Public-API function signatures should be fully typed — no implicit any in exports."
scope: coding
source: ["[[Daily/2026.05.10]]"]
---

## Raw

Public functions should never accept implicit any — readers reading the type signature get the whole contract.
