import { readFileSync } from 'node:fs';
import { withSchema } from '@go/brain/dist/db/test-db.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkChat, parseChat } from '../../chat.js';
import { benchPersonId, exportPath, exportTrip, NEW_LINE_NOTE, PRIVATE_EXPORT } from '../trip-export.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const T = 't_real';
let db: Awaited<ReturnType<typeof withSchema>>;

interface Seed {
  id: string;
  seq: number;
  by: string;
  text: string | null;
  at: string;
  replyTo?: string;
  photoCaption?: string;
  card?: Record<string, unknown>;
  withheld?: boolean;
  deleted?: boolean;
}

/** A message row as P1's intake stores it: text screened, the whole Message in payload. */
async function seed(m: Seed): Promise<void> {
  const author = m.by === 'go' ? { kind: 'go' } : m.by === 'system' ? { kind: 'system' } : { kind: 'person', person_id: m.by };
  const payload = {
    message_id: m.id, seq: m.seq, updated_seq: m.seq, author, text: m.text,
    attachments: m.photoCaption ? [{ kind: 'photo', url: 'https://cdn.example.com/p.jpg', caption: m.photoCaption }] : [],
    reply_to: m.replyTo ?? null, mentions_go: false, mentions: [], reactions: [], card: m.card ?? null,
    withheld: m.withheld ?? false, deleted: m.deleted ?? false, sent_at: m.at,
  };
  await db.pool.query(
    `insert into messages (trip_id, message_id, seq, updated_seq, person_id, text, reply_to, deleted_at, payload)
     values ($1, $2, $3, $3, $4, $5, $6, $7, $8::jsonb)`,
    [T, m.id, m.seq, author.kind === 'person' ? m.by : null, m.text, m.replyTo ?? null, m.deleted ? new Date(m.at) : null, JSON.stringify(payload)],
  );
}

const ARJUN_SERVER_ID = 'U-Arjun-42';

/** The file as an earlier export left it, labelled by hand: message 4 still existed then; 8 and 9 did not. */
const EARLIER = [
  { i: 0, at: 0, kind: 'say', person: 'p_rahul', text: 'Goa on 6 to 9 Nov?', seq: 1, go_should_speak: false, quiet_ok: true },
  { i: 1, at: 3, kind: 'say', person: 'go', text: 'Want me to put the dates to a vote?', seq: 2, go_should_speak: 'either' },
  { i: 2, at: 300, kind: 'say', person: 'p_meher', text: "I'm veg btw", seq: 3, go_should_speak: false, quiet_ok: true, note: 'a fact: Meher is veg' },
  { i: 3, at: 360, kind: 'say', person: 'p_priya', text: 'oops wrong group', seq: 4, go_should_speak: false },
  {
    i: 4, at: 600, kind: 'say', person: benchPersonId(ARJUN_SERVER_ID), text: '@Go flights Friday, after 6 please', seq: 7, reply_to: 2, go_should_speak: true,
    recall: [{ question: "What can't Meher eat?", answer: 'veg', line: 2 }, { question: 'Who wrote in the wrong group?', answer: 'Priya', line: 3 }],
  },
].map((l) => JSON.stringify(l)).join('\n');

describe.skipIf(DATABASE_URL === undefined)('exporting a trip as a bench recording', () => {
  beforeAll(async () => {
    db = await withSchema();
    await seed({ id: 'm_1', seq: 1, by: 'p_rahul', text: 'Goa on 6 to 9 Nov?', at: '2026-10-07T10:00:00Z' });
    await seed({ id: 'm_2', seq: 2, by: 'go', text: 'Want me to put the dates to a vote?', at: '2026-10-07T10:00:03Z' });
    await seed({ id: 'm_3', seq: 3, by: 'p_meher', text: "I'm veg btw", at: '2026-10-07T10:05:00Z' });
    await seed({ id: 'm_4', seq: 4, by: 'p_priya', text: null, at: '2026-10-07T10:06:00Z', deleted: true });
    await seed({ id: 'm_5', seq: 5, by: 'p_kabir', text: null, at: '2026-10-07T10:07:00Z', withheld: true });
    await seed({ id: 'm_6', seq: 6, by: 'system', text: 'Arjun joined the trip', at: '2026-10-07T10:08:00Z' });
    await seed({ id: 'm_7', seq: 7, by: ARJUN_SERVER_ID, text: '@Go flights Friday, after 6 please', at: '2026-10-07T10:10:00Z', replyTo: 'm_3' });
    // A caption that somehow kept a card number: the export screens it again on the way out.
    await seed({ id: 'm_8', seq: 8, by: 'p_arjun', text: null, at: '2026-10-07T10:11:30Z', photoCaption: 'my card 4111 1111 1111 1111 lol' });
    await seed({
      id: 'm_9', seq: 9, by: 'go', text: null, at: '2026-10-07T10:12:00Z',
      card: { card_id: 'c_n1', kind: 'notice', tone: 'heads_up', title: 'Filling fast', body: 'Friday flights are filling fast.', fallback_text: 'Heads up: the Friday flights are filling fast' },
    });
  });
  afterAll(async () => {
    await db.drop();
  });

  it("keeps the hand labels by message number, moves recall probes with their messages, and leaves out what is not people's text", async () => {
    const r = await exportTrip(db.pool, T, EARLIER);
    const text = r.lines.join('\n');
    const chat = parseChat('real-trip', text);
    expect(checkChat(chat.lines)).toEqual([]);
    // P3's SayLine keeps seq, so the bench reads each line's real message number too.
    expect(chat.lines.map((l) => (l.kind === 'say' ? l.seq : null))).toEqual([1, 2, 3, 7, 8, 9]);
    const rows = r.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows.map((x) => x['seq'])).toEqual([1, 2, 3, 7, 8, 9]);
    expect(rows.map((x) => x['person'])).toEqual(['p_rahul', 'go', 'p_meher', benchPersonId(ARJUN_SERVER_ID), 'p_arjun', 'go']);
    expect(rows.map((x) => x['at'])).toEqual([0, 3, 300, 600, 690, 720]);
    expect(rows[0]).toMatchObject({ go_should_speak: false, quiet_ok: true });
    expect(rows[1]).toMatchObject({ go_should_speak: 'either' });
    expect(rows[2]).toMatchObject({ go_should_speak: false, quiet_ok: true, note: 'a fact: Meher is veg' });
    expect(rows[3]).toMatchObject({ reply_to: 2, go_should_speak: true, recall: [{ question: "What can't Meher eat?", answer: 'veg', line: 2 }] });
    expect(rows[4]).toMatchObject({ go_should_speak: 'either', note: NEW_LINE_NOTE });
    expect(rows[5]).toMatchObject({ text: 'Heads up: the Friday flights are filling fast' });
    expect(r).toMatchObject({ kept: 3, added: 1, skipped: 3, droppedProbes: ['seq 7: "Who wrote in the wrong group?" (its proof message is gone)'] });
    expect(text).not.toMatch(/4111[ -]?1111/);
    expect(text).not.toContain('oops');
    expect(text).not.toContain('joined the trip');
  });

  it("without a file, every person's line is new, and a line that calls Go should get an answer", async () => {
    const r = await exportTrip(db.pool, T, null);
    expect(checkChat(parseChat('real-trip', r.lines.join('\n')).lines)).toEqual([]);
    const rows = r.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows.filter((x) => x['person'] !== 'go').map((x) => [x['go_should_speak'], x['note']])).toEqual([
      ['either', NEW_LINE_NOTE], ['either', NEW_LINE_NOTE], [true, NEW_LINE_NOTE], ['either', NEW_LINE_NOTE],
    ]);
    expect(r).toMatchObject({ kept: 0, added: 4, skipped: 3, droppedProbes: [] });
  });

  it('keeps bench-shaped person ids and turns any other into the same short id every time', () => {
    expect(benchPersonId('p_rahul')).toBe('p_rahul');
    expect(benchPersonId(ARJUN_SERVER_ID)).toMatch(/^p_[0-9a-f]{12}$/);
    expect(benchPersonId(ARJUN_SERVER_ID)).toBe(benchPersonId(ARJUN_SERVER_ID));
    expect(benchPersonId('U-Arjun-43')).not.toBe(benchPersonId(ARJUN_SERVER_ID));
  });
});

describe('where the export goes', () => {
  it('writes to packages/bench/chats/private/ unless --out names another file', () => {
    expect(PRIVATE_EXPORT.replace(/\\/g, '/')).toMatch(/packages\/bench\/chats\/private\/real-trip\.jsonl$/);
    expect(exportPath(undefined, '/anywhere')).toBe(PRIVATE_EXPORT);
    expect(exportPath('mine.jsonl', '/tmp/work')).toBe('/tmp/work/mine.jsonl');
  });

  it('keeps the private folder out of git', () => {
    const ignore = readFileSync(new URL('../../../../../.gitignore', import.meta.url), 'utf8').split('\n').map((l) => l.trim());
    expect(ignore).toContain('packages/bench/chats/private/');
  });
});
