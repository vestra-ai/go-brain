/**
 * The director: a scripted model for the demo test. It answers each cue with the tool calls Go would make, so the test
 * proves the plumbing (every lane, card, key and fake) and not the model's judgement. It speaks the stream shape P1's
 * composer loop reads (an async iterable, then finalMessage()). Of the side passes it answers P2's notes pass with the
 * facts the demo's lines hold, and every other side pass with an empty note.
 */
import type { TripSnapshot } from '@go/contract';
import type { AnthropicLike } from '@go/brain/dist/composer/anthropic.js';
import { afterTools, newSince, rightNow } from '@go/brain/dist/testing/start-room.js';
import { chatLinesIn } from '../policy-model.js';
import type { Block, MessageBody } from '../requests.js';
import { DEMO_CAP_MINOR, DEMO_DATE, DEMO_DIVE_SHOP, DEMO_FACT_LINES, DEMO_PAYER, DEMO_WATCH } from './demo.js';

/** What Go says on each beat. The test checks these exact words reach the room. */
export const DIRECTOR_WORDS = {
  greeting: 'Hi all, I am Go. Ask me for flights, stays, a vote or a call to a place.',
  flights: 'Friday evening flights from Delhi, all after 6 pm, checked just now.',
  noFlights: 'No flights came back just now. Want me to look at trains?',
  villaStarted: 'On it. Looking for villas with a pool in North Goa, near the beach.',
  callAnnounce: `I'll call ${DEMO_DIVE_SHOP.name} to ask if they can take five of us on Sunday morning.`,
  weather: 'November is dry and sunny in Goa, around 32 degrees by day. Good beach weather.',
  villasShown: 'Three villas that fit, with their prices for the whole stay.',
  mandate: 'Villa Sol won. Rahul, tap Yes, book it when you are ready.',
  refusal: "I can't pay without a group vote and Rahul's OK on his phone. Want me to put scuba to a vote?",
} as const;

interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}
interface Reply {
  text?: string;
  tools?: ToolCall[];
}

export interface Director {
  client: AnthropicLike;
  /** Every composer request, in order. */
  bodies: MessageBody[];
  /** Every side pass (messages.create). */
  sideBodies: MessageBody[];
  /** Every tool call the director made. */
  calls: ToolCall[];
  /** Every tool result the director was shown, with the tool that made it. */
  results: Array<{ name: string; content: string }>;
}

const silent = (reason: string): Reply => ({ tools: [{ name: 'stay_silent', input: { reason } }] });
const blocks = (content: string | Block[] | undefined): Block[] => (Array.isArray(content) ? content : []);
const textOf = (content: string | Block[] | undefined): string =>
  typeof content === 'string' ? content : blocks(content).filter((b) => b['type'] === 'text').map((b) => String(b['text'] ?? '')).join('\n');

/** The results of the round that just ran, each with the name of the tool that made it. */
export function lastResults(body: MessageBody): Array<{ name: string; content: string }> {
  const last = body.messages[body.messages.length - 1];
  const prev = body.messages[body.messages.length - 2];
  const names = new Map(blocks(prev?.content).filter((b) => b['type'] === 'tool_use').map((b) => [String(b['id']), String(b['name'])]));
  return blocks(last?.content)
    .filter((b) => b['type'] === 'tool_result')
    .map((b) => ({ name: names.get(String(b['tool_use_id'])) ?? '', content: typeof b['content'] === 'string' ? b['content'] : JSON.stringify(b['content']) }));
}

function lastAssistantText(body: MessageBody): string {
  for (let k = body.messages.length - 1; k >= 0; k--) {
    const m = body.messages[k];
    if (m?.role !== 'assistant') continue;
    if (typeof m.content === 'string') return m.content;
    return blocks(m.content).filter((b) => b['type'] === 'text').map((b) => String(b['text'] ?? '')).join('');
  }
  return '';
}

/** A string field of a tool result's JSON, or null. */
function field(content: string, key: string): string | null {
  try {
    const v = JSON.parse(content) as Record<string, unknown> | null;
    const x = v?.[key];
    return typeof x === 'string' ? x : null;
  } catch {
    return null;
  }
}

/** "Priya, Arjun, Meher and Kabir". */
const listOf = (names: string[]): string => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** Who still owes the payer, read from the trip's newest expense (split equally, as P5 records it). */
function whoOwes(trip: TripSnapshot | null): string {
  const e = trip?.expenses.at(-1);
  if (!trip || !e) return 'Nobody has paid for anything yet.';
  const name = (id: string): string => trip.people.find((p) => p.person_id === id)?.name ?? 'Someone';
  const owing = e.split_person_ids.filter((id) => id !== e.paid_by_person_id).map(name);
  if (owing.length === 0) return 'Everyone is square.';
  const each = Math.round(e.amount_minor / e.split_person_ids.length / 100).toLocaleString('en-IN');
  return `${listOf(owing)} ${owing.length === 1 ? "hasn't" : "haven't"} paid ${name(e.paid_by_person_id)} back yet: ₹${each} each.`;
}

/** P2's notes pass: the fact each demo line holds, cited by its number, as P2's NOTES_RULES ask. */
const NOTE_LINE = /^#(\d+) \[person [^|\]]*\| (p_[a-z0-9_]+)\]: (.*)$/gm;
function notesReply(body: MessageBody): string {
  const user = body.messages.filter((m) => m.role === 'user').map((m) => textOf(m.content)).join('\n');
  const facts: Array<{ person_id: string; topic: string; text: string; message: number }> = [];
  for (const x of user.matchAll(NOTE_LINE)) {
    const line = DEMO_FACT_LINES.find((l) => l.person === x[2] && l.text === x[3]);
    if (line?.fact) facts.push({ person_id: line.person, topic: line.fact.topic, text: line.fact.text, message: Number(x[1]) });
  }
  return JSON.stringify({ facts, lines: [] });
}

function messageOf(id: string, model: string, r: Reply, n: number) {
  const tools = r.tools ?? [];
  return {
    id, type: 'message', role: 'assistant', model,
    content: [
      ...(r.text ? [{ type: 'text', text: r.text, citations: null }] : []),
      ...tools.map((t, k) => ({ type: 'tool_use', id: `toolu_demo_${n}_${k}`, name: t.name, input: t.input, caller: { type: 'direct' } })),
    ],
    stop_reason: tools.length > 0 ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    container: null,
    usage: {
      input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      cache_creation: null, server_tool_use: null, service_tier: 'standard', inference_geo: null,
    },
  };
}

export function createDirector(o: { trip: () => TripSnapshot | null }): Director {
  const bodies: MessageBody[] = [];
  const sideBodies: MessageBody[] = [];
  const calls: ToolCall[] = [];
  const results: Array<{ name: string; content: string }> = [];
  const done = { mandate: false, notice: false };

  function afterRound(body: MessageBody, ran: Array<{ name: string; content: string }>): Reply {
    const now = rightNow(body);
    const result = (name: string) => ran.find((r) => r.name === name);
    const searched = result('search_flights');
    if (searched) {
      const id = field(searched.content, 'results_id');
      // The line goes in the card tool's line (Go's rules), and the turn ends on the card: no call for a line.
      return id
        ? { tools: [{ name: 'show_options', input: { results_id: id, title: 'Friday flights, Delhi to Goa', line: DIRECTOR_WORDS.flights } }] }
        : { text: DIRECTOR_WORDS.noFlights };
    }
    // The villas go up as options only: the group opens the vote with the card's own "Put it to a vote" (the stage's way).
    // Only lines that arrived meanwhile bring Go back after a card: it says its line again.
    if (result('show_options')) return { text: now.includes('finished with') ? DIRECTOR_WORDS.villasShown : DIRECTOR_WORDS.flights };
    if (result('start_task')) return { text: DIRECTOR_WORDS.villaStarted };
    if (result('set_mandate')) return { text: DIRECTOR_WORDS.mandate };
    if (result('ask_to_pay')) return { text: DIRECTOR_WORDS.refusal };
    // call_business says what it needs to itself; post_notice ends the turn on its card.
    return silent('done');
  }

  function firstRound(body: MessageBody): Reply {
    const now = rightNow(body);
    const fresh = newSince(body);
    if (now.includes('you just joined this trip')) return { text: DIRECTOR_WORDS.greeting };
    // People's new lines first: a wake's words can stay in "right now" after its moment has passed.
    if (/ignore (?:the|your) rules|rules chhod/i.test(fresh)) {
      // A model talked into it: it tries the only paying tool there is.
      return { tools: [{ name: 'ask_to_pay', input: { decision_id: 'd_scuba', option_ref: 'opt_scuba', purpose: 'Scuba for everyone' } }] };
    }
    if (/\bweather\b/i.test(fresh)) return { text: DIRECTOR_WORDS.weather };
    if (/flights delhi to goa/i.test(fresh)) {
      return { tools: [{ name: 'search_flights', input: { from: 'Delhi', to: 'Goa', date: DEMO_DATE, depart_after: '18:00' } }] };
    }
    if (/find us a villa/i.test(fresh)) {
      return {
        tools: [{
          name: 'start_task',
          input: {
            title: 'Finding villas with a pool in North Goa',
            goal: "Find villas with a pool in North Goa for 6 to 9 Nov for 5 people, under 8,000 rupees a head for the stay, near the beach. Use Go's search_stays first.",
            returns: 'stays',
            steps: ['Search stays in North Goa', 'Keep villas with a pool', 'Read the reviews', 'Pick the best three'],
            context: { area: 'North Goa', budget_per_head_inr: 8000, must_have: ['pool', 'near the beach'] },
            asked_by: 'Priya',
          },
        }],
      };
    }
    if (/call the dive shop/i.test(fresh)) {
      return {
        tools: [{
          name: 'call_business',
          input: {
            business: DEMO_DIVE_SHOP.name,
            goal: 'Ask if they can take five of us diving on Sunday 8 Nov in the morning',
            announce: DIRECTOR_WORDS.callAnnounce,
            facts_allowed: ['Group of five', 'Staying in North Goa from 6 to 9 November'],
          },
        }],
      };
    }
    const asked = /what can't (\w+) eat/i.exec(fresh)?.[1];
    if (asked) {
      const proof = chatLinesIn(body).find((l) => l.name === asked && /\bveg\b/i.test(l.text));
      const food = proof ? `${asked} is vegetarian, so no seafood shacks. ${asked} said so in #${proof.seq}.` : `I don't know yet what ${asked} can't eat.`;
      return { text: /who hasn't paid/i.test(fresh) ? `${food} ${whoOwes(o.trip())}` : food };
    }
    // Wakes with no new line from a person.
    if (!done.notice && now.includes('Simulated for the demo')) {
      done.notice = true;
      return {
        tools: [{
          name: 'post_notice',
          input: { tone: 'heads_up', title: 'Your flight is 2 hours late', body: 'You now land at 10:45 pm but your cab is at 9. Want me to move it to 11?', for_person_ids: [DEMO_WATCH.person_id] },
        }],
      };
    }
    if (!done.mandate && now.includes(' closed: ')) {
      const decision = o.trip()?.decisions.find((x) => x.status === 'closed' && !x.mandate && x.result_index != null);
      if (decision && decision.result_index != null) {
        done.mandate = true;
        return {
          tools: [{
            name: 'set_mandate',
            input: { decision_id: decision.decision_id, choice_index: decision.result_index, cap_minor: DEMO_CAP_MINOR, refundable_only: false, payer_person_id: DEMO_PAYER },
          }],
        };
      }
    }
    const resultsId = /results_id "([^"]+)"/.exec(now)?.[1];
    if (resultsId && now.includes('finished with')) {
      return { tools: [{ name: 'show_options', input: { results_id: resultsId, title: 'Villas with a pool in North Goa', line: DIRECTOR_WORDS.villasShown } }] };
    }
    return silent('nothing for Go');
  }

  function decide(body: MessageBody): Reply {
    if (afterTools(body)) {
      const ran = lastResults(body);
      results.push(...ran);
      return afterRound(body, ran);
    }
    // P1's check just before posting: new lines came in, and Go was already answering.
    if (body.messages.length > 1) {
      const said = lastAssistantText(body);
      return said ? { text: said } : silent('nothing new to add');
    }
    return firstRound(body);
  }

  const client = {
    messages: {
      stream(body: MessageBody, options?: { signal?: AbortSignal }) {
        const n = bodies.length;
        bodies.push(JSON.parse(JSON.stringify(body)) as MessageBody);
        const r = decide(body);
        for (const t of r.tools ?? []) calls.push(t);
        const message = messageOf(`msg_demo_${n}`, body.model, r, n);
        return {
          async *[Symbol.asyncIterator]() {
            if (options?.signal?.aborted) throw new Error('aborted');
            if (r.text) yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: r.text } };
            for (let k = 0; k < (r.tools ?? []).length; k++) {
              yield { type: 'content_block_delta', index: k + 1, delta: { type: 'input_json_delta', partial_json: '{}' } };
            }
          },
          async finalMessage() {
            return message;
          },
          abort() {},
        };
      },
      async create(body: MessageBody) {
        sideBodies.push(JSON.parse(JSON.stringify(body)) as MessageBody);
        const system = typeof body.system === 'string' ? body.system : textOf(body.system);
        const text = system.includes('You keep notes for Go') ? notesReply(body) : '{}';
        return messageOf(`msg_side_${sideBodies.length}`, body.model, { text }, -1);
      },
    },
  };
  return { client: client as unknown as AnthropicLike, bodies, sideBodies, calls, results };
}
