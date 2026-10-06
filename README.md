# Go

[![ci](https://github.com/vestra-ai/go-brain/actions/workflows/ci.yml/badge.svg)](https://github.com/vestra-ai/go-brain/actions/workflows/ci.yml)

Go is the AI member of a trip group. Friends plan a trip in a group chat, and Go is in that chat with them: it reads every message, answers when someone asks, keeps track of what each person said and what the group agreed, and can phone a business for the group. To the people in the room, Go is one member of the group, and this repo is Go.

## The three parts

| Part | Built by | What it does |
|---|---|---|
| **The App** | Saket's team | The app people use: the trip room (the group chat), the trip screens, joining by link, push notifications. It talks only to the Server, except for the vault page, which it opens directly. |
| **The Server** | Nishanth's team | Everything about a trip and its database: people, messages, votes, bookings, expenses, the trip record and the spend check. It opens one signed WebSocket to Go and keeps it open. |
| **Go** (this repo) | Keshav's team | The AI member itself: reading the room, deciding when to speak, memory about people with proof, speaking first when it truly helps, phone calls, and the vault that holds cards and pays. |

All three teams are the Vestra team. What travels between the Server and Go is fixed by the contract in [`packages/contract`](packages/contract) and explained in plain words in [`docs/guide`](docs/guide) (also live, and readable by coding agents, at https://vestrago.vercel.app/docs and https://vestrago.vercel.app/llms.txt). How the pieces fit is in [`docs/architecture.md`](docs/architecture.md).

## Folder map

| Folder | What it is |
|---|---|
| [`apps/brain`](apps/brain) | Go's service: the socket the Server connects to, the trip log, the composer (the model loop that writes Go's messages), the reflex (a fast classifier on every message), memory, speaking first, and calls. |
| [`apps/vault`](apps/vault) | The vault: its own service and database. It keeps each person's card as the payment processor's token, encrypted, and pays only with the Server's signed approval and the payer's passkey. |
| [`apps/fake-go`](apps/fake-go) | A small stand-in for Go that speaks the real socket with fixed answers, so the Server team can build against it. |
| [`packages/contract`](packages/contract) | The contract in zod, the single source of truth for the wire: every event, method, card and error, socket signing, the spend approval, and the OpenAPI and AsyncAPI files generated from it. |
| [`packages/contract-py`](packages/contract-py) | The same contract for Python: models generated from the OpenAPI file, signing and spend approvals. |
| [`packages/sim`](packages/sim) | The simulator: a fake Server that holds trips in memory with the Server's rules, and the dev room, a one-page App in the browser. |
| [`packages/agent-sdk`](packages/agent-sdk) | An agent loop copied from Vestra's Bash (see its `PROVENANCE.md`). Go's composer uses a few of its helpers: model capabilities, usage, cost and error kinds. |
| [`docs/guide`](docs/guide) | The guide to the contract, for the Server and App teams. Start here to build against Go. |
| [`docs/spec`](docs/spec) | Go's design: how it works inside. |
| [`docs/plans`](docs/plans) | The week's build plans: the master plan and one plan per lane, with the code and tests for every task. |

## Try it in five minutes: the simulator and the fake Go

You need Node 22 and pnpm 10. No keys and no database.

```bash
pnpm install
pnpm --filter "@go/fake-go..." build

# Terminal 1: the fake Go, on port 8080
export GO_SIGNING_SECRET=$(openssl rand -hex 32)
export FAKE_GO_ADMIN_TOKEN=$(openssl rand -hex 16)
node apps/fake-go/dist/main.js

# Terminal 2: the simulated Server and the dev room, with the same GO_SIGNING_SECRET
pnpm --filter @go/sim room -- --go http://localhost:8080 --secret "$GO_SIGNING_SECRET"
```

Open the address it prints (http://127.0.0.1:5174). The simulator creates the Goa trip from the guide and connects to the fake Go over the signed socket. Type `@Go hello` as anyone in the room: the fake Go shows typing, reacts and answers with one of Go's cards. `--seed` replays a short seed chat first, and `--host 0.0.0.0` opens the room from a phone on the same network.

To talk to the real Go instead, start `apps/brain` (below) and point the room at it with `--go http://localhost:8080`.

## Run the real Go on your machine

The real Go needs Postgres 16 and an Anthropic API key. Everything else is optional and off by default (see [`apps/brain/.env.example`](apps/brain/.env.example)).

```bash
docker run -d --name go-pg -e POSTGRES_USER=go -e POSTGRES_PASSWORD=go -e POSTGRES_DB=go -p 5432:5432 postgres:16
pnpm --filter "@go/brain..." build
export DATABASE_URL=postgres://go:go@localhost:5432/go
export GO_SIGNING_SECRET=$(openssl rand -hex 32) GO_PUBLIC_URL=http://localhost:8080 ANTHROPIC_API_KEY=<your key>
node apps/brain/dist/main.js
```

Go applies its database migrations at boot and listens on port 8080. Then run the room from the section above with the same `GO_SIGNING_SECRET`.

## Tests

CI runs on every pull request ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)):

- **build-and-test**: builds every package, then runs every package's tests against a Postgres 16 service. Every test that needs a database gets its own schema. It also fails if someone changed the contract without regenerating the OpenAPI, AsyncAPI and method files.
- **contract-python**: the Python contract's tests, and a check that its models match the OpenAPI file.
- **fake-go-image** and **brain-image**: build the Docker images Railway builds and check that each one boots and answers its health check.

To run the tests on your own machine, start the Postgres above and run `DATABASE_URL=postgres://go:go@localhost:5432/go pnpm build && DATABASE_URL=postgres://go:go@localhost:5432/go pnpm test`. Each app's README says what its tests prove.

## Read more

- [The guide](docs/guide) and the live docs: https://vestrago.vercel.app/docs (everything as one text file for a model: https://vestrago.vercel.app/llms-full.txt)
- [The architecture](docs/architecture.md): the parts, one message from the room to Go's reply, the two keys for money, and what is live and what is simulated.
- [The design](docs/spec/2026-10-05-go-design.md)
- [The plans](docs/plans): [the master plan](docs/plans/2026-10-05-go-the-week.md) and one plan per lane.
