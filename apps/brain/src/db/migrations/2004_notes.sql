-- How far the notes pass has read each trip's chat.
CREATE TABLE notes_cursor (
  trip_id text PRIMARY KEY,
  seq integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Go's quiet reactions, each sent once with a stable request_id.
CREATE TABLE go_reactions (
  trip_id text NOT NULL,
  message_id text NOT NULL,
  emoji text NOT NULL,
  request_id text NOT NULL,
  done_at timestamptz,
  PRIMARY KEY (trip_id, message_id, emoji)
);
