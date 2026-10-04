# go-brain

The Vestra side of **Go**, the AI member of every trip group (hackweek, 5 to 9 October 2026).

Three repos, one product:

| Repo | Who | What |
|---|---|---|
| **go-brain** (this one) | Keshav and Claude | Go's brain, hands, bookings and vault |
| go-server | the Go team | everything about the trip: trips, members, the room, decisions, the spend check, money, push |
| go-app | the Go team | the app people use |

## What lives here

- `packages/contract`: the contract between go-server and go-brain. Zod schemas are the source of truth;
  `packages/contract/openapi.json` is generated from them for the Go team. Message in, message out, the
  trip API, the signed spend approval, and request signing.
- `packages/agent-sdk`: the agent loop, copied from the Bash monorepo (see its `PROVENANCE.md`).
- `apps/brain`: the service. The `go` channel, Go in group mode, memory, Go's tools, bookings through
  ixigo, the call service and the vault.

Nothing here touches the Bash or Vestra servers, databases or deploys.

Design: the team site https://vestrago.vercel.app and the spec in `vestra-ai/bash` on branch
`docs/go-hackweek-spec` (`docs/superpowers/specs/2026-10-03-go-hackweek-design.md`).
