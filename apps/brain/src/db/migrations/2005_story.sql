-- "The story so far": a long trip's oldest chat, folded into short lines, each citing its messages.
CREATE TABLE stories (
  trip_id text PRIMARY KEY,
  fold_no integer NOT NULL,
  folded_to_seq integer NOT NULL,
  tokens integer NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE story_lines (
  trip_id text NOT NULL,
  idx integer NOT NULL,
  text text NOT NULL,
  refs integer[] NOT NULL,
  ref_ids text[] NOT NULL,
  people text[] NOT NULL,
  PRIMARY KEY (trip_id, idx)
);
CREATE INDEX story_lines_people ON story_lines USING gin (people);
CREATE INDEX story_lines_ref_ids ON story_lines USING gin (ref_ids);
