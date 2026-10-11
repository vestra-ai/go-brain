import { describe, expect, it } from 'vitest';
import { fareOf, reviewAddress } from '../review-address.js';
import { firstNameOf, idNameOf, kindOn, matchSaid, matchTravellers, savedTravellers, type Wanted } from '../travellers.js';

// A results stream as ixigo sends it (7 Oct capture's shape, its values made up): a first event without the flight, the
// last one with it, two fares, the search's token at the top.
const event = (flights: unknown[]) => `data:${JSON.stringify({ data: { type: 'SPLIT', searchToken: 'tok123', flightJourneys: [{ searchId: '0710', flightFare: flights }] } })}\n\n`;
const flight = (key: string) => ({
  flightKeys: key,
  fares: [
    { fareType: 'HAND_BAGGAGE_ONLY', fareDetails: { fareToken: 'DEL|GOI|061126||1|0|0|e|INR|0710$1044|DEL-GOI-6E5341|false|true|hbo' }, fareMetadata: [{ providerId: 1044 }] },
    { fareType: 'REGULAR', fareDetails: { fareToken: 'DEL|GOI|061126||1|0|0|e|INR|0710$1044|DEL-GOI-6E5341|false|true' }, fareMetadata: [{ providerId: 1044 }] },
  ],
});
const STREAM = event([flight('DEL-GOI-AI101-06112026')]) + event([flight('DEL-GOI-AI101-06112026'), flight('DEL-GOI-6E5341-06112026')]);

describe("the review page of one flight's fare, from the results stream", () => {
  it("finds the flight's fare and builds the address ixigo's own Book opens", () => {
    const fare = fareOf(STREAM, 'DEL-GOI-6E5341-06112026', 'REGULAR')!;
    expect(fare).toEqual({ searchToken: 'tok123', providerId: '1044', fareKey: 'DEL-GOI-6E5341-06112026', fareToken: 'DEL|GOI|061126||1|0|0|e|INR|0710$1044|DEL-GOI-6E5341|false|true' });
    expect(reviewAddress(fare)).toBe(
      'https://www.ixigo.com/flight/booking/1044/tok123?fareKey=DEL-GOI-6E5341-06112026&providers=1044&hbo=false&ftk=DEL%7CGOI%7C061126%7C%7C1%7C0%7C0%7Ce%7CINR%7C0710%241044%7CDEL-GOI-6E5341%7Cfalse%7Ctrue&source=Search%20Form',
    );
    // No fare type asked: the first, as the card shows it. A flight the stream doesn't hold: none.
    expect(fareOf(STREAM, 'DEL-GOI-6E5341-06112026')?.fareToken).toMatch(/\|hbo$/);
    expect(fareOf(STREAM, 'DEL-GOI-UK811-06112026')).toBeNull();
    expect(fareOf('data:{"data":{}}\n\n', 'DEL-GOI-6E5341-06112026')).toBeNull();
  });
});

describe("the account's saved travellers, matched to whom the booking is for", () => {
  const DAY = '2026-11-06';
  const saved = savedTravellers(
    {
      data: [
        { id: 11, firstName: 'Meher', lastName: 'X', dob: '1994-03-02', travellerType: 'ADULT' },
        { id: 12, firstName: 'Kabir', dob: '2016-11-07' }, // turns 10 the day after: a child that day
        { id: 13, firstName: 'Ria', dob: '2025-12-01' },
        { id: 14, firstName: 'Arjun', travellerType: 'ADULT' },
        { id: 15, firstName: 'arjun ', age: 41 },
        { id: 16, firstName: 'Priya' },
        { firstName: 'No id' },
      ],
    },
    DAY,
  );

  it('reads each one as a match needs it: an id, a first name and the kind of fare on the day', () => {
    expect(saved).toEqual([
      { id: '11', firstName: 'meher', kind: 'adult', shown: 'Meher X' },
      { id: '12', firstName: 'kabir', kind: 'child', shown: 'Kabir' },
      { id: '13', firstName: 'ria', kind: 'infant', shown: 'Ria' },
      { id: '14', firstName: 'arjun', kind: 'adult', shown: 'Arjun' },
      { id: '15', firstName: 'arjun', kind: 'adult', shown: 'arjun' },
      { id: '16', firstName: 'priya', kind: null, shown: 'Priya' },
    ]);
    expect(kindOn({ dob: '2014-11-06' }, DAY)).toBe('adult');
    expect(kindOn({ dob: '2014-11-07' }, DAY)).toBe('child');
    expect(['Dr. Meher Shah', 'Éva', '  kabir '].map(firstNameOf)).toEqual(['meher', 'eva', 'kabir']);
  });

  it('matches by first name and kind, each saved traveller once; two of a name are asked, none is asked', () => {
    const wanted: Wanted[] = [
      { personId: 'p_meher', name: 'Meher', kind: 'adult' },
      { personId: 'p_kabir', name: 'Kabir', kind: 'adult' },
      { personId: 'p_arjun', name: 'Arjun Rao', kind: 'adult' },
      { personId: 'p_priya', name: 'priya', kind: 'adult' },
    ];
    const got = matchTravellers(wanted, saved);
    expect(got).toEqual([
      { personId: 'p_meher', name: 'Meher', status: 'matched', travellerId: '11', shown: 'Meher X' },
      // The saved Kabir flies as a child that day, so he is not this adult Kabir.
      { personId: 'p_kabir', name: 'Kabir', status: 'none' },
      { personId: 'p_arjun', name: 'Arjun Rao', status: 'several', travellerIds: ['14', '15'] },
      { personId: 'p_priya', name: 'priya', status: 'matched', travellerId: '16', shown: 'Priya' },
    ]);
    // What the model hears: the trip's own names and the outcome, never a saved name or birthday.
    expect(got.map(matchSaid)).toEqual([
      'Meher: matched', 'Kabir: no saved traveller, typed in as a new traveller', 'Arjun Rao: more than one saved traveller with that name, typed in as a new traveller', 'priya: matched',
    ]);
    // A name as on an ID, from the trip's (Keshav, 11 Oct: one not saved is typed into ixigo's form): first and middle,
    // then last, past a title; one word has no last name.
    expect(['Keshav Musunuri', 'Dr. Meher Kapoor', 'Ravi Kumar Sharma', 'Kabir'].map(idNameOf)).toEqual([
      { first: 'Keshav', last: 'Musunuri' }, { first: 'Meher', last: 'Kapoor' }, { first: 'Ravi Kumar', last: 'Sharma' }, null,
    ]);
    // A saved traveller goes to one person only.
    expect(matchTravellers([{ personId: 'a', name: 'Meher', kind: 'adult' }, { personId: 'b', name: 'Meher', kind: 'adult' }], saved).map((m) => m.status)).toEqual(['matched', 'none']);
  });
});
