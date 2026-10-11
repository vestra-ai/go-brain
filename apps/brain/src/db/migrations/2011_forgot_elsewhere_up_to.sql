-- The change number in each other trip up to which Go's own messages that name the person are hidden from its turns
-- there (composer/fence.ts roomView): a note telling Go not to repeat them was not enough (staging drill, 10 Oct).
-- Marks made before this column hide every message the trip has so far.
ALTER TABLE forgot_elsewhere ADD COLUMN up_to_seq integer;
UPDATE forgot_elsewhere f SET up_to_seq = coalesce((SELECT max(m.seq) FROM messages m WHERE m.trip_id = f.trip_id), 0);
ALTER TABLE forgot_elsewhere ALTER COLUMN up_to_seq SET NOT NULL;
