-- Recall's word search with English stemming ("paying" finds "pays", "scooter" finds "scooters"). The "simple"
-- column stays for the trigram side; Hinglish words stem the same way in the question and the chat.
ALTER TABLE messages ADD COLUMN text_tsv_en tsvector
  GENERATED ALWAYS AS (to_tsvector('english'::regconfig, coalesce(text, ''))) STORED;
CREATE INDEX messages_text_tsv_en ON messages USING gin (text_tsv_en);
