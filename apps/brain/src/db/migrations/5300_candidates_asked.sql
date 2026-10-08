-- A nudge the group asked for (a watch it asked Go to keep on ixigo, travel/recipe-watches.ts): it skips the daily
-- unprompted budget and "two in a row". Its own file in P6's range: migrations run in name order, and
-- proactive_candidates is made by 5000_proactive.
alter table proactive_candidates add column asked boolean not null default false;
