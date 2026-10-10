import { describe, expect, it } from 'vitest';
import { LIVE_RECIPES } from '../../../reflex/live-gate.js';
import { FAST_CHOICES, isSearchChoice, type FastChoice } from '../../../reflex/questions.js';
import { loadBook } from '../../book/book.js';
import { toolRecipes } from '../../book/tool.js';
import { classIn, coachIn, FAST_ASKS, flightIn, pnrIn, readFastAsk, trainNumberIn, type FastContext } from '../fast.js';
import { pickOption } from '../option-on-card.js';

const ctx: FastContext = { today: '2026-10-07', destination: 'North Goa', dates: { start: '2026-11-06', end: '2026-11-09' } };
const read = (choice: Parameters<typeof readFastAsk>[0], text: string, more: Partial<FastContext> = {}) => readFastAsk(choice, text, { ...ctx, ...more });

describe('the slots of an ixigo ask beyond the searches', () => {
  it('has a reader for every choice Jev can pick', () => {
    expect(Object.keys(FAST_ASKS).sort()).toEqual([...FAST_CHOICES].sort());
    // Each kind names the recipe its read runs: the turn's hint names it when the words don't give its slots.
    expect(FAST_ASKS.boarding_stations.recipe).toBe('trains.boarding_stations');
    expect(FAST_ASKS.hotel_rooms.recipe).toBe('hotels.rooms');
    expect(read('train_status', 'Go 12051 abhi kahan chal rahi hai?')?.recipe).toBe(FAST_ASKS.train_status.recipe);
  });

  it("reads a train by its 5-digit number, for today's run or its timetable", () => {
    expect(read('train_status', 'Go 12051 abhi kahan chal rahi hai?')).toEqual({ recipe: 'trains.running_status', given: { train: '12051' }, asked: { train: '12051' } });
    expect(read('train_status', '@Go is 16346 running late today?')?.given).toEqual({ train: '16346' });
    expect(read('schedule', 'Go 10103 kaun kaun se station pe rukti hai?')).toMatchObject({ recipe: 'trains.schedule', given: { train: '10103' } });
    // By its name only, or two numbers: the composer looks it up.
    expect(read('train_status', 'Go where is the Konkan Kanya Express right now?')).toBeNull();
    expect(read('schedule', 'Go 10103 or 12051, which one stops at Thivim?')).toBeNull();
  });

  it('never takes a price, a PNR or a date for a train number', () => {
    expect(trainNumberIn('under ₹12,000 for the 12051')).toBe('12051');
    expect(trainNumberIn('PNR 4512873690')).toBeNull();
    expect(trainNumberIn('budget 15000.50')).toBeNull();
  });

  it('reads a PNR as the one 10-digit number, and gives the tool no copy of it', () => {
    expect(pnrIn('Go PNR 2318764059 ka status batao')).toBe('2318764059');
    expect(pnrIn('PNRs 2318764059 and 8641290375')).toBeNull();
    // The PNR's recipe is a link to ixigo's page: it takes no number, so none is passed on.
    expect(read('pnr', 'Go mera ticket confirm hua kya? PNR 8641290375')).toEqual({ recipe: 'trains.pnr_status', given: {}, asked: {} });
    expect(read('pnr', 'Go hamara PNR confirm hua kya? Rahul ke paas hai number')).toBeNull();
  });

  it("reads a waitlist's chance from the journey, with the train and the class when the line gives them", () => {
    expect(read('confirm_chance', 'Go Mumbai se Madgaon 5 Nov, 12051 mein 3A ka WL 18 hai, confirm hoga kya?')).toEqual({
      recipe: 'trains.confirm_chance',
      given: { from: 'mumbai', to: 'madgaon', date: '2026-11-05', train: '12051', class: '3A' },
      asked: { from: 'mumbai', to: 'madgaon', date: '2026-11-05', train: '12051', class: '3A' },
    });
    // No journey: which trains, and from where, is the composer's to ask.
    expect(read('confirm_chance', 'Go WL 18 hai 3A mein, confirm hoga kya?')).toBeNull();
    expect(classIn('sleeper mein')).toBe('SL');
    expect(classIn('third AC or sleeper')).toBeNull();
  });

  it("reads a guide's place: one the tables know, the one named after in, else the trip's own", () => {
    expect(read('guide', 'Go Panjim mein famous jagah kaunsi hain?')?.given).toEqual({ place: 'panjim' });
    expect(read('guide', 'Go things to do in Gokarna for a day?')?.given).toEqual({ place: 'gokarna' });
    expect(read('guide', 'Go yahan kya kya dekhne layak hai?')?.given).toEqual({ place: 'North Goa' });
    expect(read('guide', 'Go what to see?', { destination: null })).toBeNull();
  });

  it("reads which product's offers, and a stay's offers only with the trip's place and dates", () => {
    expect(read('offers', 'Go train booking pe cashback offer hai kya?')?.recipe).toBe('trains.offers');
    expect(read('offers', 'Go bus tickets pe koi discount chal raha hai?')?.recipe).toBe('buses.offers');
    expect(read('offers', '@Go any bank offers on flights right now?')?.recipe).toBe('offers.list');
    expect(read('offers', 'Go does ixigo have any HDFC card offer on hotels?')).toEqual({
      recipe: 'hotels.offers', given: { place: 'North Goa', check_in: '2026-11-06', check_out: '2026-11-09' }, asked: { place: 'North Goa', check_in: '2026-11-06', check_out: '2026-11-09' },
    });
    expect(read('offers', 'Go does ixigo have any HDFC card offer on hotels?', { dates: null })?.recipe).toBe('offers.list');
  });

  it("reads a shown stay's rooms and reviews only for the stay the line points at", () => {
    const stay = { ref: 'r_ab12#2', page: 'https://www.ixigo.com/hotels/palm-grove/details?x=1' };
    expect(read('hotel_rooms', 'Go does the second one have free cancellation?', { option: stay })).toEqual({ recipe: 'hotels.rooms', given: { hotel: stay.page }, asked: { hotel: 'r_ab12#2' } });
    expect(read('hotel_reviews', 'Go Palm Grove ke reviews kaise hain?', { option: stay })?.recipe).toBe('hotels.reviews');
    expect(read('hotel_reviews', 'Go reviews?', { option: null })).toBeNull();
    const fare = { ref: 'r_fl01#1', page: 'https://www.ixigo.com/search/result/flight?x=1' };
    expect(read('fare_review', 'Go free cancellation kitna extra lagega IndiGo wali pe?', { option: fare })).toEqual({ recipe: 'flights.review', given: { option: fare.page }, asked: { option: 'r_fl01#1' } });
  });

  it("reads a flight's status by its carrier and number, on today unless the line names a day", () => {
    expect(flightIn('Go is 6E 5341 on time?')).toEqual({ carrier: '6E', number: '5341' });
    expect(flightIn('qp-1402 kal')).toEqual({ carrier: 'QP', number: '1402' });
    expect(flightIn('6E 5341 or AI 2981?')).toBeNull();
    expect(read('flight_status', 'Go is 6E 5341 on time?')).toMatchObject({ recipe: 'flights.status', given: { carrier: '6E', number: '5341', date: '2026-10-07' } });
    expect(read('flight_status', 'Go UK 827 kal late hai kya?')?.given).toEqual({ carrier: 'UK', number: '827', date: '2026-10-08' });
    expect(read('flight_status', 'Go Kabir ki flight ka terminal kaunsa hai?')).toBeNull();
  });

  it("reads a train's coach position and boarding stations by its number, with the coach and station when named", () => {
    expect(coachIn('12051 mein B2 coach kahan aayega')).toBe('B2');
    expect(coachIn('B2 or B3?')).toBeNull();
    expect(read('coach_position', 'Go 12051 mein B2 coach platform pe kahan aayega?')?.given).toEqual({ train: '12051', coach: 'B2' });
    expect(read('coach_position', 'Go how many coaches does 10103 have?')?.given).toEqual({ train: '10103' });
    expect(read('boarding_stations', 'Go 12779 mein Thivim se chadh sakte hain kya?')?.given).toEqual({ train: '12779', station: 'thivim' });
    expect(read('boarding_stations', 'Go what are the boarding stations for the Konkan Kanya Express?')).toBeNull();
  });

  it("runs only recipes the ixigo tool offers, for every choice that acts live", () => {
    const offered = new Set(toolRecipes(loadBook().book).map((r) => r.id));
    const option = { ref: 'r_ab12#2', page: 'https://www.ixigo.com/hotels/palm-grove/details?x=1' };
    // Each live choice's asks, every recipe each can run.
    const asks: Partial<Record<FastChoice, Array<[string, Partial<FastContext>?]>>> = {
      train_status: [['Go 12051 abhi kahan chal rahi hai?']],
      schedule: [['Go 10103 kaun kaun se station pe rukti hai?']],
      confirm_chance: [['Go Mumbai se Madgaon 5 Nov, 3A ka WL 18 hai, confirm hoga kya?']],
      guide: [['Go yahan kya kya dekhne layak hai?']],
      offers: [['Go train booking pe offer hai kya?'], ['Go bus pe offer?'], ['Go hotels pe card offer?'], ['Go koi offer hai kya?']],
      hotel_rooms: [['Go does the second one have free cancellation?', { option }]],
      hotel_reviews: [['Go Palm Grove ke reviews kaise hain?', { option }]],
    };
    for (const choice of LIVE_RECIPES.filter((c): c is FastChoice => !isSearchChoice(c))) {
      expect(asks[choice], choice).toBeDefined();
      for (const [text, more] of asks[choice]!) {
        const ask = read(choice, text, more ?? {});
        expect(ask && offered.has(ask.recipe), `${choice}: ${ask?.recipe}`).toBe(true);
      }
    }
  });

  it('never reads a watch the group asks for as a read now', () => {
    expect(read('train_status', 'Go tell us when 12051 is running late')).toBeNull();
    expect(read('pnr', 'Go let me know when PNR 8641290375 confirms')).toBeNull();
  });
});

describe('the option a line points at', () => {
  const card = [
    { n: 1, title: 'Casa Azul Villa' },
    { n: 2, title: 'Palm Grove Resort' },
    { n: 3, title: 'Sea Breeze Homestay' },
  ];
  it('by its place on the card, in English or Hinglish', () => {
    expect(pickOption('does the second one have free cancellation?', card)).toBe(2);
    expect(pickOption('pehle wale hotel mein pay at hotel ka option hai?', card)).toBe(1);
    expect(pickOption('log kya bol rahe hain teesre wale ke baare mein?', card)).toBe(3);
    expect(pickOption('option #2 ke rooms', card)).toBe(2);
  });
  it('by a word of its name only it has, never a word many stays share', () => {
    expect(pickOption('Palm Grove ke reviews kaise hain?', card)).toBe(2);
    expect(pickOption('what do guests say about Sea Breeze?', card)).toBe(3);
    expect(pickOption('which villa has the best reviews?', card)).toBeNull();
  });
  it('the only stay on the card, or none when the line is not plain', () => {
    expect(pickOption('reviews kaise hain?', [card[0]!])).toBe(1);
    expect(pickOption('reviews kaise hain?', card)).toBeNull();
    expect(pickOption('the first one or Palm Grove?', card)).toBeNull();
  });
});
