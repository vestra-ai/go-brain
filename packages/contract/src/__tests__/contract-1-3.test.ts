import { describe, expect, it } from 'vitest';
import {
  AddVoteOptions, Card, CardAction, CreateLink, Decision, Event, GetOptionDetails, MORE_OPTIONS, Option, OptionFullDetails, OptionsCard,
  parseParams, PlaceInfo, PlaceInfoRequest, SOCKET_METHODS, WorkingCard,
} from '../index.js';

// Contract 1.3: the Server team's rev 5 (richer choices in the chat). Every addition is optional, so what 1.2 wrote
// still reads.
const at = '2026-10-11T07:00:00Z';
const option = (n: number) => ({ option_id: `opt_${n}`, title: `Stay ${n}`, highlights: [] });
const card = (count: number, more: Record<string, unknown> = {}) => ({
  card_id: 'c_opts_3', kind: 'options', fallback_text: 'Stays', title: 'Stays in Anjuna', option_kind: 'stay', checked_at: at,
  options: Array.from({ length: count }, (_, i) => option(i + 1)), ...more,
});
const vote = (count: number) => ({
  decision_id: 'd_12', question: 'Where do we stay?', kind: 'choice', anonymous: false, status: 'open', voted: 0, of: 5,
  options: Array.from({ length: count }, (_, i) => ({ label: `Stay ${i + 1}`, option_ref: `opt_${i + 1}` })),
  tally: Array.from({ length: count }, () => 0), opened_at: at,
});

describe('contract 1.3 (rev 5)', () => {
  it('R3 an options card holds up to 10 options; R5 it may name its vote', () => {
    expect(OptionsCard.parse(card(10)).options).toHaveLength(10);
    expect(OptionsCard.safeParse(card(11)).success).toBe(false);
    expect(Card.parse(card(3, { decision_id: 'd_12' }))).toMatchObject({ kind: 'options', decision_id: 'd_12' });
    expect(OptionsCard.parse(card(3)).decision_id).toBeUndefined();
  });

  it('R4 "See more" is a standard action the contract names', () => {
    expect(CardAction.parse(MORE_OPTIONS)).toEqual({ action_id: 'more_options', label: 'See more', style: 'secondary' });
    expect(OptionsCard.parse(card(3, { actions: [MORE_OPTIONS] })).actions).toHaveLength(1);
  });

  it("R5 an option's ixigo page is https only", () => {
    expect(Option.parse({ ...option(1), url: 'https://www.ixigo.com/hotels/4395492/details' }).url).toBe('https://www.ixigo.com/hotels/4395492/details');
    expect(Option.safeParse({ ...option(1), url: 'http://www.ixigo.com/hotels/4395492/details' }).success).toBe(false);
    expect(Option.safeParse({ ...option(1), url: 'javascript:alert(1)' }).success).toBe(false);
  });

  it('R5 add_vote_options takes 1 to 10 options to an open vote, and a vote holds up to 20 options in all', () => {
    const add = { request_id: 'go_more_1', trip_id: 't_goa', decision_id: 'd_12', options: [{ label: 'Casa Lua', option_ref: 'opt_14' }] };
    expect(parseParams('add_vote_options', add)).toMatchObject({ ok: true });
    expect(AddVoteOptions.safeParse({ ...add, options: [] }).success).toBe(false);
    expect(AddVoteOptions.safeParse({ ...add, options: Array.from({ length: 11 }, (_, i) => ({ label: `S${i}` })) }).success).toBe(false);
    expect(Decision.parse(vote(20)).options).toHaveLength(20);
    expect(Decision.safeParse(vote(21)).success).toBe(false);
  });

  it('R5 decision.options_added carries the new options and who added them', () => {
    const ev = Event.parse({
      event_id: 'ev_118', trip_id: 't_goa', seq: 118, occurred_at: at, type: 'decision.options_added',
      data: { decision_id: 'd_12', options: [{ label: 'Casa Lua', option_ref: 'opt_14' }], by: { kind: 'go' } },
    });
    expect(ev.type).toBe('decision.options_added');
    // A tally now counts up to 20 options, on a vote and on decision.voted.
    expect(Event.safeParse({
      event_id: 'ev_119', trip_id: 't_goa', seq: 119, occurred_at: at, type: 'decision.voted',
      data: { decision_id: 'd_12', person_id: 'p_priya', option_index: 14, voted: 1, of: 5, tally: Array.from({ length: 15 }, (_, i) => (i === 14 ? 1 : 0)) },
    }).success).toBe(true);
  });

  it("R7 a working card's live view is https only", () => {
    const working = {
      card_id: 'c_w', kind: 'working', fallback_text: 'Working', task_id: 'task_1', title: 'Booking Villa Sol', state: 'running', steps: [], updated_at: at,
    };
    const live = 'https://staging.vestra.ai/embed/browser?s=ses_8h2#token=tk_dummy_0000';
    expect(WorkingCard.parse({ ...working, live_url: live }).live_url).toBe(live);
    expect(WorkingCard.safeParse({ ...working, live_url: 'http://brain.go.example/live/task_1' }).success).toBe(false);
  });

  it('R8 a vault link may ask to open inside the App; the sheet stays the default', () => {
    expect(CreateLink.parse({ kind: 'vault', person_id: 'p_rahul', start: 'add_card', display: 'embedded' }).display).toBe('embedded');
    expect(CreateLink.parse({ kind: 'vault', person_id: 'p_rahul' }).display).toBeUndefined();
    expect(CreateLink.safeParse({ kind: 'vault', person_id: 'p_rahul', display: 'popup' }).success).toBe(false);
  });

  it('R6 place_info and R9 get_option_details: their params and answers', () => {
    expect(PlaceInfoRequest.parse({ name: 'Ladakh', from_city: 'Delhi' }).name).toBe('Ladakh');
    expect(PlaceInfoRequest.parse({ name: 'Ladakh' }).from_city).toBeUndefined();
    const info = PlaceInfo.parse({ place: { name: 'Ladakh', lat: 34.15, lng: 77.58 }, tag: 'High-altitude road trip', travel: { mode: 'flight', duration_minutes: 85 }, best_months: [6, 7, 8, 9] });
    expect(info.best_months).toEqual([6, 7, 8, 9]);
    expect(PlaceInfo.safeParse({ place: { name: 'Ladakh' }, best_months: [13] }).success).toBe(false);
    expect(GetOptionDetails.parse({ trip_id: 't_goa', card_id: 'c_opts_3', option_id: 'opt_2', person_id: 'p_priya' }).option_id).toBe('opt_2');
    const full = OptionFullDetails.parse({
      caption: 'A quiet villa', check_in: '14:00', check_out: '11:00', stars: 4, map: { lat: 15.58, lng: 73.74 },
      reviews: [{ rating: 4.5, text: 'Lovely pool.', date: '2026-09-12', source: 'ixigo' }], nearby: [{ name: 'Anjuna beach', distance_m: 600 }],
      url: 'https://www.ixigo.com/hotels/4395492/details',
    });
    expect(full.check_in).toBe('14:00');
    expect(OptionFullDetails.safeParse({ check_in: '2 pm' }).success).toBe(false);
    // A review's date may be a month when the source gives no day; never free text.
    expect(OptionFullDetails.safeParse({ reviews: [{ text: 'ok', date: '2026-09' }] }).success).toBe(true);
    expect(OptionFullDetails.safeParse({ reviews: [{ text: 'ok', date: 'Sep 2026' }] }).success).toBe(false);
    // complete: false is a partial answer the Server doesn't keep; absent means complete.
    expect(OptionFullDetails.parse({ caption: 'x', complete: false }).complete).toBe(false);
    expect(OptionFullDetails.parse({ caption: 'x' }).complete).toBeUndefined();
    expect(PlaceInfo.parse({ place: { name: 'Ladakh' }, complete: false }).complete).toBe(false);
    expect(OptionFullDetails.safeParse({ reviews: Array.from({ length: 11 }, () => ({ text: 'ok' })) }).success).toBe(false);
  });

  it('names the three new socket methods, each in its direction and time', () => {
    const row = (name: string) => SOCKET_METHODS.find((m) => m.name === name);
    expect(row('place_info')).toMatchObject({ direction: 'to_go', answer_within: 3 });
    expect(row('get_option_details')).toMatchObject({ direction: 'to_go', answer_within: 3 });
    expect(row('add_vote_options')).toMatchObject({ direction: 'to_server', answer_within: 2, sends_event: 'decision.options_added' });
  });
});
