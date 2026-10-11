-- An add_travel link may name the travel details a booking still needs (Go's one ask for a ticket: a date of birth, the
-- IRCTC user ID for a train), and its page then shows those fields, with any it must have that the person hasn't kept.
-- Null: every field.
alter table links add column if not exists fields text[];
