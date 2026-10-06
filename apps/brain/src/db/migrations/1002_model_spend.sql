-- What each model call cost: every composer round and every side pass (notes, fold). The daily model budget
-- (MODEL_DAILY_BUDGET_USD) sums today's rows (a UTC day) at boot and on a slow interval, so a restart keeps its total.
create table model_spend (
  id bigserial primary key,
  at timestamptz not null,
  purpose text not null,
  model text not null,
  cost_usd numeric(12, 6) not null
);
create index model_spend_at on model_spend (at);
