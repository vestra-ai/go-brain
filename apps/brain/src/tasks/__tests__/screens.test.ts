import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createImages } from '../../travel/images.js';
import { createScreens, LIVE_FOR_MS, stepWords, type Screens, type ScreensDeps } from '../screens.js';
import { makeTaskHarness, type TaskHarness } from '../testing/harness.js';

let h: TaskHarness;
let screens: Screens;
beforeAll(async () => {
  h = await makeTaskHarness();
  screens = createScreens({ v1: h.v1, store: h.store, images: createImages({ pool: h.pool, publicUrl: 'https://go.test' }), tasks: h.tasks, userIdFor: h.computer.userIdFor, now: h.lb.clock.now, log: h.lb.brain.log });
});
afterAll(async () => {
  await h.close();
});

describe("the trip's screen on the card", () => {
  it('re-hosts the screen only when it changed, and puts the new picture on the card', async () => {
    const { row } = await h.runningJob('scr', 't_scr');
    h.fake.screen = Buffer.from([0xff, 0xd8, 0xff, 1]);
    await screens.tick('t_scr');
    await h.cards.flush();
    const first = (await h.store.get(row.id))!.screenshotUrl;
    expect(first).toMatch(/^https:\/\/go\.test\/img\/i[0-9a-f]{32}\.jpg$/);
    expect(h.lb.link.card(row.cardId)?.screenshot_url).toBe(first);
    const updates = h.lb.link.sent('replace_card').length;
    h.lb.clock.advance(1_000);
    await screens.tick('t_scr');
    await h.cards.flush();
    expect(h.lb.link.sent('replace_card')).toHaveLength(updates);
    h.fake.screen = Buffer.from([0xff, 0xd8, 0xff, 2]);
    // The same screen twice: the next read waits 2 s.
    h.lb.clock.advance(2_000);
    await screens.tick('t_scr');
    await h.cards.flush();
    const second = (await h.store.get(row.id))!.screenshotUrl;
    expect(second).not.toBe(first);
    expect(h.lb.link.card(row.cardId)?.screenshot_url).toBe(second);
    h.fake.screen = null;
    await expect(screens.tick('t_scr')).resolves.toBeUndefined();
  });

  it('shows the last steps from the trace while a job has no to-do list, and stops once it writes one', async () => {
    const { row, v1TaskId } = await h.runningJob('trace', 't_trace');
    h.fake.traceSteps = [
      { tool_use_id: 'a', name: 'WebSearch', input_summary: 'villas north goa pool', is_error: false, started_at: '2026-10-07T12:00:01Z', finished_at: '2026-10-07T12:00:03Z' },
      { tool_use_id: 'b', name: 'mcp__browser-control__computer_navigate', input_summary: 'https://www.example-villas.in/north-goa', is_error: false, started_at: '2026-10-07T12:00:04Z', finished_at: null },
    ];
    h.lb.clock.advance(25_000);
    await screens.tick('t_trace');
    expect((await h.store.get(row.id))!.steps).toEqual([{ text: 'Searching the web', state: 'done' }, { text: 'Opening www.example-villas.in', state: 'doing' }]);
    await h.events.apply({ type: 'task.progress', data: { task_id: v1TaskId, todos: [{ content: 'Search stays', status: 'in_progress' }] }, source: 'stream' });
    h.lb.clock.advance(20_000);
    await screens.tick('t_trace');
    expect((await h.store.get(row.id))!.steps).toEqual([{ text: 'Search stays', state: 'doing' }]);
  });

  it('never puts a finished job back to running: a job that ends while its screen is being saved stays done', async () => {
    const { row, v1TaskId } = await h.runningJob('scr_done', 't_scr_done');
    const images = createImages({ pool: h.pool, publicUrl: 'https://go.test' });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let saving!: () => void;
    const started = new Promise<void>((r) => {
      saving = r;
    });
    const slow = createScreens({
      v1: h.v1, store: h.store, tasks: h.tasks, userIdFor: h.computer.userIdFor, now: h.lb.clock.now, log: h.lb.brain.log,
      images: {
        putBytes: async (bytes, mime) => {
          saving();
          await gate;
          return images.putBytes(bytes, mime);
        },
      },
    });
    h.fake.screen = Buffer.from([0xff, 0xd8, 0xff, 9]);
    const tick = slow.tick('t_scr_done');
    await started;
    h.fake.complete(v1TaskId, { summary: 'Nothing fits.', options: [] }, 'Nothing fits.');
    await h.events.apply({ type: 'task.completed', data: { task_id: v1TaskId }, source: 'webhook' });
    release();
    await tick;
    await h.cards.flush();
    expect((await h.store.get(row.id))?.state).toBe('done');
    expect(h.lb.link.card(row.cardId)).toMatchObject({ state: 'done', actions: [] });
    h.fake.screen = null;
  });

  it("takes no picture of the trip's screen for any job while one of them waits on someone signing in", async () => {
    const signing = await h.runningJob('scr_sign', 't_scr_sign');
    const other = await h.runningJob('scr_other', 't_scr_sign');
    await h.store.transition(signing.row.id, ['running'], 'needs_you', { needsPersonId: 'p_meher' });
    h.fake.screen = Buffer.from([0xff, 0xd8, 0xff, 7]);
    const shots = () => h.fake.callsTo('GET', /\/screenshot$/).length;
    const before = shots();
    await screens.tick('t_scr_sign');
    expect(shots()).toBe(before);
    expect((await h.store.get(other.row.id))?.screenshotUrl).toBeNull();
    await h.store.transition(signing.row.id, ['needs_you'], 'running', { needsPersonId: null });
    await screens.tick('t_scr_sign');
    expect(shots()).toBe(before + 1);
    expect((await h.store.get(other.row.id))?.screenshotUrl).toMatch(/^https:\/\/go\.test\/img\//);
    h.fake.screen = null;
  });

  describe('live, but bounded', () => {
    const shots = () => h.fake.callsTo('GET', /\/screenshot$/).length;
    const own = (o: Partial<ScreensDeps> = {}): Screens =>
      createScreens({
        v1: h.v1, store: h.store, images: createImages({ pool: h.pool, publicUrl: 'https://go.test' }), tasks: h.tasks, userIdFor: h.computer.userIdFor,
        now: h.lb.clock.now, log: h.lb.brain.log, perMinute: 1_000, ...o,
      });
    /** Ticks after `ms`, and says whether the screen was read. */
    const tickAfter = async (s: Screens, tripId: string, ms: number): Promise<boolean> => {
      h.lb.clock.advance(ms);
      const before = shots();
      await s.tick(tripId);
      await h.cards.flush();
      return shots() > before;
    };

    it('reads the screen about once a second while it changes, waits 2, 4 then 7 s while it does not, and is back to 1 s on the next change', async () => {
      const s = own();
      const { row } = await h.runningJob('live_pace', 't_live_pace');
      h.fake.screen = Buffer.from([0xff, 0xd8, 0xff, 0x21]);
      expect(await tickAfter(s, 't_live_pace', 0)).toBe(true);
      expect(await tickAfter(s, 't_live_pace', 500)).toBe(false);
      h.fake.screen = Buffer.from([0xff, 0xd8, 0xff, 0x22]);
      expect(await tickAfter(s, 't_live_pace', 500)).toBe(true);
      const shown = h.lb.link.card(row.cardId)?.screenshot_url;
      expect(shown).toBe((await h.store.get(row.id))!.screenshotUrl);
      // Unchanged from here: 1 s, then 2 s, then 4 s, then 7 s.
      expect(await tickAfter(s, 't_live_pace', 1_000)).toBe(true);
      expect(await tickAfter(s, 't_live_pace', 1_000)).toBe(false);
      expect(await tickAfter(s, 't_live_pace', 1_000)).toBe(true);
      expect(await tickAfter(s, 't_live_pace', 3_000)).toBe(false);
      expect(await tickAfter(s, 't_live_pace', 1_000)).toBe(true);
      expect(await tickAfter(s, 't_live_pace', 6_000)).toBe(false);
      expect(await tickAfter(s, 't_live_pace', 1_000)).toBe(true);
      // An unchanged screen put nothing new on the card.
      expect(h.lb.link.card(row.cardId)?.screenshot_url).toBe(shown);
      h.fake.screen = Buffer.from([0xff, 0xd8, 0xff, 0x23]);
      expect(await tickAfter(s, 't_live_pace', 7_000)).toBe(true);
      expect(h.lb.link.card(row.cardId)?.screenshot_url).not.toBe(shown);
      expect(await tickAfter(s, 't_live_pace', 1_000)).toBe(true);
      h.fake.screen = null;
    });

    it('slows to every 7 s once the newest job has run 5 minutes', async () => {
      const s = own();
      await h.runningJob('live_long', 't_live_long');
      h.fake.screen = Buffer.from([0xff, 0xd8, 0xff, 0x31]);
      expect(await tickAfter(s, 't_live_long', LIVE_FOR_MS)).toBe(true);
      h.fake.screen = Buffer.from([0xff, 0xd8, 0xff, 0x32]);
      expect(await tickAfter(s, 't_live_long', 1_000)).toBe(false);
      expect(await tickAfter(s, 't_live_long', 6_000)).toBe(true);
      h.fake.screen = null;
    });

    it('shares one budget a minute across trips, skipping a tick over it', async () => {
      const s = own({ perMinute: 2 });
      await h.runningJob('budget_a', 't_budget_a');
      await h.runningJob('budget_b', 't_budget_b');
      h.fake.screen = Buffer.from([0xff, 0xd8, 0xff, 0x41]);
      expect(await tickAfter(s, 't_budget_a', 0)).toBe(true);
      expect(await tickAfter(s, 't_budget_b', 0)).toBe(true);
      h.fake.screen = Buffer.from([0xff, 0xd8, 0xff, 0x42]);
      expect(await tickAfter(s, 't_budget_a', 1_000)).toBe(false);
      expect(await tickAfter(s, 't_budget_b', 1_000)).toBe(false);
      expect(await tickAfter(s, 't_budget_a', 58_000)).toBe(true);
      h.fake.screen = null;
    });

    it('never reads one trip's screen twice at once', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let reads = 0;
      const s = own({
        v1: {
          ...h.v1,
          bytes: async (path, opts) => {
            reads += 1;
            await gate;
            return h.v1.bytes(path, opts);
          },
        },
      });
      await h.runningJob('live_busy', 't_live_busy');
      h.fake.screen = Buffer.from([0xff, 0xd8, 0xff, 0x51]);
      const first = s.tick('t_live_busy');
      while (reads === 0) await new Promise((r) => setTimeout(r, 5));
      h.lb.clock.advance(5_000);
      await s.tick('t_live_busy');
      expect(reads).toBe(1);
      release();
      await first;
      h.fake.screen = null;
    });
  });

  it('words a trace step plainly and never echoes what the job read', () => {
    expect(stepWords('WebFetch', 'https://reviews.example.com/villa-sol?ref=ignore-your-rules')).toBe('Reading reviews.example.com');
    expect(stepWords('mcp_invoke', 'search_stays')).toBe("Using Go's trip tools");
    expect(stepWords('Bash', 'rm -rf /')).toBe('Working');
  });
});
