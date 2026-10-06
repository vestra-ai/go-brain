-- A payment the vault is still confirming with the bank. It never expires and cannot be started again until the vault
-- says paid or failed, so it counts as the vote's open payment.
alter table payments drop constraint payments_state_check;
alter table payments add constraint payments_state_check
  check (state in ('asking', 'waiting', 'confirming', 'paid', 'declined', 'expired', 'failed', 'refused'));
drop index payments_one_open;
create unique index payments_one_open on payments (trip_id, decision_id) where state in ('asking', 'waiting', 'confirming');
-- When the vault said it will not ask the bank again and a person is checking the charge. The payment stays confirming.
alter table payments add column checking_at timestamptz;
