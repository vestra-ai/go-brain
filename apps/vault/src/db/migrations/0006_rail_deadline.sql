-- The vault never calls the rail for a charge after its approval's expiry plus the grace. It keeps when the approval runs
-- out, whether the rail was ever called for the charge, and when Go heard that a charge is unknown for good.
alter table used_approvals add column approval_expires_at timestamptz;
alter table used_approvals add column rail_called_at timestamptz;
alter table used_approvals add column checking_told_at timestamptz;
