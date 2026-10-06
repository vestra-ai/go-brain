-- Approvals Go let go (declined, expired, failed or refused). Their pay links stop working and no new one is made, even
-- when Go voids an approval before the vault saw it.
create table voided_approvals (
  approval_id text primary key,
  voided_at timestamptz not null
);
