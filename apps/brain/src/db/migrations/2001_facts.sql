-- What Go knows about people. One current fact per person, topic and trip; older versions stay as history.
CREATE TABLE people (
  person_id text PRIMARY KEY,
  carry_over boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE facts (
  fact_id text PRIMARY KEY,
  person_id text NOT NULL,
  trip_id text NOT NULL,
  topic text NOT NULL CHECK (topic ~ '^[a-z0-9_]{1,40}$'),
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 200),
  -- The message the person said it in; null for a join answer.
  message_id text,
  said_at timestamptz NOT NULL,
  audience text NOT NULL CHECK (audience IN ('group', 'go')),
  source text NOT NULL CHECK (source IN ('message', 'join', 'note')),
  -- The newer fact that replaced this one; null for the current fact.
  superseded_by text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX facts_one_current ON facts (person_id, trip_id, topic) WHERE superseded_by IS NULL;
CREATE INDEX facts_by_message ON facts (trip_id, message_id);
CREATE INDEX facts_by_person ON facts (person_id, trip_id);
CREATE INDEX facts_superseded_by ON facts (superseded_by);

-- "Forget me": messages up to this change number never teach Go about the person again.
CREATE TABLE forgotten (
  person_id text NOT NULL,
  trip_id text NOT NULL,
  up_to_seq integer NOT NULL,
  forgotten_at timestamptz NOT NULL,
  PRIMARY KEY (person_id, trip_id)
);
