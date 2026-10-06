-- Go's record of each ask to pay. It holds no card data, ever: only ids, amounts and states.
create table payments (
  payment_id text primary key,
  trip_id text not null,
  decision_id text not null,
  -- The winning vote option's option_ref (an options card's option_id), as the vote names it. A fresh ask
  -- resolves it to the travel offer again with Travel.offer; it is never itself a travel offer id.
  option_ref text not null,
  purpose text not null,
  -- The voted option's name, for Go's lines ("Villa Sol").
  label text not null,
  payer_person_id text not null,
  payer_name text not null,
  for_person_ids text[] not null,
  state text not null check (state in ('asking', 'waiting', 'paid', 'declined', 'expired', 'failed', 'refused')),
  refused_reason text,
  release_reason text check (release_reason in ('payment_failed', 'payer_declined', 'price_changed', 'expired', 'other')),
  hold_id text,
  amount_minor integer,
  currency text,
  merchant text,
  payment_kind text,
  hold_expires_at timestamptz,
  -- Kept exactly as the travel layer gave it, because it is signed into the approval.
  refundable_until text,
  approval_id text unique,
  approval_token text,
  approval_expires_at timestamptz,
  card_id text unique,
  card_state text,
  pay_link_url text,
  pay_link_expires_at timestamptz,
  rail_ref text,
  fail_reason text,
  confirmed jsonb,
  booking_id text,
  expense_id text,
  released_at timestamptz,
  ticket_posted_at timestamptz,
  said_at timestamptz,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
-- One open ask per vote, so two paths can never post two pay cards.
create unique index payments_one_open on payments (trip_id, decision_id) where state in ('asking', 'waiting');
create index payments_trip on payments (trip_id, created_at desc);

-- Signatures on the vault's calls back to Go, each accepted once.
create table vault_callback_seen (
  t bigint not null,
  v1 text not null,
  seen_at timestamptz not null,
  primary key (t, v1)
);
