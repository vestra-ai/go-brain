-- Lane C (P4): each trip's computer on Vestra /v1 (its user and its conversation), and the tokens its jobs use to
-- reach Go's MCP server. Tokens are stored only as hashes.

create table trip_computers (
  trip_id text primary key,
  v1_user_id text not null unique,
  conversation_id text,
  user_ready_at timestamptz,
  warm_at timestamptz,
  created_at timestamptz not null default now()
);

create table trip_tokens (
  token_hash text primary key,
  trip_id text not null,
  created_at timestamptz not null,
  -- The job's deadline and a margin: a token nobody revoked still stops working.
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index trip_tokens_live on trip_tokens (trip_id) where revoked_at is null;
