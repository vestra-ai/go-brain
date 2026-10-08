/**
 * The demo's transcript: what reached the room while the demo test played the run sheet, in order. Every message (people,
 * Go and the trip), every tap and every action outside the chat (votes, the vault, the admin page, the App's forget), each
 * with its time from the start and under the beat it belongs to, then the beat timings. The demo test names the beat of
 * every line it sends, every act and every reply of Go's it waits for, so a row's beat never depends on the clock. The demo
 * test writes it on every run, so docs/demo/transcript.md is generated, never written by hand.
 */
import type * as C from '@go/contract';

/** Something that happened outside the chat lines: a tap, a vote, the vault, the admin page, the App. */
export interface TranscriptAct {
  at: number;
  /** The room's last change number when it happened: it comes after the messages up to here and before any later one. */
  afterSeq: number;
  beat: string;
  who: string;
  what: string;
}

export interface TranscriptInput {
  messages: readonly C.Message[];
  people: ReadonlyArray<{ person_id: string; name: string }>;
  acts: readonly TranscriptAct[];
  /** The beats of the run sheet, in order. */
  beats: readonly string[];
  /**
   * The beat of each message, by message id: the beat that sent it, and for Go's message the beat whose cue it answers,
   * however late it lands. A message not named here goes with the message before it.
   */
  beatOf: ReadonlyMap<string, string>;
  /** Each beat's time from its cue to what had to happen, as the test measured it. */
  took: ReadonlyArray<{ beat: string; ms: number }>;
  /** Where the run happened: a CI run's address, or null for a run on someone's machine. */
  runUrl: string | null;
  at: Date;
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
/** Text in a table cell: one line, and a pipe cannot break the table. */
const cell = (s: string): string => oneLine(s).replace(/\|/g, '\\|');

/** A card, as a person sees it: its kind and the words on it. */
function cardLine(card: C.Card): string {
  switch (card.kind) {
    case 'options':
      return `[options card: ${card.options.map((o) => o.title).join(', ')}]`;
    case 'working':
      return `[working card: ${card.title}]`;
    case 'vote':
      return `[vote card: ${card.fallback_text}]`;
    case 'call':
      return `[call card: ${card.business}, ${card.state}]`;
    default:
      return `[${card.kind} card: ${card.fallback_text}]`;
  }
}

function messageLine(m: C.Message): string {
  const parts: string[] = [];
  if (m.text) parts.push(m.text);
  for (const a of m.attachments) {
    parts.push(a.kind === 'photo' ? `[photo: ${a.caption ?? 'no caption'}]` : a.kind === 'location' ? `[location: ${a.name ?? `${a.lat}, ${a.lng}`}]` : `[file: ${a.name}]`);
  }
  if (m.card) parts.push(cardLine(m.card));
  const goReacted = m.reactions.filter((r) => r.person_id == null).map((r) => r.emoji);
  if (goReacted.length > 0) parts.push(`(Go reacted ${goReacted.join(' ')})`);
  return parts.join(' ');
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
/** Beats are timed to the hundredth: most land in well under a tenth of a second. */
const secs2 = (ms: number): string => `${(ms / 1000).toFixed(2)} s`;

export type TranscriptRow = { chapter: true; what: string } | { chapter: false; at: number; who: string; what: string };

/**
 * The rows in order: each beat's heading, then what belongs to it in the room's order (change numbers, not times). Two
 * runs of the same demo give the same rows, so the demo test checks the committed transcript against a fresh run with this.
 */
export function transcriptRows(t: Pick<TranscriptInput, 'messages' | 'people' | 'acts' | 'beats' | 'beatOf'>): TranscriptRow[] {
  const name = new Map(t.people.map((p) => [p.person_id, p.name]));
  type Item = { pos: number; at: number; who: string; what: string };
  const byBeat = new Map<string, Item[]>();
  const add = (beat: string, item: Item): void => {
    byBeat.set(beat, [...(byBeat.get(beat) ?? []), item]);
  };
  let beat = '';
  for (const m of [...t.messages].sort((a, b) => a.seq - b.seq)) {
    beat = t.beatOf.get(m.message_id) ?? beat;
    if (m.deleted) continue;
    add(beat, {
      pos: m.seq,
      at: Date.parse(m.sent_at),
      who: m.author.kind === 'go' ? 'Go' : m.author.kind === 'system' ? 'Trip' : (name.get(m.author.person_id) ?? m.author.person_id),
      what: messageLine(m),
    });
  }
  // Half a step after its change number, so an act never ties with a message.
  for (const a of t.acts) add(a.beat, { pos: a.afterSeq + 0.5, at: a.at, who: a.who, what: a.what });
  const rows: TranscriptRow[] = [];
  // What came before the first beat, then the beats in the run sheet's order.
  for (const b of new Set(['', ...t.beats, ...byBeat.keys()])) {
    if (b !== '') rows.push({ chapter: true, what: b });
    for (const i of (byBeat.get(b) ?? []).sort((x, y) => x.pos - y.pos)) rows.push({ chapter: false, at: i.at, who: i.who, what: i.what });
  }
  return rows;
}

export function renderTranscript(t: TranscriptInput): string {
  const rows = transcriptRows(t);
  const times = rows.flatMap((r) => (r.chapter ? [] : [r.at]));
  const start = times.length > 0 ? Math.min(...times) : 0;
  const out: string[] = [
    '# The demo, as the test plays it',
    '',
    'Generated by the demo test (`packages/bench/src/scenarios/__tests__/demo.test.ts`). It plays the run sheet against the real Go with every lane registered. Every outside service is faked, and a scripted model (the director, `packages/bench/src/scenarios/director.ts`) makes the calls Go would make. So this shows what reaches the room and in what order, not how a real model words things. Each card reads as it ended up: a pay card that was paid reads as paid. Do not edit it by hand: regenerate it with `pnpm --filter @go/bench demo-transcript` (it needs `DATABASE_URL`), or take `demo-transcript.md` from the `bench-report` artifact of a CI run.',
    '',
    `Run: ${t.runUrl ? `[${t.runUrl}](${t.runUrl})` : 'a local run'}, ${t.at.toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
    '',
    '## Beat timings',
    '',
    'From each cue to what had to happen, on the wall clock of the run.',
    '',
    '| Beat | Took |',
    '|---|---|',
    ...t.took.map((b) => `| ${cell(b.beat)} | ${secs2(b.ms)} |`),
    '',
    '## The room',
  ];
  let open = false;
  for (const r of rows) {
    if (r.chapter) {
      out.push('', `### ${cell(r.what)}`, '', '| Time | Who | What |', '|---|---|---|');
      open = true;
      continue;
    }
    if (!open) {
      out.push('', '| Time | Who | What |', '|---|---|---|');
      open = true;
    }
    out.push(`| ${secs(r.at - start)} | ${cell(r.who)} | ${cell(r.what)} |`);
  }
  return `${out.join('\n')}\n`;
}

/**
 * The rows of a transcript file without what changes from run to run: the time column, and a booking's reference (the
 * fake ixigo makes a new one for each hold). This is what the drift check compares.
 */
export function rowsOfFile(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => l.startsWith('### ') || /^\| [\d.]+ s \|/.test(l))
    .map((l) => (l.startsWith('### ') ? l : l.replace(/^\| [\d.]+ s \|/, '|').replace(/\bRef [A-Z0-9-]+/g, 'Ref (a booking reference)')));
}
