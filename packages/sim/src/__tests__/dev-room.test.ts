import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PAGE_HTML, roomPage } from '../dev-room/page.js';
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
function pageInBrowser(html: string, o: { column: boolean; me?: string }) {
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
  /** An element: its markup counts how often it was rewritten (a rewritten frame loads its page again). */
  const stub = (id: string, attrs: Record<string, string> = {}): any => {
    const listeners: Record<string, Array<(e: unknown) => void>> = {};
    const inner = new Map<string, any>();
    let markup = '';
    return {
      id, textContent: '', value: '', className: '', dataset: {}, hidden: id === 'newpill', listeners, writes: 0,
      get innerHTML() { return markup; },
      set innerHTML(v: string) { markup = v; this.writes += 1; },
      getAttribute: (k: string) => attrs[k] ?? null,
      setAttribute: (k: string, v: string) => { attrs[k] = String(v); },
      hasAttribute: (k: string) => k in attrs,
      removeAttribute: (k: string) => { delete attrs[k]; },
      querySelector: (q: string) => { if (!inner.has(q)) inner.set(q, stub(`${id} ${q}`)); return inner.get(q); },
      querySelectorAll: () => [],
      addEventListener: (type: string, fn: (e: unknown) => void) => { (listeners[type] ??= []).push(fn); },
      focus: () => {},
      contains: (x: { inRoom?: boolean }) => x.inRoom === true,
    };
  };
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, stub(id));
    return elements.get(id);
  };
  // Go Live's column carries the origin of the one page it may frame.
  const watchOrigin = /<aside[^>]* data-watch-origin="([^"]*)"/.exec(html)?.[1];
  if (watchOrigin) elements.set('live', stub('live', { 'data-watch-origin': watchOrigin }));
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
  const opened: string[] = [];
  const window = {
    innerHeight: view.height,
    get scrollY() { return winTop; },
    scrollTo: (_x: number, y: number) => { winTop = clamp(y); },
    open: (url: string) => { opened.push(url); },
  };
  const sockets: any[] = [];
  const sent: any[] = [];
  class StubSocket {
    readyState = 1;
    onmessage: ((ev: { data: string }) => void) | null = null;
    constructor() { sockets.push(this); }
    send(data: string) { sent.push(JSON.parse(data)); }
  }
  const run = new Function('document', 'window', 'localStorage', 'WebSocket', 'location', 'getComputedStyle', 'setInterval', 'setTimeout', script);
  run(document, window, { getItem: () => o.me ?? null, setItem: () => {} }, StubSocket, { protocol: 'http:', host: 'room.test', reload: () => {} },
    (x: unknown) => ({ overflowY: x === col ? 'auto' : 'visible' }), () => 0, () => 0);
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
    el,
    /** What the page sent on its socket. */
    sent: () => sent,
    /** The pages it opened in a new window. */
    opened: () => opened,
    /** The room sends the page one message. */
    receive(data: object) {
      sockets[0].onmessage({ data: JSON.stringify(data) });
    },
    /** A tap on one of the page's own buttons, by its id. */
    click(id: string) {
      for (const fn of el(id).listeners.click ?? []) fn({});
    },
    /** A tap on a person at the top: the page is now that person. */
    play(personId: string) {
      for (const fn of docListeners.click ?? []) fn({ target: { closest: () => ({ dataset: { me: personId } }) } });
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

describe("Go Live's screen between runs", () => {
  const LIVE_PAGE = roomPage({ title: 'Try Go', hosted: true, live: true });
  const before = (ms: number) => new Date(Date.now() - ms).toISOString();
  /** The room relays one message of Go's live view of the trip. */
  const relay = (p: ReturnType<typeof pageInBrowser>, msg: object, tripId = 't_try_1') => p.receive({ type: 'live', trip_id: tripId, msg });
  const runStart = (id: string, at: string) => ({ type: 'run_start', run_id: id, recipe_id: 'ixigo.hotels.search', label: 'Stays in Goa', group_id: `g_${id}`, at, speed: 'page' });
  const runEnd = (id: string) => ({ type: 'run_end', run_id: id, ok: true, ms: 900, rows: 12 });
  const frame = (tab: string, jpeg: string, at: string, page = '/hotels/search/result') =>
    ({ type: 'frame', tab_id: tab, tag: 'run_1', at, page, width: 1280, height: 800, jpeg_base64: jpeg });
  const screen = (p: ReturnType<typeof pageInBrowser>) => p.el('screen');
  const picture = (p: ReturnType<typeof pageInBrowser>) => screen(p).querySelector('img').getAttribute('src');
  const label = (p: ReturnType<typeof pageInBrowser>) => screen(p).querySelector('.rest-label').textContent;

  it("shows one calm line in the screen's own space before the trip's first page, never an empty box", () => {
    expect(LIVE_PAGE).not.toMatch(/[\u2014\u2013]|claude/i);
    const p = pageInBrowser(LIVE_PAGE, { column: true });
    expect(screen(p).getAttribute('data-key')).toBe('calm');
    expect(screen(p).innerHTML).toBe('<div class="tile calm"><div class="view"><span class="hint"></span></div></div>');
    expect(screen(p).querySelector('.hint').textContent).toBe("Say something to start the trip. Go's searches on ixigo show here, live.");
    relay(p, { type: 'hello', events: [], screen: [] });
    expect(screen(p).querySelector('.hint').textContent).toBe('When Go searches ixigo for the trip, its pages show here, live.');
  });

  it('rests on the last page the computer drew, dimmed under a quiet label, and a run brings the screen back live', () => {
    const p = pageInBrowser(LIVE_PAGE, { column: true });
    // In late: a search that ended two minutes ago, its warm tab still open on the drawn list.
    relay(p, {
      type: 'hello', events: [runStart('run_1', before(130_000)), runEnd('run_1')],
      screen: [{ type: 'tab_open', tab_id: 'tab_1', tag: 'run_1' }, frame('tab_1', 'TElTVA==', before(125_000))],
    });
    expect(screen(p).getAttribute('data-key')).toBe('rest');
    expect(screen(p).innerHTML).toBe('<div class="tile rest"><div class="tile-bar"><span class="rest-label"></span></div><div class="view"><img alt=""></div></div>');
    expect(picture(p)).toBe('data:image/jpeg;base64,TElTVA==');
    expect(label(p)).toBe("Go's computer · ixigo hotels · 2 min ago");
    expect(p.el('live-state').textContent).toBe('Live');
    // A search starts: the same tab, at full brightness and LIVE.
    relay(p, { type: 'run', event: runStart('run_2', before(0)) });
    expect(screen(p).getAttribute('data-key')).toBe('tabs:tab_1');
    expect(screen(p).innerHTML).not.toContain('tile rest');
    expect(p.el('live-state').textContent).toBe('A page open, live');
    relay(p, { type: 'screen', event: frame('tab_1', 'TkVX', before(0)) });
    // Back in after a dropped socket, the search over and its tab closed: the screen rests on the newest page.
    relay(p, { type: 'hello', events: [runStart('run_1', before(130_000)), runEnd('run_1'), runStart('run_2', before(5_000)), runEnd('run_2')], screen: [] });
    expect(screen(p).getAttribute('data-key')).toBe('rest');
    expect(picture(p)).toBe('data:image/jpeg;base64,TkVX');
    expect(label(p)).toBe("Go's computer · ixigo hotels · just now");
  });

  it("rests on a run's own picture when no tab was left open, named from its page, and a new trip starts calm", () => {
    const p = pageInBrowser(LIVE_PAGE, { column: true });
    relay(p, {
      type: 'hello', screen: [],
      events: [
        runStart('run_1', before(185_000)),
        { type: 'frames', run_id: 'run_1', frames: [{ label: 'results', at_ms: 5_000, page: '/trains/search/result', jpeg_base64: 'VFJBSU4=' }] },
        runEnd('run_1'),
      ],
    });
    expect(picture(p)).toBe('data:image/jpeg;base64,VFJBSU4=');
    expect(label(p)).toBe("Go's computer · ixigo trains · 3 min ago");
    relay(p, { type: 'hello', events: [], screen: [] }, 't_try_2');
    expect(screen(p).getAttribute('data-key')).toBe('calm');
  });

  it('never rests on a page Go hides: a tab gone to a sign-in page keeps the page before it, and a tab hidden from the start shows none', () => {
    const p = pageInBrowser(LIVE_PAGE, { column: true });
    relay(p, {
      type: 'hello', events: [runStart('run_1', before(70_000)), runEnd('run_1')],
      screen: [
        { type: 'tab_open', tab_id: 'tab_1' }, frame('tab_1', 'SE9URUxT', before(65_000)),
        { type: 'hidden', tab_id: 'tab_1', reason: 'blocked_path' },
        // A picture of that tab after it was hidden is never shown.
        frame('tab_1', 'U0lHTklO', before(60_000)),
      ],
    });
    expect(picture(p)).toBe('data:image/jpeg;base64,SE9URUxT');
    expect(label(p)).toBe("Go's computer · ixigo hotels · 1 min ago");
    const q = pageInBrowser(LIVE_PAGE, { column: true });
    relay(q, { type: 'hello', events: [], screen: [{ type: 'tab_open', tab_id: 'tab_9' }, { type: 'hidden', tab_id: 'tab_9', reason: 'blocked_path' }] });
    expect(screen(q).getAttribute('data-key')).toBe('calm');
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
