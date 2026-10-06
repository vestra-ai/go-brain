-- When the sweep last asked the rail about a charge, so it looks at the one asked longest ago first and a long outage
-- starves no row; and when it said a charge is still unsettled a day after its deadline, so that is said once.
alter table used_approvals add column rail_checked_at timestamptz;
alter table used_approvals add column stale_logged_at timestamptz;
