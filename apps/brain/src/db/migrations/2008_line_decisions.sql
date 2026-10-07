-- Go's open record lines that a vote settles: each line, its vote, and what settles it. Linked by id when Go writes the
-- line, never by its words.
CREATE TABLE line_decisions (
  trip_id text NOT NULL,
  line_id text NOT NULL,
  decision_id text NOT NULL,
  -- vote: the line is done once the vote closes or is cancelled. mandate (a line written after the vote closed, such as
  -- who pays): done once the group sets what to book, or the vote is cancelled.
  closes_on text NOT NULL CHECK (closes_on IN ('vote', 'mandate')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_id, line_id)
);
CREATE INDEX line_decisions_by_decision ON line_decisions (trip_id, decision_id);
