-- A place's best months, 1 to 12, from ixigo's guide (rev 5 R6, place_info; travel/place-for.ts): null until a guide
-- answered for it, so a place kept before this column is learned once more; [] when its guide names none.

alter table place_details add column best_months int[];
