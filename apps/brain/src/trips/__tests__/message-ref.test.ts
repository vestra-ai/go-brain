import { describe, expect, it } from 'vitest';
import { goaSnapshot, msg, vote } from '../../__tests__/fixtures/goa.js';
import { messageByRef } from '../pack.js';
import { groupDecided } from '../save-trip.js';

// Varkala, 11 Oct: the model sees the chat as "#593 Saket: Yes please do it @Go" and never a message id, so a message it
// cited (record, set_budget, update_trip's proof then) was no message in the trip.
const messages = [msg(55, 'p_rahul', "let's do Morocco"), msg(61, 'p_priya', 'Dec 1 to 7'), msg(62, 'p_arjun', 'yes 1 to 7 works'), msg(63, 'p_kabir', '👍')];
const pack = (decisions: ReturnType<typeof vote>[] = []) => ({ trip: goaSnapshot({ decisions }), messages, seq: 63 });

describe('a message as the model names it', () => {
  it('is found by "#57", "57" or its id, and by nothing else', () => {
    expect(messageByRef(messages, '#55')?.message_id).toBe('m_55');
    expect(messageByRef(messages, ' 61 ')?.message_id).toBe('m_61');
    expect(messageByRef(messages, 'm_62')?.message_id).toBe('m_62');
    expect(messageByRef(messages, '#70')).toBeUndefined();
    expect(messageByRef(messages, 'the organizer')).toBeUndefined();
  });
});

// Keshav, 11 Oct: "for change of place voting was right move but remove the organizer stuff".
describe('who decides a place or dates change', () => {
  it("the group's closed vote, never an open one, and nobody's word: the organizer's neither", () => {
    const decisions = [vote({ decision_id: 'd_name', status: 'closed', result_index: 0 }), vote({ decision_id: 'd_open' })];
    expect(groupDecided(pack(decisions), 'd_name')).toBe(true);
    expect(groupDecided(pack(decisions), 'd_open')).toBe(false);
    expect(groupDecided(pack(decisions))).toBe(false);
  });

  it('a trip of one: their word is the decision', () => {
    const alone = pack();
    alone.trip.people = alone.trip.people.slice(0, 1);
    expect(groupDecided(alone)).toBe(true);
  });
});
