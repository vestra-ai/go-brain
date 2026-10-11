-- A Forget me in one trip, by someone whose facts carried into their other trips (carry-over on): Go may have said
-- those facts in its own messages there. Each other trip is marked, and its turns are told never to repeat them
-- (memory/forget-elsewhere.ts).
CREATE TABLE forgot_elsewhere (
  person_id text NOT NULL,
  trip_id text NOT NULL,
  forgot_in text NOT NULL,
  marked_at timestamptz NOT NULL,
  PRIMARY KEY (person_id, trip_id, forgot_in)
);
