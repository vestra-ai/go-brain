-- Go's copy of the trip record (the Server holds the truth), kept by change number.
CREATE TABLE record_lines (
  trip_id text NOT NULL,
  line_id text NOT NULL,
  seq integer NOT NULL,
  line jsonb NOT NULL,
  kind text NOT NULL,
  status text NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (trip_id, line_id)
);
CREATE INDEX record_lines_updated ON record_lines (trip_id, updated_at);

-- Every record line Go sends, keyed by what it says, so a retry reuses the request_id and a repeat is a no-op.
CREATE TABLE record_writes (
  trip_id text NOT NULL,
  write_key text NOT NULL,
  request_id text NOT NULL,
  method text NOT NULL,
  params jsonb NOT NULL,
  line_id text,
  done_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_id, write_key)
);
