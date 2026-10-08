-- Places as Go tells the Server about them (contract 1.1 Place, travel/place-for.ts): ixigo's id, where it is, its time
-- zone, its photo and what it lies within, by the words people used. Kept for good, like travel_places: one ixigo
-- lookup a place and one guide load a destination, ever. place is the contract's Place; kind is state, city or area;
-- within is the city and state it lies in, by ixigo's names.

create table place_details (
  words text primary key,
  place jsonb not null,
  kind text not null check (kind in ('state', 'city', 'area')),
  within text[] not null default '{}',
  learned_at timestamptz not null default now()
);
