-- One row per reflex read: what Jev said (numbers only), what each question would have done, and what it did.
-- Never people's words.
CREATE TABLE reflex_reads (
  read_id text PRIMARY KEY,
  trip_id text NOT NULL,
  message_id text NOT NULL,
  seq integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  ok boolean NOT NULL,
  fault text,
  http_status integer,
  total_ms integer NOT NULL,
  server_ms integer,
  input_tokens integer NOT NULL DEFAULT 0,
  live text[] NOT NULL,
  versions jsonb NOT NULL,
  p jsonb NOT NULL,
  would jsonb NOT NULL,
  acted jsonb NOT NULL,
  secret_kinds text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX reflex_reads_trip_seq ON reflex_reads (trip_id, seq);
