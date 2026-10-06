-- The vault's own database. A card is a Stripe PaymentMethod id sealed per item, never a card number.

create table vault_people (
  person_id text primary key,
  display_name text,
  stripe_customer_id text unique,
  created_at timestamptz not null
);

create table passkeys (
  credential_id text primary key,
  person_id text not null references vault_people (person_id),
  public_key bytea not null,
  counter bigint not null default 0,
  transports text[] not null default '{}',
  created_at timestamptz not null,
  last_used_at timestamptz
);
create index passkeys_person on passkeys (person_id);

-- One row per spend approval Go asked the vault to take, with the hold it pays.
create table pay_requests (
  approval_id text primary key,
  jti text not null unique,
  trip_id text not null,
  payer_person_id text not null,
  approval text not null,
  amount_minor integer not null check (amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  merchant text not null,
  hold_id text not null,
  hold_expires_at timestamptz not null,
  payment_kind text not null check (payment_kind in ('fake', 'stripe_test', 'ixigo')),
  created_at timestamptz not null
);

-- Links store only a hash of their token.
create table links (
  link_id text primary key,
  token_hash bytea not null unique,
  kind text not null check (kind in ('home', 'pay')),
  person_id text not null,
  -- The Server may ask for add_login (the contract allows it); logins are not stored this week, so it opens at home.
  start text not null default 'home' check (start in ('home', 'add_card')),
  approval_id text references pay_requests (approval_id),
  expires_at timestamptz not null,
  used_at timestamptz,
  session_hash bytea,
  session_until timestamptz,
  created_at timestamptz not null,
  check ((kind = 'pay') = (approval_id is not null))
);

create table challenges (
  challenge_id text primary key,
  link_id text not null references links (link_id),
  person_id text not null,
  purpose text not null check (purpose in ('register', 'unlock', 'pay')),
  challenge text not null,
  expires_at timestamptz not null,
  used_at timestamptz
);

create table cards (
  card_id text primary key,
  person_id text not null references vault_people (person_id),
  brand text not null,
  last4 text not null constraint cards_last4_check check (last4 ~ '^[0-9]{4}$'),
  exp_month integer not null check (exp_month between 1 and 12),
  exp_year integer not null,
  sealed bytea not null,
  created_at timestamptz not null,
  removed_at timestamptz
);
create index cards_person on cards (person_id) where removed_at is null;

-- One row per approval the vault ever tried to pay with. The primary key makes a jti single-use.
create table used_approvals (
  jti text primary key,
  approval_id text not null,
  trip_id text not null,
  payer_person_id text not null,
  link_id text not null references links (link_id),
  card_id text not null references cards (card_id),
  amount_minor integer not null,
  currency text not null,
  merchant text not null,
  rail text not null,
  outcome text not null check (outcome in ('charging', 'paid', 'failed')),
  rail_ref text,
  fail_reason text,
  used_at timestamptz not null,
  settled_at timestamptz,
  callback_at timestamptz,
  callback_attempts integer not null default 0
);

create table unlock_log (
  id bigserial primary key,
  person_id text not null,
  at timestamptz not null,
  kind text not null check (kind in ('passkey_added', 'unlock', 'card_added', 'pay_refused', 'pay_attempt', 'pay_ok', 'pay_failed')),
  card_id text,
  approval_id text,
  trip_id text,
  amount_minor integer,
  currency text,
  merchant text,
  passkey_ok boolean,
  approval_ok boolean,
  rail text,
  rail_ref text,
  reason text
);
create index unlock_log_person on unlock_log (person_id, at desc);

create table internal_seen (
  t bigint not null,
  v1 text not null,
  seen_at timestamptz not null,
  primary key (t, v1)
);
