-- The rooms cards Go posts once a vote picks a stay (travel/rooms-card.ts, the Server's REV4 B5): the ways the group can
-- take its rooms, and the way someone picked, for the expense per room (B6).
create table if not exists rooms_cards (
  card_id text primary key,
  trip_id text not null,
  decision_id text not null,
  -- The picked stay's option on the card it came from (the vote option's option_ref).
  option_ref text not null,
  stay text not null,
  arrangements jsonb not null,
  chosen_id text,
  chosen_by text,
  chosen_at timestamptz,
  -- Set when the stay's payment starts: the way picked holds from then (no tap changes it), so a retried finish reads it
  -- the same.
  closed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists rooms_cards_option on rooms_cards (trip_id, option_ref, created_at desc);
