-- The proof board's copy of the latest replay bench numbers, one row per chat.
create table if not exists bench_reports (
  chat text primary key,
  mode text not null check (mode in ('fast', 'live')),
  summary jsonb not null,
  received_at timestamptz not null default now()
);
