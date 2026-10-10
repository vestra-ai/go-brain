-- A fact is about the person (food, health, a lean) or only about one trip (when they can leave this time, who comes
-- along, this trip's stay area). Carry-over shows only a person's facts in their other trips (memory/pages.ts).
ALTER TABLE facts ADD COLUMN scope text NOT NULL DEFAULT 'person' CHECK (scope IN ('person', 'trip'));
