# go-brain

The Vestra side of **Go**, the AI member of every trip group (hackweek, 5 to 9 October 2026).

Three repos, one product:

| Repo | Who | What |
|---|---|---|
| **go-brain** (this one) | Keshav and Claude | Go's brain, hands, bookings and vault |
| go-server | the Go team | everything about the trip: trips, members, the room, decisions, the spend check, money, push |
| go-app | the Go team | the app people use |

## What lives here

- `docs/guide`: **start here.** The guide to the contract between the app, go-server and go-brain, in plain
  words, with TypeScript and Python for every piece.
- `packages/contract`: the contract in zod (the source of truth), with `openapi/go-server.json` and
  `openapi/go-brain.json` generated from it, the request signing and spend approval helpers, and shared test
  vectors.
- `packages/contract-py`: the same contract for Python (pydantic models, signing, spend approvals).
- `packages/agent-sdk`: the agent loop, copied from the Bash monorepo (see its `PROVENANCE.md`).
- `apps/brain`: the service. The `go` channel, Go in group mode, memory, Go's tools, bookings through
  ixigo, the call service and the vault.

Nothing here touches the Bash or Vestra servers, databases or deploys.

Design: the team site https://vestrago.vercel.app, the go-brain map (`mockups/go-brain-map-2026-10-04.html`) and
the spec in `vestra-ai/bash` on branch `docs/go-hackweek-spec`. Where they differ from `docs/guide`, the guide wins.
