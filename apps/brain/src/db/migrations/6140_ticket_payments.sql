-- A traveller's own ticket (contract 1.2, REV4 B7: never voted on) is paid like a stay, with the Server's ticket approval
-- in place of a vote's: no decision, and the person it is for is the payer. option_ref names what it pays for (the
-- caller's key, such as a flight booking); one open ask per ticket, as one per vote.
alter table payments add column kind text not null default 'group' check (kind in ('group', 'ticket'));
alter table payments alter column decision_id drop not null;
alter table payments add constraint payments_group_has_vote check ((kind = 'group') = (decision_id is not null));
create unique index payments_one_open_ticket on payments (trip_id, option_ref) where kind = 'ticket' and state in ('asking', 'waiting', 'confirming');
