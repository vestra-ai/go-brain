-- Lane C (P4): every call the trip's computer made to Go's MCP server, against the trip and the jobs running then.

create table mcp_calls (
  id bigserial primary key,
  trip_id text not null,
  task_ids text[] not null default '{}',
  tool text not null,
  args jsonb not null,
  ok boolean not null,
  ms integer not null,
  at timestamptz not null
);
create index mcp_calls_trip on mcp_calls (trip_id, at desc);
