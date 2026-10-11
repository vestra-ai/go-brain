-- The Server team's demo payment (payment.completed, 11 Oct): the payer's tap on a waiting pay card never reaches Go; the
-- Server pays it itself and writes the booking and the expense. Who paid a payments row ('server'; null: the vault), and
-- the Server's booking on a person's own flight or bus, whichever way it was paid.
alter table payments add column if not exists paid_by text check (paid_by in ('server'));
alter table flight_bookings add column if not exists booking_id text;
alter table bus_bookings add column if not exists booking_id text;
