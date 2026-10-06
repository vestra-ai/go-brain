# Go "hands" research: travel MCP, MCP client/server, calls, passkeys, vault crypto, payments

Read-only research, 2026-10-05. Bash = `~/workspace/agents/bash` at `origin/staging` a669d2ac21 (all `file:line`
below are on that ref unless marked). Memory = `~/.claude/projects/-Users-keshavmusunuri-workspace-agents-bash/memory/`.
SDK facts for `openai` were read from the installed `openai@7.15.0` (the version `apps/server` pins: `"openai": "^7.15.0"`,
`apps/server/package.json:46`) in a worktree's node_modules; the main checkout's node_modules has the stale 7.5.0, which
has no `live` resource.

Versions Bash runs (verified, `apps/server/package.json`): `@modelcontextprotocol/sdk ^1.29.0` (:31; installed 1.29.0),
`fastify ^5.12.5` (:41), `openai ^7.15.0` (:46), `ws ^8.18.3` (:54), `zod ^4.0.0` (:56), `@fastify/cors ^11.2.0`,
`@fastify/rate-limit ^10.3.0`. `sdks/cli/package.json` pins `@modelcontextprotocol/sdk` exactly `1.29.0`.
NOT in any Bash package.json: `stripe`, `razorpay`, `twilio`, `@simplewebauthn/*`, `@fastify/websocket`.

---------------------------------------------------------------------------------------------------------------------

## 1. The mock travel MCP server (fake ixigo base)

**Path:** `examples/mock-travel-mcp/` (6 files, 241 lines total, 216 of them JS; zero dependencies, `"engines": {"node": ">=20"}`).

| File | Lines | What |
|---|---|---|
| `README.md` | 16 | how to run + how to register it with /v1 (per-user token header) |
| `package.json` | 9 | `"type": "module"`, `start: node server.mjs`, no deps |
| `server.mjs` | 41 | `node:http` wrapper; `createMockTravelServer({ token })` (:18); body cap 256 KB (:7); PORT default 8787 |
| `app.mjs` | 58 | framework-free handler `handleMockTravelRequest({method,path,headers,body}, state)` (:30) + `createMockTravelState` (:18) + optional bearer `bearerOk` (:22-27, `timingSafeEqual`) + a webhook sink |
| `mcp.mjs` | 54 | hand-rolled JSON-RPC MCP: `initialize`, `ping`, `tools/list`, `tools/call` (:38-54); `TOOLS` (:10-23) |
| `data.mjs` | 63 | deterministic fake data + in-memory bookings per traveller token |

**SDK / transport:** NO MCP SDK. It hand-rolls the Streamable HTTP server side: `POST /mcp` only (GET -> 405, `app.mjs:33`),
stateless, answers with a plain JSON body (no SSE), batch-aware (`[parsed].flat()`, `app.mjs:42`), notifications -> 202.
Protocol versions accepted: `['2025-11-25','2025-06-18','2025-03-26','2024-11-05']`, default `2025-06-18` (`mcp.mjs:5,44`).
`serverInfo: { name: 'mock-travel', version: '1.0.0' }`, `capabilities: { tools: { listChanged: false } }`.
It is proven against the real SDK client: `apps/server/tests/unit/platform/contract/mock-travel-mcp.test.ts` (156 lines)
connects `new Client(...)` + `new StreamableHTTPClientTransport(new URL(base+'/mcp'), { requestInit: { headers } })`
(:29-33) and asserts the tool list and the annotations (:39-55). This test file is the template for Go's MCP tests.

**Auth:** two layers.
- Server bearer: `Authorization: Bearer <MOCK_TRAVEL_MCP_TOKEN>` when the env var is set (`app.mjs:22-27,34`), else open.
- Per-traveller identity: `X-Traveller-Token` header (`app.mjs:41`); every tool call without it returns
  `{error:'missing_traveller_token'}` (`mcp.mjs:30`). Bookings are keyed by that token (`data.mjs:36-39`).

**Tools (`mcp.mjs:10-23`):** each result is `{ content: [{ type:'text', text: JSON.stringify(value) }] }`, plus
`isError: true` when `value.error` is set (`mcp.mjs:26`).

| Tool | inputSchema (all strings) | annotations | Output (JSON in the text part) |
|---|---|---|---|
| `search` | `from`, `to`, `date` (YYYY-MM-DD), all required | `{ readOnlyHint: true }` | `{ options: [{ option_id, from, to, date, departs, arrives, carrier, kind:'train'\|'flight', fare_inr, seats_left }] }` (3 fixed departures, `data.mjs:4-8`; option_id `opt_<fro>_<to_>_<yyyymmdd>_<i>`, `:28`) or `{error:'invalid_search'}` |
| `pnr_status` | `pnr` | `{ readOnlyHint: true }` | the booking `{ pnr, status, passenger_name, option, fare_inr }` or `{error:'pnr_not_found'}` |
| `book` | `option_id`, `passenger_name` | `{ destructiveHint: false }` | `{ pnr:'PNR100001', status:'confirmed', passenger_name, option, fare_inr }` (`data.mjs:41-50`); `option_not_found` if not searched first |
| `cancel` | `pnr` | `{ destructiveHint: true }` | `{ pnr, status:'cancelled', refund_inr: round(fare*0.8) }` or `already_cancelled` |

Memory bounds: `MAX_OPTIONS = 1000`, `MAX_TRAVELLERS = 200`, oldest dropped (`data.mjs:11-21`).

**Where it runs inside Bash:** staging mounts it at `/v1/_staff/fixtures/mock-travel-mcp/*` for the integration drill
(`apps/server/src/platform/contract/fixtures.ts:1-60`, loads `examples/mock-travel-mcp/app.mjs` via a computed path,
`FIXTURE_PATH` :18, staging + `MOCK_TRAVEL_MCP_TOKEN` only). The race/drill scripts register it as slug `mock-travel`
(`apps/server/scripts/drills/race-box-rules.mjs:16`, `race-box.mjs:115`). Companion client sample: `examples/trip-rescue/`
(index.mjs 43 + lib.mjs 59 lines) drives a /v1 conversation that rebooks a cancelled train against this server.

**Is it a good base for a fake ixigo MCP?** Good as a seed for the DATA idea and the per-traveller-isolation idea, not as
the transport. Reasons:
- Only 4 tools, 3 hard-coded departures, trains+flights only; no buses, no stays, no live status, no seat/fare classes,
  no payment step. A fake ixigo needs ~10-14 tools (see sketch below) with richer, seeded-random but deterministic data.
- The hand-rolled JSON-RPC means hand-written JSON Schema and no argument validation. Go needs an MCP server anyway (2b/3),
  so build BOTH Go's own MCP and the fake ixigo on the SDK's `McpServer` + `registerTool` (zod schemas, annotations,
  stateless per-request transport) and keep one pattern. Reuse `data.mjs`'s determinism trick (option ids derived from
  route+date, so a search is reproducible across restarts) and its token-keyed booking store (move it to Postgres or keep
  in-memory for the fake).
- Its bearer + `X-Traveller-Token` split is exactly the shape Go will need if ixigo identifies the end customer separately
  from the partner key.

**Fake ixigo tool sketch (names are placeholders until ixigo's list is known):** `search_flights`, `search_trains`,
`search_buses`, `search_stays` (readOnly), `get_fare_rules`/`get_option` (readOnly), `train_live_status` /
`flight_status` (readOnly), `pnr_status` (readOnly), `hold`/`create_booking` (not readOnly, destructiveHint false),
`create_payment` or `pay` (not readOnly), `cancel_booking` (destructiveHint true), `refund_status` (readOnly). Keep a
`FAKE_IXIGO_SEED` and a scenario switch (e.g. a magic date that returns a cancelled train) for the "journey rescue" demo.

**What is known about ixigo's real MCP (memory):**
- `vestra-platform-api-program.md:17` (ixigo hackweek doc pasted 09-27): ixigo builds 3 platforms on one "ixigo MCP"
  foundation: "search flights/trains/buses/hotels, PNR, trips, refunds, payments, eventually booking". Hackweek 10-05 ->
  10-09, demos Mon 10-12.
- `go-hackweek-program.md` line 46 (10-04, his words): "we will get access to ixigo mcp which will be used for bookings
  etc!". Open there: "what the ixigo MCP covers (search vs book vs pay, test mode, access date)".
- go-brain spec `docs/spec/2026-10-05-go-design.md` (branch `plan-week` of `~/workspace/agents/go-brain`) section 12, line
  321: "To confirm with ixigo: the MCP address and auth, the exact tool list and argument shapes, which tools book or change
  bookings, rate limits, sandbox versus live inventory, and refund and cancellation tools." Line 319: the trip's Bash gets
  ixigo SEARCH only through Go's MCP server (read kinds), never ixigo directly. Line 398: open item 1 = ixigo access.
- Bash spec `docs/superpowers/specs/2026-10-03-go-hackweek-design.md` (branch `origin/docs/go-hackweek-spec`) :275 and
  :441: if ixigo cannot book/pay or lands late, LiteAPI (hotels) + Duffel (flights) + the box browser are the backup, and
  "a payment link paid by the payer over UPI also works".
- NOTHING known about: URL, auth scheme (static key vs OAuth), tool names/shapes, test mode. If it is OAuth 2.1 with
  RFC 9728 discovery, Bash has a full broker: `apps/server/src/services/mcp-oauth.service.ts` (472 lines: protected-resource
  + auth-server metadata discovery, client acquisition, PKCE) and `mcp-probe.service.ts:64` `detectMcpAuthRequirement`
  (401/403 + `WWW-Authenticate: Bearer` challenge = OAuth). Note /v1 company MCP servers refuse OAuth today
  (`apps/server/src/platform/abilities/mcp-servers.ts:36-37`), irrelevant if Go calls ixigo itself.

---------------------------------------------------------------------------------------------------------------------

## 2. Bash as an MCP CLIENT (what Go copies to call ixigo)

### 2a. `apps/sandbox/src/mcp/mcp-client.ts` (363 lines), the box's one MCP client

- SDK loaded lazily at connect (`await import('@modelcontextprotocol/sdk/client/index.js')`, :199-202; the file header
  :28-36 explains why: static import of the stdio chain slowed module load). Go can import statically.
- Interface `McpClient { connect(); listTools(): McpTool[]; callTool(name,args): unknown /* = result.content */; close();
  listResources?; listResourceTemplates?; readResource? }` (:110-121). `McpTool { name; description?; inputSchema?;
  annotations?: { readOnlyHint?; destructiveHint? } }` (:63-69); `declaredAnnotations(raw)` keeps only the two booleans the
  server actually set (:72-80).
- Factory `makeMcpClient(name, makeTransport, handshakeTimeoutMs, onElicit?)` (:183-308). A fresh transport per `connect()`
  because a transport is single-use (:172-182); `connect()` idempotent.
  - `new Client({ name, version: '1.0.0' })` (:208-210); with elicitation: `{ capabilities: { elicitation: { form: {} } } }`
    + `c.setRequestHandler(ElicitRequestSchema, ...)` (:211-219, URL-mode elicitations declined).
  - `await c.connect(transport, { timeout: handshakeTimeoutMs })` (:220).
  - `listTools`: `session().listTools(undefined, { timeout: handshakeTimeoutMs })` (:224-235).
  - `callTool`: `session().callTool({ name, arguments: args ?? {} }, undefined, { timeout: CALL_TIMEOUT_MS })` and returns
    `result.content` (:237-244).
  - resources paged via `collectPages` with caps `LIST_RESOURCES_MAX=1000`, `LIST_MAX_PAGES=50` (:145-170, 247-300).
  - `close()` drops the handle first so a failed close still allows reconnect (:302-306).
- Timeouts: `HANDSHAKE_TIMEOUT_MS = 5_000` for initialize AND listTools (:130), `CALL_TIMEOUT_MS = 60_000` per tool call
  (:136). (SDK default is 60 s for everything; the 5 s is deliberate: a dead server is skipped, not a 60 s stall.)
- HTTP factory `makeHttpMcpClient({ url, name, headers?, onElicit? })` (:314-333):
  ```ts
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  return new StreamableHTTPClientTransport(new URL(opts.url), { ...(opts.headers && { requestInit: { headers: opts.headers } }) });
  ```
  Auth = whatever headers the server resolved (`headers` "may carry a resolved credential and must never be logged", :311-312).
- Callers: `apps/sandbox/src/mcp/user-mcp-registry.ts:145-158` (`defaultClientFactory`, http only) and
  `apps/sandbox/src/harness/openai-mcp.ts:24` (Composio). Stdio variant `makeStdioMcpClient` (:342-363) not needed by Go.

### 2b. `apps/server/src/studio/fal-mcp-upstream.ts` (102 lines): a SERVER-side client to a remote vendor MCP. THE closest
match to "Go calls ixigo".

- One client per process to `https://mcp.fal.ai/mcp`, our key as bearer (:1-17, :22).
- `realConnect(url, apiKey)` (:51-60):
  ```ts
  const client = new Client({ name: 'vestra-studio-relay', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${apiKey}` } } });
  await client.connect(transport, { timeout: HANDSHAKE_TIMEOUT_MS });
  ```
- Timeouts: `HANDSHAKE_TIMEOUT_MS = 8_000`, `CALL_TIMEOUT_MS = 25_000` (two attempts stay under the box's 60 s per call),
  `DROP_TIMEOUT_MS = 5_000` for a hanging close (:23-27).
- Failure split (:47-49, :78-93): `isProtocolError(err)` = `err instanceof McpError && code !== ErrorCode.RequestTimeout &&
  code !== ErrorCode.ConnectionClosed` -> return `{ text, isError: true }` on the still-good connection; anything else =
  transport -> drop the client, retry once, then `"... temporarily unreachable"`.
- `textOf(result)` joins text parts and carries `isError` (:62-66). `createFalUpstream({ apiKey, url?, connectImpl? })`
  (:68-96) has a `connectImpl` test seam; `getFalUpstream()` singleton (:98-102).
- Copy this nearly verbatim as `ixigo-upstream.ts`; parameterise URL/headers; add `listTools()` caching for Jev's
  tool choice (go-brain spec :318).

### 2c. Server-side probe: `apps/server/src/services/mcp-probe.service.ts` (202 lines): `probeMcpUrl` (handshake + listTools
with `HANDSHAKE_TIMEOUT_MS = 5000`, :42, :102-116) and `detectMcpAuthRequirement` (:64). Useful as Go's Day-0
"is ixigo reachable, which tools" script.

### 2d. How the trip's Bash will reach GO's MCP (the client side Go does not write but must satisfy)

- Registration (/v1): `POST /v1/mcp-servers { name, slug, url, auth: { type:'headers', headers: { Authorization:
  'Bearer ${user_secret:TRIP_TOKEN}' } } }` + `PUT /v1/secrets/TRIP_TOKEN { value, user_id }` (pattern in
  `examples/mock-travel-mcp/README.md:9-12`; the go-brain spec line 269 already chose this).
- Validation in `apps/server/src/platform/abilities/mcp-servers.ts:35-54` (`companyConnection`): `auth.type 'oauth'` refused
  (:36-37); `${` in the URL refused (:39); URL must be PUBLIC HTTPS (`assertPublicHttpsUrl`, :40-45) => Go's MCP needs a
  real https host (a tunnel in dev), never localhost; <= 20 headers (:48); an Authorization-like header must be a
  `${secret:..}`/`${user_secret:..}` reference, never raw (:49-52). Ref regex: `company-mcp-runtime.ts:18`
  `/\$\{(secret|user_secret):([A-Z0-9_]+)\}/g`.
- The box reaches company MCP tools through the meta tools `mcp_search` / `mcp_invoke({ server, tool, args })`
  (`apps/sandbox/src/mcp/mcp-tool-defs.ts:20-37`), so tool descriptions are what the model searches; write them well.
- Box-side budgets apply to Go's server: initialize + tools/list must answer < 5 s, each tool call < 60 s
  (mcp-client.ts:130,136). `recall` and any ixigo-backed search must stay well under 60 s.
- Approval rule for company servers (Keshav 2 Oct): every tool ASKS the person before it runs unless the server marks it
  `readOnlyHint: true` or the deployment version's `run_without_asking` lists it
  (`packages/agent-sdk/src/policy/company-action.ts:1-35`, `companyActionAsks`; box side
  `apps/sandbox/src/mcp/company-actions.ts:1-21`; the company's readOnly claim is trusted, `user-mcp-registry.ts:458-475`,
  unlike a third party's, `:437-456`). In a test run (`testRun: true`, `mcps-runtime-routes.handler.ts:38-56`) a
  non-read-only tool never runs. => mark `trip`, `person`, `recall`, all travel search tools `readOnlyHint: true`; `note`
  is a write: either list it in the version's `run_without_asking` or every `note` raises an approval Go must answer via
  `/v1/interactions`.
- The sandbox adds `X-Vestra-Task-Id` only to Vestra-served MCPs (`vestra: true`, `mcps-runtime-routes.handler.ts:44`);
  Go's server sees only the trip bearer, so the token alone must identify the trip.

---------------------------------------------------------------------------------------------------------------------

## 3. A minimal streamable-HTTP MCP SERVER with bearer auth to copy

Three working shapes exist in Bash; all are stateless (a fresh `McpServer` + transport PER REQUEST, closed when the response
closes), so there is no MCP session to store or leak between trips.

### 3a. Fastify + SDK (best fit for Go): `/v1/mcp`
`apps/server/src/platform/mcp-server/routes.ts` (52 lines):
```ts
app.post('/mcp', async (req, reply) => {
  const server = buildVestraMcpServer({ principal: p, inject: injectAs(req) }, deps ?? defaultMcpDeps());
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: !asksProgress(req.body) });
  reply.hijack();                                   // the SDK writes the response itself
  reply.raw.on('close', () => { void server.close().catch(() => undefined); });
  try { await server.connect(transport); await transport.handleRequest(req.raw, reply.raw, req.body); }
  catch (err) { if (!reply.raw.headersSent) { reply.raw.writeHead(500, {...}); reply.raw.end(...); } }
});
app.get('/mcp', notAllowed); app.delete('/mcp', notAllowed);   // 405: stateless, no SSE stream, no session
```
(:24-52). `asksProgress(body)` (:19-22): answer as SSE only when the call carries `_meta.progressToken`, else plain JSON.
Auth happens BEFORE the handler in the /v1 hook (`req.platform`, from `apps/server/src/platform/auth.ts:52-68`
`authenticatePlatformRequest`: `Authorization: Bearer vk_live_|vk_test_...`).

Tool registration: `apps/server/src/platform/mcp-server/server.ts` (307 lines), `buildVestraMcpServer(ctx, deps)` (:87):
`new McpServer({ name: 'vestra', version: '2.0.0' })` (:88); a `guard(name, run)` wrapper turns every throw into an
`isError` result and audits the call (:91-107); `ok(v) = { content: [{ type:'text', text: JSON.stringify(v) }] }`,
`refuse(v) = { ...ok(v), isError: true }` (:74-75); zod field helpers with `.describe()` (:84-85);
`server.registerTool('ask', { description, inputSchema: { ... zod shape ... } }, guard('ask', async (a, extra) => ...))`
(:135ff). `extra` = `RequestHandlerExtra<ServerRequest, ServerNotification>` (:45) for progress notifications
(`progress.ts`, 45 lines).

The Studio relay is the same shape with its own auth + per-task scoping and is a nice 84-line read:
`apps/server/src/handlers/studio-relay-routes.handler.ts:46-84` (order: 404 flag, 401 auth via `authenticateRequest`,
400 task id, 403 owner, 503 key, then handshake), tools in `apps/server/src/studio/relay-server.ts:58-159`
(`registerTool('search_models', { description, inputSchema: { query: z.string().optional(), ... } }, guard(...))`).

### 3b. node:http + SDK with a per-turn bearer: the Vestra bridge
`apps/sandbox/src/harness/engines/cli-common/bridge/vestra-bridge.ts` (327 lines). Useful bits:
- `bearerOf(req)` = `/^Bearer (\S+)$/i` on `req.headers.authorization` (:116-121); constant-time compare
  `tokenMatches(expected, received)` (`apps/sandbox/src/harness/engines/cli-common/token-match.ts:11-16`, length check on
  BYTES then `timingSafeEqual`); 401 before reading the body (:232).
- Low-level handlers instead of `registerTool`: `mcp.server.setRequestHandler(ListToolsRequestSchema, ...)` and
  `(CallToolRequestSchema, ...)` (:175-227), handy when the tool list is dynamic (e.g. proxying ixigo's list).
- Unknown tool = a RESULT with `isError: true`, not a protocol error (:185-189).
- Body cap 1 MB enforced while streaming (:71, :131-158).
- SSE on purpose for long calls: `new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: false })`
  plus a `': keepalive\n\n'` comment every 15 s (:251-262; header :17-23 explains the measured 300 s idle cut in Claude
  Code's client). Go's `recall` or a slow ixigo search behind Go's MCP can use the same trick.
- Every path answers or closes; nothing throws out of the request handler (:43-45, :271-279).

### 3c. Zero-dependency JSON-RPC: `examples/mock-travel-mcp/mcp.mjs` (54 lines) + `app.mjs` bearer (:22-27). Fine for a
throwaway fake, but no validation; see 1.

### Tool annotations (readOnlyHint) with the SDK 1.29 `registerTool`
No Bash SDK-built server sets annotations today (the only declarations are the hand-written ones in
`examples/mock-travel-mcp/mcp.mjs:13-22`). SDK 1.29.0 `McpServer.registerTool(name, config, cb)` config is
`{ title?, description?, inputSchema?, outputSchema?, annotations?: ToolAnnotations, _meta? }`
(`node_modules/.pnpm/@modelcontextprotocol+sdk@1.29.0_.../dist/esm/server/mcp.d.ts:150-157`). So:
```ts
server.registerTool('search_trains', {
  description: 'Trains between two stations on a date. Read-only.',
  inputSchema: { from: z.string(), to: z.string(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) },
  annotations: { readOnlyHint: true },            // `book`: { readOnlyHint: false, destructiveHint: false }; `cancel`: { destructiveHint: true }
}, guard('search_trains', async (a) => ok(await ixigo.call('search_trains', a))));
```
With the low-level `setRequestHandler(ListToolsRequestSchema)` shape, put `annotations` on each tool object in the list.
The Bash client keeps only `readOnlyHint` and `destructiveHint` (`mcp-client.ts:72-80`). zod v4 works with SDK 1.29
(server uses `zod ^4.0.0` with `registerTool`; SDK ships `server/zod-compat.js`, imported at `relay-server.ts:17`).

Per-trip bearer minting/storage pattern to copy: `apps/server/src/platform/auth.ts:32-40`
`hashApiKey(key) = sha256 hex`, `mintApiKey(mode)` = `vk_${mode}_${randomBytes(32).toString('base64url')}`, store only
sha256 + prefix + last4; lookup by sha256 (:70-80). Same idea for one-shot tokens: `apps/server/src/platform/voice/token.ts:8-16`
(`mintVoiceToken`, prefix + 32 random bytes, TTL 60 s, sha256 stored).

---------------------------------------------------------------------------------------------------------------------

## 4. Voice: Bash's live line, and what a Twilio hotel call needs

### 4a. What Bash runs: OpenAI "GPT Live" (`gpt-live-1`), browser WebRTC + server sideband
Spec: `docs/superpowers/specs/2026-09-11-composer-live-line-design.md`; plans `docs/superpowers/plans/2026-09-11-composer-live-line-{server,web}.md`.

- Constants: `packages/shared/src/composer/live.ts` (283 lines): `LIVE_VOICE_USD_PER_MINUTE = 0.05` (:14, billed per second
  from creation to `session.closed`); 13 voices `LIVE_VOICES` (:17-30: marin, quartz, ripple, vesper, willow, stone, gleam,
  meridian, beacon, delta, cinder, bossa, tempo); default `LIVE_DEFAULT_VOICE = 'ripple'` (:39, masculine, his pick 09-12).
- Session config: `apps/server/src/services/live/live-session-config.ts:34-52` `buildLiveSessionConfig({ instructions, input, voice })`:
  ```ts
  { model: 'gpt-live-1', instructions, input /* seeded history */, audio: { output: { voice } },
    delegation: { type: 'client' }, store: false,
    client: { data_channel: { allowed_client_events: [], allowed_server_events: ALLOWED_SERVER_EVENTS } } }
  ```
  No turn-detection or audio-format knobs: WebRTC negotiates audio (Opus) and the Live model owns turn taking itself.
  Browser data channel is fenced to 8 server events (:16-25).
- Door: `apps/server/src/handlers/live-door.handler.ts` (608 lines). `import OpenAI from 'openai'` (:18),
  `SidebandWS from 'openai/resources/live/sideband/ws'` (:20); client `new OpenAI({ apiKey: process.env.OPENAI_API_KEY,
  maxRetries: 0 })` (:69-71); `LIVE_CREATE_TIMEOUT_MS = 15_000` (:67); create:
  `openai().live.create({ session, transport: { type: 'webrtc', sdp: parsed.req.sdp } }, { timeout })` (:339); sideband:
  `new SidebandWS(openai(), { session_id, graceful_close: true }, { reconnect: { maxRetries, onReconnecting } })` (:198-203).
  /v1 sibling: `apps/server/src/platform/voice/connect.ts` (281 lines, :105 attach, :205-219 create; one-shot call token
  `token.ts`; process cap `PLATFORM_VOICE_MAX_LINES = 10`).
- The actor: `apps/server/src/services/live/live-line.ts` (1095 lines). `SidebandLike { on, send, close }` (:74-78). It
  listens to `session.started` (:907), `session.input_transcript.delta` (:922), `session.output_transcript.delta` (:1010),
  `session.delegation.created` (:1030, runs the composer turn), `session.usage.updated` (:1068, metering),
  `session.closed` (:1072), `error` (:1079); it speaks with `session.commentary.append { delegation_id, content }` (:412),
  narrates with `session.thinking.append` (:416), hangs up with `session.close` (:704). Helpers in `line-core.ts` (608),
  `hangup.ts` (333), `line-standby.ts` (84), `begin-gate.ts` (89).
- "Tools in realtime": GPT Live has no function tools on the frontend model; it DELEGATES (`delegation: { type: 'client' }`)
  and our server answers with commentary. Alternative `delegation: { type: 'responses', responses: { model, instructions,
  tools: FunctionTool[] | WebSearch, tool_choice, reasoning } }` lets OpenAI run a Responses backend with function tools
  (`openai/resources/live/live.d.ts:1027-1072`, FunctionTool `:380-408`).

### 4b. Twilio in Bash
Only WhatsApp messaging, no voice: `apps/server/src/gateway/adapters/whatsapp-twilio.adapter.ts` (409 lines;
`Messages.json` URL + Basic auth :129-130). Reusable piece: **Twilio webhook signature check**
`verifyInboundWithBody(headers, body, url)` (:143-164) = HMAC-SHA1(authToken, url + sorted(k+v)), base64, compared with
`x-twilio-signature` via `timingSafeEqual`. Same algorithm signs Voice status callbacks and TwiML fetches. Env names
`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` (`packages/shared/src/schemas/env.schema.ts:1326-1329`),
and the lesson at :1336-1340: sign against the EXACT public URL Twilio called (Railway's proxy rewrites host/proto).
No Twilio Voice, TwiML, Media Streams, `twilio` npm, SIP, or mu-law code anywhere (grep `twilio|TwiML|<Stream|pcmu|ulaw`).

### 4c. Audio format support (verified in `openai@7.15.0` types)
- **GPT Live over a WebSocket** (`LiveWS`, `openai/resources/live/ws`): `AudioFormat = audio/pcm (16000|24000) |
  audio/pcmu (G.711 mu-law, 8000) | audio/pcma (A-law, 8000)` (`live.d.ts:30-75`), set via `session.start { session: {
  model: 'gpt-live-1', audio: { format: { type: 'audio/pcmu', rate: 8000 }, output: { voice } }, ... } }`
  (`SessionStartEvent` :1569-1589, `SessionConfig.Audio.format` :1421-1426). Send caller audio with
  `{ type: 'session.input_audio.append', audio: <base64> }` (:586-603, primary WS only, no ack); model audio arrives as
  `session.output_audio.delta { delta: <base64 in the configured format> }` (:898-924). So Twilio mu-law frames pass
  through with NO transcoding. Caveat: the 7.15 Live server-event union (:1215) has no "speech started" / "response
  interrupted" event, so Twilio's `clear` (flush queued audio on barge-in) must be driven by something else (e.g. the first
  `session.input_transcript.delta` of a caller turn, or Twilio `mark` bookkeeping). Unproven: measure on Day 0.
- **GPT Live over SIP**: `client.live.sessions.accept(sessionId, { session: { type: 'live', model: 'gpt-live-1', ... } })`,
  `.refer(id, { target_uri: 'tel:+...' })` (transfer), `.reject(id, { status_code })`, hang-up (`sessions.d.ts:7-78,
  244-250`). Server events for an OUTBOUND SIP provider leg exist (`transport.ringing`, `transport.answered`,
  `transport.failed`, DTMF received/sent by a hosted tool; `live.d.ts:1237-1300`) but `LiveCreateParams.transport` in 7.15
  is `webrtc` only (:1833-1857): how to start an outbound OpenAI SIP call is not in the typed SDK; check OpenAI's docs /
  org enablement (Bash spec ref [82] "OpenAI realtime SIP / Live outbound").
- **Realtime API (`gpt-realtime-2.1`, `-2.1-mini`, `-2`, `-1.5`, `gpt-realtime`, `gpt-realtime-mini`; model ids in
  `resources/realtime/calls.d.ts`)**: `OpenAIRealtimeWS` (`openai/realtime/ws`, `realtime/ws.d.ts:14`);
  `RealtimeAudioFormats = audio/pcm (24 kHz) | audio/pcmu | audio/pcma` (`realtime.d.ts` :1123-1160, PCMU :1144) set at
  `session.audio.input.format` / `output.format`; server VAD event `input_audio_buffer.speech_started` (:789-819) +
  `conversation.item.truncate` (:541) = the official Twilio sample's barge-in pattern; function tools on the session;
  SIP via `client.realtime.calls.accept(callId, { type: 'realtime', model, audio, instructions, tools })`, `.hangup`,
  `.refer`, `.reject` (`calls.d.ts:25-59`). Pricing is per audio token (not read).

### 4d. What a Twilio Media Streams bridge needs (Go server, Fastify + ws)
General Twilio facts below are from Twilio's docs as I know them, NOT verified here; confirm on Day 0.
1. Outbound call: `POST /2010-04-01/Accounts/{sid}/Calls.json` (or `twilio` npm `client.calls.create({ to, from, twiml |
   url, statusCallback, statusCallbackEvent: ['initiated','ringing','answered','completed'], machineDetection? })`), TwiML
   `<Response><Connect><Stream url="wss://go.example/calls/stream"><Parameter name="call_token" value="..."/></Stream></Connect></Response>`
   (bidirectional; custom parameters arrive in the `start` message, the place for a one-shot call token like
   `mintVoiceToken`).
2. A WebSocket endpoint on the Fastify server: copy the `noServer` upgrade hook in
   `apps/server/src/services/runner-transport.service.ts:72-135` (`new WebSocketServer({ noServer: true })`,
   `server.on('upgrade', onUpgrade)`, path guard first, `wss.handleUpgrade(req, socket, head, cb)`), or add `@fastify/websocket`.
3. Twilio -> us: `connected`, `start` (`streamSid`, `callSid`, `customParameters`, `mediaFormat: { encoding:
   'audio/x-mulaw', sampleRate: 8000, channels: 1 }`), `media` (`payload` = base64 mu-law, 20 ms = 160 bytes), `mark`,
   `dtmf`, `stop`. Us -> Twilio: `{ event:'media', streamSid, media:{ payload } }`, `{ event:'mark', streamSid, mark:{ name } }`,
   `{ event:'clear', streamSid }`.
4. Bridge: open the model WS with `pcmu` in AND out; forward `payload` -> `input_audio.append` and output deltas -> Twilio
   `media`, byte-for-byte. On caller speech: Twilio `clear` (+ Realtime `conversation.item.truncate` at the played ms).
5. Verify Twilio callbacks with the HMAC-SHA1 code above; never log the auth token; status callback ends the call row.
6. The fixed disclosure opening + `may_not` list (Bash spec `2026-10-03-go-hackweek-design.md` 6.6, :312-319); keep only
   the transcript, not audio. Trial accounts can call only verified numbers; calling India needs the India voice geo
   permission and an Indian landline test (Day-0 checklist :444).
Rough size: TwiML + calls route (~80 lines), WS bridge (~200), call actor with transcript, goal, hang-up, outcome (~250).

Alternative that avoids a media bridge: point Twilio at OpenAI SIP (`<Dial><Sip>sip:<project>@sip.api.openai.com;transport=tls</Sip></Dial>`
or an Elastic SIP trunk), accept the incoming-call webhook with `live.sessions.accept` / `realtime.calls.accept`, and drive it
from a sideband exactly as `live-door.handler.ts:198-203` does. Webhook name/URI from memory of OpenAI docs: verify.

### 4e. Memory notes on the call stack and latency
- `voice-audio-breakups-2026-09-29.md`: gpt-live-1 WebRTC calls crackle; OpenAI's media edge (Azure Pune, 13.71.25.29)
  adds ~200 ms (STUN RTT 240-340 ms vs ICMP 47 ms), bursty delivery, jitter-buffer target 350-580 ms, loss bursts 1-6 %
  audible; RED refused by OpenAI; jitterBufferTarget A/B no gain. Lever noted: "a server-side transport (WebSocket + our
  own playout buffer) would give control". A Twilio bridge IS a server-side transport: colocate the Go server with
  Twilio's edge and OpenAI, and measure.
- `feedback-no-second-ear-on-the-call.md` (09-28, he was angry): hear with the voice model's own ears only; never add
  ElevenLabs Scribe or any second STT beside it. Apply to the hotel call: use `session.input_transcript.delta` (Live) or
  the session's own input transcription (Realtime), no separate STT.
- `onboarding-rethink-2026-09-27-call.md`: the onboarding call is gpt-live-1 (same as the composer Line); never restart a
  server mid-call or overwrite its log (09-28 round 7).
- `go-hackweek-program.md` / Bash spec 6.6 (:312-319): rail = "Twilio outbound voice with Media Streams, bridged to an
  OpenAI realtime model (the official Twilio pattern [83]). Day 0 decides between that and OpenAI's own outbound SIP if our
  org has it enabled [82]. Fallback: Vapi (about 1 hour to set up) [88]." Call landlines/front desks only, disclose, no
  audio recording. go-brain `docs/plans/2026-10-04-plan-1-brain.md:13`: Plan 2 = "the call service: Twilio Media Streams to
  the OpenAI realtime model".

---------------------------------------------------------------------------------------------------------------------

## 5. Passkeys / WebAuthn and encryption helpers

**WebAuthn: none in Bash.** No `@simplewebauthn/*` or any WebAuthn dependency in any package.json. The only "passkey"
code is native Google login: `apps/desktop/src-tauri/src/native_auth.rs` (ASWebAuthenticationSession sheet, so Google's own
passkey/Touch ID works; WKWebView cannot do platform WebAuthn) + `apps/web/src/lib/native-login.ts` +
`AuthContext.tsx` (memory `native-passkey-login.md`). Lesson that carries over: a passkey prompt must run in a real browser
context (Safari sheet / system browser / installed PWA), never an embedded WebView or iframe; that matches go-brain spec
line 335 (vault page on Go's own domain, opened as its own page). For a native Flutter app to do passkeys inline it would
need associated domains (`apple-app-site-association`, Android `assetlinks.json`) under the RP ID; the system-browser page
avoids that.

**Encryption helpers worth copying:**
- `apps/server/src/services/user-secrets.service.ts` (97 lines), AES-256-GCM, the only `createCipheriv` in Bash:
  - `interface EncPayload { ciphertext: string; iv: string; auth_tag: string }` (base64 each) (:19-23)
  - `function key(): Buffer` = `SECRET_ENCRYPTION_KEY` 64 hex chars (:25-31)
  - `export function encryptSecret(plaintext: string): EncPayload` (12-byte random IV, :33-42)
  - `export function decryptSecret(p: EncPayload): string` (tag verified, throws on tamper, :44-51)
  - `storeUserSecret(supabase, userId, k, plaintext)`, `resolveUserSecret(...)`, `listUserSecretKeys(...)` (:53-97)
  - NOT envelope encryption: one app-wide key, no AAD, no key id/rotation. For the vault: per-item random DEK
    (AES-256-GCM), the DEK wrapped by a per-person KEK (KMS `GenerateDataKey`/`Decrypt`, or for hackweek a KEK derived
    with HKDF from a master key + person id), `cipher.setAAD(Buffer.from(personId + itemId))` on both layers, store
    `{ ciphertext, iv, tag, wrapped_dek, dek_iv, dek_tag, kek_id, v }`. Memory `agent-credentials-and-payments-research-
    2026-09-03.md` (Steel's design): "per-cred AES-256-GCM key wrapped by per-org KMS key, org id as AAD".
- Constant-time compares: `tokenMatches` (`token-match.ts:11-16`), `safeEqual` in `apps/server/src/services/billing/webhook-verify.ts:22-29`.
- Hash-only token storage: `platform/auth.ts:32-40`, `platform/voice/token.ts:8-16`.
- Already in go-brain: Ed25519 compact-JWS spend approval `signSpendApproval` / `verifySpendApproval`
  (`~/workspace/agents/go-brain/packages/contract/src/spend-approval.ts:40,52`, `node:crypto` only, TTL <= 600 s) and HMAC
  request signing (`packages/contract/src/signing.ts`).

---------------------------------------------------------------------------------------------------------------------

## 6. Payments in Bash

**No Stripe code.** `stripe` appears only as (a) hostnames the box treats as payment pages
(`apps/sandbox/src/browser/payment-hosts.ts:8`: js/checkout/buy/billing/hooks.stripe.com, m.stripe.network), (b) the
Composio Stripe toolkit hints and composer catalog effects (`composio-tool-hints.service.ts`,
`services/composer/catalog/app/effect.ts`), (c) tests. No PaymentIntents, SetupIntents, saved payment methods, or test-card
flows exist.

**What does exist: subscription billing over two rails, raw `fetch`, no vendor SDKs.**
- Port: `apps/server/src/services/billing/gateway.port.ts` (160 lines): `PaymentGateway { id; createSubscription;
  getSubscription; cancelSubscription; verifyWebhook(rawBody: Buffer, headers); parseEvent(rawBody, headers) }` (:146-160).
- `razorpay.adapter.ts` (168 lines): `createRazorpayAdapter({ baseUrl, keyId, keySecret, webhookSecret, planIds })`
  (:24-30, :58), Basic auth `keyId:keySecret` (:59-60), base URL `RAZORPAY_BASE_URL ?? 'https://api.razorpay.com/v1'`
  (`billing.config.ts:103-106`, env `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`). Subscriptions +
  RBI e-mandate only (comment :47-54); no one-time Orders/Payments code.
- `xpay.adapter.ts` (251 lines), international, Basic `publicKey:privateKey`, sandbox `api.test.xpaycheckout.com`
  (memory `billing-gateways-xpay-razorpay-program.md:85-90`: sandbox not self-serve, wiped periodically). Subscriptions only.
- Reusable for any demo rail's webhooks: `webhook-verify.ts` (41 lines) `verifyRazorpaySignature(rawBody, sig, secret)`
  (HMAC-SHA256 hex, header `x-razorpay-signature`, :37-41), `verifyXpaySignature` (HMAC-SHA512 base64, :31-35), and the
  raw-body Fastify parser `apps/server/src/handlers/billing-webhook.handler.ts:27-40`
  (`instance.addContentTypeParser('application/json', { parseAs: 'buffer' }, ...)` keeping `req.rawBody`; verify the RAW
  bytes, never a re-serialised object, file header :4-14).
- Memory `renewals-never-collect-razorpay-card-tokens-rejected.md`: Razorpay card mandate tokens were rejected
  (`compliant_with_tokenisation_guidelines: false`, "Failed to tokenised the card") on every card subscription; a live
  reminder that Indian card-on-file goes through network tokenisation, and it can fail.

**Nothing in Bash can serve as a one-time "pay with saved card" rail as-is.** Options for the demo (outside Bash):
- Stripe test mode: `stripe` npm; vault page collects the card with Stripe Elements + a SetupIntent, Go keeps only the
  `pm_...` id + brand/last4; at approval, `paymentIntents.create({ amount, currency, customer, payment_method,
  off_session: true, confirm: true })`; test cards (4242 4242 4242 4242, 3DS cards) and webhooks verified with the raw body.
  Stripe holds the PAN, so neither PCI scope nor RBI CoF storage falls on Go. Test mode needs no account activation;
  whether a live India account is possible is a separate question (not needed for the demo).
- Razorpay test mode (Vestra already has a Razorpay account + keys in Bash's env): Orders API + Checkout; saved cards are
  tokenised by Razorpay (CoFT-compliant). Bash has no Orders code to copy, only the signature verify.
- The fake ixigo's own `pay` step accepting a vault-issued one-time token (no real gateway at all): the simplest demo,
  and the place the vault's "fill once" is exercised end to end.
- Bash spec stretch (:377): "Stripe Issuing test-mode single-use card minted per mandate" [60]; Day-0 checklist (:444):
  "payer's capped virtual card ready" for the one real booking.

---------------------------------------------------------------------------------------------------------------------

## 7. Memory: agent credentials and payments research (`agent-credentials-and-payments-research-2026-09-03.md`, 113 lines)

Key conclusions:
- Nobody's model sees a password. Three patterns: (1) credential-blind sign-in form on the user's device -> remote browser,
  then the SESSION (cookie) persists (OpenAI cloud browser, 08-25); (2) password manager fills, human approves with
  biometrics, agent stops reading (1Password for Claude 07-16, E2E Noise channel); (3) platform vault + blind injection
  (Steel/Browser Use: envelope encryption, per-cred AES-256-GCM key wrapped by per-org KMS key, org id as AAD; fill, then
  blur the field; TOTP from stored secret).
- Cards: "agent never holds a PAN". Stripe Shared Payment Tokens (one seller, max amount, expiry, revocable, 3DS via
  next_action) are US/CA/EU only, NOT India; Visa Trusted Agent Protocol / Mastercard Agent Pay tokens; Google AP2
  mandates; for browser checkout, single-use virtual cards with caps (Stripe Issuing + Cross River, Lithic).
- India: NPCI Unified Agent Protocol on UPI Circle (delegated pay) + Reserve Pay (block funds), limits + audit trail;
  RBI approval pending (Jul 2026 reporting); Razorpay says agentic payments are live with NPCI.
- Recommended program: 1 credential-blind sign-in sheet, 2 OTP/TOTP, 3 vault (1Password Agentic Autofill or own
  Steel-style store), 4 "money with a cap, never a card" (UPI Circle in India, single-use capped virtual cards for card
  checkouts, SPTs abroad). Until then payment = takeover.
- Bash state (corrections 09-24): Chrome `PasswordManagerEnabled:false`, `AutofillCreditCardEnabled:false` by policy;
  chat-pasted passwords are typed by design (#3272) and land raw in `messages`; browser checkout classifies as
  `external_mutation`, money keywords lack ₹/INR/UPI; no TOTP / 1Password / vault / agent-UPI code anywhere.

What is legal for the demo (from the Go specs, which apply this research):
- Bash spec 6.8 (:334-345) and the risk table (:440): RBI's card-on-file (CoFT) rules stop merchants and payment
  companies from storing card numbers; a vault only the person can unlock (the 1Password shape) "is a different case, but
  it needs a legal read first". **Hackweek = test cards only**; never store CVV; the CVV and bank OTP are typed by the
  payer on the approval screen. Long term in India: UPI with limits (UPI Circle, Reserve Pay, once RBI approves).
  General background (not from the notes; verify with counsel): since 1 Oct 2022 only card issuers and networks may store
  actual card data in India; everyone else uses network tokens with explicit consent + additional factor authentication.
- The one REAL action in the hackweek is a refundable, capped booking on the payer's capped virtual card
  (Day-0 checklist :444), paid only with both keys: go-server's signed spend approval (Ed25519, <= 600 s, one use) + the
  payer's passkey (go-brain spec :26, :325-335; Bash spec :224).
- Rule from memory `feedback-no-secrets-in-the-box` (Bash spec :452): no card or login on the box, in the transcript, the
  model's context, or the Go DB; the trip's Bash holds no card and no paying tool (go-brain spec :279).

---------------------------------------------------------------------------------------------------------------------

## Recommendations

1. **Fake ixigo MCP base:** a new SDK-based server (`McpServer` + `registerTool` + zod + `annotations`), stateless per
   request, mounted on a Fastify route exactly like `apps/server/src/platform/mcp-server/routes.ts:24-52`. Seed its data
   and per-traveller isolation from `examples/mock-travel-mcp/data.mjs` (deterministic option ids, token-keyed bookings,
   bounded maps) and its bearer from `app.mjs:22-27`; widen to flights/trains/buses/stays search, status, PNR, hold/book,
   pay, cancel, refund status, plus a scenario switch for the journey-rescue demo. Test it with the SDK client exactly as
   `apps/server/tests/unit/platform/contract/mock-travel-mcp.test.ts:29-55` does. Keep tool names behind one adapter so the
   real ixigo list drops in.
2. **MCP client (Go -> ixigo):** copy `apps/server/src/studio/fal-mcp-upstream.ts` (102 lines) as `ixigo-upstream.ts`
   (singleton, bearer header, 8 s handshake / 25 s call, protocol-vs-transport error split, one retry), plus the
   `declaredAnnotations` + `McpTool` shapes from `apps/sandbox/src/mcp/mcp-client.ts:43-80` to keep ixigo's read-only
   hints, and `apps/server/src/services/mcp-probe.service.ts` for a Day-0 reachability/OAuth check. Package:
   `@modelcontextprotocol/sdk@1.29.0` (pin like `sdks/cli`), `zod@^4`.
3. **MCP server (Go's own: trip, person, recall, note, travel search):** copy `platform/mcp-server/routes.ts` (transport
   per request, `reply.hijack()`, 405 on GET/DELETE) + the `guard`/`ok`/`refuse` pattern from
   `platform/mcp-server/server.ts:74-107`; auth with a per-trip bearer minted/hashed like `platform/auth.ts:32-40`, compared
   with `token-match.ts`; `annotations: { readOnlyHint: true }` on everything except `note`, and list `note` in the
   deployment version's `run_without_asking` (or Go must answer an approval per note). Serve on public HTTPS (required by
   `mcp-servers.ts:40-45`); keep every call < 60 s; use the bridge's SSE keepalive (`vestra-bridge.ts:251-262`) for slow
   calls. Register via `POST /v1/mcp-servers` with `Authorization: Bearer ${user_secret:TRIP_TOKEN}`.
4. **Call stack:** Twilio Programmable Voice outbound call -> `<Connect><Stream>` -> Go's WS endpoint (the `noServer`
   upgrade hook from `apps/server/src/services/runner-transport.service.ts:72-135`, `ws@^8`) -> OpenAI over WebSocket with
   `audio/pcmu` both ways (no transcoding). Model: prefer `gpt-realtime-2.1` via `OpenAIRealtimeWS` for the bridge
   (documented `speech_started` + `truncate` barge-in, function tools on the session); keep `gpt-live-1` over `LiveWS`
   (`audio/pcmu` 8 kHz, $0.05/min, same model as Bash's Line) as the A/B if barge-in can be made clean. Day-0 probe:
   OpenAI SIP (`realtime.calls.accept` / `live.sessions.accept` + sideband, `live-door.handler.ts:198-203`) if the org has
   it, which removes the media bridge. Copy Twilio signature verification from
   `whatsapp-twilio.adapter.ts:143-164`. Packages: `openai@^7.15.0`, `ws@^8.18`, `twilio` (or raw REST + Basic auth like
   `whatsapp-twilio.adapter.ts:129-130`). Use the model's own transcript only (no second STT). Fallback: Vapi.
5. **WebAuthn library:** none to copy from Bash; add `@simplewebauthn/server` + `@simplewebauthn/browser` (same major on
   both; current major as I know it is 13.x, confirm on npm). Vault page on Go's own domain (the RP ID), opened as a real
   page / system browser sheet, never a WebView or iframe. Envelope crypto: start from
   `apps/server/src/services/user-secrets.service.ts:19-51`, add per-item DEK + wrapped DEK + AAD (person id, item id) +
   key id; KEK from a KMS (or HKDF from a master key for hackweek). Spend approval verify already exists in go-brain
   `packages/contract/src/spend-approval.ts`.
6. **Payment rail for the demo:** test cards only. Simplest: the fake ixigo's `pay`/`book` step takes a one-time vault
   token (no gateway). If a real gateway is wanted: Stripe test mode (`stripe` npm; Elements + SetupIntent on the vault
   page, store `pm_...` + last4 only, off-session PaymentIntent on approval; Stripe holds the PAN, which also keeps RBI CoF
   and PCI off Go) or Razorpay test mode (Vestra's account; Orders + Checkout; Razorpay tokenises saved cards). Copy
   webhook verification + raw-body parsing from `apps/server/src/services/billing/webhook-verify.ts` and
   `apps/server/src/handlers/billing-webhook.handler.ts:27-40`. The one real booking = refundable, capped, on the payer's
   capped virtual card, behind the signed spend approval + passkey. Real stored cards wait for the legal read on RBI CoFT.
