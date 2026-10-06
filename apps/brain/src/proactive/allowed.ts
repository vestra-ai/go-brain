// The tools a proactive turn may use. A turn woken only by things Go noticed itself gets the actions the
// bar allowed and nothing else. A turn a person (or a tap, or a task) woke follows the normal rules: null.
import type { TurnLimits } from '../composer/context.js';
import type { DeskItem } from '../desk/desk.js';
import { PROACTIVE_KINDS, proactiveOf } from './payload.js';
import { ACTIONS, type Action } from './policy.js';

/** Tool names: `react` and `record` (P2), `post_notice` and `update_notice` (this plan). */
export const TOOLS_FOR: Readonly<Record<Action, readonly string[]>> = {
  react: ['react'],
  record: ['record'],
  update_card: ['update_notice'],
  pin: ['post_notice'],
  message: ['post_notice'],
};
/** Reading and staying silent are always fine. */
export const ALWAYS: readonly string[] = ['stay_silent', 'trip', 'person', 'recall'];

export interface TurnRules {
  allowed: Action[];
  tools: string[];
  mayPostText: boolean;
  /** Set when posts may only be pins: the people the bar named. */
  pinOnlyFor: string[] | null;
  dedupeKeys: string[];
}

export function rulesForTurn(wake: DeskItem[]): TurnRules | null {
  if (wake.length === 0) return null;
  // A person, a tap or a task woke the turn too: the normal rules.
  if (wake.some((item) => !(PROACTIVE_KINDS as readonly string[]).includes(item.kind))) return null;
  const payloads = wake.map(proactiveOf);
  // A proactive item whose payload cannot be read allows nothing but reading and staying silent.
  if (payloads.some((p) => p === null)) {
    return { allowed: [], tools: [...ALWAYS], mayPostText: false, pinOnlyFor: [], dedupeKeys: payloads.flatMap((p) => (p ? [p.candidate.dedupeKey] : [])) };
  }
  const allowed = new Set<Action>();
  const pins = new Set<string>();
  const dedupeKeys: string[] = [];
  let simulated = false;
  for (const p of payloads) {
    if (p === null) return null;
    for (const a of p.allowed) allowed.add(a);
    for (const id of p.forPersonIds) pins.add(id);
    dedupeKeys.push(p.candidate.dedupeKey);
    if (p.candidate.simulated) simulated = true;
  }
  const tools = new Set<string>(ALWAYS);
  for (const a of allowed) for (const t of TOOLS_FOR[a]) tools.add(t);
  // Simulated news goes out only on a notice card, which carries the "Simulated for the demo" label and the pins.
  const mayPostText = allowed.has('message') && !simulated;
  return {
    allowed: ACTIONS.filter((a) => allowed.has(a)),
    tools: [...tools],
    mayPostText,
    pinOnlyFor: !mayPostText && allowed.has('pin') ? [...pins] : null,
    dedupeKeys,
  };
}

/** Whether a proactive item in the wake (a timer, a watch, an opening) allowed this tool, also in a turn a person woke too. */
export function allowedByAnItem(wake: DeskItem[], tool: string): boolean {
  return wake.some((item) => proactiveOf(item)?.allowed.some((a) => TOOLS_FOR[a].includes(tool)) === true);
}

export function simulatedIn(wake: DeskItem[]): boolean {
  return wake.some((item) => proactiveOf(item)?.candidate.simulated === true);
}

/** What P1's turn takes through Context.addTurnRules (master §6.3, P1's TurnLimits): the tools this turn may call and whether its text is posted. */
export function composerRules(wake: DeskItem[]): TurnLimits | null {
  const r = rulesForTurn(wake);
  return r ? { tools: r.tools, mayPostText: r.mayPostText } : null;
}
