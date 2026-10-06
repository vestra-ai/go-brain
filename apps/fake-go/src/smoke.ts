// The end-to-end check of a deployed fake Go, from the Server's side of the socket. It checks health, opens the
// socket with a fresh signature, creates a Goa trip (with a new trip_id each run), says "@Go hello" as Rahul,
// prints every frame both ways, and checks that Go sent typing, read_trip, add_reaction and post_message.
import { randomUUID } from 'node:crypto';
import { Health, PostMessage, SOCKET_PATH } from '@go/contract';
import { GoSocket, goaFreshTrip, type Handler } from '@go/sim';

export interface SmokeOptions {
  /** Go's https base URL, with no path. */
  goUrl: string;
  secret: string;
  instance?: string;
  print?: (line: string) => void;
  timeoutMs?: number;
}

export interface SmokeReport {
  ok: boolean;
  /** Go's requests in the order they arrived, with typing as "typing on" and "typing off". */
  goRequests: string[];
  problems: string[];
}

const EXPECTED = ['typing on', 'read_trip', 'add_reaction', 'post_message', 'typing off'];

function waitUntil(check: () => boolean, ms: number, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (check()) return resolve();
      if (Date.now() - started > ms) return reject(new Error(message));
      setTimeout(tick, 50);
    };
    tick();
  });
}

export async function runSmoke(o: SmokeOptions): Promise<SmokeReport> {
  const print = o.print ?? ((line: string) => console.log(line));
  const timeoutMs = o.timeoutMs ?? 15_000;
  const base = o.goUrl.replace(/\/+$/, '');
  const problems: string[] = [];
  const goRequests: string[] = [];

  try {
    const res = await fetch(`${base}/v1/health`);
    const body: unknown = await res.json();
    print(`health: ${res.status} ${JSON.stringify(body)}`);
    const health = Health.safeParse(body);
    if (!health.success || !health.data.contract.startsWith('1.')) problems.push(`health answered ${JSON.stringify(body)}`);
  } catch (err) {
    problems.push(`health failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const run = randomUUID().slice(0, 8);
  const trip = { ...goaFreshTrip(), trip_id: `t_smoke_${run}` };
  let seq = 1;
  const handlers: Record<string, Handler> = {
    read_trip: async () => {
      goRequests.push('read_trip');
      return { ...trip, seq };
    },
    read_messages: async () => {
      goRequests.push('read_messages');
      return { messages: [], has_more: false };
    },
    add_reaction: async () => {
      goRequests.push('add_reaction');
      seq += 1;
      return { seq };
    },
    post_message: async (_p, raw) => {
      goRequests.push('post_message');
      if (!PostMessage.safeParse(raw).success) problems.push('post_message did not pass the contract');
      seq += 1;
      return { message_id: `m_smoke_${run}_${seq}`, seq };
    },
    typing: async (p: { on: boolean }) => {
      goRequests.push(p.on ? 'typing on' : 'typing off');
    },
  };

  let open = false;
  const sock = new GoSocket({
    url: `${base.replace(/^http/, 'ws')}${SOCKET_PATH}?instance=${encodeURIComponent(o.instance ?? 'smoke')}`,
    secret: o.secret,
    handlers,
    backoffSeconds: [2],
    onOpen: () => {
      open = true;
      print('socket open');
    },
    onError: (err) => print(`socket error: ${err.message}`),
    onFrame: (direction, text) => print(`${direction === 'out' ? 'Server -> Go' : 'Go -> Server'} ${text}`),
  });
  sock.start();
  try {
    await waitUntil(() => open, timeoutMs, 'the socket did not open: check GO_URL and GO_SIGNING_SECRET');
    const at = new Date().toISOString();
    const created = await sock.request('send_event', {
      event_id: `ev_smoke_${run}_1`, trip_id: trip.trip_id, seq: 1, occurred_at: at, type: 'trip.created', data: { trip },
    });
    if (created.accepted !== true) problems.push(`trip.created answered ${JSON.stringify(created)}`);
    seq = 2;
    const hello = {
      message_id: `m_smoke_${run}`, seq: 2, updated_seq: 2, author: { kind: 'person', person_id: 'p_rahul' }, text: '@Go hello',
      attachments: [], mentions_go: true, mentions: [], reactions: [], withheld: false, deleted: false, sent_at: at,
    };
    const said = await sock.request('send_event', {
      event_id: `ev_smoke_${run}_2`, trip_id: trip.trip_id, seq: 2, occurred_at: at, type: 'message.created', data: { message: hello },
    });
    if (said.accepted !== true) problems.push(`message.created answered ${JSON.stringify(said)}`);
    await waitUntil(() => goRequests.includes('post_message') && goRequests.includes('typing off'), timeoutMs, 'Go did not answer "@Go hello" in time');
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  } finally {
    sock.close();
  }
  for (const want of EXPECTED) if (!goRequests.includes(want)) problems.push(`Go never sent ${want}`);
  return { ok: problems.length === 0, goRequests, problems };
}
