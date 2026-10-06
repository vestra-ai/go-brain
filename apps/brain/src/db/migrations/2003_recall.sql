-- Word search over messages and facts: the "simple" text search (no English stemming, so Hinglish words
-- stay whole) plus trigrams for romanised spellings ("khana", "khaana").
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
EXCEPTION WHEN unique_violation OR duplicate_object THEN
  NULL; -- another test schema created it at the same moment
END
$$;

ALTER TABLE messages ADD COLUMN text_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce(text, ''))) STORED;
CREATE INDEX messages_text_tsv ON messages USING gin (text_tsv);
CREATE INDEX messages_text_trgm ON messages USING gin (text public.gin_trgm_ops);

ALTER TABLE facts ADD COLUMN text_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, topic || ' ' || text)) STORED;
CREATE INDEX facts_text_tsv ON facts USING gin (text_tsv);
