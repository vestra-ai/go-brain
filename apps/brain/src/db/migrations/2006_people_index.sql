-- Forget finds every trip a person wrote in, and the story lines that cite their messages.
CREATE INDEX messages_by_person ON messages (person_id, trip_id) WHERE person_id IS NOT NULL;
