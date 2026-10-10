import type * as C from '@go/contract';
import { z } from 'zod';
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
  /** How long the loop waits for it; 8 s when absent. The travel searches take up to 12 s on a sleeping box. */
  timeoutMs?: number;
  /**
   * A card tool that needs nothing back (show_options, put_to_vote, open_vote, post_notice): when every call in a reply
   * is one of these and each put its card up, the turn ends there, and no model call is spent on a line. A card tool
   * that takes a `line` pushes it to ctx.lines with its card: the lines are the reply's words, and its free text (written
   * before the card went up, so often the model's working) is never posted.
   */
  endsTurn?: boolean;
  /**
   * The words a reply would use to say this tool's work was done ("Noted"). When the tool was called this turn and refused
   * every time, a sentence with them is not posted (sanitize.ts withoutRefused): Go never claims what it didn't do. A
   * turn that didn't call the tool keeps them.
   */
  claims?: RegExp;
  /**
   * When two or more calls in one reply use this same summary (the searches), the loop adds its line after their results:
   * a tally the model reads once, in code, instead of counting results itself.
   */
  summarizeRound?(results: Array<{ content: string; isError: boolean }>): string | null;
  /**
   * The model called a tool that doesn't exist, named after something of this tool's own (a recipe id for the ixigo
   * tool): what to call instead, as the call's error. Undefined for any other name.
   */
  misnamed?(name: string): string | undefined;
}

/** A 1.1 quick reply: the contract exports its schema only. */
export type QuickReply = z.infer<typeof C.QuickReply>;

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
  /** The `line` of each card tool whose card went up (show_options, put_to_vote, open_vote): the words posted with it. */
  lines: string[];
  /** A stable id for a write or a card, e.g. stableId('go_react'): the same on a rerun of this turn, so the Server does it once. */
  stableId(prefix: string): string;
  /** Aborts when the turn runs out of time (20 s); pass it to anything that waits. */
  signal: AbortSignal;
  /** Set from Context.addTurnRules (P6's proactive bar). The loop refuses a call to any other tool (stay_silent always works)
   *  with an error result; the tool definitions themselves never change, so the 1h cache holds. */
  allowedTools?: string[];
  /** false: the turn's final text is not posted (cards and reactions still go). */
  mayPostText?: boolean;
  /** The tools the model asked for in the round now running, set by the loop before they run. */
  roundTools?: string[];
  /** Set by a tool that put up its card and its line itself (a finished plain search): the turn ends on them. */
  answered?: boolean;
  /** 1.1 quick replies under this turn's message (offer_replies): each tap comes back as the tapper's own message. */
  quickReplies?: QuickReply[];
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

/** A card tool's `line` (show_options, put_to_vote, open_vote): the message posted with its card. CARD_LINE says how it reads. */
export const CardLineArg = z
  .string()
  .min(1)
  .max(1_000)
  .describe('The message posted with the card, the only words the group sees from this reply: the finished answer to whoever asked, in one or two sentences.');

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
    lines: [],
    ...(a.limits ? { allowedTools: [...a.limits.tools], mayPostText: a.limits.mayPostText } : {}),
    stableId(prefix) {
      const n = (counts.get(prefix) ?? 0) + 1;
      counts.set(prefix, n);
      return `${prefix}_${a.turnId}_${n}`;
    },
  };
}
