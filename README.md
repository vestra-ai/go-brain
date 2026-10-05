# go-brain

**Go** itself: the AI member of every trip group. It reads the room, remembers people, searches, books and calls (hackweek, 5 to 9 October 2026).

Three repos, one product:

| Repo | Who | What |
|---|---|---|
| **go-brain** (this one) | Keshav's team | Go itself: its brain, memory, hands, bookings and the vault. It publishes the contract below. |
| server | Nishanth's team | Everything about a trip and its database: people, the room, votes, the trip record, bookings, money, the spend check. |
| go-app | Saket's team | The app people use. |

All three teams are the Vestra team.

## What lives here

- `docs/guide`: **start here.** The guide to the contract between the app, the server and go-brain, in plain
  words, with TypeScript and Python for every piece.
- `packages/contract`: the contract in zod (the source of truth), with `openapi/go-brain.json`,
  `asyncapi/socket.json` and `socket/methods.json` generated from it, the socket signing and spend approval
  helpers, and shared test vectors.
- `packages/contract-py`: the same contract for Python (pydantic models, signing, spend approvals).
- `packages/agent-sdk`: the agent loop, copied from the Bash monorepo (see its `PROVENANCE.md`).
- `apps/brain`: the service. The `go` channel, Go in group mode, memory, Go's tools, bookings through
  ixigo, the call service and the vault.

Nothing here touches the Bash or Vestra servers, databases or deploys.

Design: the team site https://vestrago.vercel.app, the go-brain map (`mockups/go-brain-map-2026-10-04.html`) and
the spec in `vestra-ai/bash` on branch `docs/go-hackweek-spec`. Where they differ from `docs/guide`, the guide wins.
