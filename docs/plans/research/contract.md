# go-brain contract research (for the build plan)

Source: `~/workspace/agents/go-brain-worktrees/plan-week` @ `97907b8` (branch `plan-week`), read only.
Path shorthands used in cites: `C/` = `packages/contract/`, `G/` = `docs/guide/`, `P/` = `packages/contract-py/`.
Contract version `1.0.0` (`C/src/index.ts:2`). zod 4 (root override `zod 4.3.6`, `package.json:15`).
All zod `z.object`s STRIP unknown keys on parse (test `C/src/__tests__/schemas.test.ts:21-24`).
`.nullish()` = may be omitted or null; "null and missing mean the same thing" (`G/01-basics.md:60`).

---

## 1. Every export of `@go/contract`

Package: `C/package.json` — name `@go/contract`, `"type":"module"`, `main dist/index.js`, `types dist/index.d.ts`,
exports map ONLY `"."` → `{types: ./dist/index.d.ts, default: ./dist/index.js}` (`C/package.json:8-13`). No subpath
exports (test-vectors / methods.json are not importable via the package; `files` = dist, openapi, asyncapi, socket —
NOT test-vectors, `C/package.json:31-36`). Scripts: `build: tsc`, `typecheck: tsc --noEmit`, `test: vitest run`,
`emit-openapi: tsx scripts/emit-openapi.ts`, `check-docs: tsx scripts/docs-examples.ts`,
`test-vectors: tsx scripts/make-test-vectors.ts` (`C/package.json:14-21`). deps: `zod ^4.0.0`; dev: `@types/node ^20.14`,
`tsx ^4.21`, `typescript ^5.5`, `vitest ^4.0.17`. Consumers must `pnpm build` first (exports point at dist only).
`C/tsconfig.json` excludes `src/**/__tests__/**` from build.

`index.ts` (`C/src/index.ts:1-16`): `export const CONTRACT_VERSION = '1.0.0'` + `export *` from common, people, cards,
room, trip, events, to-server, to-go, socket, errors, signing, spend-approval, routes.

Every exported zod schema has `.meta({ id: '<SameName>' })` (the registry id = OpenAPI/Python model name).

### common.ts (`C/src/common.ts`)
| Name | Kind | Shape |
|---|---|---|
| `Id` :7 | zod | `z.string().min(1).max(64)` (opaque) |
| `Seq` :14 | zod | `z.int().positive()` (≥1) |
| `AmountMinor` :17 | zod | `z.int().nonnegative()` |
| `PositiveAmountMinor` :19 | zod | `z.int().positive()` |
| `Currency` :20 | zod | `/^[A-Z]{3}$/` |
| `IsoDateTime` :23 | zod | `z.iso.datetime({ offset: true })` |
| `IsoDate` :24 | zod | `z.iso.date()` |
| `HttpUrl` :27 | zod | `z.url({ protocol: /^https?$/ })` |
| `Category` :30 | zod enum | `stay|food|getting_around|activities|other` |
| `Actor` :35 (+type :42) | zod DU on `kind` | `{kind:'person',person_id}` (PersonActor) / `{kind:'go'}` (GoActor) / `{kind:'system'}` (SystemActor) |
| `Place` :45 (+type) | zod | `name 1-120, place_id? ≤256, address? ≤200, lat? -90..90, lng? -180..180, photo_url? HttpUrl` |
| `Journey` :58 (+type) | zod | `mode flight|train|bus|cab, origin{name 1-80, code? ≤8}, destination{same}, depart_at, arrive_at, carrier_name? ≤60, carrier_code? ≤8, number? ≤20, logo_url?, stops? int≥0` |

### errors.ts (`C/src/errors.ts`)
- `ErrorCode` :4 zod enum: `bad_signature|not_found|invalid|conflict|rate_limited|internal|unavailable`.
- `ErrorBody` :24 (+type :27): `{ error: { code: ErrorCode, message: string ≤500 } }` (HTTP only: upgrade 401, health).
- `HTTP_STATUS_FOR: Record<ErrorCode, number>` :29 = `{bad_signature:401, not_found:404, invalid:422, conflict:409, rate_limited:429, internal:500, unavailable:503}`.

### people.ts (`C/src/people.ts`)
- `Person` :11 (+type): `person_id, name 1-80, photo_url?, role organizer|member, joined_at, from_city? ≤60,
  earliest_leave? ≤60, know: string(1-80)[] ≤20, has_upi: boolean, go_paused: boolean`.
- `BudgetBand` :36 (+type): `{ min_minor: AmountMinor, max_minor?: AmountMinor, currency }`.
- `BudgetSummary` :45: `{ lowest?: BudgetBand, answered: int≥0, of: int≥0 }`.

### cards.ts (`C/src/cards.ts`) — see §5 for fields
`CardAction` :28 (+type :40), `VoteCard` :46, `MandateCard` :49, `TicketCard` :56, `ExpenseCard` :59, `SettleUpCard` :62,
`DayCard` :65, `PlanCard` :68, `BudgetCard` :71, `Option` :77, `OptionsCard` :98, `WorkingCard` :111, `CallCard` :128,
`PayCard` :147, `NoticeCard` :168, `Card` :184 (DU on `kind`, +type :201). (`CallLine` :126 is NOT exported.)

### room.ts (`C/src/room.ts`)
`Attachment` :6 (DU on kind: PhotoAttachment / FileAttachment), `Reaction` :26, `Message` :34 (+type :62),
`MessagesPage` :64, `PostMessage` :69 (+type :82), `PostMessageResult` :84, `ReplaceCard` :87, `ReplaceCardResult` :88,
`GoTyping` :91.

### trip.ts (`C/src/trip.ts`)
`DecisionOption` :10, `Mandate` :23 (+type), `Decision` :39 (+type), `BookingKind` :66, `Booking` :70 (+type),
`Expense` :100 (+type), `Transfer` :118, `Money` :123, `ItineraryItem` :135, `Day` :149, `Proof` :154,
`RecordLine` :165 (+type), `TripSnapshot` :186 (+type :210).

### events.ts (`C/src/events.ts`)
`MessageCreated` :27, `MessageEdited` :29, `MessageDeleted` :31, `ReactionAdded` :33, `ReactionRemoved` :35,
`PersonJoined` :37, `PersonUpdated` :39, `PersonLeft` :42, `TripCreated` :43, `TripUpdated` :46, `DecisionOpened` :49,
`DecisionVoted` :51, `DecisionClosed` :63, `DecisionCancelled` :66, `MandateSet` :68, `MandateConfirmed` :70,
`MandateDeclined` :72, `RecordChanged` :74, `BookingChanged` :77, `ExpenseChanged` :80, `Event` :84 (DU on `type`),
`type Event` :108, `type EventType = Event['type']` :109. Each event's `data` schema is registered as `<Name>Data`
(e.g. `ReactionAddedData`) via `ev()` :24-25 — exists in OpenAPI/Python (`models.ReactionAddedData`) but NOT as a TS export.

### to-server.ts (`C/src/to-server.ts`) — Go → server params/results (§4)
`ReadTrip` :16, `ReadMessages` :19, `WriteResult` :24, `UpdateTrip` :26, `OpenDecision` :40, `OpenDecisionResult` :51,
`CloseDecision` :53, `CloseDecisionResult` :54, `SetMandate` :56, `AddRecordLine` :72, `AddRecordLineResult` :85,
`UpdateRecordLine` :87, `AddBooking` :103, `AddBookingResult` :126, `UpdateBooking` :128, `AddExpense` :141,
`AddExpenseResult` :154, `RequestSpendApproval` :157, `CancelSpendApproval` :173, `SpendDenialReason` :182,
`SpendApproved` :196, `SpendDenied` :206, `SpendApprovalResult` :210 (DU on `status`), `AddReaction` :215,
`RemoveReaction` :219. (No TS `type` aliases here: use `z.infer<typeof X>`.)

### to-go.ts (`C/src/to-go.ts`) — server → Go params/results (§3)
`EventAccepted` :9, `CardTap` :18, `ActionDone` :32, `ActionOpen` :34, `ActionRefused` :36, `CardActionResult` :38
(DU on `result`), `CatchUpRequest` :43, `CatchUp` :44, `Fact` :63, `PersonPage` :77, `GetPerson` :86, `UpdatePerson` :87,
`DeleteFact` :88, `ForgetPerson` :90, `Ok` :91, `ForgetResult` :93, `CreateLink` :102, `Link` :110, `Health` :112.

### socket.ts (`C/src/socket.ts`) — §2
consts `SOCKET_PATH` :30, `PING_INTERVAL_SECONDS` :32, `IDLE_CLOSE_SECONDS` :33, `RECONNECT_BACKOFF_SECONDS` :35,
`MAX_FRAME_BYTES` :37, `SOCKET_ERROR_CODES` :58, `TO_GO` :105, `TO_SERVER` :117, `SOCKET_METHODS` :138;
zod `SocketRequest` :42, `SocketNotification` :46, `SocketResult` :50, `SocketError` :63;
`type Direction = 'to_go' | 'to_server'` :82; `interface SocketMethod` :84;
functions:
```ts
export const methodByName: (name: string) => SocketMethod | undefined;                       // :139
export function parseParams(method: string, params: unknown):                                 // :142
  | { ok: true; params: <parsed>; method: SocketMethod }
  | { ok: false; code: -32601 | 422; message: string };   // -32601 unknown method; 422 + z.prettifyError
```
(internal, not exported: `jsonrpc = z.literal('2.0')`, `RequestId = z.string().min(1).max(64)` :39-40, helper `m()` :98.)

### signing.ts (`C/src/signing.ts`) — §2
```ts
export const SIGNATURE_HEADER = 'x-go-signature';                                   // :20
export const MAX_SKEW_SECONDS = 300;                                                // :21
export interface SignedRequest { method: string; target: string; body: string | Uint8Array }   // :25
export function signRequest(req: SignedRequest, secret: string, now?: number /*unix s*/): string;  // :42
export type VerifyResult = { ok: true } | { ok: false; reason: 'missing' | 'malformed' | 'stale' | 'mismatch' }; // :46
export function verifyRequest(req: SignedRequest, header: string | undefined, secret: string, now?: number): VerifyResult; // :48
```
Throws `Error('GO_SIGNING_SECRET is empty')` on empty secret (:34).

### spend-approval.ts (`C/src/spend-approval.ts`) — §6
```ts
export const MAX_APPROVAL_TTL_SECONDS = 600;                                        // :17
export const SpendApprovalClaims: ZodType; export type SpendApprovalClaims;         // :21, :43
export function signSpendApproval(claims: SpendApprovalClaims, privateKeyPem: string): string;   // :47
export type VerifySpendApprovalResult =
  | { ok: true; claims: SpendApprovalClaims }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'invalid_claims' | 'expired' | 'not_yet_valid' }; // :55
export function verifySpendApproval(token: string, publicKeyPem: string, now?: number): VerifySpendApprovalResult; // :59
```
(internal: `ALLOWED_CLOCK_SKEW_SECONDS = 30` :18, `HEADER` :19.)

### routes.ts (`C/src/routes.ts`)
```ts
export interface HttpRoute { id: string; method: 'GET'; path: string; summary: string; signed: boolean; response: z.ZodType | null } // :10
export const HTTP_ROUTES: readonly HttpRoute[] = [
  { id: 'openSocket', method: 'GET', path: '/v1/socket', signed: true,  response: null },   // :20
  { id: 'health',     method: 'GET', path: '/v1/health', signed: false, response: Health }, // :22
];
```

### Python `go_contract` public API (`P/go_contract/__init__.py:8-36`)
`CONTRACT_VERSION="1.0.0"`, `models` (148 pydantic classes generated from `C/openapi/go.json`; `models.Event` is a
`RootModel` → `.root`, `P/go_contract/models.py:1021`), `Card` (RootModel over 13 kinds, `P/go_contract/card.py:27`),
`METHODS: dict[str, Method]` + `Method(NamedTuple: name, direction, params, result, answer_within_seconds, sends_event)`
(`P/go_contract/socket_methods.py:9-40`; also `PATH='/v1/socket'` not re-exported), `SIGNATURE_HEADER`, `MAX_SKEW_SECONDS`,
`Verified(ok, reason)`, `sign_request(method, target, body: bytes|str, secret, now=None) -> str`,
`verify_request(method, target, body, header, secret, now=None) -> Verified` (`P/go_contract/signing.py:26-75`),
`MAX_APPROVAL_TTL_SECONDS`, `VerifiedApproval(ok, claims, reason)`, `sign_spend_approval(claims: dict, private_key_pem) -> str`,
`verify_spend_approval(token, public_key_pem, now=None) -> VerifiedApproval` (`P/go_contract/spend_approval.py:26-76`).
Python exports NO socket timing constants (ping/idle/backoff/max frame) and no `parse_params` — use
`METHODS[m].params.model_validate(params)`. Python models skip some TS-only limits (lengths/link rules on nullable fields,
PostMessage text-or-card refine) (`P/README.md`; `G/01-basics.md:65`).

---

## 2. The socket layer

**Topology.** One WebSocket, the SERVER (Nishanth's go-server) dials OUT to Go at `wss://<GO_URL host>/v1/socket`
and keeps it open; Go is the WS server. Go has no setting for the server's address and never calls it over HTTP
(`C/src/socket.ts:16-29`; `G/02-the-socket.md:9-20`; `G/01-basics.md:7-16`). Frames are JSON-RPC 2.0 text frames,
both directions.

Env (`G/01-basics.md:9-14`): server: `GO_URL` (https base, no path/trailing slash), `GO_SIGNING_SECRET`,
`GO_SPEND_PRIVATE_KEY` (Ed25519 PEM). Go: `GO_SIGNING_SECRET`, `GO_SPEND_PUBLIC_KEY`. Secret = `openssl rand -hex 32`.

### Methods (`C/src/socket.ts:105-136`; generated table `C/socket/methods.json`; `G/02-the-socket.md:216-252`)
| Method | Dir | Req/notif | Params | Result | answer_within | sends_event |
|---|---|---|---|---|---|---|
| send_event | to_go | req | `Event` | `EventAccepted` | 2 | — |
| card_tap | to_go | req | `CardTap` | `CardActionResult` | 3 | — |
| catch_up | to_go | req | `CatchUpRequest` | `CatchUp` | 3 | — |
| get_person | to_go | req | `GetPerson` | `PersonPage` | 2 | — |
| update_person | to_go | req | `UpdatePerson` | `Ok` | 2 | — |
| delete_fact | to_go | req | `DeleteFact` | `Ok` | 2 | — |
| forget_person | to_go | req | `ForgetPerson` | `ForgetResult` | 2 | — |
| vault_link | to_go | req | `CreateLink` | `Link` | 2 | — |
| read_trip | to_server | req | `ReadTrip` | `TripSnapshot` | 2 | — |
| read_messages | to_server | req | `ReadMessages` | `MessagesPage` | 2 | — |
| post_message | to_server | req | `PostMessage` | `PostMessageResult` | 2 | message.created |
| replace_card | to_server | req | `ReplaceCard` | `ReplaceCardResult` | 2 | — (not a change) |
| typing | to_server | **notification** | `GoTyping` | null | null | — |
| add_reaction | to_server | req | `AddReaction` | `WriteResult` | 2 | reaction.added |
| remove_reaction | to_server | req | `RemoveReaction` | `WriteResult` | 2 | reaction.removed |
| update_trip | to_server | req | `UpdateTrip` | `WriteResult` | 2 | trip.updated |
| open_vote | to_server | req | `OpenDecision` | `OpenDecisionResult` | 2 | decision.opened |
| close_vote | to_server | req | `CloseDecision` | `CloseDecisionResult` | 2 | decision.closed |
| set_mandate | to_server | req | `SetMandate` | `WriteResult` | 2 | mandate.set |
| add_record_line | to_server | req | `AddRecordLine` | `AddRecordLineResult` | 2 | record.changed |
| update_record_line | to_server | req | `UpdateRecordLine` | `WriteResult` | 2 | record.changed |
| add_booking | to_server | req | `AddBooking` | `AddBookingResult` | 2 | booking.changed |
| update_booking | to_server | req | `UpdateBooking` | `WriteResult` | 2 | booking.changed |
| add_expense | to_server | req | `AddExpense` | `AddExpenseResult` | 2 | expense.changed |
| request_spend_approval | to_server | req | `RequestSpendApproval` | `SpendApprovalResult` | 2 | — |
| cancel_spend_approval | to_server | req | `CancelSpendApproval` | `Ok` | 2 | — |

8 to_go + 18 to_server = 26 methods; `typing` is the ONLY notification in either direction (test
`schemas.test.ts:41-44`). `SocketMethod = { name, direction, summary, params: ZodType, result: ZodType|null,
answer_within: number|null, sends_event?: string }` (`socket.ts:84-96`).
Extra writes per method (`G/04-gos-requests.md:222-242`): `close_vote` → `decision.closed` (reason `closed_by_go`) THEN
`record.changed` (decided line, by system, own seq); `add_booking` → `booking.changed` (added, by go) THEN `record.changed`
(booked line, by system). Result carries the seq of the FIRST change.

### Frames (`C/src/socket.ts:42-80`; `G/02-the-socket.md:120-210`)
```ts
SocketRequest      = { jsonrpc: '2.0', id: string(1..64), method: string(1..64), params: Record<string, unknown> }
SocketNotification = { jsonrpc: '2.0', method: string(1..64), params: Record<string, unknown> }       // no id
SocketResult       = { jsonrpc: '2.0', id: string(1..64), result: Record<string, unknown> }            // result must be an object
SocketError        = { jsonrpc: '2.0', id: string(1..64) | null,                                          // null only if request unreadable
                       error: { code: int, message: string ≤500,
                                data?: { code: ErrorCode, retry_after_seconds?: int 1..3600 } | null } }
```
- `SOCKET_ERROR_CODES` (`socket.ts:58-61`) = `{ not_found: 404, invalid: 422, conflict: 409, rate_limited: 429,
  internal: 500, unavailable: 503, parse_error: -32700, unknown_method: -32601 }` (no 401 on the socket).
- `-32700` (unreadable frame) answered with `id: null`, no `data`; `-32601` (unknown method) no `data`
  (`G/02-the-socket.md:186-191`; `G/01-basics.md:93-102`).
- Every other error has `data.code` = the ErrorCode name; 429 must carry `data.retry_after_seconds` (>0, ≤3600).
- Telling frames apart: has `method` → request (has `id`) or notification (no `id`); no `method` → answer (result/error).
- 1 frame = 1 JSON object = 1 WS text frame, ≤ `MAX_FRAME_BYTES = 1_048_576` (`socket.ts:37`; `G/02-the-socket.md:122`).
- Ids only need to be unique among the SENDER's own unanswered requests; same id may appear both directions
  (`G/02-the-socket.md:207-210`).
- **Id prefixes:** guide uses `gs_` for server-sent request ids and `go_` for Go-sent ids, readability only; any 1-64 char
  string works (`G/02-the-socket.md:131`). Reference client mints `gs_${randomUUID()}` / `gs_{uuid4().hex}` (:397, :512).
  Example prefixes elsewhere (readability only, `G/01-basics.md:36`): `t_ p_ m_ rq_ ev_ tap_ c_ d_ b_ e_ ap_ lk_ f_ opt_ task_`.
- Who mints which id (`G/01-basics.md:38-41`): Server: trip_id, person_id, message_id, decision_id, booking_id, expense_id,
  line_id, event_id, approval_id, tap_id, JSON-RPC id of server requests. Go: card_id, task_id, call_id, option_id,
  fact_id, request_id, JSON-RPC id of Go requests. (`common.ts:4-6` also says Go mints "approval-request" ids.)

### Upgrade signing (`C/src/signing.ts:3-68`; `G/02-the-socket.md:40-118`; vectors `C/test-vectors/signing.json`)
- Header `x-go-signature: t=<unix seconds>,v1=<lowercase hex HMAC-SHA256(GO_SIGNING_SECRET, signing string)>`.
- Signing string = `` `${t}\n${METHOD.toUpperCase()}\n${target}\n` `` + raw body bytes (`signing.ts:36-37`).
  For the upgrade: `"<t>\nGET\n/v1/socket\n"` (body empty, ends with the newline after target).
- `target` = path + query EXACTLY as sent (`/v1/socket?instance=server-1` must be signed with the query).
- HMAC key = the secret STRING's UTF-8 bytes (`createHmac('sha256', secret)`; Python `secret.encode('utf-8')`,
  `P/go_contract/signing.py:42-46`) — NOT the hex-decoded 32 bytes.
- Verify (`signing.ts:48-68`): missing → `missing`; parse `k=v` pairs split on `,`; `t` must be integer, `v1` must match
  `/^[0-9a-f]{64}$/` else `malformed`; `|now - t| > 300` → `stale` (both directions); timing-safe compare else `mismatch`.
- **Replay:** Go accepts each signature ONCE — a second upgrade with the same `t`+`v1` → 401 even inside 300 s
  (`signing.ts:17-18`; `socket.ts:24`; `G/02-the-socket.md:63`). `verifyRequest` does NOT implement this — Go must keep a
  used-signature set (at least until `t + 300`).
- Refusal = HTTP `401` with `ErrorBody` `{ "error": { "code": "bad_signature", "message": "signature already used" } }`
  (`G/02-the-socket.md:65-70`; `G/01-basics.md:106`). Socket does not open.
- Two instances signing in the same second with the same target collide → each instance uses its own
  `?instance=<name>` (`G/02-the-socket.md:117, 312-324`).
- Frames after upgrade are never signed (`G/01-basics.md:32`).
- OpenAPI describes the header param as `t=<unix seconds>,v1=<hex HMAC-SHA256(GO_SIGNING_SECRET, "<t>\nGET\n/v1/socket\n")>`
  (`C/scripts/emit-openapi.ts:57-58`); 101 on success, 401 on bad signature (:62-63).

### Keepalive / reconnect numbers (`C/src/socket.ts:31-37`; `G/02-the-socket.md:261-271`)
- `PING_INTERVAL_SECONDS = 20`: **Go** sends WS ping control frames (not JSON-RPC) every 20 s.
- `IDLE_CLOSE_SECONDS = 40`: either side closes after 40 s with no frame/ping/pong from the other.
- `RECONNECT_BACKOFF_SECONDS = [1, 2, 5, 10, 30]`: server's waits, then 30 s forever; reset to 1 s after a good connect.
- `MAX_FRAME_BYTES = 1_048_576`.
- After reconnect: each side resends every unanswered request with the SAME JSON-RPC `id` (and same event_id/request_id/
  tap_id). Notifications are dropped, never resent. Lost answers fine (`G/02-the-socket.md:300-310`;
  `G/01-basics.md:127-130`).

### HTTP routes on Go (`C/src/routes.ts:19-24`; `G/05-your-requests.md:404-419`)
- `GET /v1/socket` — signed WS upgrade.
- `GET /v1/health` — unsigned, `Health = { ok: true, contract: string }`, e.g. `{ "ok": true, "contract": "1.0.0" }`
  (`G/05-your-requests.md:412`). Server checks `contract` starts with `1.`.
- Go's web pages (vault, watch) are short-lived links, not API routes (`routes.ts:5-8`).

---

## 3. send_event and the other to_go methods

### Event envelope (`C/src/events.ts:16-25`; `G/03-events.md:19-30`)
```ts
{ event_id: Id,            // unique per event; same on every resend; Go ignores one it has seen
  trip_id: Id,
  seq: Seq,                // trip change number (≥1); trip.created is seq 1 (G/03-events.md:914)
  occurred_at: IsoDateTime,// original time kept on retry
  type: <literal>,
  data: <per type> }
```
There is NO `at` field — it is `occurred_at`. Change number field is `seq`.

### All 20 event types (`C/src/events.ts:27-82`; table `G/03-events.md:430-453`)
| type | data |
|---|---|
| `message.created` | `{ message: Message }` (Go's own messages come back too) |
| `message.edited` | `{ message: Message }` (current state, `edited_at` set) |
| `message.deleted` | `{ message_id }` |
| `reaction.added` | `{ message_id, reaction: Reaction }` (`person_id` null/absent = Go's) |
| `reaction.removed` | `{ message_id, reaction: Reaction }` |
| `person.joined` | `{ person: Person }` |
| `person.updated` | `{ person: Person, changed: ('name'|'photo_url'|'from_city'|'earliest_leave'|'know'|'has_upi'|'go_paused'|'role')[] ≥1 }` |
| `person.left` | `{ person_id }` |
| `trip.created` | `{ trip: TripSnapshot }` (whole trip) |
| `trip.updated` | `{ by: Actor, changed: ('title'|'destination'|'dates'|'vibe'|'stay'|'itinerary'|'status'|'budget')[] ≥1 }` — no new values; budget change always `by:{kind:'system'}` |
| `decision.opened` | `{ decision: Decision, by: Actor }` |
| `decision.voted` | `{ decision_id, person_id?, option_index?: int≥0, voted: int≥0, of: int≥0, tally: int≥0[] ≤10 }` (person_id/option_index omitted when anonymous) |
| `decision.closed` | `{ decision: Decision, reason: 'time'|'everyone_voted'|'closed_by_person'|'closed_by_go' }` |
| `decision.cancelled` | `{ decision_id, by: Actor }` |
| `mandate.set` | `{ decision_id, mandate: Mandate }` |
| `mandate.confirmed` | `{ decision_id, person_id }` (payer tapped "Yes, book it") |
| `mandate.declined` | `{ decision_id, person_id }` (payer tapped "Not now") |
| `record.changed` | `{ line: RecordLine, change: 'added'|'updated'|'done'|'undone', by: Actor }` |
| `booking.changed` | `{ booking: Booking, change: 'added'|'updated'|'cancelled', by: Actor }` |
| `expense.changed` | `{ expense: Expense, change: 'added'|'removed', by: Actor }` |

`Event` = `z.discriminatedUnion('type', [...20])` (`events.ts:84-107`): **an unknown `type` FAILS `Event.safeParse`**
(test `schemas.test.ts:17-20`), so `parseParams('send_event', …)` returns 422 for it — Go must check `type` first (§10).

### EventAccepted (`C/src/to-go.ts:9-15`)
`{ accepted: true, duplicate: boolean }` — `duplicate: true` when event_id already seen (still success).
Unknown type → `{ accepted: true, duplicate: false }` before validating the rest (`socket.ts:101-104`;
`G/03-events.md:83`; `G/02-the-socket.md:259`). Errors Go may return: 422 invalid (server does NOT retry), 503/429/500
(server retries; 429 honours retry_after_seconds) (`G/03-events.md:85`).

### card_tap (`C/src/to-go.ts:18-40`; `G/05-your-requests.md:34-211`)
- Params `CardTap = { tap_id: Id, trip_id, card_id, action_id: /^[a-z][a-z_]{0,31}$/, person_id, option_id?: Id }`.
- Result `CardActionResult` (DU on `result`):
  - `ActionDone = { result: 'done', toast?: string ≤120 }`
  - `ActionOpen = { result: 'open', url: HttpUrl, expires_at: IsoDateTime }` (links expire 5 min after made, :110)
  - `ActionRefused = { result: 'refused', toast: string 1..120 }`
- Only Go-card taps are forwarded (options, working, call, pay, notice); record-card buttons are the server's
  (`G/05-your-requests.md:36-38`). Go acts once per `tap_id`; Go re-checks who may use a button (refuses `approve` from
  non-payer) (:209). Usual action_ids: options `pick` (per_option) / `vote`; working `watch` / `stop`; call `stop`;
  pay `approve` (payer only) / `decline` (:62-70; `G/06-cards.md:97-105`). Answer within 3 s; server waits ~3.5 s and
  never auto-resends a tap (:112-114).

### catch_up (`C/src/to-go.ts:43-60`; `G/05-your-requests.md:213-253`)
- Params `CatchUpRequest = { trip_id, person_id, since: IsoDateTime }`.
- Result `CatchUp = { summary?: string ≤200, items: { kind: 'decided'|'booked'|'needs_you'|'open'|'news', text: 1..140,
  image_url?: HttpUrl, message_id?: Id }[] ≤5 }`. For one person only, never posted. Empty summary+items → show nothing.
  Suggested trigger: away ≥3 h or ≥15 unread. 3 s limit. Example 429 for catch-up: `G/02-the-socket.md:177-184`.

### People requests (`C/src/to-go.ts:63-99`; `G/05-your-requests.md:255-380`)
- `get_person`: `GetPerson = { person_id }` → `PersonPage = { person_id, carry_over: boolean, facts: Fact[] ≤500 }`,
  `Fact = { fact_id, topic 1..40, text 1..200, trip_id, message_id?: Id, said_at }` (one current fact per topic/person).
- `update_person`: `UpdatePerson = { person_id, carry_over: boolean }` → `Ok = { ok: true }`. carry_over default off.
- `delete_fact`: `DeleteFact = { person_id, fact_id }` → `Ok`. 404 not_found = already gone (:349).
- `forget_person`: `ForgetPerson = { person_id, trip_id?: Id }` (no trip_id = everywhere) → `ForgetResult =
  { deleted_facts: int≥0, remaining_facts: 0 /*literal*/ }`. Go must verify nothing left before answering. Server then
  clears join answers and sends `person.updated` per trip (:371-376). Safe to repeat.
- person_id must come from the signed-in session on the server side (:23).

### vault_link (`C/src/to-go.ts:102-110`; `G/05-your-requests.md:382-402`)
`CreateLink = { kind: 'vault', person_id, start?: 'home'|'add_card'|'add_login' }` → `Link = { url: HttpUrl,
expires_at }`; link expires 5 minutes after made; opened in system browser sheet (never a WebView).

---

## 4. Go → server (to_server) params and results

Common: every request names `trip_id`; every WRITE carries `request_id` (Go-minted `Id`); reads, `replace_card`,
`typing` have none (`to-server.ts:5-13`; `G/04-gos-requests.md:107-114`). Results: `WriteResult = { seq: Seq }`
(`to-server.ts:24`). "Only the fields sent change" for update_* methods.

| Method | Params (beyond `trip_id`) | Result |
|---|---|---|
| read_trip | — (`ReadTrip = {trip_id}`) | `TripSnapshot` (§5) |
| read_messages | `after_seq: int≥0`, `limit?: int 1..200` (default 200) | `MessagesPage = { messages: Message[] ≤200, has_more: boolean }` |
| post_message | `request_id`, `text?: 1..2000`, `card?: Card`, `reply_to?: Id`, `mentions?: Id[] ≤30`; refine text or card required | `PostMessageResult = { message_id, seq }` |
| replace_card | `card: Card` (same card_id) | `ReplaceCardResult = { message_id }` (no seq) |
| typing (notif) | `on: boolean` (`GoTyping`) | none |
| add_reaction | `request_id`, `message_id`, `emoji: 1..16` | `WriteResult` |
| remove_reaction | `request_id`, `message_id`, `emoji: 1..16` | `WriteResult` |
| update_trip | `request_id`, `title?: 1..80`, `destination?: Place`, `dates?: {start: IsoDate, end: IsoDate}`, `vibe?: string(1..40)[] ≤12`, `stay?: ≤60`, `itinerary?: Day[] ≤30` (replaces whole) | `WriteResult` |
| open_vote | `request_id`, `question: 1..200`, `kind: 'choice'|'yesno'`, `anonymous: boolean`, `options: DecisionOption[2..10]`, `closes_at?` (`OpenDecision`) | `OpenDecisionResult = { decision_id, seq }` |
| close_vote | `request_id`, `decision_id` (`CloseDecision`) | `CloseDecisionResult = { decision: Decision, seq }` |
| set_mandate | `request_id`, `decision_id`, `choice_index: int≥0`, `cap_minor: int>0`, `currency`, `refundable_only: boolean`, `payer_person_id` | `WriteResult` |
| add_record_line | `request_id`, `kind: 'agreed'|'open'|'doing'`, `text: 1..200`, `proof: Proof[] ≤10`, `person_ids: Id[] ≤30`, `due_at?` | `AddRecordLineResult = { line_id, seq }` |
| update_record_line | `request_id`, `line_id`, `kind?: agreed|open|doing`, `text?`, `status?: 'active'|'done'`, `proof?` (replaces list), `person_ids?`, `due_at?` | `WriteResult` |
| add_booking | `request_id`, `kind: BookingKind`, `title 1..120`, `vendor 1..80`, `ref 1..80`, `amount_minor: int≥0`, `currency`, `payer_person_id`, `for_person_ids: Id[1..30]`, `refundable_until?`, `starts_at?`, `ends_at?`, `journey?`, `place?`, `image_url?`, `decision_id?`, `approval_id?` (required when paid via vault) | `AddBookingResult = { booking_id, seq }` |
| update_booking | `request_id`, `booking_id`, `status?: 'cancelled'`, `ref?`, `refundable_until?`, `starts_at?`, `ends_at?` | `WriteResult` |
| add_expense | `request_id`, `paid_by_person_id`, `amount_minor: int>0`, `currency`, `note 1..120`, `category: Category`, `split_person_ids: Id[1..30]`, `booking_id?` | `AddExpenseResult = { expense_id, seq }` |
| request_spend_approval | `request_id`, `decision_id`, `amount_minor: int>0` (max), `currency`, `merchant 1..120`, `purpose 1..200`, `refundable_until?` (required if mandate refundable_only) | `SpendApprovalResult` = `SpendApproved { status:'approved', approval_id, approval: string 1..4096, expires_at }` \| `SpendDenied { status:'denied', reason: SpendDenialReason, detail?: ≤200 }` |
| cancel_spend_approval | `request_id`, `approval_id`, `reason: 'payment_failed'|'payer_declined'|'price_changed'|'expired'|'other'` | `Ok` |

Cites: `C/src/to-server.ts:16-221`, `C/src/room.ts:64-91`.

### request_id rules (`G/04-gos-requests.md:107-216`; `G/01-basics.md:67-76`)
- Server stores `(trip_id, request_id)` UNIQUE with the stored answer, in the same txn as the change; a repeat gets the
  stored answer (same ids, same seq) — checked BEFORE any rule (repeat `add_booking` returns first answer, not 409).
- Only successful answers stored; refused writes leave nothing, so a repeat is re-checked (:214).
- A `denied` spend approval IS a success result → repeat returns same denial; Go uses a NEW request_id to ask again (:215).
- Race: second copy waits on the trip row lock, hits unique index → return the stored answer (:216). Suggested table
  `go_requests(trip_id, request_id, answer jsonb, created_at, PK(trip_id, request_id))` (:124-131).
- tap_id: server mints one per tap; Go acts once per tap_id (`G/01-basics.md:73`).
- Go's retries: 3 more times after 0.5, 2, 5 s on timeout/500/503 with same request_id; after 429 wait
  retry_after_seconds (`G/01-basics.md:125`; `G/04-gos-requests.md:101-102`).

### Rules for every Go request (`G/04-gos-requests.md:85-105`)
| Rule | Fail |
|---|---|
| method known | -32601 (Go skips) |
| params match contract | 422 invalid (message names field) |
| trip exists; target (vote, line, booking, card, message, approval) exists in this trip | 404 not_found |
| every other id belongs to this trip (person currently in trip; message/vote/booking of trip) | 422 invalid |
| every amount uses the trip's currency (`money.currency`) | 422 invalid |
| no clash with current state | 409 conflict |
Can't answer in 2 s → 429 (+retry_after_seconds) / 500 / 503. Person who left is not "in the trip".
Build first: `read_trip`, `read_messages`, `post_message`, `typing` (:105).

### Per-method errors (all in `G/04-gos-requests.md`)
- read_trip: 404 trip (:662-664).
- read_messages: 422 bad after_seq / limit (:739-742).
- post_message (:838-845): 422 no text+card; 422 mention not in trip; 422 reply_to not in trip; 422 record-card id
  (decision_id/booking_id/expense_id) not in trip; **409 mandate card's vote has no mandate**; **409 card_id already in
  this trip's room** (use replace_card).
- replace_card (:892-895): 422 invalid card; 404 card_id not on one of Go's messages in this trip.
- typing (:930-933): bad params / unknown trip → dropped + logged, never answered.
- add_reaction (:983-987): 404 message; **409 message deleted; 409 Go already reacted with this emoji**.
- remove_reaction (:1005-1008): 404 message; **409 Go has no such reaction**.
- update_trip (:1037-1041): 422 no field besides request_id/trip_id; 422 dates.start > end; 422 itinerary booking_id not in trip.
- open_vote (:1124-1127): 422 options not 2..10; 422 closes_at not future.
- close_vote (:1182-1185): 404 vote; **409 vote not open (closed or cancelled)**.
- set_mandate (:1220-1227): 404 vote; **409 not a choice vote; 409 vote not closed**; 422 choice_index out of range;
  422 payer not in trip; 422 cap ≤0.
- add_record_line (:1271-1276): 422 kind not agreed/open/doing; 422 agreed with no proof; 422 proof message/person not in trip.
- update_record_line (:1295-1303): 404 line; **409 line not Go's (`source != 'go'`); 409 line undone**; 422 status not
  active|done; 422 no field besides ids; 422 agreed without proof after change; 422 foreign ids.
- add_booking (:1358-1365): 422 payer/for_person not in trip; 422 decision_id not in trip; with approval_id:
  **409 approval not this trip; 409 different decision; 409 used or cancelled; 409 amount > approved or currency differs**.
  Expired approval is NOT refused (:1368).
- update_booking (:1385-1389): 404 booking; **409 booking cancelled**; 422 no field.
- add_expense (:1424-1428): 422 people not in trip; 422 booking_id not in trip; 422 amount ≤0.
- request_spend_approval (:1525-1529): only 422 for bad params; every other failed check is a `denied` RESULT.
- cancel_spend_approval (:1566-1572): 404 approval not in trip; already used/cancelled/expired → still `{ok:true}`.
- Server side-effects: post_message stores card exactly as arrived (`raw.card`), pushes `mentions` and card
  `for_person_ids`, hides typing (:831-851); replace_card updates "needs you" pins, no push, no seq (:887-903).

---

## 5. Shapes: trip, message, cards

### TripSnapshot (`C/src/trip.ts:186-209`) — read_trip result and `trip.created.data.trip`
```ts
{ trip_id, seq /*snapshot change number*/, title: 1..80, status: 'planning'|'booked'|'on_trip'|'over',
  created_at, organizer_person_id, invite_url: HttpUrl, destination?: Place, dates?: {start: IsoDate, end: IsoDate},
  vibe: string(1..40)[] ≤12, stay?: ≤60, budget: BudgetSummary, people: Person[] ≤30 /*NOT "members"*/,
  decisions: Decision[] ≤100, bookings: Booking[] ≤100, expenses: Expense[] ≤500, money: Money,
  itinerary: Day[] ≤30, record: RecordLine[] ≤300 }
```
No messages in the snapshot. Left out: budget answers, contact details, anonymous votes' `votes`, people who left
(`G/04-gos-requests.md:656-671`). `record` includes done and undone lines. Full Goa example: `G/04-gos-requests.md:266-655`.
- `Decision` (`trip.ts:39-63`): `decision_id, question 1..200, kind choice|yesno, anonymous, status open|closed|cancelled,
  opened_by_person_id? (null = Go), options: DecisionOption[2..10], closes_at?, voted, of, tally: int[] ≤10,
  votes?: {person_id, option_index}[] ≤30 (absent if anonymous), result_index? (null = nobody voted or tie),
  mandate?: Mandate, opened_at, closed_at?`.
- `DecisionOption` (:10-20): `label 1..120, image_url?, price_minor?, currency?, option_ref? ≤200 (Go's own ref), note? ≤120`.
- `Mandate` (:23-36): `choice_index, cap_minor (int≥0), currency, refundable_only, payer_person_id, set_at,
  confirmed_at?, declined_at?`.
- `BookingKind` (:66): `stay|flight|train|bus|cab|table|activity|other`.
- `Booking` (:70-96): `booking_id, kind, status confirmed|cancelled, title, vendor, ref, amount_minor, currency,
  payer_person_id, for_person_ids[1..30], refundable_until?, starts_at?, ends_at?, journey?, place?, image_url?,
  decision_id?, approval_id?, added_by_person_id? (null = Go), created_at`.
- `Expense` (:100-114): `expense_id, paid_by_person_id, amount_minor, currency, note 1..120, category,
  split_person_ids[1..30] (equal split), booking_id?, added_by_person_id?, created_at`.
- `Money` (:123-133): `currency, plan_minor?, spent_minor, by_category: {category, amount_minor}[] ≤5,
  transfers: Transfer[] ≤60` with `Transfer = {from_person_id, to_person_id, amount_minor, currency}` (:118).
  Server does all money maths.
- `Day` (:149): `{ date: IsoDate, title?: ≤80, items: ItineraryItem[] ≤20 }`; `ItineraryItem` (:135-147):
  `item_id?, time?: "HH:MM" (local), title 1..120, category, place?, booking_id?, status booked|planned|idea, note? ≤200`.
- `RecordLine` (:165-183): `line_id, kind 'decided'|'agreed'|'open'|'doing'|'booked', text 1..200,
  status 'active'|'done'|'undone', proof: Proof[] ≤10, person_ids ≤30 (agreed: who agreed; open: who is asked; doing:
  who is on it), due_at?, decision_id? (decided lines), booking_id? (booked lines), source 'go'|'person'|'vote'|'booking',
  created_at, updated_at`. Decided lines written by server from votes, booked from bookings; Go writes agreed/open/doing.
- `Proof` (:154): `{ message_id, person_id? }`.

### Message (`C/src/room.ts:34-61`)
```ts
{ message_id, seq /*when posted*/, updated_seq /*latest change: edit, delete, reaction (Go's too); = seq until changed*/,
  author: Actor, text?: ≤4000 /*null if deleted or withheld*/, attachments: Attachment[] ≤10, reply_to?: Id,
  about_message_id?: Id /*"Ask Go about this"*/, mentions_go: boolean, mentions: Id[] ≤30, reactions: Reaction[] ≤100,
  card?: Card /*only on Go's messages*/, withheld: boolean, deleted: boolean, edited_at?, sent_at }
```
- `Reaction = { emoji 1..16, person_id?: Id }` (null = Go) (:26). One reaction per author per emoji.
- `Attachment`: `{kind:'photo', url, width?, height?, caption? ≤500}` | `{kind:'file', url, name 1..200, mime 1..100,
  size_bytes}`; URLs fetchable ≥1 h (:5-23).
- Withheld (author paused Go): text null, no attachments, `mentions_go: false`, no mentions, no about_message_id (:28-33).
- `mentions_go` true when text @mentions Go, names Go, or replies to a Go message; false on Go's own messages.
- read_messages returns `updated_seq > after_seq` ordered by `updated_seq`, includes deleted (`deleted:true`, no text),
  withheld, Go's own (`G/04-gos-requests.md:731-737`).

### Cards (`C/src/cards.ts`) — 13 kinds, DU on `kind` (:184-200)
Base on every card (:17-26): `card_id: Id` (Go's, unique within the trip's room), `fallback_text: 1..300` (also push text),
`for_person_ids?: Id[] ≤30` (push + pin in "needs you" until removed via replace_card). Go omits for_person_ids on
vote/mandate cards (`G/06-cards.md:55`).
`CardAction` (:28-39): `action_id /^[a-z][a-z_]{0,31}$/, label 1..24, style 'primary'|'secondary',
only_for_person_ids?: Id[] ≤30, per_option?: boolean`; `actions?: CardAction[] ≤3` on Go cards only.

Record cards (server draws from its rows; server owns buttons):
| kind | extra fields |
|---|---|
| `vote` :46 | `decision_id` |
| `mandate` :49 | `decision_id` |
| `ticket` :56 | `booking_id` |
| `expense` :59 | `expense_id` |
| `settle_up` :62 | — |
| `day` :65 | `date: IsoDate` |
| `plan` :68 | — |
| `budget` :71 | — |

Go cards (content inside; taps → card_tap):
- `options` :98 — `title 1..80, option_kind 'stay'|'flight'|'train'|'bus'|'place'|'food'|'activity', checked_at,
  options: Option[1..5], actions?`. `Option` :77 = `option_id, title 1..80, subtitle? ≤120, image_url?, logo_url?,
  price_minor?, currency? /^[A-Z]{3}$/, price_note? ≤40, highlights: string(1..40)[] ≤4 (REQUIRED array), journey?,
  place?, rating? 0..5, refundable_until?`.
- `working` :111 — `task_id: Id, title 1..80, state 'running'|'needs_you'|'done'|'failed',
  steps: {text 1..80, state 'todo'|'doing'|'done'|'failed'}[] ≤8, screenshot_url?, updated_at, actions?`.
  Example `G/06-cards.md:447-468`; needs_you → set for_person_ids (:443); buttons watch (→ `open`), stop.
- `call` :128 — `call_id, business 1..80, goal 1..160, state 'dialing'|'talking'|'ended'|'failed', started_at?, ended_at?,
  last_line?: {who 'go'|'them', text 1..500}, outcome? ≤500, transcript?: CallLine[] ≤300, actions?`.
- `pay` :147 — `approval_id (the jti), payer_person_id, amount_minor, currency, merchant 1..120, purpose 1..200,
  refundable_until?, expires_at, state 'waiting'|'paid'|'declined'|'expired'|'failed', actions?`.
- `notice` :168 — `tone 'info'|'heads_up', title 1..80, body 1..500, image_url?, source?: {name 1..60, url?},
  checked_at?, deadline_at?, actions?`.
There is NO "catch-up" card: catch-up is the `catch_up` method's `CatchUp` result, shown above the room for one person.
Unknown kind → app shows `fallback_text` (`G/06-cards.md:149-151`). Card examples: `G/06-cards.md` markers at
:183 vote, :205 mandate, :232 ticket, :250 expense, :268 settle_up, :290 day, :308 plan, :330 budget, :357 options,
:447 working, :486/:504 call, :545 pay, :583/:601 notice. Image URLs are https from Go's image cache, immutable (:143-147).

---

## 6. Spend approval (`C/src/spend-approval.ts`; `G/08-money-and-the-vault.md:115-500`)
- Claims `SpendApprovalClaims` (:21-42), serialised in THIS key order (compact JSON):
  `iss: 'server'` (literal), `aud: 'go-vault'` (literal), `jti: string 8..64`, `trip_id`, `decision_id`,
  `payer_person_id` (always the mandate's payer), `amount_minor: int>0` (max), `currency`, `merchant 1..120`,
  `purpose 1..200`, `refundable_until?`, `iat: int`, `exp: int`; refine `exp > iat && exp - iat <= 600`.
- Token: compact JWS `b64url(header).b64url(claims).b64url(Ed25519 sig over "<h>.<c>" ASCII)`, header exactly
  `{"alg":"EdDSA","typ":"go-spend+jws"}` = `eyJhbGciOiJFZERTQSIsInR5cCI6ImdvLXNwZW5kK2p3cyJ9`, no padding
  (:13-16, :47-53; `G/08-money-and-the-vault.md:414-427`).
- `signSpendApproval(claims, privateKeyPem): string` (parses claims first, throws on invalid) (:47).
- `verifySpendApproval(token, publicKeyPem, now = Math.floor(Date.now()/1000))` (:59-83): 3 parts of `[A-Za-z0-9_-]+`
  else malformed; header must equal exactly else malformed; bad sig → `bad_signature`; claims parse fail →
  `invalid_claims`; `iat > now + 30` → `not_yet_valid`; `exp <= now` → `expired`. (Does NOT check jti reuse — vault does.)
- Max lifetime `MAX_APPROVAL_TTL_SECONDS = 600` (:17).
- Python: `sign_spend_approval(claims: dict, private_key_pem) -> str` (dict key order = serialised order),
  `verify_spend_approval(token, public_key_pem, now=None) -> VerifiedApproval` (`P/go_contract/spend_approval.py:64-76`).
- Test vectors: `C/test-vectors/spend-approval.json` (TEST KEY ONLY: `private_key_pem`, `public_key_pem`, `claims`
  {jti ap_01JA7Q3V8Z, trip t_goa, decision d_villa, payer p_rahul, 5420000 INR, iat 1791190800, exp 1791191400},
  `token`, `verify_at: 1791190860`); `C/test-vectors/signing.json` (`secret: "test-only-go-signing-secret"`,
  `t: 1791190800`, `max_skew_seconds: 300`, 3 cases: GET /v1/socket, GET /v1/socket?instance=server-1, POST /v1/example
  with ₹/emoji body). Generator `C/scripts/make-test-vectors.ts` (seed = 32 bytes of 0x07).
- Spend check order (server; first failure = reason) (`G/08-money-and-the-vault.md:135-147`;
  `G/04-gos-requests.md:1511-1523`): `decision_not_found` → `decision_not_closed` → `no_mandate` → `payer_declined`
  → `payer_has_not_confirmed` → `currency_mismatch` → `over_cap` → `not_refundable` → `approval_outstanding`.
  (The zod enum order at `to-server.ts:182-194` differs; the guide's order is the evaluation order.)
- Approved: server mints approval_id (= jti, 8..64), signs with `GO_SPEND_PRIVATE_KEY`, stores (id, trip, vote, payer,
  amount, currency, expiry, used/cancelled flags), answers `{status:'approved', approval_id, approval, expires_at}`
  (`G/04-gos-requests.md:1494-1498`). One outstanding approval per vote. Marked used on `add_booking` with approval_id.
- Vault (Go) checks signature, aud, expiry, jti never used, payer = unlocker, checkout ≤ amount (`G/08…:724-729`).

---

## 7. "The fake Go" (`G/10-build-and-test.md:85-96`)
Exact promises (L89-95):
- "Keshav's team is building a small fake Go next, so the server and the app can be built before the real one is ready.
  It speaks the same socket as the real one:"
  - "It checks the signature on the upgrade and pings every 20 seconds."
  - "It answers every `send_event` with `{ "accepted": true, "duplicate": false }`, and with `"duplicate": true` for an
    `event_id` it has seen."
  - "When a `message.created` event mentions Go, it sends a `typing` notification, sends `read_trip`, adds a ✅ to the
    message with `add_reaction`, and then sends `post_message` with a reply and one of Go's own cards (`options`,
    `working`, `call`, `pay` or `notice`), a different kind each time."
  - "It answers `card_tap`, `catch_up`, the people requests and `vault_link` with fixed answers."
- "Until it is up, the server can test its signing code with the test vectors, and its answers to Go's requests with the
  examples in this guide." (L95)
- **No URL is promised.** "The staging URL for Go. It goes into the server's `GO_URL` once Go is deployed." is listed
  as an open question (L131). AsyncAPI uses placeholder host `brain.go.example` (`C/scripts/emit-openapi.ts:108`).
- How the Server team uses it: set `GO_URL` + `GO_SIGNING_SECRET`, run the GoSocket client (§8), or connect by hand with
  `connect.py` / `wscat` (L25-73, sends `get_person` for `p_kabir`).
- Spec: "The fake Go for the other teams speaks the real socket from Monday" (`docs/spec/2026-10-05-go-design.md:380`,
  week table :389).
- Natural canned answers = the guide's checked examples: ActionDone `G/05-your-requests.md:84`, ActionOpen :98,
  ActionRefused :105, CatchUp :226, PersonPage :270, Ok :328, ForgetResult :364, Link :395, Health :412; card bodies at
  `G/06-cards.md` lines in §5.
- The mirror "fake server" (for Go's own tests): opens the socket, sends the Goa trip's events, answers Go's requests from
  the Goa trip in `G/04-gos-requests.md` (snapshot :266-655), records every write (L96; `G/04-gos-requests.md:671`).
- **No test kit exists in the repo**: no fake Go, fake server, GoSocket source, or `apps/` dir (`pnpm-workspace.yaml`
  lists `apps/*` but there is no `apps/` dir; root README names `apps/brain` which does not exist yet).
- Server "done" checklist (L100-108) and Go "done" checklist (L116-124) are the acceptance lists (Go: valid one-use
  signature, ping 20 s, close after 40 s silence; send_event ≤2 s incl. unknown types; dedupe event_id; gap catch-up;
  card_tap/catch_up ≤3 s others ≤2 s; once per tap_id; -32601 unknown; `retry_after_seconds` on every 429; resend
  unanswered with same id + request_id; typing while working; ~2 s wait after a message for Go; quiet ✅; people pages /
  forget with nothing-left check; pay only with valid approval + passkey).

---

## 8. Reference client `GoSocket` (server's end) — GUIDE ONLY, no source file
Exists only as code blocks in `G/02-the-socket.md:339-445` (TS `go-socket.ts`) and `:449-569` (Python `go_socket.py`);
usage `:577-634` (`go.ts`/`go.py`). Repo grep finds no `GoSocket` source. Uses `ws` (TS) / `websockets` ≥14 (Py).

TypeScript:
```ts
export class SocketCallError extends Error {
  constructor(readonly code: number, message: string, readonly dataCode?: string, readonly retryAfterSeconds: number | undefined = undefined)
}
export class SocketTimeoutError extends Error {}
type Handler = (params: any, raw: Record<string, unknown>) => Promise<object | void>;
export class GoSocket {
  constructor(opts: { url: string; secret: string; handlers: Record<string, Handler> });
  start(): void;   // signs target = pathname+search fresh each connect; ws maxPayload = MAX_FRAME_BYTES
  request(method: string, params: object, { timeoutMs = 2000 } = {}): Promise<object>; // id `gs_${randomUUID()}`
  notify(method: string, params: object): void;  // dropped while disconnected
}
```
Python: `SocketCallError(code, message, data_code=None, retry_after_seconds=None)` with `.answer(id) -> dict`;
`GoSocket(url, secret, handlers: dict[str, async (params_model, raw_dict) -> dict | None])`; `async run()` (reconnect loop,
`BACKOFF=[1,2,5,10,30]`, `ping_interval=20, ping_timeout=20`, `max_size=1_048_576`); `async request(method, params,
timeout=2.0) -> dict` (raises `SocketCallError` / `asyncio.TimeoutError`); `async notify(method, params)`.
Behaviour: unknown method → -32601 (no data); bad params → 422 `invalid`; thrown non-SocketCallError → 500 `internal`;
unreadable → -32700 id null; notifications never answered; on (re)open resends every pending frame with the same id;
answers matched by `id`, late answers ignored; results NOT schema-checked. Handler gets `(checkedParams, rawParams)`;
store cards from `raw.card` (`G/02-the-socket.md:571-573`). card_tap called with `{ timeoutMs: 3500 }` (:598).
Quirks: TS client never pings itself — its 40 s idle timer is reset only by incoming `message`/`ping` (:372-386), so
**Go's 20 s pings are load-bearing**; TS timer starts at `request()` time even while disconnected; a TS handler returning
`void` for a request emits a frame with no `result` (invalid `SocketResult`).

---

## 9. CI (`.github/workflows/ci.yml`) and workspace
- Triggers: push to `main`, every `pull_request` (:2-5).
- Job `build-and-test` (ubuntu-latest, :7-21): checkout@v4; `pnpm/action-setup` v4.3.0 (no version input → uses
  root `packageManager: pnpm@10.29.1`, `package.json:4`); `actions/setup-node` v4.4.0 `node-version: 22`, `cache: pnpm`;
  `pnpm install --frozen-lockfile`; `pnpm build`; `pnpm test`; then
  `pnpm --filter @go/contract emit-openapi && git diff --exit-code packages/contract/openapi packages/contract/asyncapi packages/contract/socket`.
- Job `contract-python` (:23-33): setup-python v5.6.0 `3.12`; `pip install -e 'packages/contract-py[dev]'`;
  `pytest -q packages/contract-py/tests`; `cd packages/contract-py && python scripts/gen_models.py && git diff --exit-code go_contract/models.py go_contract/socket_methods.py`.
- **No Postgres (or any) service container.** No lint job, no deploy.
- Root `package.json`: `engines.node >=22`; scripts `build: pnpm -r --workspace-concurrency=1 build`, `test: pnpm -r test`,
  `typecheck: pnpm -r typecheck`; overrides zod 4.3.6, openai 6.39.1, yaml 2.9.0.
- `pnpm-workspace.yaml`: `packages/*`, `apps/*`. Packages today: `@go/contract`, `@vestra/agent-sdk` (copied from Bash,
  its `test` runs a secrets lint + vitest), `contract-py` (not a pnpm pkg).
- `tsconfig.base.json`: ES2022, `module/moduleResolution NodeNext` (imports need `.js`), strict, `noImplicitAny`,
  `noUnusedLocals`, `noUnusedParameters`, **`exactOptionalPropertyTypes: true`**, `noImplicitReturns`,
  `noFallthroughCasesInSwitch`, declaration + maps, `rootDir src`, `outDir dist`.
- Contract tests: `C/src/__tests__/{schemas,signing,spend-approval,docs-examples}.test.ts`; docs-examples checks every
  `<!-- schema: Name -->` JSON block in `G/*.md` and that every event, card, method params/result and frame has ≥1
  example (`C/scripts/docs-examples.ts:21-31`). Adding a schema without a guide example fails CI.

---

## 10. Must-dos for the Go side (WS server: real or fake brain) that are easy to miss
1. **Unknown event types before validation.** `parseParams('send_event')` / `Event.safeParse` REJECT unknown `type`
   (422). Dispatch must check `type ∈ known 20` first and answer `{accepted:true, duplicate:false}` for unknown ones
   (`socket.ts:101-104`; `G/03-events.md:83`; `schemas.test.ts:17-20`). A generic `parseParams`-first dispatcher (like
   the guide's GoSocket) violates this.
2. **Dedupe on `event_id`, not JSON-RPC id**: server outbox resends after its restart with a NEW JSON-RPC id
   (`G/01-basics.md:76`). Seen-set should survive Go restarts or a redelivered event re-triggers side effects (e.g. a
   second ✅ → server 409 `conflict` "already reacted").
3. **Answer send_event within 2 s, work afterwards**; per-trip queue in seq order (`G/03-events.md:36, 386-394`).
4. **Gap detection**: holding N and receiving N+2 → `read_trip` + `read_messages(after_seq: N)`; paginate while
   `has_more`, next `after_seq` = last message's `updated_seq` (`G/04-gos-requests.md:736, 744-785`). Also re-read every
   active trip once a minute (`G/03-events.md:393`).
5. **One-use signatures**: keep a used `(t, v1)` set; 401 + `ErrorBody{code:'bad_signature'}` on missing/malformed/
   stale/mismatch/replayed. Verify against `req.url` (path+query exactly as sent). HMAC key is the secret string's bytes.
6. **Ping every 20 s** (WS control frames) — the guide's TS client dies after 40 s without them; close any socket silent
   for 40 s.
7. **Frame limit**: set WS max payload to 1,048,576 both ways; Go's own outgoing frames must stay under it.
8. **Multiple sockets** (several server instances, `?instance=`): Go sends each request on ONE open socket and waits for
   the answer there; keep pending requests per socket; on that socket's loss resend unanswered ones (same JSON-RPC id,
   same request_id) on the next available socket (`G/02-the-socket.md:312-324`; `G/10-build-and-test.md:120`).
   If no socket is open, Go's requests must wait (Go cannot dial the server).
9. **Every request gets exactly one answer, same `id`, even if the same id arrives twice** (`G/04-gos-requests.md:81`);
   -32700 with `id:null` for unreadable; -32601 (no `data`) for unknown method; 422 `invalid` with field in message;
   500 `internal` on own crash; **every 429 must include `retry_after_seconds`** (`G/10-build-and-test.md:119`).
10. **card_tap once per `tap_id`**; 3 s limit; refuse unauthorised (`approve` by non-payer → `refused` + toast).
11. **Go's own writes**: new `request_id` per new write, same on resend; retry 0.5/2/5 s on timeout/500/503; honour 429;
    treat 409/404/422 as final ("read the trip and decide again"); treat `-32601` as "server doesn't support yet, skip".
12. **Don't react to own messages**: `message.created` comes back for Go's posts (`author.kind === 'go'`,
    `mentions_go: false`); also skip `withheld` messages. Go's own reactions come back with `person_id` null.
13. **post_message**: fresh `card_id` per new card (re-use → 409); update via `replace_card` sequentially per card
    (`G/04-gos-requests.md:899`), keep the same `kind`; text 1..2000; `mentions` only people in the trip; never
    `for_person_ids` on vote/mandate cards; mandate card only after `set_mandate` (else 409).
14. **typing**: notification (no id); "on" lasts 10 s, resend every 5 s while working, send `on:false` when done; never
    resent after reconnect (`C/src/room.ts:90`; `G/02-the-socket.md:202`).
15. **Results must validate**: server checks results against result schemas (`G/02-the-socket.md:288`); e.g.
    `ForgetResult.remaining_facts` must be literal 0, `ActionRefused.toast` required (1..120), `CatchUp.items` ≤5,
    `Option.highlights` required array, `ActionOpen/Link` URLs http(s) with `expires_at`.
16. **Ignore unknown fields; null == missing** in everything received (`G/01-basics.md:57-63`).
17. **Health route** `GET /v1/health` → `{ok:true, contract:"1.0.0"}` unsigned.
18. Server-role (fake server / the go-server) equivalents: one sender per trip in seq order, retry schedule 1 s, 5 s,
    30 s, 2 min, 10 min, then every 10 min, give up after 24 h; never retry 422 (`G/01-basics.md:123`;
    `G/03-events.md:107-116`); `read_messages` must shrink the page and set `has_more:true` to stay under 1 MB
    (`to-server.ts:21`); request_id idempotency checked before rules; `trip.created` is seq 1; budget changes `by: system`.

---

## Ambiguities / missing pieces a builder will trip on
1. **No fake-Go URL / deploy target**: guide promises behaviour but no host; staging URL is an open question
   (`G/10-build-and-test.md:131`). `GO_URL` value for the Server team is undefined until we deploy.
2. **No `apps/brain` (or any `apps/`)** although README and workspace reference it; no GoSocket/fake/test-kit source —
   the GoSocket exists only in guide markdown and must be copied/written.
3. **Unknown-event acceptance vs `parseParams`**: the contract helper returns 422 for unknown event types; nothing in
   the package special-cases it. Builder must hand-roll the pre-check (and decide whether an unknown type's `event_id`
   is still recorded for `duplicate:true`).
4. **Repeated `tap_id` answer is unspecified**: "Go acts on each tap_id once" but not whether a repeat returns the first
   answer (sensible: cache and replay it) or `done`.
5. **Fake Go "fixed answers" not enumerated**: which ActionDone/Open/Refused per action_id, what `catch_up`/people return,
   and whether `vault_link` URLs must actually open anything. The guide's examples are the obvious fixtures.
6. **Fake `pay` card needs an `approval_id`** (and `expires_at`) without a real spend approval; the server doesn't
   validate it on post_message, but a server that cross-checks would 422/409. Same for a fake `working` card's `task_id`.
7. **Signature replay store**: in-memory set is lost on Go restart (replay possible inside the 300 s window); guide says
   "Go accepts each signature once" without saying durable.
8. **Spend-denial enum order ≠ evaluation order** (`to-server.ts:182-194` vs `G/04-gos-requests.md:1511-1523`).
9. **Minor doc drift**: `C/scripts/make-test-vectors.ts:16` comment says `2026-10-05T07:00:00Z` but `1791190800` is
   09:00:00Z (the guide `G/08…:458` is right); `P/go_contract/card.py:1` docstring mentions a dead `PUT /cards/{card_id}`
   route; `common.ts:5` says Go mints "approval-request" ids while `G/01-basics.md:40` says the server mints `approval_id`.
10. **`Mandate.cap_minor` is `AmountMinor` (≥0)** in the snapshot but `SetMandate.cap_minor` is `PositiveAmountMinor`.
11. **Python lacks socket constants and a parse helper**; Python models skip some TS-only limits, so a Python-side
    implementation can accept frames the TS side would 422.
12. **`exactOptionalPropertyTypes`** is on repo-wide: hand-written objects passed where zod-inferred optional props are
    expected must omit keys rather than set `undefined` in non-zod interfaces.
13. **CI has no Postgres**: any brain test that needs a DB needs a service container added to `ci.yml` or an in-memory
    substitute; new workspace packages are auto-included in `pnpm -r build/test` and need `pnpm-lock.yaml` updated
    (`--frozen-lockfile`).
14. **Contract changes require Keshav + Nishanth approval** and regenerating openapi/asyncapi/methods.json + Python
    models + a checked guide example per new schema (`G/README.md:143-152`), or CI fails.
