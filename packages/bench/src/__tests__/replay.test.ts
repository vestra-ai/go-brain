import { describe, expect, it } from 'vitest';
import { parseChat } from '../chat.js';
import { planReplay, SimClock } from '../replay.js';

const chat = parseChat('gaps', [0, 1.5, 2.5, 7202.5, 7203].map((at, i) => JSON.stringify({ i, at, kind: 'say', person: 'p_rahul', text: `line ${i}`, go_should_speak: false })).join('\n'));

describe('planning a replay', () => {
  it('replays short gaps in real time, turns long ones into a quiet wait, and keeps chat time', () => {
    const plan = planReplay(chat, 3);
    expect(plan.map((s) => s.wait)).toEqual([{ kind: 'none' }, { kind: 'real', ms: 1500 }, { kind: 'real', ms: 1000 }, { kind: 'quiet' }, { kind: 'real', ms: 500 }]);
    expect(plan.map((s) => s.simS)).toEqual([0, 1.5, 2.5, 7202.5, 7203]);
  });

  it('keeps chat time on a clock the model stand-in reads', () => {
    const c = new SimClock();
    const read = c.now;
    c.s = 7200;
    expect(read()).toBe(7200);
  });
});
