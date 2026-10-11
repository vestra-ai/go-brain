/**
 * A fake Vestra /v1 for lane C's tests: the routes Go calls, a conversation event stream (SSE, resumable with
 * Last-Event-ID, cut on demand), GET /v1/events for the webhook kinds, and helpers that play the trip's computer
 * (a task starts, ticks its to-do list, asks, hands off, finishes). It checks keys, the admin key where /v1 asks for
 * it, idempotency keys on creates, and records every call.
 *
 * Turns as /v1 keeps them: every message is a turn. A follow-up's words wait in its conversation's task (the task
 * inbox) for the next run, and a run settles the turns whose words it took (conversation.status, after the run's
 * ending), so a task with a follow-up runs twice and ends twice. A conversation is idle only with no turn and no work
 * open.
 */
import { createHmac } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

export interface FakeEvent { seq: number; type: string; data: Record<string, unknown>; created_at: string }
export interface FakePlatformEvent {
  id: string; object: 'event'; type: string; mode: 'test'; created_at: string; user_id: string | null; task_id: string | null; conversation_id: string | null;
  data: Record<string, unknown>;
}
export interface FakeTask {
  id: string; conversationId: string; userId: string; turnId: string; title: string; status: 'queued' | 'working' | 'waiting' | 'done' | 'failed';
  progress: Array<{ content: string; status: string }>; result: { text: string | null; data: unknown }; stopped: boolean;
  /** The turns whose words the current run took: they settle when it ends. */
  inRun: string[];
  /** The turns whose words wait for the next run. */
  inbox: string[];
}
export interface FakeTurn { id: string; conversationId: string; status: 'working' | 'completed' | 'failed' | 'stopped'; data: unknown }
export interface FakeInteraction {
  id: string; taskId: string; conversationId: string; userId: string; type: 'question' | 'handoff' | 'approval' | 'connect' | 'tool_call'; kind: string;
  status: 'pending' | 'resolved' | 'cancelled' | 'expired'; summary: string;
  questions?: Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multi_select: boolean }>;
  browser?: { suggested_mode: 'control'; url: string | null }; details?: Record<string, unknown>; answer?: unknown;
}
export interface FakeCall { method: string; path: string; query: Record<string, string>; body: any; headers: Record<string, string | undefined> }

const STREAM_ONLY = new Set(['message.delta', 'task.progress', 'usage.updated', 'screen.control', 'error', 'ping']);

export function signV1(secret: string, body: string, tSec: number): string {
  return `t=${tSec},v1=${createHmac('sha256', secret).update(`${tSec}.${body}`).digest('hex')}`;
}

type Init = Omit<FakeInteraction, 'id' | 'taskId' | 'conversationId' | 'userId' | 'status'>;

export class FakeV1 {
  // forceCloseConnections: close() ends open event streams and keep-alive sockets at once instead of waiting them out.
  readonly app: FastifyInstance = Fastify({ logger: false, forceCloseConnections: true });
  url = '';
  readonly calls: FakeCall[] = [];
  readonly users = new Map<string, { default_deployment: string | null }>();
  readonly secrets = new Map<string, string>();
  readonly conversations = new Map<string, { id: string; userId: string; deployment: string | null; events: FakeEvent[] }>();
  readonly tasks = new Map<string, FakeTask>();
  readonly turns = new Map<string, FakeTurn>();
  readonly interactions = new Map<string, FakeInteraction>();
  readonly platformEvents: FakePlatformEvent[] = [];
  /** The computer's screen; null answers 409 browser_not_open. */
  screen: Buffer | null = null;
  /** Bash refusing the screenshot with this 409 code, such as browser_in_use while a person signs in on the screen. */
  screenRefusal: string | null = null;
  /** Vestra's BROWSER_SHARED_CONTROL. Off answers screen: 'control' with 409 screen_control_unavailable. */
  controlAvailable = false;
  /** A hand_off: always message starts its task by itself (task.started on the stream). */
  autoStart = true;
  /** Cut the next stream connection after this many frames, once. */
  dropAfterFrames: number | null = null;
  /** The next stream connection answers this status and code, once. */
  failNextStream: { status: number; code: string } | null = null;
  /** null: the MCP check passes when the user has TRIP_TOKEN. false: it always fails. */
  checkOk: boolean | null = null;
  /** What a warm answers: 'waking' (202), or 'ready' (200) for a computer that is up. */
  warmStatus: 'waking' | 'ready' = 'waking';
  /** The next POST to a path that matches answers this status and code, once (402 wallet_empty, 409 conversation_busy). */
  failNextPost: { path: RegExp; status: number; code: string } | null = null;
  traceSteps: Array<Record<string, unknown>> = [];
  private n = 0;
  private readonly idem = new Map<string, { status: number; body: unknown }>();
  private readonly listeners = new Map<string, Set<(e: FakeEvent) => void>>();
  private readonly liveStreams = new Set<ServerResponse>();

  constructor(readonly o: { keys: string[]; adminKey: string; now: () => Date }) {
    this.routes();
  }

  async start(): Promise<string> {
    await this.app.listen({ port: 0, host: '127.0.0.1' });
    this.url = `http://127.0.0.1:${(this.app.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async close(): Promise<void> {
    await this.app.close();
  }

  callsTo(method: string, path: RegExp): FakeCall[] {
    return this.calls.filter((c) => c.method === method && path.test(c.path));
  }

  /** Cuts every open stream now, as a network drop would. Answers how many it cut. */
  cutStreams(): number {
    const n = this.liveStreams.size;
    for (const r of this.liveStreams) r.destroy();
    this.liveStreams.clear();
    return n;
  }

  /** Appends an event to a conversation's stream, and to GET /v1/events when it is a webhook kind. */
  emit(conversationId: string, type: string, data: Record<string, unknown>): FakeEvent {
    const conv = this.conversations.get(conversationId);
    if (!conv) throw new Error(`no conversation ${conversationId}`);
    const e: FakeEvent = { seq: conv.events.length + 1, type, data, created_at: this.o.now().toISOString() };
    conv.events.push(e);
    if (!STREAM_ONLY.has(type)) {
      this.platformEvents.push({
        id: this.next('evt'), object: 'event', type, mode: 'test', created_at: e.created_at, user_id: conv.userId,
        task_id: typeof data.task_id === 'string' ? data.task_id : null, conversation_id: conversationId, data,
      });
    }
    for (const listener of this.listeners.get(conversationId) ?? []) listener(e);
    return e;
  }

  /** /v1 starts the work a hand_off message asked for. Queued: the computer is still waking, so no run has its words yet. */
  startTask(conversationId: string, turnId: string, title: string, o: { queued?: boolean } = {}): FakeTask {
    const conv = this.conversations.get(conversationId);
    if (!conv) throw new Error(`no conversation ${conversationId}`);
    const t: FakeTask = {
      id: this.next('task'), conversationId, userId: conv.userId, turnId, title, status: o.queued ? 'queued' : 'working', progress: [], result: { text: null, data: null },
      stopped: false, inRun: o.queued ? [] : [turnId], inbox: o.queued ? [turnId] : [],
    };
    this.tasks.set(t.id, t);
    this.emit(conversationId, 'task.started', { task_id: t.id, title, turn_id: turnId });
    return t;
  }

  /** The task's next run starts, taking the words of these turns from its inbox (default: all of them). */
  nextRun(taskId: string, takes?: string[]): void {
    const t = this.task(taskId);
    const taking = takes ?? [...t.inbox];
    t.inbox = t.inbox.filter((id) => !taking.includes(id));
    t.inRun = taking;
    t.status = 'working';
  }

  lastTask(): FakeTask | undefined {
    return [...this.tasks.values()].at(-1);
  }

  progress(taskId: string, todos: Array<[string, 'pending' | 'in_progress' | 'completed']>): void {
    const t = this.task(taskId);
    t.progress = todos.map(([content, status]) => ({ content, status }));
    this.emit(t.conversationId, 'task.progress', { progress: 'status', task_id: taskId, todos: t.progress });
  }

  ask(taskId: string, init: Init): FakeInteraction {
    const t = this.task(taskId);
    const i: FakeInteraction = { ...init, id: this.next('int'), taskId, conversationId: t.conversationId, userId: t.userId, status: 'pending' };
    this.interactions.set(i.id, i);
    t.status = 'waiting';
    this.emit(t.conversationId, 'interaction.created', { interaction_id: i.id, type: i.type, task_id: taskId });
    return i;
  }

  /** The current run ends: its ending, then the turns whose words it took settle. Words still in the inbox run next. */
  complete(taskId: string, data: unknown, text: string): void {
    const t = this.task(taskId);
    const ran = this.endRun(t);
    t.status = t.inbox.length > 0 ? 'queued' : 'done';
    t.result = { text, data };
    this.emit(t.conversationId, 'task.completed', { task_id: taskId, status: 'completed', cost_usd: 0.42, cost_complete: true, summary: text.slice(0, 280), answer: text });
    this.settleTurns(ran, 'completed', data, true);
  }

  fail(taskId: string, message: string): void {
    const t = this.task(taskId);
    const all = [...this.endRun(t), ...t.inbox.splice(0)];
    t.status = 'failed';
    this.emit(t.conversationId, 'task.failed', { task_id: taskId, status: 'failed', message });
    this.settleTurns(all, 'failed', null, true);
  }

  /** Done on /v1 with no event at all: what a lost webhook and a dead stream look like together. */
  finishSilently(taskId: string, data: unknown, text: string): void {
    const t = this.task(taskId);
    const all = [...this.endRun(t), ...t.inbox.splice(0)];
    t.status = 'done';
    t.result = { text, data };
    this.settleTurns(all, 'completed', data, false);
  }

  /** A webhook delivery of one event, signed as Vestra signs it. */
  delivery(evt: FakePlatformEvent, secret: string, tSec: number): { body: string; headers: Record<string, string> } {
    const body = JSON.stringify(evt);
    return { body, headers: { 'content-type': 'application/json', 'vestra-signature': signV1(secret, body, tSec), 'vestra-event-id': evt.id, 'vestra-event-type': evt.type } };
  }

  private next(prefix: string): string {
    this.n += 1;
    return `${prefix}_${this.n}`;
  }

  private task(id: string): FakeTask {
    const t = this.tasks.get(id);
    if (!t) throw new Error(`no task ${id}`);
    return t;
  }

  private endRun(t: FakeTask): string[] {
    const ran = t.inRun;
    t.inRun = [];
    return ran;
  }

  /** Settles open turns; announced, each is a conversation.status naming the turn and the conversation's status after it. */
  private settleTurns(ids: string[], status: FakeTurn['status'], data: unknown, announce: boolean): void {
    for (const id of ids) {
      const turn = this.turns.get(id);
      if (!turn || turn.status !== 'working') continue;
      turn.status = status;
      turn.data = data ?? null;
      if (announce) {
        const conv = this.conversationView(turn.conversationId);
        this.emit(turn.conversationId, 'conversation.status', { status: conv.status, turn_id: id, turn_status: status, ...(data != null ? { data } : {}) });
      }
    }
  }

  private stop(t: FakeTask): void {
    if (t.status === 'done' || t.status === 'failed') return;
    const all = [...this.endRun(t), ...t.inbox.splice(0)];
    t.status = 'failed';
    t.stopped = true;
    for (const i of this.interactions.values()) if (i.taskId === t.id && i.status === 'pending') i.status = 'cancelled';
    this.emit(t.conversationId, 'task.stopped', { task_id: t.id, status: 'stopped' });
    this.settleTurns(all, 'stopped', null, true);
  }

  private conversationView(id: string): Record<string, unknown> {
    const c = this.conversations.get(id)!;
    const work = [...this.tasks.values()].filter((t) => t.conversationId === id && (t.status === 'working' || t.status === 'waiting' || t.status === 'queued'));
    const asks = [...this.interactions.values()].filter((i) => i.conversationId === id && i.status === 'pending');
    const openTurns = [...this.turns.values()].some((u) => u.conversationId === id && u.status === 'working');
    const status = asks.length > 0 ? 'waiting' : work.length > 0 || openTurns ? 'working' : 'idle';
    return {
      id, object: 'conversation', user_id: c.userId, deployment_id: c.deployment, deployment_version: 1, status, metadata: {},
      open_work: work.map((t) => ({ task_id: t.id, title: t.title, status: t.status })),
      open_interactions: asks.map((i) => ({ interaction_id: i.id, task_id: i.taskId, kind: i.kind })),
      pending_tool_calls: [], last_event_seq: c.events.length, cost_usd: 0, created_at: this.o.now().toISOString(), last_active_at: this.o.now().toISOString(),
    };
  }

  private taskView(t: FakeTask): Record<string, unknown> {
    return {
      id: t.id, object: 'task', user_id: t.userId, conversation_id: t.conversationId, status: t.status, title: t.title, progress: t.progress,
      result: t.result, outcome: null, cost_usd: 0.42, created_at: this.o.now().toISOString(), updated_at: this.o.now().toISOString(),
    };
  }

  private interactionView(i: FakeInteraction): Record<string, unknown> {
    return {
      object: 'interaction', id: i.id, user_id: i.userId, task_id: i.taskId, conversation_id: i.conversationId, kind: i.kind, type: i.type, status: i.status,
      summary: i.summary, moves_money: false, requires_present_user: i.type === 'approval', ...(i.questions ? { questions: i.questions } : {}),
      ...(i.browser ? { browser: i.browser } : {}), details: i.details ?? {}, outcome: null, created_at: this.o.now().toISOString(), expires_at: null, resolved_at: null,
    };
  }

  private routes(): void {
    const app = this.app;
    const fail = (reply: FastifyReply, status: number, code: string) => reply.code(status).send({ error: { type: 'invalid_request', code, message: code } });
    const isAdmin = (req: FastifyRequest) => req.headers.authorization === `Bearer ${this.o.adminKey}`;
    const param = (req: FastifyRequest) => (req.params as { id: string }).id;
    const idempotent = (req: FastifyRequest, reply: FastifyReply, status: number, make: () => unknown) => {
      const key = req.headers['idempotency-key'];
      const k = typeof key === 'string' ? `${req.url}|${key}` : null;
      const stored = k ? this.idem.get(k) : undefined;
      if (stored) return reply.code(stored.status).header('idempotent-replayed', 'true').send(stored.body);
      const body = make();
      if (k) this.idem.set(k, { status, body });
      return reply.code(status).send(body);
    };

    app.addHook('onRequest', async (req, reply) => {
      const key = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
      if (!key || (!this.o.keys.includes(key) && key !== this.o.adminKey)) {
        return reply.code(401).send({ error: { type: 'authentication', code: 'invalid_api_key', message: 'That key is not valid.' } });
      }
      return undefined;
    });
    app.addHook('preHandler', async (req, reply) => {
      const u = new URL(req.url, 'http://fake');
      const header = (name: string) => {
        const v = req.headers[name];
        return typeof v === 'string' ? v : undefined;
      };
      this.calls.push({
        method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body: req.body ?? null,
        headers: { authorization: header('authorization'), 'idempotency-key': header('idempotency-key'), 'last-event-id': header('last-event-id') },
      });
      if (this.failNextPost && req.method === 'POST' && this.failNextPost.path.test(u.pathname)) {
        const f = this.failNextPost;
        this.failNextPost = null;
        return reply.code(f.status).send({ error: { type: 'invalid_request', code: f.code, message: f.code } });
      }
      return undefined;
    });

    app.post('/v1/users', async (req, reply) => {
      if (!isAdmin(req)) return fail(reply, 403, 'scope_missing');
      const b = req.body as { user_id: string };
      if (!this.users.has(b.user_id)) this.users.set(b.user_id, { default_deployment: null });
      return reply.code(200).send({ id: b.user_id, object: 'user', status: 'active', default_deployment: this.users.get(b.user_id)!.default_deployment, memory_mode: 'none' });
    });
    app.patch('/v1/users/:id', async (req, reply) => {
      if (!isAdmin(req)) return fail(reply, 403, 'scope_missing');
      const u = this.users.get(param(req));
      if (!u) return fail(reply, 404, 'user_not_found');
      const b = req.body as { default_deployment?: string | null };
      if (b.default_deployment !== undefined) u.default_deployment = b.default_deployment;
      return { id: param(req), object: 'user', status: 'active', default_deployment: u.default_deployment };
    });
    app.post('/v1/users/:id/warm', async (req, reply) => {
      if (!this.users.has(param(req))) return fail(reply, 404, 'user_not_found');
      return reply.code(this.warmStatus === 'ready' ? 200 : 202).send({ user_id: param(req), status: this.warmStatus });
    });
    // A browser fetch whose page answers each page_fetch step at once, as a new computer's prime asks it (runners.ts).
    app.post('/v1/users/:id/browser/fetch', async (req, reply) => {
      if (!this.users.has(param(req))) return fail(reply, 404, 'user_not_found');
      const b = (req.body ?? {}) as { url?: string; capture?: Array<{ required?: boolean }>; steps?: Array<{ op?: string; capture_as?: string }> };
      // Bash's own rule (BrowserFetchBody): at least one capture required, or a page_fetch step; else 400 before anything opens.
      if (!(b.capture ?? []).some((c) => c.required !== false) && !(b.steps ?? []).some((s) => s.op === 'page_fetch')) {
        return fail(reply, 400, 'invalid_request');
      }
      const captures = (b.steps ?? []).filter((s) => s.op === 'page_fetch').map((s) => ({
        match: s.capture_as, url: b.url ?? '', status: 200, content_type: 'text/html', body: '', truncated: false, at_ms: 1,
      }));
      return { final_url: b.url ?? null, elapsed_ms: 1, woke: false, captures };
    });
    app.put('/v1/secrets/:name', async (req) => {
      const name = (req.params as { name: string }).name;
      const b = req.body as { user_id?: string; value: string };
      this.secrets.set(`${b.user_id ?? ''}/${name}`, b.value);
      return { object: 'secret', name, user_id: b.user_id ?? null, mode: 'test' };
    });
    app.post('/v1/mcp-servers/:id/check', async (req) => {
      const b = (req.body ?? {}) as { user_id?: string };
      const ok = this.checkOk ?? this.secrets.has(`${b.user_id ?? ''}/TRIP_TOKEN`);
      return ok ? { object: 'mcp_check', ok: true, tools: ['trip', 'person', 'recall', 'note'] } : { object: 'mcp_check', ok: false, tools: [], reason: 'missing_secret', missing: ['TRIP_TOKEN'] };
    });

    app.post('/v1/conversations', async (req, reply) =>
      idempotent(req, reply, 201, () => {
        const b = req.body as { user_id: string; deployment?: string };
        if (!this.users.has(b.user_id)) this.users.set(b.user_id, { default_deployment: null });
        const id = this.next('conv');
        this.conversations.set(id, { id, userId: b.user_id, deployment: b.deployment ?? null, events: [] });
        return this.conversationView(id);
      }),
    );
    app.post('/v1/conversations/:id/messages', async (req, reply) => {
      const id = param(req);
      if (!this.conversations.has(id)) return fail(reply, 404, 'conversation_not_found');
      return idempotent(req, reply, 202, () => {
        const b = req.body as { message: string; hand_off?: string };
        const turnId = this.next('turn');
        this.turns.set(turnId, { id: turnId, conversationId: id, status: 'working', data: null });
        if (b.hand_off === 'always') {
          if (this.autoStart) setImmediate(() => this.startTask(id, turnId, b.message.slice(0, 60)));
        } else {
          // More words for the conversation's work: they wait in its inbox for its next run. With no work, Bash just replies.
          const work = [...this.tasks.values()].filter((t) => t.conversationId === id && t.status !== 'failed').at(-1);
          if (work) {
            work.inbox.push(turnId);
            if (work.status === 'done') work.status = 'queued';
          } else {
            setImmediate(() => this.settleTurns([turnId], 'completed', null, true));
          }
        }
        return {
          id: turnId, object: 'conversation.turn', conversation_id: id, status: 'running', reply: null, answer: null, data: null, outcome: null,
          work: [], tool_calls: [], error: null, created_at: this.o.now().toISOString(), finished_at: null,
        };
      });
    });
    app.get('/v1/conversations/:id', async (req, reply) => (this.conversations.has(param(req)) ? this.conversationView(param(req)) : fail(reply, 404, 'conversation_not_found')));
    app.get('/v1/conversations/:id/events', async (req, reply) => this.streamEvents(req, reply));
    app.post('/v1/conversations/:id/stop', async (req) => {
      const stopped = [...this.tasks.values()].filter((t) => t.conversationId === param(req) && (t.status === 'working' || t.status === 'waiting'));
      for (const t of stopped) this.stop(t);
      return { id: param(req), object: 'conversation.stop', stopped_work: stopped.map((t) => t.id) };
    });
    app.post('/v1/tasks/:id/stop', async (req, reply) => {
      const t = this.tasks.get(param(req));
      if (!t) return fail(reply, 404, 'task_not_found');
      this.stop(t);
      return { id: t.id, object: 'task', status: t.status };
    });
    app.get('/v1/tasks/:id', async (req, reply) => {
      const t = this.tasks.get(param(req));
      return t ? this.taskView(t) : fail(reply, 404, 'task_not_found');
    });
    app.get('/v1/tasks/:id/trace', async (req) => ({ object: 'task_trace', task_id: param(req), steps: this.traceSteps, turns: [], totals: {} }));
    app.get('/v1/interactions/:id', async (req, reply) => {
      const i = this.interactions.get(param(req));
      return i ? this.interactionView(i) : fail(reply, 404, 'interaction_not_found');
    });
    app.post('/v1/interactions/:id/answer', async (req, reply) => {
      const i = this.interactions.get(param(req));
      if (!i) return fail(reply, 404, 'interaction_not_found');
      if (i.status !== 'pending') return fail(reply, 409, 'interaction_already_settled');
      i.answer = req.body;
      i.status = 'resolved';
      const t = this.tasks.get(i.taskId);
      if (t && t.status === 'waiting') t.status = 'working';
      this.emit(i.conversationId, 'interaction.resolved', { interaction_id: i.id, type: i.type, task_id: i.taskId });
      return { id: i.id, object: 'interaction', type: i.type, status: 'resolved' };
    });
    app.post('/v1/interactions/:id/cancel', async (req, reply) => {
      const i = this.interactions.get(param(req));
      if (!i) return fail(reply, 404, 'interaction_not_found');
      if (i.status === 'pending') {
        i.status = 'cancelled';
        this.emit(i.conversationId, 'interaction.resolved', { interaction_id: i.id, type: i.type, task_id: i.taskId, outcome: 'cancelled' });
      }
      return this.interactionView(i);
    });
    app.post('/v1/sessions', async (req, reply) => {
      const b = req.body as { user_id: string; conversation_id?: string; screen?: string };
      if (b.screen === 'control' && !this.controlAvailable) return fail(reply, 409, 'screen_control_unavailable');
      const id = this.next('ses');
      return reply.code(201).send({
        id, object: 'session', user_id: b.user_id, conversation_id: b.conversation_id ?? null, chat: false, screen: b.screen ?? false, voice: false, memory: false,
        token: `tok_${id}`, url: `https://web.vestra.test/embed/browser?s=${id}#token=tok_${id}`, frame_ancestors: [],
        expires_at: new Date(this.o.now().getTime() + 15 * 60_000).toISOString(),
      });
    });
    app.get('/v1/users/:id/screenshot', async (_req, reply) => {
      if (this.screenRefusal) return fail(reply, 409, this.screenRefusal);
      if (!this.screen) return fail(reply, 409, 'browser_not_open');
      return reply.header('content-type', 'image/jpeg').header('cache-control', 'no-store').send(this.screen);
    });
    app.get('/v1/events', async (req, reply) => {
      const q = req.query as { after?: string; type?: string; user_id?: string; created_after?: string; limit?: string };
      const limit = Number(q.limit ?? 20);
      const list = this.platformEvents.filter((e) => (!q.type || e.type === q.type) && (!q.user_id || e.user_id === q.user_id) && (!q.created_after || e.created_at >= q.created_after));
      if (q.after) {
        const at = list.findIndex((e) => e.id === q.after);
        if (at === -1) return fail(reply, 404, 'event_not_found');
        return { data: list.slice(at + 1, at + 1 + limit), next_cursor: null };
      }
      return { data: [...list].reverse().slice(0, limit), next_cursor: null };
    });
  }

  private async streamEvents(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const id = (req.params as { id: string }).id;
    const conv = this.conversations.get(id);
    if (!conv) return reply.code(404).send({ error: { code: 'conversation_not_found', message: 'no such conversation' } });
    if (this.failNextStream) {
      const f = this.failNextStream;
      this.failNextStream = null;
      return reply.code(f.status).send({ error: { code: f.code, message: f.code } });
    }
    const q = req.query as { after?: string; format?: string; limit?: string };
    const header = req.headers['last-event-id'];
    const after = typeof header === 'string' ? Number(header) : Number(q.after ?? conv.events.length);
    if (!Number.isInteger(after) || after < 0 || after > conv.events.length) {
      return reply.code(410).send({ error: { code: 'stream_expired', message: 'Read the conversation and follow from last_event_seq.' } });
    }
    if (q.format === 'json') {
      const data = conv.events.filter((e) => e.seq > after).slice(0, Number(q.limit ?? 100));
      return { data, next_after: data.at(-1)?.seq ?? after };
    }
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    this.liveStreams.add(raw);
    raw.on('close', () => this.liveStreams.delete(raw));
    const drop = this.dropAfterFrames;
    this.dropAfterFrames = null;
    let written = 0;
    let cutting = false;
    const write = (e: FakeEvent): boolean => {
      if (raw.destroyed || cutting) return false;
      const frame = `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
      written += 1;
      if (drop !== null && written >= drop) {
        // Cut once this frame is on the wire: destroying at once would drop the headers and the frame with it.
        cutting = true;
        raw.write(frame, () => raw.destroy());
        return false;
      }
      raw.write(frame);
      return true;
    };
    for (const e of conv.events.filter((x) => x.seq > after)) if (!write(e)) return undefined;
    const set = this.listeners.get(id) ?? new Set<(e: FakeEvent) => void>();
    const listener = (e: FakeEvent) => {
      write(e);
    };
    set.add(listener);
    this.listeners.set(id, set);
    raw.on('close', () => set.delete(listener));
    return undefined;
  }
}
