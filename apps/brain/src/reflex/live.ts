import { PASSED_SETS } from './live-gate.js';
import { QUESTION_NAMES, QUESTION_NUMBER, type QuestionName } from './questions.js';

export interface LiveMode {
  /** False only for "off": no Jev call at all. */
  call: boolean;
  live: ReadonlySet<QuestionName>;
}

/**
 * Reads REFLEX_LIVE in the switch's format (admin/switches.ts SWITCH_RULES): "q1,q2,q3" names the live
 * questions, an empty value keeps every question in shadow, and "off" makes no Jev call at all.
 */
export function parseLive(value: string, passed: readonly number[] = PASSED_SETS): LiveMode {
  const v = value.trim().toLowerCase();
  if (v === 'off') return { call: false, live: new Set() };
  const wanted = new Set<number>();
  for (const token of v.split(/[\s,]+/).filter(Boolean)) {
    const m = /^q(1[01]|[1-9])$/.exec(token);
    if (m) wanted.add(Number(m[1]));
  }
  return { call: true, live: new Set(QUESTION_NAMES.filter((q) => wanted.has(QUESTION_NUMBER[q]) && passed.includes(QUESTION_NUMBER[q]))) };
}
