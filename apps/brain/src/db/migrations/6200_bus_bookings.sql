-- A bus Go books on ixigo for one person (travel/booking/bus-booking.ts), as a flight is, up to ixigo's pay button: the
-- seats and the boarding and dropping points it chose in code, the fare, then their pay card. One row a tap; no
-- passenger's details are kept here (they go only into ixigo's form).
create table if not exists bus_bookings (
  run_id text primary key,
  trip_id text not null,
  person_id text not null,
  option_id text not null,
  -- The options card the person picked it on, for the Server's personal approval (contract 1.3).
  pick_card_id text,
  title text not null,
  -- The day it leaves (YYYY-MM-DD), for the card and the payment's purpose.
  day text,
  state text not null check (state in ('seats', 'passengers', 'ready_to_pay', 'paid', 'failed')),
  -- The seats chosen ("6LC"), and the boarding and dropping points' ixigo ids, for the trip's other bookings on this bus.
  seats text[] not null default '{}',
  board_id text,
  drop_id text,
  total_minor bigint,
  card_id text,
  approval_id text,
  why text,
  -- What a booking that waits (the trip's login, the person's details) carries on with, and since when it waits.
  resume jsonb,
  waiting_since timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index if not exists bus_bookings_trip on bus_bookings (trip_id, person_id);
create index if not exists bus_bookings_option on bus_bookings (trip_id, option_id);
