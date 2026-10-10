-- A person's travel details as on their ID (store/travel.ts), sealed like a card: no value in a plaintext column. A row
-- kept is the person's yes to Go using them for a ticket of their own; unticking or deleting removes the row itself.
create table travel_details (
  person_id text primary key references vault_people (person_id),
  sealed bytea not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  last_read_at timestamptz
);

-- Saving, reading for a booking and deleting them are written down like every unlock: who, which trip, which booking,
-- what for, when; never a value.
alter table unlock_log drop constraint unlock_log_kind_check;
alter table unlock_log add constraint unlock_log_kind_check check (kind in (
  'passkey_added', 'unlock', 'card_added', 'pay_refused', 'pay_attempt', 'pay_ok', 'pay_failed',
  'travel_saved', 'travel_read', 'travel_deleted'
));

-- A link Go opens straight at the travel details.
alter table links drop constraint links_start_check;
alter table links add constraint links_start_check check (start in ('home', 'add_card', 'add_travel'));
