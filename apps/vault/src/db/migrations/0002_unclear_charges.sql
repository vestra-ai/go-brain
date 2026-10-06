-- A charge the rail gave no clear answer for stays charging and is asked again with the same key. After the cap it is
-- marked unknown for a person to check, never failed: the money may have moved.
alter table used_approvals add column charge_tries integer not null default 0;
alter table used_approvals drop constraint used_approvals_outcome_check;
alter table used_approvals add constraint used_approvals_outcome_check check (outcome in ('charging', 'paid', 'failed', 'unknown'));
