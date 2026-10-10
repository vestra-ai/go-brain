import type { DeskItem } from '../desk/desk.js';
import { amountsIn } from '../money/expenses.js';
import { looksLikeMoney, saysMoneyMoved } from '../reflex/money-line.js';
import type { TripPack } from '../trips/pack.js';
import { flexibleOf } from '../trips/votes.js';
import { answersToGo, inlineData, personName } from './fence.js';

/** For a line that says someone paid but no amount: record_expense would ask, but with no amount the model never calls it. */
export const ASK_HOW_MUCH =
  "This says someone paid but not how much: ask them, in one short line, how much it was and who it was for. Don't record anything yet.";

/**
 * Three rules for Go speaking on the group's chat unasked, read by both ways it does (the quiet note on a line the reflex
 * was unsure was for Go, and proactive's chime-in on one it was sure was not). From the 10 Oct live proof (trip
 * t_try_138755ec9655): Go asked about dates the trip already had three times, called Saudades "locked in" when 3 of 5
 * liked it with no vote, and searched stays on one person's "Saudades looks perfect to me".
 */
export const CHIME_RULES =
  'Answer a question the trip already answers once ("Dates are set: 6 to 9 Nov ✅. Want to change them?"), then never raise ' +
  'it again, even while the record lists it as open. When part of the group backs an option that is not a vote yet, offer a ' +
  'vote with the count ("3 of you said yes to Saudades. Want me to put it to a vote?"): never say locked in, confirmed or ' +
  'decided until a vote closes or the organizer decides, and a "Leaning" line in the record is not a decision. Run a search ' +
  'only when someone asks for one ("find", "show", "any trains"); one person liking something ("Saudades looks perfect to ' +
  'me") is never a search.';

export function renderMessageWake(item: DeskItem, pack: TripPack): string {
  const p = (item.payload ?? {}) as { messageId?: string; namesGo?: boolean; asksGo?: boolean };
  const m = pack.messages.find((x) => x.message_id === (p.messageId ?? item.ref));
  if (!m) return 'a message that was deleted since';
  const a = m.author;
  let who = 'Go';
  if (a.kind === 'person') {
    const id = a.person_id;
    who = personName(pack.trip.people.find((x) => x.person_id === id)?.name ?? 'Someone who left');
  }
  const line = `message #${m.seq} from ${who}${p.namesGo ? ', it names you' : p.asksGo ? ', it asks you without your name' : ''}`;
  return a.kind === 'person' && m.text && looksLikeMoney(m.text) && amountsIn(m.text).length === 0 ? `${line}. ${ASK_HOW_MUCH}` : line;
}

/**
 * Said once under "why you woke" when a person's message woke Go without naming it: the turn decides, and its default is
 * to jump in wherever it can add anything (Keshav, 10 Oct: "go can interfere in most of the messages"), silent only on
 * pure banter, an acknowledgement, or when it spoke last and nobody answered (never two messages in a row). Here, after
 * the cache point, not in GO_RULES: the rules' cached bytes never change. A line saying someone paid or owes keeps its own instruction (record_expense from the rules, or ASK_HOW_MUCH); a
 * price or a budget ("villa under 8k a head") gets the note like any other line. A line by someone who named Go in
 * the same turn goes on with what they asked ("@Go one thing" ... "is there a good bakery near Anjuna?"), and so does a
 * line by someone answering a question Go asked them (answersToGo): it is a reply to Go, not the group talking.
 */
export function quietNote(items: DeskItem[], pack: TripPack): string | null {
  const messages = items.flatMap((item) => {
    if (item.kind !== 'message') return [];
    const p = (item.payload ?? {}) as { messageId?: string; namesGo?: boolean; asksGo?: boolean };
    const m = pack.messages.find((x) => x.message_id === (p.messageId ?? item.ref));
    // A line the quick read is sure asks Go is an ask (askNote), as one that names Go.
    return m && m.author.kind === 'person' ? [{ m, person: m.author.person_id, namesGo: p.namesGo === true || p.asksGo === true }] : [];
  });
  const answers = answersToGo(pack);
  const named = new Set(messages.filter((x) => x.namesGo || answers.has(x.m.message_id)).map((x) => x.person));
  const seqs = messages.filter((x) => !named.has(x.person) && !saysMoneyMoved(x.m.text)).map((x) => x.m.seq);
  if (seqs.length === 0) return null;
  const refs = seqs.map((s) => `#${s}`);
  const one = refs.length === 1;
  const which = one ? `${refs[0]} doesn't name you, so it is` : `${refs.slice(0, -1).join(', ')} and ${refs[refs.length - 1]} don't name you, so they are`;
  return (
    `${which} the group talking, unless it asks for something you do (logging in to ixigo, a search, a booking, a vote, a ` +
    'reminder, someone checking something): that is an ask even without your name, so do it, or answer it in one line. ' +
    'Either way, jump in whenever you can add anything: answer a question with facts from ixigo or the trip (weather, ' +
    'distances, timings, prices, the record, votes, money, places) unless a person already answered it; offer the lookup ' +
    'or the next step in one line; flag a clash with the plan or the record; note a need or a preference with a ✅ and use ' +
    'it; a quick useful fact. When the group agrees dates on a trip with a place, offer stays in one line (search_stays ' +
    'only when someone asks to see them); when it agrees a place, offer the next step in one line; when people disagree, ' +
    `offer a vote. ${CHIME_RULES} ` +
    "Someone saying what they'd like for the trip (a place, food, a vibe) gets a ✅ and at most one short offer, never a search. Who brings, pays or does " +
    "what is the friends' to settle unless the record already says, and the App gives anyone asking what they missed " +
    'their own catch-up. Call stay_silent only for pure banter or an acknowledgement ("haha", "ok", "see you"), a side ' +
    'conversation not about the trip, something a person already answered, or when your last message has had no reply ' +
    'from a person since: never two messages in a row.'
  );
}

/**
 * The order for a turn that a message naming Go woke: an ask. Said at the very end of the prompt (context.addEndNote),
 * after the newest messages, as the last thing read before the reply. Under "why you woke" it changed nothing (run
 * 37582427795: still three sentences, writing time 1.30 s before and 1.31 s after), read as part of the turn's state
 * while the rules said one to three. A list, a recap or a comparison may be longer, an offer the rules call for (a vote
 * instead of paying) stays, and what someone said keeps its message number, which recall's answers cite. The reply starts
 * with the answer: on staging (10 Oct) a recap began "Priya asked for a recap, so a short list is fine. I'll keep each
 * person's own facts without budgets or names tied to them.", this note's and the rules' permissions said back as working.
 */
export function askNote(items: DeskItem[], pack: TripPack): string | null {
  const seqs = items.flatMap((item) => {
    const asked = item.payload as { namesGo?: boolean; asksGo?: boolean } | null;
    if (item.kind !== 'message' || (asked?.namesGo !== true && asked?.asksGo !== true)) return [];
    const p = (item.payload ?? {}) as { messageId?: string };
    const m = pack.messages.find((x) => x.message_id === (p.messageId ?? item.ref));
    return m && m.author.kind === 'person' ? [m.seq] : [];
  });
  if (seqs.length === 0) return null;
  const refs = seqs.map((s) => `#${s}`);
  const which = refs.length === 1 ? refs[0] : `${refs.slice(0, -1).join(', ')} and ${refs[refs.length - 1]}`;
  return (
    `Answer ${which} in one or two short sentences: the answer itself, no extra tips and no offer to do more unless your rules call for one. ` +
    'A list, a recap or a comparison they asked for may be longer. When you cite what someone said, keep its message number. ' +
    'Start with the answer: never with what they asked for, why your answer takes the shape it does, or what you will leave out.'
  );
}

export function renderTripChangeWake(item: DeskItem, pack: TripPack): string {
  const p = (item.payload ?? {}) as { type?: string; decisionId?: string };
  if (p.type === 'decision.closed' && p.decisionId) {
    const d = pack.trip.decisions.find((x) => x.decision_id === p.decisionId);
    if (!d) return 'a vote closed';
    const won = d.result_index != null ? d.options[d.result_index] : undefined;
    // The counts from the Server's own tally, so the result line never gets a number wrong.
    const flexible = flexibleOf(d);
    const tally = `${d.options.map((op, k) => `${inlineData(op.label)} ${d.tally[k] ?? 0}`).join(', ')}; ${d.voted} of ${d.of} voted${flexible ? `, ${flexible} flexible` : ''}`;
    // An option is only a label (DecisionOption has no dates or place fields), so the model reads the winner and saves it.
    return won
      ? `the vote ${inlineData(d.question)} closed: ${inlineData(won.label)} won (${tally}). ` +
          "If it settled the trip's dates, save them with update_trip first (days without a year are the next ones from today). If it settled where to stay (an area or a place to stay), save the winner as the stay, never as the destination: the destination is where the trip goes. " +
          'Then say the result in one line, using exactly these numbers, and the next step.'
      : `the vote ${inlineData(d.question)} closed with no clear winner (${tally}). Ask the group how to settle it.`;
  }
  return `the trip changed (${p.type ?? item.ref})`;
}

export function renderSetupWake(item: DeskItem): string {
  if (item.ref === 'greet') {
    return (
      'you just joined this trip. Say hello to the group in one or two short lines and what you can do for them ' +
      '(find stays and flights, run votes, keep the plan, book when the group agrees). If someone asked you something ' +
      'in this turn, answer that first and keep the hello to a few words. Do not open a vote unless someone asks for one: ' +
      'votes come later, when the group is choosing.'
    );
  }
  return `setup: ${item.ref}`;
}
