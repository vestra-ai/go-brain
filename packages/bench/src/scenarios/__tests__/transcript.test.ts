import type * as C from '@go/contract';
import { describe, expect, it } from 'vitest';
import { renderTranscript, rowsOfFile, transcriptRows } from '../transcript.js';

const T0 = Date.parse('2026-10-06T10:00:00.000Z');
const at = (ms: number): string => new Date(T0 + ms).toISOString();

function message(o: { seq: number; ms: number; author: C.Message['author']; text?: string | null } & Partial<C.Message>): C.Message {
  return {
    message_id: `m_${o.seq}`, seq: o.seq, updated_seq: o.seq, author: o.author, text: o.text ?? null, attachments: [], mentions_go: false,
    mentions: [], reactions: [], withheld: false, deleted: false, sent_at: at(o.ms), ...o,
  } as C.Message;
}

const people = [{ person_id: 'p_priya', name: 'Priya' }, { person_id: 'p_meher', name: 'Meher' }];
const messages: C.Message[] = [
  message({ seq: 1, ms: 100, author: { kind: 'go' }, text: 'Hi all, I am Go.' }),
  message({ seq: 2, ms: 900, author: { kind: 'person', person_id: 'p_meher' }, text: "I'm veg btw | no fish", reactions: [{ emoji: '✅', person_id: null }] }),
  message({ seq: 3, ms: 1_500, author: { kind: 'person', person_id: 'p_priya' }, text: 'gone', deleted: true }),
  message({
    seq: 4, ms: 2_000, author: { kind: 'go' }, text: 'Three villas.',
    card: { kind: 'options', card_id: 'c_1', fallback_text: 'Villas', title: 'Villas', option_kind: 'stay', options: [{ option_id: 'o1', title: 'Villa Sol' }, { option_id: 'o2', title: 'Casa Azul' }] } as unknown as C.Card,
  }),
];

const beatOf = new Map([['m_1', '0:00 Go joins'], ['m_2', '0:00 Go joins'], ['m_4', '2:20 The villas']]);

describe('the demo transcript', () => {
  it("puts every message and tap under its named beat, in the room's order, and leaves out deleted lines", () => {
    const rows = transcriptRows({
      messages, people, beatOf,
      acts: [{ at: T0 + 2_500, afterSeq: 4, beat: '2:20 The villas', who: 'Priya', what: 'taps "vote" on the options card: done, "Putting it to a vote"' }],
      beats: ['0:00 Go joins', '2:20 The villas'],
    });
    expect(rows.map((r) => (r.chapter ? `## ${r.what}` : `${r.who}: ${r.what}`))).toEqual([
      '## 0:00 Go joins',
      'Go: Hi all, I am Go.',
      "Meher: I'm veg btw | no fish (Go reacted ✅)",
      '## 2:20 The villas',
      'Go: Three villas. [options card: Villa Sol, Casa Azul]',
      'Priya: taps "vote" on the options card: done, "Putting it to a vote"',
    ]);
  });

  it("files a reply of Go's that lands after the next beat started under the beat that asked, and an unnamed line with the one before it", () => {
    const delayed: C.Message[] = [
      message({ seq: 1, ms: 0, author: { kind: 'person', person_id: 'p_priya' }, text: "@Go what can't Meher eat?" }),
      // Go's answer lands 50 ms after Meher's tap opened the next beat, and after it in the room too.
      message({ seq: 2, ms: 60, author: { kind: 'go' }, text: 'Meher is vegetarian.' }),
      message({ seq: 3, ms: 70, author: { kind: 'go' }, text: 'A line nobody waited for.' }),
    ];
    const rows = transcriptRows({
      messages: delayed, people, beats: ['4:10 Memory', '4:20 Forget me'],
      beatOf: new Map([['m_1', '4:10 Memory'], ['m_2', '4:10 Memory']]),
      acts: [{ at: T0 + 10, afterSeq: 1, beat: '4:20 Forget me', who: 'Meher', what: 'taps "Forget me in this trip" in the App' }],
    });
    expect(rows.map((r) => (r.chapter ? `## ${r.what}` : `${r.who}: ${r.what}`))).toEqual([
      '## 4:10 Memory',
      "Priya: @Go what can't Meher eat?",
      'Go: Meher is vegetarian.',
      'Go: A line nobody waited for.',
      '## 4:20 Forget me',
      'Meher: taps "Forget me in this trip" in the App',
    ]);
  });

  it('renders the timings and the room as tables, with times from the first row, no broken cells and no long dashes', () => {
    const text = renderTranscript({
      messages, people, acts: [], beats: ['0:00 Go joins'], beatOf,
      took: [{ beat: 'flights', ms: 60 }], runUrl: 'https://github.com/vestra-ai/go-brain/actions/runs/1', at: new Date(T0),
    });
    expect(text).toContain('Run: [https://github.com/vestra-ai/go-brain/actions/runs/1](https://github.com/vestra-ai/go-brain/actions/runs/1), 2026-10-06 10:00 UTC.');
    expect(text).toContain('| flights | 0.06 s |');
    expect(text).toContain('### 0:00 Go joins');
    expect(text).toContain('| 0.0 s | Go | Hi all, I am Go. |');
    expect(text).toContain("| 0.8 s | Meher | I'm veg btw \\| no fish (Go reacted ✅) |");
    expect(text).not.toMatch(/[—–]/);
  });

  it('compares two runs by their rows, not their times', () => {
    const a = renderTranscript({ messages, people, acts: [], beats: ['x'], beatOf: new Map(), took: [], runUrl: null, at: new Date(T0) });
    const later = messages.map((m) => ({ ...m, sent_at: new Date(Date.parse(m.sent_at) + 1_234).toISOString() }));
    const b = renderTranscript({ messages: later, people, acts: [], beats: ['x'], beatOf: new Map(), took: [{ beat: 'x', ms: 9 }], runUrl: null, at: new Date(T0 + 99) });
    expect(rowsOfFile(a)).toEqual(rowsOfFile(b));
    expect(rowsOfFile(a)).toContain("| Meher | I'm veg btw \\| no fish (Go reacted ✅) |");
    const changed = renderTranscript({ messages: messages.slice(1), people, acts: [], beats: [], beatOf: new Map(), took: [], runUrl: null, at: new Date(T0) });
    expect(rowsOfFile(changed)).not.toEqual(rowsOfFile(a));
    // A booking's reference is new on every run, so it is not compared.
    const ticket = (ref: string) => rowsOfFile(`| 1.0 s | Go | [ticket card: Booked: Villa Sol. Ref ${ref}. Free cancellation until 3 Nov.] |`);
    expect(ticket('IXG456974')).toEqual(ticket('IXG123456'));
  });
});
