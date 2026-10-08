-- Who books for the group (money/claims.ts, contract 1.1 A10): one row a closed vote. The "One person books for all"
-- card went up on offered_turn's post; person_id took it first ("I'll book it", or asking Go to book it in words), and
-- is the payer Go sets the mandate for.
create table booking_claims (
  trip_id text not null,
  decision_id text not null,
  person_id text,
  offered_turn text,
  offered_at timestamptz,
  claimed_at timestamptz,
  primary key (trip_id, decision_id)
);
