import type { DeskItem } from '../desk/desk.js';
import type { Message } from '../door/methods.js';
import { amountsIn } from '../money/expenses.js';
import { looksLikeMoney, saysMoneyMoved } from '../reflex/money-line.js';
import { plainlyNamesGo } from '../trips/names-go.js';
import type { TripPack } from '../trips/pack.js';
import { flexibleOf } from '../trips/votes.js';
import { answersToGo, followsGoAnswer, inlineData, personName } from './fence.js';

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
  'decided until a vote closes, and a "Leaning" line in the record is not a decision. Run a search ' +
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
 * line by someone answering a question Go asked them (answersToGo), or going on from Go's answer to them (followsGoAnswer):
 * it is a reply to Go, not the group talking.
 */
export function quietNote(items: DeskItem[], pack: TripPack): string | null {
  const messages = items.flatMap((item) => {
    if (item.kind !== 'message') return [];
    const p = (item.payload ?? {}) as { messageId?: string; namesGo?: boolean; asksGo?: boolean; actionable?: boolean };
    const m = pack.messages.find((x) => x.message_id === (p.messageId ?? item.ref));
    // A line the quick read is sure asks Go is an ask (askNote), as one that names Go.
    return m && m.author.kind === 'person' ? [{ m, person: m.author.person_id, namesGo: p.namesGo === true || p.asksGo === true, actionable: p.actionable === true }] : [];
  });
  const answers = answersToGo(pack);
  const follows = followsGoAnswer(pack);
  const named = new Set(messages.filter((x) => x.namesGo || answers.has(x.m.message_id) || follows.has(x.m.message_id)).map((x) => x.person));
  const seqs = messages.filter((x) => !named.has(x.person) && !saysMoneyMoved(x.m.text)).map((x) => x.m.seq);
  if (seqs.length === 0) return null;
  const refs = seqs.map((s) => `#${s}`);
  const one = refs.length === 1;
  const which = one ? `${refs[0]} doesn't name you, so it is` : `${refs.slice(0, -1).join(', ')} and ${refs[refs.length - 1]} don't name you, so they are`;
  // The quick read is sure Go has something to do with these (reflex question 11): said first, plainly.
  const acts = messages.filter((x) => x.actionable && seqs.includes(x.m.seq)).map((x) => `#${x.m.seq}`);
  const sure = acts.length
    ? `${acts.join(' and ')} ${acts.length === 1 ? 'carries' : 'carry'} something you can answer, act on, note or offer, though ${acts.length === 1 ? 'it doesn\'t' : 'they don\'t'} name you: jump in, in one line. `
    : '';
  return (
    `${sure}${which} the group talking, unless it asks for something you do (logging in to ixigo, a search, a booking, a vote, a ` +
    'reminder, someone checking something): that is an ask even without your name, so do it, or answer it in one line. ' +
    'Either way, jump in whenever you can add anything: answer a question with facts from ixigo or the trip (weather, ' +
    'distances, timings, prices, the record, votes, money, places) unless a person already answered it; offer the lookup ' +
    'or the next step in one line; flag a clash with the plan or the record; note a need or a preference with a ✅ and use ' +
    'it; a quick useful fact. Plan-talk is never banter: a plan or a question to the group about the trip gets its line ' +
    '("let\'s do Goa in Nov?": the weather then, or a stays offer; "budget kitna rakhein?": a suggested band a head from what ' +
    'you know; "Arjun can\'t leave before 6": noted, and used in what you look up). When the group agrees dates on a trip with a place, show its stays: search_stays, the card ' +
    '(the trip\'s head start often has them already); when it agrees a place, take the next step and say it in one line; when people disagree, ' +
    `offer a vote. ${CHIME_RULES} ` +
    "Someone saying what they'd like for the trip (a place, food, a vibe) gets a ✅ and at most one short offer, never a search. Who brings, pays or does " +
    "what is the friends' to settle unless the record already says: never assign it, though you may offer your part (a lookup, a booking, a split). The App gives anyone asking what they missed " +
    'their own catch-up. Call stay_silent only for pure banter, a greeting or an acknowledgement ("haha", "good morning", "ok", "see you"), a side ' +
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
  const asks = items.flatMap((item) => {
    const asked = item.payload as { namesGo?: boolean; asksGo?: boolean } | null;
    if (item.kind !== 'message' || (asked?.namesGo !== true && asked?.asksGo !== true)) return [];
    const p = (item.payload ?? {}) as { messageId?: string };
    const m = pack.messages.find((x) => x.message_id === (p.messageId ?? item.ref));
    return m && m.author.kind === 'person' ? [m] : [];
  });
  if (asks.length === 0) return null;
  const which = listOfRefs(asks.map((m) => m.seq));
  const points = asks.flatMap((m) => pointsAt(m, pack) ?? []);
  return (
    `Answer ${which} in one or two short sentences: the answer itself, no extra tips and no offer to do more unless your rules call for one. ` +
    'A list, a recap or a comparison they asked for may be longer. When you cite what someone said, keep its message number. ' +
    'Start with the answer: never with what they asked for, why your answer takes the shape it does, or what you will leave out.' +
    points.map((x) => ` ${x}`).join('')
  );
}

/** An ask this much older than the turn waited for Go: Go was away (an outage, a restart, the trip's Server unreachable). */
export const WAITED_MS = 2 * 60_000;

/**
 * The asks Go missed while it was away, answered together: when a turn takes asks that waited, the oldest real ask
 * comes first (prod, 11 Oct, Manali: "whats going on", "plan a stay", "hi" and "respond" waited 30 minutes on a stranded
 * socket, and Go came back answering only the newest line, "are you back alive?").
 */
export function catchUpNote(items: DeskItem[], pack: TripPack, now: Date): string | null {
  const asks = items.flatMap((item) => {
    const asked = item.payload as { namesGo?: boolean; asksGo?: boolean; messageId?: string } | null;
    if (item.kind !== 'message' || (asked?.namesGo !== true && asked?.asksGo !== true)) return [];
    const m = pack.messages.find((x) => x.message_id === (asked?.messageId ?? item.ref));
    return m && m.author.kind === 'person' ? [m] : [];
  });
  const waited = asks.filter((m) => now.getTime() - Date.parse(m.sent_at) > WAITED_MS).sort((a, b) => a.seq - b.seq);
  if (waited.length === 0) return null;
  return (
    `You couldn't reach the room when ${listOfRefs(waited.map((m) => m.seq))} came, and they waited. Answer every ask that waited ` +
    'together in this one reply, the oldest real ask first, doing what it asked (an ask for stays gets the stays card), ' +
    'never only the newest line. A greeting or "are you there" needs no more than that you are back.'
  );
}

const listOfRefs = (seqs: number[], last: 'and' | 'or' = 'and'): string => {
  const refs = seqs.map((s) => `#${s}`);
  return refs.length === 1 ? refs[0]! : `${refs.slice(0, -1).join(', ')} ${last} ${refs[refs.length - 1]}`;
};

/**
 * How far back a tag reads: the person's own lines just before it ("I'll take you on the trip with me", then "@Go"
 * alone), and their last ask to Go behind a nudge ("@Go I order you" after Go said no to a rename).
 */
export const LEAD_UP_MS = 10 * 60_000;
/** A person's own lines just before a tag that it reads with, at most. */
const LEAD_UP_LINES = 3;

/**
 * What a tag to Go points at besides itself (the App team, prod, 11 Oct: "@Go" alone right after the same person's "I'll
 * take you on the trip with me" got "your message came through with just my name", and "@Go I order you" right after Go
 * said no to their rename got "you haven't said what you want me to do"). A tag right after someone's own words points
 * at those words: their lines just before it, back to a line by anyone else (Go included). A nudge points at their last
 * ask: the latest earlier line of theirs that named Go. Both within LEAD_UP_MS, and found by who said what and when,
 * never by the words.
 */
export function leadUp(m: Message, pack: TripPack): { own: number[]; lastAsk: number | null } {
  if (m.author.kind !== 'person') return { own: [], lastAsk: null };
  const by = m.author.person_id;
  const at = Date.parse(m.sent_at);
  const theirs = (x: Message): boolean => x.author.kind === 'person' && x.author.person_id === by;
  // Newest first; a join or a money line from the App is no one's words, so it never ends the run.
  const before = pack.messages.filter((x) => x.seq < m.seq && !x.deleted && x.author.kind !== 'system').sort((a, b) => b.seq - a.seq);
  const own: number[] = [];
  for (const x of before) {
    if (!theirs(x) || at - Date.parse(x.sent_at) > LEAD_UP_MS || own.length === LEAD_UP_LINES) break;
    if (x.text) own.push(x.seq);
  }
  const ask = before.find((x) => theirs(x) && !own.includes(x.seq) && at - Date.parse(x.sent_at) <= LEAD_UP_MS && plainlyNamesGo(x, pack));
  return { own: own.reverse(), lastAsk: ask?.seq ?? null };
}

/** The ask note's pointer for one tag: what it reads with, and how to answer when it says nothing of its own. */
function pointsAt(m: Message, pack: TripPack): string | null {
  const { own, lastAsk } = leadUp(m, pack);
  if (own.length === 0 && lastAsk === null) return null;
  const a = m.author;
  const who = a.kind === 'person' ? personName(pack.trip.people.find((x) => x.person_id === a.person_id)?.name ?? 'Someone') : 'Someone';
  const reads = [...(own.length ? [`${who}'s own ${listOfRefs(own)} just before it`] : []), ...(lastAsk !== null ? [`${who}'s last ask to you, #${lastAsk}`] : [])];
  const targets = listOfRefs([...own, ...(lastAsk !== null ? [lastAsk] : [])], 'or');
  return (
    `Read #${m.seq} with ${reads.join(', and ')}: a tag right after someone's own words points at them, and a nudge ("do it", "I order you", "?") points at their last ask. ` +
    `When #${m.seq} says nothing of its own beyond your name or a nudge, it asks you to answer ${targets}: answer that, in character, as your reply to them. ` +
    'Never say their message came with only your name or said nothing, and never ask what they need.'
  );
}

export function renderTripChangeWake(item: DeskItem, pack: TripPack): string {
  const p = (item.payload ?? {}) as { type?: string; decisionId?: string; title?: string };
  // The group's stay is booked (money/finish.ts): each person's flights are next, never before it (Saket's test, 11 Oct).
  if (p.type === 'stay.booked') {
    return (
      `the group's stay ${inlineData(p.title ?? 'the stay')} is booked, and its ticket is up. Each person's flights are next: ` +
      "call search_flights_each for everyone who has no flight picked or booked yet, and say it in one short line. Call stay_silent when everyone has theirs."
    );
  }
  if (p.type === 'decision.closed' && p.decisionId) {
    const d = pack.trip.decisions.find((x) => x.decision_id === p.decisionId);
    if (!d) return 'a vote closed';
    const won = d.result_index != null ? d.options[d.result_index] : undefined;
    // The counts from the Server's own tally, for the model to read: the App posts the result line itself ("Villa Sol won ·
    // 3 votes"), so Go never says it again (the Server team's GO-TEAM-FINAL §8).
    const flexible = flexibleOf(d);
    const tally = `${d.options.map((op, k) => `${inlineData(op.label)} ${d.tally[k] ?? 0}`).join(', ')}; ${d.voted} of ${d.of} voted${flexible ? `, ${flexible} flexible` : ''}`;
    // An option is only a label (DecisionOption has no dates or place fields), so the model reads the winner and saves it.
    return won
      ? `the vote ${inlineData(d.question)} closed: ${inlineData(won.label)} won (${tally}). ` +
          // Where the trip goes and its name too (Varkala, 11 Oct: "Where do we go?" closed on Morocco and a 7 to 0 rename
          // passed, and Go said neither changed the trip, then sent the organizer to group settings the App doesn't have).
          `If it settled where the trip goes, its dates or its name, save it with update_trip at once, with decision_id "${d.decision_id}" ` +
          '(days without a year are the next ones from today; a country or region is its main city for visitors, and say which; a city ' +
          'someone names in the winning country is that pick, with the same decision_id, never a second vote). ' +
          'If it settled where to stay (an area or a place to stay), save the winner as the stay, never as the destination: the destination is where the trip goes. ' +
          'Say it is the stay or picked, never "locked in": that reads as ixigo\'s Lock Price. ' +
          'The App already posted the result in the room: never say the counts again, or who won outside the stay\'s line below. ' +
          'Then take the next step yourself and say it in one short line, or call stay_silent when there is none. ' +
          // The stay comes first (Saket's test, 11 Oct: his flights card and the stay's card at once, and "tell me when").
          'A stay Go can book: its booking is the only next step, and its card goes up with your post. Say only "<the stay> it is. Tap I\'ll book it to book it." ' +
          '(a trip of one: its booking goes up for them by itself, so call stay_silent). No flights yet: each person\'s flights come once the stay is booked, ' +
          'unless someone asks for theirs, and never ask anyone to tell you when.'
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
      'votes come later, when the group is choosing. Where the trip could go, if you suggest any, is a place card (suggest_places), ' +
      'never names in your words or in offer_replies. If the card can\'t come, say the hello anyway.'
    );
  }
  return `setup: ${item.ref}`;
}
