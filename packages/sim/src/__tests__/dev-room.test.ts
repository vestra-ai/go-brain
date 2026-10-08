import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('is laid out like the App: one 600 px column in the middle, a sticky message box, 44 px tap targets, no zoom on focus', () => {
    expect(PAGE_HTML).toContain('viewport-fit=cover');
    expect(PAGE_HTML).toContain('--column: 600px');
    expect(PAGE_HTML).toMatch(/\.app \{ max-width: var\(--column\); margin: 0 auto;/);
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
 * Runs the page's own script against a small stand-in for a browser: the page's scroll, its height, scroll events,
 * pictures that load, and the socket. The test sets the page's height to what the browser would lay out, then sends the
 * page a state.
 */
function pageInBrowser(html: string, o: { me?: string } = {}) {
  const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html)![1]!;
  const view = { height: 600, content: 1000 };
  const clamp = (top: number) => Math.max(0, Math.min(top, view.content - view.height));
  let winTop = 0;
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
  // The sheet carries the origin of the one page it may frame.
  const watchOrigin = /<div class="sheet"[^>]* data-watch-origin="([^"]*)"/.exec(html)?.[1];
  if (watchOrigin) elements.set('sheet', stub('sheet', { 'data-watch-origin': watchOrigin }));
  const docListeners: Record<string, Array<(e: unknown) => void>> = {};
  const scrolling = { get scrollHeight() { return view.content; } };
  const document = {
    getElementById: el,
    addEventListener: (type: string, fn: (e: unknown) => void) => { (docListeners[type] ??= []).push(fn); },
    body: { getAttribute: () => '1', className: '' },
    scrollingElement: scrolling,
    documentElement: scrolling,
  };
  const opened: string[] = [];
  const winListeners: Record<string, Array<(e: unknown) => void>> = {};
  const window = {
    innerHeight: view.height,
    get scrollY() { return winTop; },
    scrollTo: (_x: number, y: number) => { winTop = clamp(y); },
    open: (url: string) => { opened.push(url); },
    addEventListener: (type: string, fn: (e: unknown) => void) => { (winListeners[type] ??= []).push(fn); },
  };
  const sockets: any[] = [];
  const sent: any[] = [];
  class StubSocket {
    readyState = 1;
    onmessage: ((ev: { data: string }) => void) | null = null;
    constructor() { sockets.push(this); }
    send(data: string) { sent.push(JSON.parse(data)); }
  }
  const run = new Function('document', 'window', 'localStorage', 'WebSocket', 'location', 'setInterval', 'setTimeout', script);
  run(document, window, { getItem: () => o.me ?? null, setItem: () => {} }, StubSocket, { protocol: 'http:', host: 'room.test', reload: () => {} }, () => 0, () => 0);
  const trip = goaFreshTrip();
  const message = (n: number, text: string) => ({
    message_id: `m_${n}`, seq: n + 1, updated_seq: n + 1, author: { kind: 'person', person_id: 'p_priya' }, text, attachments: [],
    mentions_go: false, mentions: [], reactions: [], withheld: false, deleted: false, sent_at: '2026-10-08T10:00:00Z',
  });
  return {
    view,
    /** Where the reader is: the top of what they see. */
    top: () => winTop,
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
      winTop = clamp(top);
      for (const fn of docListeners.scroll ?? []) fn({ target: document });
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
    /** A tap on one of Go's buttons on a card, as the page draws it (data-tap, data-action). */
    tapCard(cardId: string, actionId: string) {
      for (const fn of docListeners.click ?? []) fn({ target: { closest: () => ({ dataset: { tap: cardId, action: actionId } }) } });
    },
    /** A tap on a card's mini browser or login tile (data-browse). */
    browse(cardId: string) {
      for (const fn of docListeners.click ?? []) fn({ target: { closest: () => ({ dataset: { browse: cardId } }) } });
    },
    /** The page's body, as the sheet leaves it. */
    body: () => document.body,
    /** A frame on the page posts it a message from `origin`: the login frame's own window unless another is named. */
    post(data: unknown, origin: string, source: unknown = el('login-frame').querySelector('iframe').contentWindow) {
      for (const fn of winListeners.message ?? []) fn({ data, origin, source });
    },
  };
}

/** A stand-in for the browser's Image, for a card's picture: the test says when each one loads, or fails. */
class TestImage {
  static made: TestImage[] = [];
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = '';
  constructor() { TestImage.made.push(this); }
  static load(src: string) { for (const i of TestImage.made) if (i.src === src) i.onload?.(); }
  static fail(src: string) { for (const i of TestImage.made) if (i.src === src) i.onerror?.(); }
}
const withPictures = () => {
  beforeEach(() => {
    TestImage.made = [];
    vi.stubGlobal('Image', TestImage);
  });
  afterEach(() => vi.unstubAllGlobals());
};

describe("a card's picture", () => {
  withPictures();
  const shot = (n: number) => `https://brain.go.example/live/shot_${n}.jpg`;
  /** Go's working card with its newest screenshot: Go replaces it about once a second while a job runs. */
  const working = (n: number, page_url: string | null) => ({
    message_id: 'm_go_1', seq: 5, updated_seq: 5 + n, author: { kind: 'go' }, text: 'On it.', attachments: [],
    mentions_go: false, mentions: [], reactions: [], withheld: false, deleted: false, sent_at: '2026-10-08T10:00:00Z',
    card: {
      kind: 'working', card_id: 'c_job', fallback_text: 'Logging in to ixigo', task_id: 'task_1', title: 'Logging in to ixigo', state: 'running',
      steps: [{ text: "Open ixigo's log in", state: 'doing' }], screenshot_url: shot(n), page_url, updated_at: '2026-10-08T10:00:00Z', actions: [],
    },
  });
  /** Every picture the room shows. */
  const pictures = (p: ReturnType<typeof pageInBrowser>) => [...p.room().matchAll(/<img alt="" src="([^"]*)"/g)].map((m) => m[1]);

  for (const page of [null, 'https://www.ixigo.com/hotels/search/result']) {
    it(`never blanks ${page ? 'the live search card' : 'a working card'}: three quick swaps keep the loaded picture until the newest loads`, () => {
      const p = pageInBrowser(PAGE_HTML);
      p.messages([working(1, page)], 1200);
      // The first picture shows once it has loaded, never as an empty picture before that.
      expect(pictures(p)).toEqual([]);
      TestImage.load(shot(1));
      expect(pictures(p)).toEqual([shot(1)]);
      // Three new screenshots a moment apart: the card keeps the loaded one.
      p.messages([working(2, page)], 1200);
      expect(pictures(p)).toEqual([shot(1)]);
      p.messages([working(3, page)], 1200);
      expect(pictures(p)).toEqual([shot(1)]);
      p.messages([working(4, page)], 1200);
      expect(pictures(p)).toEqual([shot(1)]);
      // One already passed by loads late: never shown. The newest loads: shown.
      TestImage.load(shot(2));
      expect(pictures(p)).toEqual([shot(1)]);
      TestImage.load(shot(4));
      expect(pictures(p)).toEqual([shot(4)]);
      // A picture that fails to load: the card keeps the one it has.
      p.messages([working(5, page)], 1200);
      TestImage.fail(shot(5));
      expect(pictures(p)).toEqual([shot(4)]);
      p.messages([working(5, page)], 1200);
      expect(pictures(p)).toEqual([shot(4)]);
      // Each address is fetched once, however often the room is drawn.
      expect(TestImage.made.map((i) => i.src)).toEqual([1, 2, 3, 4, 5].map(shot));
    });
  }
});

describe('the chat stays at the bottom', () => {
  it(`keeps a reader at the bottom on a page that scrolls when a card above grows and a reply arrives`, () => {
    const p = pageInBrowser(PAGE_HTML);
    p.state(['Goa?', 'yes!'], 1000);
    expect(p.top()).toBe(p.bottom());
    // The vote card above grows (people voting, then "Saudades won"), and the needs box changes, before the reply.
    p.state(['Goa?', 'yes!'], 1240, { p_rahul: [{ text: 'Vote on the stay' }] });
    expect(p.top()).toBe(p.bottom());
    p.state(['Goa?', 'yes!', 'Saudades won, 4 to 1'], 1400);
    expect(p.top()).toBe(800);
    expect(p.pill().hidden).toBe(true);
  });

  it(`keeps a reader at the bottom on a page that scrolls when a picture loads after the render`, () => {
    const p = pageInBrowser(PAGE_HTML);
    p.state(['Go, find villas'], 1000);
    // The live card is rebuilt on every render: its picture loads afterwards and makes the room 300 px taller.
    p.state(['Go, find villas', 'Working on it'], 1100);
    p.pictureLoads(1400);
    expect(p.top()).toBe(p.bottom());
    // The next render, a second later, still finds the reader at the bottom.
    p.state(['Go, find villas', 'Working on it', 'Three villas'], 1700);
    expect(p.top()).toBe(p.bottom());
  });

  it(`leaves a reader who scrolled up on a page that scrolls where they are, and says when a new message arrives`, () => {
    const p = pageInBrowser(PAGE_HTML);
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

  it(`hides the pill on a page that scrolls when the reader scrolls back down to the bottom themselves`, () => {
    const p = pageInBrowser(PAGE_HTML);
    p.state(['a'], 1500);
    p.scroll(0);
    p.state(['a', 'b'], 1700);
    expect(p.pill().hidden).toBe(false);
    p.scroll(p.bottom() - 40); // near enough to the bottom
    expect(p.pill().hidden).toBe(true);
    p.state(['a', 'b', 'c'], 1900);
    expect(p.top()).toBe(p.bottom());
  });

  it('has the pill in the page, hidden, above the message box, with no em dash', () => {
    expect(PAGE_HTML).toContain('<button class="newpill" id="newpill" type="button" hidden>New messages ↓</button>');
    expect(PAGE_HTML).toContain('.newpill[hidden] { display: none; }');
    expect(PAGE_HTML).not.toContain('—');
  });
});

describe("Go's live search card", () => {
  withPictures();
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
    const p = pageInBrowser(PAGE_HTML);
    const url = 'https://www.ixigo.com/hotels/search/result?locationId=32&locationName=Goa&checkinDate=06112026&filters=FL_HF_29%2CMP';
    p.messages([searchCard(url)], 1200);
    TestImage.load(shot);
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
      const p = pageInBrowser(PAGE_HTML);
      p.messages([searchCard(other)], 1200);
      const html = p.room();
      expect(html).not.toContain('See on ixigo');
      if (other) expect(html).not.toContain(other);
      expect(html).toContain('Read the results');
    }
    // An ixigo subdomain or the bare domain is ixigo.
    for (const ixigo of ['https://ixigo.com/trains', 'https://www.ixigo.com/hotels/goa']) {
      const p = pageInBrowser(PAGE_HTML);
      p.messages([searchCard(ixigo)], 1200);
      expect(p.room()).toContain('See on ixigo');
    }
  });
});

describe('a card button', () => {
  const CARD = 'c_login_t_goa_1';
  const fromGo = (card: object, n = 1) => ({
    message_id: `m_go_${n}`, seq: n, updated_seq: n, author: { kind: 'go' }, text: '', attachments: [], mentions_go: false, mentions: [],
    reactions: [], withheld: false, deleted: false, sent_at: '2026-10-08T10:00:00Z', card,
  });
  const only = (action_id: string, label: string, style = 'secondary') => ({ action_id, label, style, only_for_person_ids: ['p_rahul'] });
  /** The ixigo login card's ask, and the same card once Go has taken the Log in tap. */
  const ask = fromGo({
    kind: 'notice', card_id: CARD, tone: 'info', for_person_ids: ['p_rahul'], fallback_text: 'Link ixigo', title: 'Link ixigo for this trip',
    body: "One login on Go's computer.", actions: [only('ixigo_login', 'Log in to ixigo', 'primary'), only('ixigo_not_now', 'Not now')],
  });
  const opening = fromGo({ ...ask.card, title: 'Logging in to ixigo', actions: [only('ixigo_logged_in', "I'm logged in"), only('ixigo_not_now', 'Not now')] });
  /** A job's working card, with Watch and Stop for everyone. */
  const job = (updated_at: string) => fromGo({
    kind: 'working', card_id: 'c_job', fallback_text: 'Finding villas', task_id: 'task_1', title: 'Finding villas', state: 'running', steps: [], updated_at,
    actions: [{ action_id: 'watch', label: 'Watch', style: 'primary' }, { action_id: 'stop', label: 'Stop', style: 'secondary' }],
  }, 2);
  const LOGIN_TAP = { type: 'tap', cardId: CARD, actionId: 'ixigo_login', personId: 'p_rahul' };

  it('holds a tapped button as Opening… until its card changes, and never sends a second tap', () => {
    const p = pageInBrowser(PAGE_HTML);
    p.messages([ask], 1000);
    p.tapCard(CARD, 'ixigo_login');
    expect(p.sent()).toEqual([LOGIN_TAP]);
    expect(p.room()).toContain(`data-tap="${CARD}" data-action="ixigo_login" disabled aria-busy="true">Opening…</button>`);
    // Only that button waits: Not now is still there to tap.
    expect(p.room()).toContain(`data-tap="${CARD}" data-action="ixigo_not_now">Not now</button>`);
    // A second tap, a fresh render and Go's done all leave it waiting, and nothing more is sent.
    p.tapCard(CARD, 'ixigo_login');
    p.messages([ask], 1000);
    p.receive({ type: 'tap_result', cardId: CARD, actionId: 'ixigo_login', personId: 'p_rahul', result: { result: 'done', toast: "Opening ixigo's log in on Go's screen" } });
    p.tapCard(CARD, 'ixigo_login');
    expect(p.sent()).toEqual([LOGIN_TAP]);
    expect(p.room()).toContain('disabled aria-busy="true">Opening…</button>');
    // Go changes the card: the wait is over. Back at its ask later, the button taps again.
    p.messages([opening], 1000);
    p.messages([ask], 1000);
    expect(p.room()).toContain(`data-tap="${CARD}" data-action="ixigo_login">Log in to ixigo</button>`);
    p.tapCard(CARD, 'ixigo_login');
    expect(p.sent()).toEqual([LOGIN_TAP, LOGIN_TAP]);
  });

  it('frees a button when Go refuses or opens a page, and after 15 s at most', () => {
    const p = pageInBrowser(PAGE_HTML);
    p.messages([job('2026-10-08T10:00:00Z')], 1000);
    p.tapCard('c_job', 'watch');
    expect(p.room()).toContain('data-action="watch" disabled aria-busy="true">Opening…</button>');
    p.receive({ type: 'tap_result', cardId: 'c_job', actionId: 'watch', personId: 'p_rahul', result: { result: 'refused', toast: "Can't open Go's screen right now" } });
    expect(p.room()).toContain('data-action="watch">Watch</button>');
    expect(p.el('toast').textContent).toBe("Can't open Go's screen right now");
    p.tapCard('c_job', 'watch');
    p.receive({ type: 'tap_result', cardId: 'c_job', actionId: 'watch', personId: 'p_rahul', result: { result: 'open', url: 'https://bash.test/s', expires_at: '2099-01-01T00:00:00Z' } });
    expect(p.room()).toContain('data-action="watch">Watch</button>');
    expect(p.opened()).toEqual(['https://bash.test/s']);
    // Stop is answered done and the card doesn't change: it waits, then frees itself after 15 s.
    p.tapCard('c_job', 'stop');
    p.receive({ type: 'tap_result', cardId: 'c_job', actionId: 'stop', personId: 'p_rahul', result: { result: 'done', toast: 'Stopping it' } });
    expect(p.room()).toContain('data-action="stop" disabled aria-busy="true">One moment…</button>');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16_000);
    try {
      p.messages([job('2026-10-08T10:00:00Z')], 1000);
      expect(p.room()).toContain('data-action="stop">Stop</button>');
    } finally {
      clock.mockRestore();
    }
    // A card that changes (a new picture, a new step) frees it at once.
    p.tapCard('c_job', 'stop');
    p.messages([job('2026-10-08T10:00:05Z')], 1000);
    expect(p.room()).toContain('data-action="stop">Stop</button>');
    expect(p.sent().map((t) => t.actionId)).toEqual(['watch', 'watch', 'stop', 'stop']);
  });

  it("waits per person: another person's tap on the same button still goes", () => {
    const p = pageInBrowser(PAGE_HTML);
    p.messages([job('2026-10-08T10:00:00Z')], 1000);
    p.tapCard('c_job', 'stop');
    p.play('p_priya');
    expect(p.room()).toContain('data-action="stop">Stop</button>');
    p.tapCard('c_job', 'stop');
    expect(p.sent().map((t) => t.personId)).toEqual(['p_rahul', 'p_priya']);
  });

  it('frees a waiting button when the room turns the tap away before it reaches Go', () => {
    const p = pageInBrowser(roomPage({ title: 'Try Go', hosted: true }));
    p.messages([job('2026-10-08T10:00:00Z')], 1000);
    p.tapCard('c_job', 'stop');
    p.receive({ type: 'limit', text: "Today's turns are used up." });
    expect(p.room()).toContain('data-action="stop">Stop</button>');
    expect(p.el('limit').textContent).toBe("Today's turns are used up.");
    expect(p.el('toast').textContent).toBe("Today's turns are used up.");
    p.tapCard('c_job', 'stop');
    p.receive({ type: 'error', message: 'That is not in your trip.' });
    expect(p.room()).toContain('data-action="stop">Stop</button>');
    expect(p.el('toast').textContent).toBe('That is not in your trip.');
  });
});

describe("the trip's computer in the chat", () => {
  withPictures();
  const LIVE_PAGE = roomPage({ title: 'Try Go', hosted: true, live: true });
  const SHOT = 'https://brain.go.example/live/shot_1.jpg';
  /** Go's search card: a working card with its screenshot and the ixigo page in it. */
  const search = (state: 'running' | 'done', screenshot_url: string | null = SHOT) => ({
    message_id: 'm_go_1', seq: 5, updated_seq: state === 'done' ? 9 : 5, author: { kind: 'go' }, text: 'Looking.', attachments: [],
    mentions_go: false, mentions: [], reactions: [], withheld: false, deleted: false, sent_at: '2026-10-08T10:00:00Z',
    card: {
      kind: 'working', card_id: 'c_live_1', fallback_text: 'Searching hotels in Goa', task_id: 'task_1', title: 'Villas with a pool in North Goa',
      state, steps: [{ text: 'Open ixigo hotels', state: state === 'done' ? 'done' : 'doing' }], screenshot_url,
      page_url: 'https://www.ixigo.com/hotels/search/result', updated_at: '2026-10-08T10:00:00Z', actions: [],
    },
  });
  /** One message of Go's live view, as the room relays it: a page the trip's computer drew. */
  const frame = (p: ReturnType<typeof pageInBrowser>, jpeg: string) => p.receive({
    type: 'live', trip_id: 't_try_1',
    msg: { type: 'screen', event: { type: 'frame', tab_id: 'tab_1', at: new Date().toISOString(), page: '/hotels/search/result', width: 1280, height: 800, jpeg_base64: jpeg } },
  });

  it('is one column like the App, with no second column: the runs sit behind Details, closed until asked for', () => {
    expect(LIVE_PAGE).not.toContain('class="split"');
    expect(LIVE_PAGE).not.toContain('<aside');
    expect(LIVE_PAGE).toContain('<button class="act secondary" type="button" id="details-open" aria-controls="details" aria-expanded="false">Details</button>');
    expect(LIVE_PAGE).toContain('<div class="details" id="details" role="dialog" aria-modal="true" aria-label="Details" hidden>');
    expect(LIVE_PAGE).toContain('.details[hidden] { display: none; }');
    expect(PAGE_HTML).not.toContain('id="details-open"');
    const p = pageInBrowser(LIVE_PAGE);
    p.click('details-open');
    expect(p.el('details').hidden).toBe(false);
    expect(p.el('details-open').getAttribute('aria-expanded')).toBe('true');
    p.receive({ type: 'live', trip_id: 't_try_1', msg: { type: 'run', event: { type: 'run_start', run_id: 'run_1', recipe_id: 'ixigo.hotels.search', label: 'Stays in Goa', group_id: 'g_1', at: new Date().toISOString(), speed: 'page' } } });
    expect(p.el('strip').innerHTML).toContain('<b>Stays in Goa</b>');
    expect(p.el('live-state').textContent).toBe('Working');
    p.click('details-close');
    expect(p.el('details').hidden).toBe(true);
    expect(p.el('details-open').getAttribute('aria-expanded')).toBe('false');
  });

  it("shows a search card's page in a mini browser; a tap opens it big, view-only, and Close closes it", () => {
    const p = pageInBrowser(PAGE_HTML);
    p.messages([search('done')], 1200);
    TestImage.load(SHOT);
    const html = p.room();
    expect(html).toContain('<button class="mini" type="button" data-browse="c_live_1"><span class="mini-bar"><i></i><i></i><i></i><span class="mini-host">ixigo.com</span></span>');
    expect(html).toContain(`<span class="mini-view"><img alt="" src="${SHOT}"></span><span class="mini-tap">Tap to see it big</span></button>`);
    expect(p.el('sheet').hidden).toBe(true);
    p.browse('c_live_1');
    expect(p.el('sheet').hidden).toBe(false);
    expect(p.el('sheet').className).toBe('sheet');
    expect(p.body().className).toBe('sheet-open');
    expect(p.el('sheet-view').hidden).toBe(false);
    expect(p.el('sheet-title').textContent).toBe('Villas with a pool in North Goa');
    expect(p.el('sheet-img').getAttribute('src')).toBe(SHOT);
    expect(p.el('sheet-live').hidden).toBe(true);
    p.click('sheet-close');
    expect(p.el('sheet').hidden).toBe(true);
    expect(p.body().className).toBe('');
    // The picture takes no pointer, on the card or in the sheet: it is a picture of the page, not the page.
    expect(PAGE_HTML).toContain('.mini-view img { max-width: 100%; max-height: 100%; width: auto; height: auto; display: block; pointer-events: none; }');
    expect(PAGE_HTML).toMatch(/\.sheet-view img \{[^}]*pointer-events: none; \}/);
  });

  it("shows Go's computer live while the search runs, in place on the card and in the open sheet, from pictures that came since", () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const p = pageInBrowser(LIVE_PAGE);
      // A picture from before the search ran is not this search's.
      frame(p, 'T0xE');
      now += 1000;
      p.messages([search('running', null)], 1200);
      expect(p.room()).toContain('<span class="mini-live" id="mini-live-badge" hidden>LIVE</span>');
      expect(p.room()).toContain('<span class="mini-view"><img alt="" id="mini-live"></span>');
      const writes = p.el('room').writes;
      now += 1000;
      frame(p, 'TkVX');
      expect(p.el('mini-live').getAttribute('src')).toBe('data:image/jpeg;base64,TkVX');
      expect(p.el('mini-live-badge').hidden).toBe(false);
      // In place: the room is not drawn again for a picture.
      expect(p.el('room').writes).toBe(writes);
      p.browse('c_live_1');
      expect(p.el('sheet-img').getAttribute('src')).toBe('data:image/jpeg;base64,TkVX');
      expect(p.el('sheet-live').hidden).toBe(false);
      now += 1000;
      frame(p, 'TkVYVA==');
      expect(p.el('sheet-img').getAttribute('src')).toBe('data:image/jpeg;base64,TkVYVA==');
      // A redraw keeps the live picture on the card.
      p.messages([search('running', null)], 1200);
      expect(p.room()).toContain('<img alt="" src="data:image/jpeg;base64,TkVYVA==" id="mini-live">');
      // The search is done: its own picture, once loaded, and no LIVE.
      p.messages([search('done')], 1200);
      TestImage.load(SHOT);
      expect(p.el('sheet-img').getAttribute('src')).toBe(SHOT);
      expect(p.el('sheet-live').hidden).toBe(true);
      expect(p.room()).not.toContain('mini-live');
    } finally {
      clock.mockRestore();
    }
  });
});

describe('the login card and its sheet', () => {
  const ORIGIN = 'https://bash.test';
  const LIVE_PAGE = roomPage({ title: 'Try Go', hosted: true, live: true, watchOrigin: ORIGIN });
  const SESSION = `${ORIGIN}/screen?s=ses_1#token=tok_secret`;
  const FRAME = `<iframe title="Go&#39;s computer" src="${SESSION}" sandbox="allow-scripts allow-same-origin allow-forms" referrerpolicy="no-referrer"></iframe>`;
  const CARD = 'c_login_t_goa_1';
  const OPENING = "Opening ixigo's login on Go's computer…";
  const LINE = 'Type your number and the code. They go to ixigo only. Go never sees them.';
  /** Go's message with a card in it. */
  const fromGo = (card: object, n = 1) => ({
    message_id: `m_go_${n}`, seq: n, updated_seq: n, author: { kind: 'go' }, text: '', attachments: [], mentions_go: false, mentions: [],
    reactions: [], withheld: false, deleted: false, sent_at: '2026-10-08T10:00:00Z', card,
  });
  const button = (action_id: string, label: string, style = 'secondary') => ({ action_id, label, style, only_for_person_ids: ['p_rahul'] });
  /**
   * The ixigo login card, pinned to Rahul: its ask, then logging in (opening: no Watch until the login page is in front;
   * then Watch, only for him, and his two buttons), then logged in.
   */
  const loginCard = (state: 'asked' | 'opening' | 'logging_in' | 'logged_in') => fromGo({
    kind: 'notice', card_id: CARD, tone: 'info', for_person_ids: ['p_rahul'], fallback_text: "Rahul is logging in to ixigo on Go's computer.",
    title: { asked: 'Link ixigo for this trip', opening: 'Logging in to ixigo', logging_in: 'Logging in to ixigo', logged_in: 'ixigo: logged in as Rahul' }[state],
    body: "ixigo's log in is open on Go's screen.",
    actions: {
      asked: [button('ixigo_login', 'Log in to ixigo', 'primary'), button('ixigo_not_now', 'Not now')],
      opening: [button('ixigo_logged_in', "I'm logged in"), button('ixigo_not_now', 'Not now')],
      logging_in: [button('ixigo_watch', 'Watch', 'primary'), button('ixigo_logged_in', "I'm logged in"), button('ixigo_not_now', 'Not now')],
      logged_in: [button('ixigo_logout', 'Log out')],
    }[state],
  });
  /** The room's answer to a Watch tap: Bash's session page, good for 15 minutes. */
  const answer = (over: object = {}) => ({
    type: 'tap_result', cardId: CARD, actionId: 'ixigo_watch', personId: 'p_rahul',
    result: { result: 'open', url: SESSION, expires_at: '2099-01-01T00:00:00Z' }, ...over,
  });
  const WATCH_TAP = { type: 'tap', cardId: CARD, actionId: 'ixigo_watch', personId: 'p_rahul' };
  const LOGIN_TAP = { type: 'tap', cardId: CARD, actionId: 'ixigo_login', personId: 'p_rahul' };
  /** What Bash's embed posts the room as its picture comes. */
  const embed = (state: string) => ({ type: 'vestra:embed', state });
  /** Rahul's page once Watch came and was answered and the embed's picture is live, the sheet still closed. */
  const loggingIn = () => {
    const p = pageInBrowser(LIVE_PAGE);
    p.messages([loginCard('logging_in')], 1000);
    p.receive(answer());
    p.post(embed('live'), ORIGIN);
    return p;
  };

  it('says it is opening the moment Go takes the tap, then shows a Log in tile once Watch comes, Watch tapped once by itself', () => {
    expect(LIVE_PAGE).not.toMatch(/[—–]|claude/i);
    const p = pageInBrowser(LIVE_PAGE);
    p.messages([loginCard('asked')], 1000);
    expect(p.room()).not.toContain('data-browse');
    p.tapCard(CARD, 'ixigo_login');
    expect(p.sent()).toEqual([LOGIN_TAP]);
    // Go turns the card at once; Watch comes once the login page is in front.
    p.messages([loginCard('opening')], 1000);
    const opening = p.room();
    expect(opening).toContain('<span class="tag warn">Needs you</span><h3>Logging in to ixigo</h3>');
    expect(opening).toContain(`<button class="mini login-tile" type="button" data-browse="${CARD}">`);
    expect(opening).toContain(`<span class="login-face"><b>${OPENING}</b><span class="login-progress" aria-hidden="true"><i></i></span></span>`);
    expect(opening).toContain(`data-action="ixigo_not_now">Not now</button>`);
    expect(p.sent()).toEqual([LOGIN_TAP]);
    // Watch comes: tapped once, by the page, and the tile says Log in.
    p.messages([loginCard('logging_in')], 1000);
    expect(p.sent()).toEqual([LOGIN_TAP, WATCH_TAP]);
    const tile = p.room();
    expect(tile).toContain('<span class="login-face"><b>Log in to ixigo</b><span class="login-field">Mobile number</span><span class="login-cta">Tap to log in</span></span>');
    expect(tile).toContain(`<div class="meta">${LINE}</div>`);
    expect(tile).not.toContain('data-action="ixigo_watch"');
    p.messages([loginCard('logging_in')], 1000);
    expect(p.sent()).toEqual([LOGIN_TAP, WATCH_TAP]);
    // The answer goes in the sheet's frame while the sheet is still closed, so it opens on a loaded page.
    p.receive(answer());
    expect(p.el('login-frame').innerHTML).toBe(FRAME);
    expect(p.el('sheet').hidden).toBe(true);
    expect(p.opened()).toEqual([]);
  });

  it("opens big on a tap: Go's screen in control, filling the sheet, with I'm logged in and Not now at its foot", () => {
    const p = loggingIn();
    p.browse(CARD);
    expect(p.el('sheet').hidden).toBe(false);
    expect(p.el('sheet').className).toBe('sheet login');
    expect(p.el('sheet-view').hidden).toBe(true);
    expect(p.el('sheet-login').hidden).toBe(false);
    expect(p.el('sheet-title').textContent).toBe('Log in to ixigo');
    expect(p.el('login-line').textContent).toBe(LINE);
    expect(p.el('login-frame').hidden).toBe(false);
    expect(p.el('login-wait').hidden).toBe(true);
    const foot = p.el('login-acts').innerHTML;
    expect(foot).toContain(`data-tap="${CARD}" data-action="ixigo_logged_in">I'm logged in</button>`);
    expect(foot).toContain(`data-tap="${CARD}" data-action="ixigo_not_now">Not now</button>`);
    expect(foot).not.toContain('ixigo_watch');
    // Close and open again: the same frame, never loaded twice.
    p.click('sheet-close');
    expect(p.el('sheet').hidden).toBe(true);
    expect(p.el('login-frame').innerHTML).toBe(FRAME);
    p.browse(CARD);
    expect(p.el('login-frame').writes).toBe(1);
    expect(p.sent()).toEqual([WATCH_TAP]);
  });

  it('opens the sheet while the login is still opening, and it never says "didn\'t open" however long the computer takes to wake', () => {
    const p = pageInBrowser(LIVE_PAGE);
    p.messages([loginCard('opening')], 1000);
    p.browse(CARD);
    expect(p.el('sheet').className).toBe('sheet login');
    expect(p.el('login-wait').hidden).toBe(false);
    expect(p.el('login-why').textContent).toBe(OPENING);
    expect(p.el('login-progress').hidden).toBe(false);
    expect(p.el('login-again').hidden).toBe(true);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30_000);
    try {
      p.messages([loginCard('opening')], 1000);
      expect(p.el('login-why').textContent).toBe(OPENING);
    } finally {
      clock.mockRestore();
    }
    // Watch comes while the sheet is open: tapped, and the screen fills the sheet once its picture is live.
    p.messages([loginCard('logging_in')], 1000);
    expect(p.sent()).toEqual([WATCH_TAP]);
    p.receive(answer());
    expect(p.el('login-frame').innerHTML).toBe(FRAME);
    expect(p.el('login-frame').hidden).toBe(false);
    expect(p.el('login-wait').hidden).toBe(false);
    p.post(embed('live'), ORIGIN);
    expect(p.el('login-wait').hidden).toBe(true);
  });

  it("keeps Opening over the loading frame until Bash's embed says its picture is live, hearing only Watch's origin", () => {
    const p = pageInBrowser(LIVE_PAGE);
    p.messages([loginCard('logging_in')], 1000);
    p.receive(answer());
    p.browse(CARD);
    // The frame is up and loading under the opening state.
    expect(p.el('login-frame').innerHTML).toBe(FRAME);
    expect(p.el('login-frame').hidden).toBe(false);
    expect(p.el('login-wait').hidden).toBe(false);
    expect(p.el('login-why').textContent).toBe(OPENING);
    expect(p.el('login-progress').hidden).toBe(false);
    p.post(embed('connecting'), ORIGIN);
    expect(p.el('login-wait').hidden).toBe(false);
    // Another origin, another kind of message, or a state the room doesn't know: nothing changes.
    p.post(embed('live'), 'https://elsewhere.test');
    p.post({ type: 'other', state: 'live' }, ORIGIN);
    p.post(embed('ready'), ORIGIN);
    p.post('live', ORIGIN);
    // Nor does another frame on Watch's origin: only the login frame's own window is heard.
    p.el('login-frame').querySelector('iframe').contentWindow = { frame: 'login' };
    p.post(embed('live'), ORIGIN, { frame: 'another' });
    expect(p.el('login-wait').hidden).toBe(false);
    p.post(embed('live'), ORIGIN);
    expect(p.el('login-wait').hidden).toBe(true);
    expect(p.el('login-frame').writes).toBe(1);
    // The CSS lays the opening state over the frame, which keeps loading under it.
    expect(LIVE_PAGE).toContain('<div class="login-stage">');
    expect(LIVE_PAGE).toMatch(/\.login-wait \{ position: absolute; inset: 0; z-index: 1;/);
  });

  it("lifts Opening as soon as the embed shows a still of the screen, before the video's first frame", () => {
    const p = pageInBrowser(LIVE_PAGE);
    p.messages([loginCard('logging_in')], 1000);
    p.receive(answer());
    p.browse(CARD);
    p.post(embed('connecting'), ORIGIN);
    expect(p.el('login-wait').hidden).toBe(false);
    p.post(embed('showing'), ORIGIN);
    expect(p.el('login-wait').hidden).toBe(true);
    // The video's first frame changes nothing more; an error after it still offers the way back.
    p.post(embed('live'), ORIGIN);
    expect(p.el('login-wait').hidden).toBe(true);
    p.post(embed('error'), ORIGIN);
    expect(p.el('login-wait').hidden).toBe(false);
    expect(p.el('login-again').hidden).toBe(false);
  });

  it('shows an embed that says nothing after 5 s, and a picture still connecting after 30 s, as the embed has them', () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const p = pageInBrowser(LIVE_PAGE);
      p.messages([loginCard('logging_in')], 1000);
      p.receive(answer());
      p.browse(CARD);
      now += 4_000;
      p.messages([loginCard('logging_in')], 1000);
      expect(p.el('login-wait').hidden).toBe(false);
      now += 2_000;
      p.messages([loginCard('logging_in')], 1000);
      expect(p.el('login-wait').hidden).toBe(true);
      // An embed that says it is connecting is waited for longer.
      p.post(embed('connecting'), ORIGIN);
      expect(p.el('login-wait').hidden).toBe(false);
      now += 20_000;
      p.messages([loginCard('logging_in')], 1000);
      expect(p.el('login-wait').hidden).toBe(false);
      now += 5_000;
      p.messages([loginCard('logging_in')], 1000);
      expect(p.el('login-wait').hidden).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it("offers Open the login again when the embed's picture fails, and opens a fresh frame", () => {
    const p = pageInBrowser(LIVE_PAGE);
    p.messages([loginCard('logging_in')], 1000);
    p.receive(answer());
    p.browse(CARD);
    p.post(embed('error'), ORIGIN);
    expect(p.el('login-wait').hidden).toBe(false);
    expect(p.el('login-why').textContent).toBe("Go's screen didn't open here.");
    expect(p.el('login-again').hidden).toBe(false);
    p.click('login-again');
    expect(p.sent()).toEqual([WATCH_TAP, WATCH_TAP]);
    expect(p.el('login-frame').innerHTML).toBe('');
    expect(p.el('login-why').textContent).toBe(OPENING);
    p.receive(answer());
    expect(p.el('login-frame').innerHTML).toBe(FRAME);
    expect(p.el('login-frame').writes).toBe(3);
    // A fresh frame waits for its own word.
    expect(p.el('login-wait').hidden).toBe(false);
    p.post(embed('live'), ORIGIN);
    expect(p.el('login-wait').hidden).toBe(true);
  });

  it('shows everyone else who is logging in, with no tile and never the page', () => {
    const q = pageInBrowser(LIVE_PAGE, { me: 'p_priya' });
    for (const state of ['opening', 'logging_in'] as const) {
      q.messages([loginCard(state)], 1000);
      expect(q.room()).toContain('<span class="tag">Logging in</span><h3>Logging in to ixigo</h3><div>Rahul is logging in to ixigo</div>');
      expect(q.room()).not.toContain('data-browse');
      expect(q.room()).not.toContain('login-face');
    }
    expect(q.sent()).toEqual([]);
    expect(q.el('login-frame').innerHTML).toBe('');
    q.browse(CARD);
    expect(q.el('sheet').hidden).toBe(true);
  });

  it("shows Go's heads-up on the card and in the sheet when I'm logged in found no login yet, and keeps the screen", () => {
    const p = loggingIn();
    p.browse(CARD);
    expect(p.el('login-note').hidden).toBe(true);
    const notYet = loginCard('logging_in');
    Object.assign(notYet.card, { tone: 'heads_up', body: 'Not logged in yet. Finish on Watch, then tap again.' });
    p.messages([notYet], 1000);
    expect(p.room()).toContain('<div class="login-note" role="status">Not logged in yet. Finish on Watch, then tap again.</div>');
    expect(p.el('login-note').hidden).toBe(false);
    expect(p.el('login-note').textContent).toBe('Not logged in yet. Finish on Watch, then tap again.');
    expect(p.el('login-frame').writes).toBe(1);
    expect(p.el('sheet').hidden).toBe(false);
  });

  it('closes the sheet when the hand-off ends, and when Go could not open the login, the card goes back to its ask', () => {
    const p = loggingIn();
    p.browse(CARD);
    p.messages([loginCard('logged_in')], 1000);
    expect(p.el('sheet').hidden).toBe(true);
    expect(p.el('login-frame').innerHTML).toBe('');
    expect(p.room()).toContain('<h3>ixigo: logged in as Rahul</h3>');
    expect(p.room()).not.toContain('data-browse');
    const q = pageInBrowser(LIVE_PAGE);
    q.messages([loginCard('opening')], 1000);
    q.browse(CARD);
    q.messages([loginCard('asked')], 1000);
    expect(q.el('sheet').hidden).toBe(true);
    expect(q.room()).toContain('data-action="ixigo_login">Log in to ixigo</button>');
    expect(q.sent()).toEqual([]);
  });

  it('closes your sheet when you play someone else, and keeps the screen for when you come back', () => {
    const p = loggingIn();
    p.browse(CARD);
    p.play('p_priya');
    expect(p.el('sheet').hidden).toBe(true);
    expect(p.el('login-frame').innerHTML).toBe(FRAME);
    p.play('p_rahul');
    p.browse(CARD);
    expect(p.el('sheet').hidden).toBe(false);
    expect(p.el('login-frame').writes).toBe(1);
    expect(p.sent()).toEqual([WATCH_TAP]);
  });

  it('offers Open the login again when the screen ran out or Go refused it, and it taps Watch again', () => {
    const p = pageInBrowser(LIVE_PAGE);
    p.messages([loginCard('logging_in')], 1000);
    p.receive(answer({ result: { result: 'open', url: SESSION, expires_at: '2020-01-01T00:00:00Z' } }));
    p.browse(CARD);
    expect(p.el('login-frame').innerHTML).toBe('');
    expect(p.el('login-why').textContent).toBe('Your view of the login closed after 15 minutes.');
    expect(p.el('login-again').hidden).toBe(false);
    p.click('login-again');
    expect(p.sent()).toEqual([WATCH_TAP, WATCH_TAP]);
    expect(p.el('login-why').textContent).toBe(OPENING);
    p.receive(answer({ result: { result: 'refused', toast: "Can't open Go's screen right now" } }));
    expect(p.el('login-why').textContent).toBe("Go's screen didn't open here.");
    expect(p.el('login-again').hidden).toBe(false);
    expect(p.el('toast').textContent).toBe("Can't open Go's screen right now");
  });

  it('frames no page from another site, and a room with no watch origin draws the card as before, Watch opening a window', () => {
    const p = pageInBrowser(LIVE_PAGE);
    p.messages([loginCard('logging_in')], 1000);
    const elsewhere = 'https://elsewhere.test/screen#token=tok_secret';
    p.receive(answer({ result: { result: 'open', url: elsewhere, expires_at: '2099-01-01T00:00:00Z' } }));
    expect(p.el('login-frame').innerHTML).toBe('');
    expect(p.opened()).toEqual([elsewhere]);

    const plain = pageInBrowser(roomPage({ title: 'Try Go', hosted: true, live: true }));
    plain.messages([loginCard('logging_in')], 1000);
    expect(plain.room()).toContain(`data-tap="${CARD}" data-action="ixigo_watch">Watch</button>`);
    expect(plain.room()).not.toContain('data-browse');
    expect(plain.sent()).toEqual([]);
    plain.receive(answer());
    expect(plain.opened()).toEqual([SESSION]);
  });

  it("opens a job's hand-off in the sheet in control, and its Watch opens that sheet too", () => {
    const working = (state: 'running' | 'needs_you') => fromGo({
      kind: 'working', card_id: 'c_job', fallback_text: 'Booking the villa', task_id: 'task_1', title: 'Booking the villa', state,
      steps: [], updated_at: '2026-10-08T10:00:00Z', ...(state === 'needs_you' ? { for_person_ids: ['p_rahul'] } : {}),
      actions: [{ action_id: 'watch', label: 'Watch', style: 'primary' }, { action_id: 'stop', label: 'Stop', style: 'secondary' }],
    });
    const p = pageInBrowser(LIVE_PAGE);
    p.messages([working('needs_you')], 1000);
    expect(p.sent()).toEqual([{ type: 'tap', cardId: 'c_job', actionId: 'watch', personId: 'p_rahul' }]);
    expect(p.room()).toContain("<span class=\"mini-tap\">Tap to use Go's computer</span>");
    p.tapCard('c_job', 'watch');
    expect(p.sent()).toHaveLength(1);
    expect(p.el('sheet').className).toBe('sheet login');
    expect(p.el('sheet-title').textContent).toBe('Booking the villa');
    expect(p.el('login-line').textContent).toBe("Go's computer is yours for this step.");
    expect(p.el('login-acts').innerHTML).toContain('data-action="stop">Stop</button>');
    p.click('sheet-close');
    // A job that only runs is no hand-off: its Watch is tapped as any button.
    p.messages([working('running')], 1000);
    p.tapCard('c_job', 'watch');
    expect(p.sent()).toHaveLength(2);
  });
});
