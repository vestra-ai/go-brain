import type * as C from '@go/contract';
import type { z } from 'zod';
import type { DeskItem } from '../desk/desk.js';
import type { ToServerMethod, ToServerParams } from '../door/methods.js';
import type { ServerLink } from '../door/server-link.js';
import type { TripPack } from '../trips/pack.js';
import type { TurnLimits } from './context.js';

/** A quick tool: every lane registers its own. */
export interface QuickTool<A = unknown> {
  /** snake_case, unique. */
  name: string;
  /** One or two plain sentences for the model. */
  description: string;
  input: z.ZodType<A>;
  /** Must finish in a few seconds; slow work is start_task. */
  run(args: A, ctx: TurnCtx): Promise<unknown>;
  /**
   * A card tool that needs nothing back (show_options, put_to_vote, open_vote, post_notice): when every call in a reply
   * is one of these and each put its card up, the turn ends there. The reply's own text goes out with the cards, and no
   * model call is spent on a line.
   */
  endsTurn?: boolean;
}

export interface TurnCtx {
  tripId: string;
  turnId: string;
  /** Tags every request with this turn, so a rerun can see what it already did. */
  link: ServerLink;
  pack: TripPack;
  outcome: TurnOutcome;
  wake: DeskItem[];
  /** Cards to post with this turn's message; the first rides with the text, the rest follow it. */
  cards: C.Card[];
  /** A stable id for a write or a card, e.g. stableId('go_react'): the same on a rerun of this turn, so the Server does it once. */
  stableId(prefix: string): string;
  /** Aborts when the turn runs out of time (20 s); pass it to anything that waits. */
  signal: AbortSignal;
  /** Set from Context.addTurnRules (P6's proactive bar). The loop refuses a call to any other tool (stay_silent always works)
   *  with an error result; the tool definitions themselves never change, so the 1h cache holds. */
  allowedTools?: string[];
  /** false: the turn's final text is not posted (cards and reactions still go). */
  mayPostText?: boolean;
}

export interface TurnOutcome {
  spoke: boolean;
  silent: boolean;
  reactions: number;
  posts: string[];
  /** Messages a tool chose to ask about instead of recording (record_expense with an unclear amount): no ✅ goes on them. */
  asked?: string[];
  /** Messages this turn noted itself (a ✅ from the react tool, an expense recorded): a question in the same turn keeps their ✅. */
  noted?: string[];
}

export interface Tools {
  register(t: QuickTool<any>): void;
  list(): QuickTool<any>[];
}

export const STAY_SILENT = 'stay_silent';

/** tell_the_room on a refusal that is Go's own business (a record line, a notice): the group never hears about Go's tools. */
export const SAY_NOTHING = 'Say nothing about this in the chat, and carry on.';

export function createTools(): Tools {
  const byName = new Map<string, QuickTool<any>>();
  return {
    register(t) {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(t.name)) throw new Error(`tool name "${t.name}" must be snake_case`);
      if (byName.has(t.name)) throw new Error(`tool ${t.name} is already registered`);
      byName.set(t.name, t);
    },
    // Sorted, so the tool definitions are the same bytes whatever order the lanes registered in.
    list: () => [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** A ServerLink that tags every request with the turn (go_requests.turn_id). */
export function scopedLink(link: ServerLink, turnId: string): ServerLink {
  return {
    request<M extends ToServerMethod>(method: M, params: ToServerParams<M>, opts?: { timeoutMs?: number; turnId?: string }) {
      return link.request(method, params, { ...opts, turnId });
    },
    notify: (method, params) => link.notify(method, params),
    isOpen: () => link.isOpen(),
  };
}

export function makeTurnCtx(a: {
  tripId: string;
  turnId: string;
  link: ServerLink;
  pack: TripPack;
  wake: DeskItem[];
  signal: AbortSignal;
  /** Context.turnRules' answer for this turn's wake items; null or absent means no limits. */
  limits?: TurnLimits | null;
}): TurnCtx {
  const counts = new Map<string, number>();
  return {
    tripId: a.tripId,
    turnId: a.turnId,
    link: scopedLink(a.link, a.turnId),
    pack: a.pack,
    wake: a.wake,
    signal: a.signal,
    outcome: { spoke: false, silent: false, reactions: 0, posts: [], asked: [], noted: [] },
    cards: [],
    ...(a.limits ? { allowedTools: [...a.limits.tools], mayPostText: a.limits.mayPostText } : {}),
    stableId(prefix) {
      const n = (counts.get(prefix) ?? 0) + 1;
      counts.set(prefix, n);
      return `${prefix}_${a.turnId}_${n}`;
    },
  };
}
