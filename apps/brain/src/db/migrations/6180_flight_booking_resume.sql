-- A flight booking that stopped at the trip's ixigo login waits for it (Keshav, 11 Oct: "when logged in, automatically
-- continue"): what it carries on with (the person's name, the fare type, the tap, and their card as it was before their
-- pick), and since when it waits. The login landing carries it on; a login let go, or never in, puts the card back.
alter table flight_bookings add column if not exists resume jsonb;
alter table flight_bookings add column if not exists waiting_since timestamptz;
