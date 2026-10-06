import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PAGE_HTML } from '../dev-room/page.js';
import { serveDevRoom, type DevRoom } from '../dev-room/serve.js';
import { FakeServer } from '../fake-server.js';
import { goaFreshTrip } from '../goa.js';
import { startTestGo, type TestGo } from './helpers/test-go.js';

const secret = 'sim-test-secret-0123456789abcdef';
const KINDS = ['vote', 'mandate', 'ticket', 'expense', 'settle_up', 'day', 'plan', 'budget', 'options', 'working', 'call', 'pay', 'notice'];
let go: TestGo | undefined;
let fake: FakeServer | undefined;
let room: DevRoom | undefined;
const clients: WebSocket[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.terminate();
  await room?.close();
  fake?.stop();
  await go?.close();
  room = undefined;
  fake = undefined;
  go = undefined;
});

async function setUp() {
  go = await startTestGo(secret);
  fake = new FakeServer({ goUrl: go.url, secret });
  await fake.start(3000);
  await fake.createTrip(goaFreshTrip());
  room = await serveDevRoom({ fake, port: 0 });
  return { go, fake, room };
}

/** Opens the page's live socket and collects what it receives. */
async function live(url: string) {
  const ws = new WebSocket(`${url.replace('http', 'ws')}live`);
  clients.push(ws);
  const got: any[] = [];
  ws.on('message', (d) => got.push(JSON.parse(d.toString())));
  await once(ws, 'open');
  return { ws, got };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('the dev room page', () => {
  it('is one self-contained page with no em dashes, a script that parses, and every card kind', async () => {
    const { room: r } = await setUp();
    const res = await fetch(r.url);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toBe(PAGE_HTML);
    expect(html).toContain('<title>Go dev room</title>');
    expect(html).not.toContain('\u2014');
    expect(html).not.toMatch(/<script[^>]+src=/);
    const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.indexOf('</script>'));
    expect(() => new Function(script)).not.toThrow();
    for (const kind of KINDS) expect(script).toContain(`${kind}: function`);
    expect((await fetch(`${r.url}nope`)).status).toBe(404);
  });

  it('is laid out for a phone: one 430 px column, a sticky message box, 44 px tap targets, no zoom on focus', () => {
    expect(PAGE_HTML).toContain('viewport-fit=cover');
    expect(PAGE_HTML).toContain('--column: 430px');
    expect(PAGE_HTML).toMatch(/footer \{ position: sticky; bottom: 0;/);
    expect(PAGE_HTML).toContain('min-height: 44px');
    expect(PAGE_HTML).toMatch(/input\[type=text\] \{[^}]*font-size: 16px/);
    expect(PAGE_HTML).toContain('<div class="app">');
  });

  it('has "Forget me in this trip" for whoever is "me", as on the App\'s You screen, and shows its toast', () => {
    expect(PAGE_HTML).toContain('data-forget="\' + esc(me) + \'">Forget me in this trip</button>');
    expect(PAGE_HTML).toContain("send({ type: 'forget', personId: d.forget })");
    expect(PAGE_HTML).toContain("data.type === 'forget_result'");
  });
});

describe('the live socket', () => {
  it("sends the room's state on connect: the trip, the people and each person's needs", async () => {
    const { room: r } = await setUp();
    const { got } = await live(r.url);
    await until(() => got.length > 0);
    expect(got[0]).toMatchObject({ type: 'state', connected: true, trip: { trip_id: 't_goa' }, typing: false, messages: [] });
    expect(Object.keys(got[0].needs).sort()).toEqual(['p_arjun', 'p_kabir', 'p_meher', 'p_priya', 'p_rahul']);
  });

  it('turns what people do on the page into the room, and pushes the new state', async () => {
    const { go: g, fake: f, room: r } = await setUp();
    const { ws, got } = await live(r.url);
    ws.send(JSON.stringify({ type: 'say', personId: 'p_priya', text: '@Go flights?' }));
    await until(() => g.events.some((e) => e.type === 'message.created'));
    expect(g.events.at(-1)).toMatchObject({ type: 'message.created', data: { message: { mentions_go: true } } });
    expect(f.messages()).toHaveLength(1);
    await until(() => got.some((s) => s.type === 'state' && s.messages.length === 1));
    const opened = (await g.call('open_vote', { request_id: 'rq_o', trip_id: 't_goa', question: 'Where?', kind: 'choice', anonymous: false, options: [{ label: 'A' }, { label: 'B' }] })).result;
    ws.send(JSON.stringify({ type: 'vote', decisionId: opened.decision_id, personId: 'p_arjun', optionIndex: 1 }));
    await until(() => f.trip().decisions[0]?.voted === 1);
    ws.send(JSON.stringify({ type: 'react', personId: 'p_meher', messageId: f.messages()[0]!.message_id, emoji: '👍' }));
    await until(() => f.messages()[0]!.reactions.length === 1);
  });

  it("sends a tap to Go and hands Go's answer back to the page", async () => {
    const { go: g, room: r } = await setUp();
    const { ws, got } = await live(r.url);
    await g.call('post_message', {
      request_id: 'rq_card', trip_id: 't_goa',
      card: { card_id: 'c_w', kind: 'working', fallback_text: 'Working', task_id: 'task_1', title: 'Finding villas', state: 'running', steps: [], updated_at: '2026-10-05T07:00:00Z', actions: [{ action_id: 'watch', label: 'Watch', style: 'primary' }] },
    });
    ws.send(JSON.stringify({ type: 'tap', cardId: 'c_w', actionId: 'watch', personId: 'p_arjun' }));
    await until(() => got.some((m) => m.type === 'tap_result'));
    expect(got.find((m) => m.type === 'tap_result').result).toEqual({ result: 'done', toast: 'Noted.' });
    expect(g.taps[0]).toMatchObject({ card_id: 'c_w', action_id: 'watch', person_id: 'p_arjun' });
  });

  it('"Forget me in this trip": forget_person to Go first, then the join answers cleared, and the toast says nothing is left', async () => {
    const { go: g, fake: f, room: r } = await setUp();
    const { ws, got } = await live(r.url);
    ws.send(JSON.stringify({ type: 'forget', personId: 'p_meher' }));
    await until(() => got.some((m) => m.type === 'forget_result'));
    expect(got.find((m) => m.type === 'forget_result')).toEqual({ type: 'forget_result', personId: 'p_meher', toast: 'Done. Nothing about Meher is left.' });
    expect(g.forgets).toEqual([{ person_id: 'p_meher', trip_id: 't_goa' }]);
    // The Server's half, after Go answered: her join answers are gone, and Go hears it as person.updated.
    expect(f.trip().people.find((p) => p.person_id === 'p_meher')).toMatchObject({ from_city: null, know: [] });
    const order = g.frames
      .filter((x) => x.method === 'forget_person' || (x.method === 'send_event' && x.params.type === 'person.updated'))
      .map((x) => x.method);
    expect(order).toEqual(['forget_person', 'send_event']);
    expect(g.events.at(-1)).toMatchObject({ type: 'person.updated', data: { person: { person_id: 'p_meher', from_city: null, know: [] }, changed: ['from_city', 'know'] } });
    // Nothing is said in the room: the toast is only for the person who tapped.
    expect(f.messages()).toEqual([]);
  });

  for (const [why, answer] of [['Go fails', 'fail'], ['Go says something is left', { deleted_facts: 1, remaining_facts: 1 }]] as const) {
    it(`never says "Done" when ${why}, and keeps the join answers`, async () => {
      const { go: g, fake: f, room: r } = await setUp();
      g.forget = answer;
      const { ws, got } = await live(r.url);
      ws.send(JSON.stringify({ type: 'forget', personId: 'p_meher' }));
      await until(() => got.some((m) => m.type === 'forget_result'));
      expect(got.find((m) => m.type === 'forget_result').toast).toBe("Go couldn't forget you just now. Try again.");
      expect(f.trip().people.find((p) => p.person_id === 'p_meher')).toMatchObject({ from_city: 'Mumbai', know: ['Birthday on 7 Nov'] });
      expect(g.events.some((e) => e.type === 'person.updated')).toBe(false);
    });
  }

  it('shrugs off junk, and tells the page when an action is refused', async () => {
    const { fake: f, room: r } = await setUp();
    const { ws, got } = await live(r.url);
    ws.send('not json');
    ws.send(JSON.stringify({ type: 'dance' }));
    ws.send(JSON.stringify({ type: 'say', personId: 'p_stranger', text: 'hi' }));
    await until(() => got.some((m) => m.type === 'error'));
    expect(got.find((m) => m.type === 'error').message).toContain('p_stranger');
    ws.send(JSON.stringify({ type: 'forget', personId: 'p_stranger' }));
    await until(() => got.filter((m) => m.type === 'error').length === 2);
    expect(got.filter((m) => m.type === 'error')[1].message).toContain('p_stranger');
    expect(got.some((m) => m.type === 'forget_result')).toBe(false);
    ws.send(JSON.stringify({ type: 'say', personId: 'p_rahul', text: 'still here' }));
    await until(() => f.messages().some((m) => m.text === 'still here'));
  });
});
