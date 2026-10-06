-- When Go heard that a charge has no clear answer yet, so its pay card waits on the bank instead of starting again.
alter table used_approvals add column confirming_told_at timestamptz;
