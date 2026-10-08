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

/**
 * Runs the page's own script against a small stand-in for a browser: the chat's scroll box (Go Live's column, or the page
 * itself), its height, scroll events, pictures that load, and the socket. The test sets the chat's height to what the
 * browser would lay out, then sends the page a state.
 */
function pageInBrowser(html: string, o: { column: boolean }) {
  const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html)![1]!;
  const view = { height: 600, content: 1000 };
  const clamp = (top: number) => Math.max(0, Math.min(top, view.content - view.height));
  let colTop = 0;
  let winTop = 0;
  const col = {
    clientHeight: view.height,
    get scrollHeight() { return view.content; },
    get scrollTop() { return colTop; },
    set scrollTop(v: number) { colTop = clamp(v); },
  };
  const elements = new Map<string, any>();
  const el = (id: string) => {
    if (!elements.has(id)) {
      const listeners: Record<string, Array<(e: unknown) => void>> = {};
      elements.set(id, {
        id, innerHTML: '', textContent: '', value: '', dataset: {}, hidden: id === 'newpill', listeners,
        addEventListener: (type: string, fn: (e: unknown) => void) => { (listeners[type] ??= []).push(fn); },
        focus: () => {},
        contains: (x: { inRoom?: boolean }) => x.inRoom === true,
      });
    }
    return elements.get(id);
  };
  const docListeners: Record<string, Array<(e: unknown) => void>> = {};
  const scrolling = { get scrollHeight() { return view.content; } };
  const document = {
    getElementById: el,
    querySelector: (q: string) => (q === '.split .app' && o.column ? col : null),
    addEventListener: (type: string, fn: (e: unknown) => void) => { (docListeners[type] ??= []).push(fn); },
    body: { getAttribute: () => '1' },
    scrollingElement: scrolling,
    documentElement: scrolling,
  };
  const window = {
    innerHeight: view.height,
    get scrollY() { return winTop; },
    scrollTo: (_x: number, y: number) => { winTop = clamp(y); },
    open: () => {},
  };
  const sockets: any[] = [];
  class StubSocket { onmessage: ((ev: { data: string }) => void) | null = null; constructor() { sockets.push(this); } send() {} }
  const run = new Function('document', 'window', 'localStorage', 'WebSocket', 'location', 'getComputedStyle', 'setInterval', script);
  run(document, window, { getItem: () => null, setItem: () => {} }, StubSocket, { protocol: 'http:', host: 'room.test', reload: () => {} },
    (x: unknown) => ({ overflowY: x === col ? 'auto' : 'visible' }), () => 0);
  const trip = goaFreshTrip();
  const message = (n: number, text: string) => ({
    message_id: `m_${n}`, seq: n + 1, updated_seq: n + 1, author: { kind: 'person', person_id: 'p_priya' }, text, attachments: [],
    mentions_go: false, mentions: [], reactions: [], withheld: false, deleted: false, sent_at: '2026-10-08T10:00:00Z',
  });
  return {
    view,
    /** Where the reader is: the top of what they see. */
    top: () => (o.column ? colTop : winTop),
    bottom: () => view.content - view.height,
    pill: () => el('newpill'),
    /** The page gets the room's state with these messages, laid out at `content` px tall. */
    state(texts: string[], content: number, needs: Record<string, unknown[]> = {}) {
      view.content = content;
      sockets[0].onmessage({ data: JSON.stringify({ type: 'state', connected: true, trip, messages: texts.map((t, i) => message(i, t)), typing: false, needs, about: [], limit: null }) });
    },
    /** The page gets the room's state with these messages as they are, cards included. */
    messages(list: object[], content: number) {
      view.content = content;
      sockets[0].onmessage({ data: JSON.stringify({ type: 'state', connected: true, trip, messages: list, typing: false, needs: {}, about: [], limit: null }) });
    },
    /** What the page drew in the room. */
    room: (): string => el('room').innerHTML,
    /** The reader scrolls to `top`; the browser sends a scroll event. */
    scroll(top: number) {
      if (o.column) colTop = clamp(top);
      else winTop = clamp(top);
      for (const fn of docListeners.scroll ?? []) fn({ target: o.column ? col : document });
    },
    /** A picture in the room finishes loading, and the room is `content` px tall now. */
    pictureLoads(content: number) {
      view.content = content;
      for (const fn of docListeners.load ?? []) fn({ target: { tagName: 'IMG', inRoom: true } });
    },
    tapPill() {
      for (const fn of el('newpill').listeners.click ?? []) fn({});
    },
  };
}

describe('the chat stays at the bottom', () => {
  for (const column of [true, false]) {
    const where = column ? "in Go Live's column" : 'on a page that scrolls';
    it(`keeps a reader at the bottom ${where} when a card above grows and a reply arrives`, () => {
      const p = pageInBrowser(PAGE_HTML, { column });
      p.state(['Goa?', 'yes!'], 1000);
      expect(p.top()).toBe(p.bottom());
      // The vote card above grows (people voting, then "Saudades won"), and the needs box changes, before the reply.
      p.state(['Goa?', 'yes!'], 1240, { p_rahul: [{ text: 'Vote on the stay' }] });
      expect(p.top()).toBe(p.bottom());
      p.state(['Goa?', 'yes!', 'Saudades won, 4 to 1'], 1400);
      expect(p.top()).toBe(800);
      expect(p.pill().hidden).toBe(true);
    });

    it(`keeps a reader at the bottom ${where} when a picture loads after the render`, () => {
      const p = pageInBrowser(PAGE_HTML, { column });
      p.state(['Go, find villas'], 1000);
      // The live card is rebuilt on every render: its picture loads afterwards and makes the room 300 px taller.
      p.state(['Go, find villas', 'Working on it'], 1100);
      p.pictureLoads(1400);
      expect(p.top()).toBe(p.bottom());
      // The next render, a second later, still finds the reader at the bottom.
      p.state(['Go, find villas', 'Working on it', 'Three villas'], 1700);
      expect(p.top()).toBe(p.bottom());
    });

    it(`leaves a reader who scrolled up ${where} where they are, and says when a new message arrives`, () => {
      const p = pageInBrowser(PAGE_HTML, { column });
      p.state(['a', 'b', 'c'], 2000);
      p.scroll(300);
      // A render with nothing new (the 15 s clock, a card ticking) moves nothing and shows no pill.
      p.state(['a', 'b', 'c'], 2050);
      expect(p.top()).toBe(300);
      expect(p.pill().hidden).toBe(true);
      p.pictureLoads(2100);
      expect(p.top()).toBe(300);
      // A new message: still where they were, and the pill appears.
      p.state(['a', 'b', 'c', 'd'], 2300);
      expect(p.top()).toBe(300);
      expect(p.pill().hidden).toBe(false);
      // The pill takes them to the bottom and goes away; from there they follow the chat again.
      p.tapPill();
      expect(p.top()).toBe(p.bottom());
      expect(p.pill().hidden).toBe(true);
      p.state(['a', 'b', 'c', 'd', 'e'], 2500);
      expect(p.top()).toBe(p.bottom());
    });

    it(`hides the pill ${where} when the reader scrolls back down to the bottom themselves`, () => {
      const p = pageInBrowser(PAGE_HTML, { column });
      p.state(['a'], 1500);
      p.scroll(0);
      p.state(['a', 'b'], 1700);
      expect(p.pill().hidden).toBe(false);
      p.scroll(p.bottom() - 40); // near enough to the bottom
      expect(p.pill().hidden).toBe(true);
      p.state(['a', 'b', 'c'], 1900);
      expect(p.top()).toBe(p.bottom());
    });
  }

  it('has the pill in the page, hidden, above the message box, with no em dash', () => {
    expect(PAGE_HTML).toContain('<button class="newpill" id="newpill" type="button" hidden>New messages ↓</button>');
    expect(PAGE_HTML).toContain('.newpill[hidden] { display: none; }');
    expect(PAGE_HTML).not.toContain('—');
  });
});

describe("Go's live search card", () => {
  const shot = 'https://brain.go.example/live/shot_1.jpg';
  /** Go's message with its working card: a finished hotels search, its picture, and the page in it. */
  const searchCard = (page_url: string | null) => ({
    message_id: 'm_go_1', seq: 5, updated_seq: 5, author: { kind: 'go' }, text: 'Here are the villas I found.', attachments: [],
    mentions_go: false, mentions: [], reactions: [], withheld: false, deleted: false, sent_at: '2026-10-08T10:00:00Z',
    card: {
      kind: 'working', card_id: 'c_live_1', fallback_text: 'Searching hotels in Goa', task_id: 'task_1', title: 'Villas with a pool in North Goa',
      state: 'done', steps: [{ text: 'Open ixigo hotels', state: 'done' }, { text: 'Read the results', state: 'done' }],
      screenshot_url: shot, page_url, updated_at: '2026-10-08T10:00:00Z', actions: [],
    },
  });

  it('shows no page address as text, only the picture, the steps and a "See on ixigo" button', () => {
    const p = pageInBrowser(PAGE_HTML, { column: false });
    const url = 'https://www.ixigo.com/hotels/search/result?locationId=32&locationName=Goa&checkinDate=06112026&filters=FL_HF_29%2CMP';
    p.messages([searchCard(url)], 1200);
    const html = p.room();
    const href = url.replace(/&/g, '&amp;');
    expect(html).toContain(`<a class="act secondary" href="${href}" target="_blank" rel="noopener noreferrer">See on ixigo</a>`);
    // The address is only ever the button's href: never between tags, where a person would read it.
    expect(html.split(href)).toHaveLength(2);
    expect(html).not.toMatch(/>[^<]*(https?:|ixigo\.com\/hotels)/);
    expect(html).toContain(`<img alt="" src="${shot}"`);
    expect(html).toContain('Read the results');
  });

  it('gives no button for a page that is not an ixigo.com page, and still shows no address', () => {
    for (const other of ['https://ixigo.com.example.net/hotels', 'https://example.com/ixigo/hotels', 'javascript:alert(1)', null]) {
      const p = pageInBrowser(PAGE_HTML, { column: false });
      p.messages([searchCard(other)], 1200);
      const html = p.room();
      expect(html).not.toContain('See on ixigo');
      if (other) expect(html).not.toContain(other);
      expect(html).toContain('Read the results');
    }
    // An ixigo subdomain or the bare domain is ixigo.
    for (const ixigo of ['https://ixigo.com/trains', 'https://www.ixigo.com/hotels/goa']) {
      const p = pageInBrowser(PAGE_HTML, { column: false });
      p.messages([searchCard(ixigo)], 1200);
      expect(p.room()).toContain('See on ixigo');
    }
  });
});
