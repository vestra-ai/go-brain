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

describe('the demo transcript', () => {
  it('puts every message, tap and beat in time order, a beat before what happened at its moment, and leaves out deleted lines', () => {
    const rows = transcriptRows({
      messages, people,
      acts: [{ at: T0 + 2_500, who: 'Priya', what: 'taps "vote" on the options card: done, "Putting it to a vote"' }],
      chapters: [{ at: T0, title: '0:00 Go joins' }, { at: T0 + 2_000, title: '2:20 The villas' }],
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

  it('renders the timings and the room as tables, with times from the start, no broken cells and no long dashes', () => {
    const text = renderTranscript({
      messages, people, acts: [], chapters: [{ at: T0, title: '0:00 Go joins' }],
      took: [{ beat: 'flights', ms: 60 }], runUrl: 'https://github.com/vestra-ai/go-brain/actions/runs/1', at: new Date(T0),
    });
    expect(text).toContain('Run: [https://github.com/vestra-ai/go-brain/actions/runs/1](https://github.com/vestra-ai/go-brain/actions/runs/1), 2026-10-06 10:00 UTC.');
    expect(text).toContain('| flights | 0.1 s |');
    expect(text).toContain('### 0:00 Go joins');
    expect(text).toContain('| 0.1 s | Go | Hi all, I am Go. |');
    expect(text).toContain("| 0.9 s | Meher | I'm veg btw \\| no fish (Go reacted ✅) |");
    expect(text).not.toMatch(/[—–]/);
  });

  it('compares two runs by their rows, not their times', () => {
    const a = renderTranscript({ messages, people, acts: [], chapters: [{ at: T0, title: 'x' }], took: [], runUrl: null, at: new Date(T0) });
    const later = messages.map((m) => ({ ...m, sent_at: new Date(Date.parse(m.sent_at) + 1_234).toISOString() }));
    const b = renderTranscript({ messages: later, people, acts: [], chapters: [{ at: T0, title: 'x' }], took: [{ beat: 'x', ms: 9 }], runUrl: null, at: new Date(T0 + 99) });
    expect(rowsOfFile(a)).toEqual(rowsOfFile(b));
    expect(rowsOfFile(a)).toContain("| Meher | I'm veg btw \\| no fish (Go reacted ✅) |");
    const changed = renderTranscript({ messages: messages.slice(1), people, acts: [], chapters: [], took: [], runUrl: null, at: new Date(T0) });
    expect(rowsOfFile(changed)).not.toEqual(rowsOfFile(a));
  });
});
