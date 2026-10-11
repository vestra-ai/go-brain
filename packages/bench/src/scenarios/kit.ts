/**
 * Everything around Go for the demo test, in one place: every lane in LANES registered, and every outside thing faked.
 * The Server is P0's FakeServer; ixigo is P4's fake ixigo (TRAVEL_MODE=fake); /v1 is P4's FakeV1; the vault is P5's
 * whole test vault with a FakeRail and a software passkey; Twilio is a fake REST API that dials Go's media socket the
 * way Twilio does; the voice model is a scripted socket playing Go's call to the dive shop. No key and no network.
 */
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Brain, RegisterLane } from '@go/brain/dist/app.js';
import { registerCalls, startCalls } from '@go/brain/dist/calls/register.js';
import type { AnthropicLike } from '@go/brain/dist/composer/anthropic.js';
import { LANES } from '@go/brain/dist/main.js';
import { registerMoney, registerMoneyWith } from '@go/brain/dist/money/register.js';
import type { ReflexRead } from '@go/brain/dist/reflex/reflex.js';
import { createTasksLane, registerTasks } from '@go/brain/dist/tasks/register.js';
import { FakeV1 } from '@go/brain/dist/tasks/testing/fake-v1.js';
import { startRoom, type Room } from '@go/brain/dist/testing/start-room.js';
import { injectFetch, startTestVault, TEST_SHARED_SECRET, type TestAuthenticator, type TestVault } from '@go/vault/testing';
import WebSocket, { WebSocketServer } from 'ws';
import { addressesGo } from '../chat.js';
import { DEMO_DIVE_SHOP, DEMO_FACT_LINES, DEMO_PAYER } from './demo.js';

export const DEMO_ADMIN_TOKEN = 'demo-admin-token-for-ci-only';
/** The one number Go may call: the teammate who plays the dive shop. */
export const DEMO_CALLEE = { name: DEMO_DIVE_SHOP.name, phone: '+919800000001' } as const;
export const DEMO_PHOTO_URL = 'https://cdn.go.example/demo/beach.jpg';
/** What the scripted voice model reports, in Go's words, after the dive shop's answer (DEMO_DIVE_SHOP.answer). */
export const CALL_OUTCOME = `${DEMO_DIVE_SHOP.name} can take all five of us on Sunday at 8 am, ₹3,500 each with gear. Come by 7:45.`;
export const CALL_RECORD = `${DEMO_DIVE_SHOP.name}: Sunday 8 am for five, ₹3,500 each with gear, come by 7:45`;

const V1_KEYS = [`vk_test_${'d'.repeat(43)}`];
const V1_ADMIN = `vk_test_${'y'.repeat(43)}`;
const SILENCE = Buffer.alloc(160, 0xff).toString('base64'); // one 20 ms frame of mu-law silence

/** Go's environment for the demo: every lane on, every outside address a fake. */
export function demoEnv(v1Url: string): Record<string, string> {
  return {
    GO_PUBLIC_URL: 'https://go.test',
    ADMIN_TOKEN: DEMO_ADMIN_TOKEN,
    REFLEX_LIVE: 'off',
    TRAVEL_MODE: 'fake',
    VESTRA_API_URL: v1Url,
    VESTRA_API_KEYS: V1_KEYS.join(','),
    VESTRA_ADMIN_KEY: V1_ADMIN,
    VESTRA_WEBHOOK_SECRET: 'whsec_demo_0123456789abcdef',
    VESTRA_DEPLOYMENT_ID: 'dep_go',
    VESTRA_MCP_SERVER_ID: 'mcp_go',
    VAULT_URL: 'https://vault.test',
    VAULT_SHARED_SECRET: TEST_SHARED_SECRET,
    PAY_RAIL: 'fake',
    TWILIO_ACCOUNT_SID: 'AC_demo',
    TWILIO_AUTH_TOKEN: 'tok_demo',
    TWILIO_FROM: '+14155550100',
    OPENAI_API_KEY: 'sk-demo-not-real',
    CALLS_MODE: 'allowlist',
    CALLS_ALLOWLIST: `${DEMO_CALLEE.name}=${DEMO_CALLEE.phone}`,
  };
}

const UNSURE = { value: null, sure: false } as const;

/**
 * The reflex for the demo: a line that calls Go is for Go and complete (its turn is due at once); every other line is
 * sure chatter with nothing in it for Go (banter, and question 11 sure no), so it never wakes the model: the run sheet's
 * chatter beat is quiet. A line that holds a fact (DEMO_FACT_LINES) is read as Jev's Q5 and Q7
 * would on stage: sure of a fact and sure of a ✅, so P2's instant ✅ and its notes pass run for real. Jev itself is off
 * (REFLEX_LIVE=off).
 */
export const cueReflex: Brain['reflex'] = {
  async read(msg) {
    const holdsFact = DEMO_FACT_LINES.some((l) => l.text === msg.text);
    const toGo = addressesGo(msg.text ?? '');
    const read: ReflexRead = {
      forGo: { value: toGo, sure: true },
      banter: { value: !toGo, sure: true },
      actionable: { value: toGo, sure: true },
      complete: { value: true, sure: true },
      fact: holdsFact ? { value: true, sure: true } : UNSURE,
      reaction: holdsFact ? { value: '✅', sure: true } : UNSURE,
      size: UNSURE, taskId: UNSURE, recordKind: UNSURE, risky: UNSURE, opening: UNSURE,
    };
    return read;
  },
};

export interface FakeTwilio {
  /** Give it to startCalls as its fetch. */
  fetch: typeof fetch;
  /** Every call Go asked Twilio to place, with when it asked (ms since 1970). */
  calls: Array<{ sid: string; to: string; from: string; path: string; at: number }>;
  hangUps: string[];
  /** Where Go's media socket listens, once Go is up. */
  connectTo(goWsBase: string): void;
  closeAll(): void;
}

/** Twilio's REST API as P6's client calls it. On a new call it opens Go's media socket, as Twilio does. */
export function fakeTwilio(): FakeTwilio {
  let base: string | null = null;
  const calls: FakeTwilio['calls'] = [];
  const hangUps: string[] = [];
  const sockets = new Map<string, WebSocket>();
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const dialGo = (sid: string, path: string, token: string): void => {
    if (base === null) return;
    const ws = new WebSocket(`${base}${path}`);
    sockets.set(sid, ws);
    ws.on('open', () => {
      ws.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
      ws.send(JSON.stringify({ event: 'start', streamSid: `MZ_${sid}`, start: { streamSid: `MZ_${sid}`, callSid: sid, customParameters: { token } } }));
      ws.send(JSON.stringify({ event: 'media', streamSid: `MZ_${sid}`, media: { timestamp: '0', payload: SILENCE } }));
    });
    ws.on('message', (data) => {
      const f = JSON.parse(String(data)) as { event?: string; mark?: { name?: string } };
      // Twilio echoes a mark once the audio sent before it has played.
      if (f.event === 'mark' && f.mark?.name) ws.send(JSON.stringify({ event: 'mark', streamSid: `MZ_${sid}`, mark: { name: f.mark.name } }));
    });
    ws.on('error', () => undefined);
  };

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const form = new URLSearchParams(String(init?.body ?? ''));
    const hangUp = /\/Calls\/([A-Za-z0-9_]+)\.json$/.exec(url);
    if (hangUp?.[1]) {
      const sid = hangUp[1];
      hangUps.push(sid);
      sockets.get(sid)?.close();
      sockets.delete(sid);
      return json(200, { sid, status: 'completed' });
    }
    if (url.endsWith('/Calls.json')) {
      const twiml = form.get('Twiml') ?? '';
      const streamUrl = /<Stream url="([^"]+)"/.exec(twiml)?.[1] ?? '';
      const token = /name="token" value="([^"]+)"/.exec(twiml)?.[1] ?? '';
      const sid = `CA_demo_${calls.length + 1}`;
      const path = streamUrl ? new URL(streamUrl.replace(/&amp;/g, '&')).pathname : '';
      calls.push({ sid, to: form.get('To') ?? '', from: form.get('From') ?? '', path, at: Date.now() });
      setTimeout(() => dialGo(sid, path, token), 50);
      return json(201, { sid, status: 'queued' });
    }
    return json(404, { message: `the fake Twilio has no ${url}` });
  }) as typeof fetch;

  return {
    fetch: fetchImpl,
    calls,
    hangUps,
    connectTo(goWsBase) {
      base = goWsBase;
    },
    closeAll() {
      for (const ws of sockets.values()) ws.close();
      sockets.clear();
    },
  };
}

export interface FakeVoice {
  url: string;
  close(): Promise<void>;
}

/** A scripted voice model: Go greets, reports the outcome, says goodbye. It never sends a transcript of the business. */
export async function fakeVoice(): Promise<FakeVoice> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  server.on('connection', (ws) => {
    ws.on('message', (data) => {
      const ev = JSON.parse(String(data)) as { type?: string; item?: { type?: string } };
      if (ev.type === 'session.update') {
        ws.send(JSON.stringify({ type: 'response.output_audio_transcript.done', item_id: 'i1', transcript: 'Hi, this is Go, an AI assistant calling for a group of 5 friends travelling together.' }));
        ws.send(JSON.stringify({
          type: 'response.function_call_arguments.done', call_id: 'fc_1', name: 'report_outcome',
          arguments: JSON.stringify({ outcome: CALL_OUTCOME, answered: true, record: { kind: 'agreed', text: CALL_RECORD } }),
        }));
      }
      if (ev.type === 'conversation.item.create' && ev.item?.type === 'function_call_output') {
        ws.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_bye' } }));
        ws.send(JSON.stringify({ type: 'response.done', response: { id: 'resp_bye' } }));
      }
    });
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * LANES with the three lanes that reach outside swapped for the same lanes wired to the fakes, and the cue reflex
 * put in last (after P2's reflex lane has set its own).
 */
export function demoLanes(d: { vault: TestVault; twilio: FakeTwilio; voice: FakeVoice }): RegisterLane[] {
  const swap = (lane: RegisterLane): RegisterLane => {
    if (lane === registerTasks) {
      return async (brain) => {
        await createTasksLane(brain, { sweepEveryMs: 0, cardGapMs: 0, follower: { reconnectMs: [20, 50], screenMs: 60_000 } });
      };
    }
    if (lane === registerMoney) return registerMoneyWith({ fetch: d.vault.fetch, sweepEveryMs: 0 });
    if (lane === registerCalls) {
      return async (brain) => {
        await startCalls(brain, { fetch: d.twilio.fetch, openVoice: () => new WebSocket(d.voice.url) });
      };
    }
    return lane;
  };
  const useCueReflex: RegisterLane = (brain) => {
    brain.reflex = cueReflex;
  };
  return [...LANES.map(swap), useCueReflex];
}

export interface DemoRoom {
  /** Go, its database schema, and the FakeServer playing the Server and the five people. */
  room: Room;
  v1: FakeV1;
  vault: TestVault;
  twilio: FakeTwilio;
  voice: FakeVoice;
  /** The payer's software passkey, with the 4242 test card in the vault. */
  payer: TestAuthenticator;
  goUrl: string;
  stop(): Promise<void>;
}

/**
 * Runs this process's clock from `at`, as if the test started then, at the real pace. Go, the FakeServer, the trip's
 * computer, the vault and the test itself all read the same Date, so signatures, expiries and the transcript's times
 * agree with each other. Returns the undo.
 */
export function runClockFrom(at: string): () => void {
  const Real = Date;
  const offset = Real.parse(at) - Real.now();
  const now = (): number => Real.now() + offset;
  globalThis.Date = new Proxy(Real, {
    construct: (target, args, newTarget) => Reflect.construct(target, args.length === 0 ? [now()] : args, newTarget),
    apply: () => new Real(now()).toString(),
    get: (target, key, receiver) => (key === 'now' ? now : Reflect.get(target, key, receiver)),
  });
  return () => {
    globalThis.Date = Real;
  };
}

export async function startDemoRoom(o: { anthropic: AnthropicLike }): Promise<DemoRoom> {
  const v1 = new FakeV1({ keys: V1_KEYS, adminKey: V1_ADMIN, now: () => new Date() });
  await v1.start();
  const voice = await fakeVoice();
  const twilio = fakeTwilio();
  let goHttp: Brain['http'] | null = null;
  // The vault calls Go back in process (its paid callback), through Go's own Fastify.
  const goFetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (goHttp === null) throw new Error('Go is not up yet');
    return injectFetch(goHttp)(input, init);
  }) as typeof fetch;
  const vault = await startTestVault({ goFetch, now: () => new Date() });
  const room = await startRoom({ anthropic: o.anthropic, lanes: demoLanes({ vault, twilio, voice }), env: demoEnv(v1.url), instance: 'demo' });
  goHttp = room.built.brain.http;
  const address = room.built.brain.http.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  twilio.connectTo(`ws://127.0.0.1:${port}`);
  const payer = await vault.passkeyFor(DEMO_PAYER, { withCard: true });
  return {
    room, v1, vault, twilio, voice, payer,
    goUrl: `http://127.0.0.1:${port}`,
    async stop() {
      twilio.closeAll();
      await room.stop();
      await vault.close();
      await v1.close();
      await voice.close();
    },
  };
}
