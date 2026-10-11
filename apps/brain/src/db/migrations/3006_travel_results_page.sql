-- Lane C: the results page a search read on ixigo.com, kept with its list, so an options card of stays can open the
-- whole list there ("See all on ixigo") when it shows only its three picks. Null for a search with no such page.

alter table travel_results add column if not exists page text;
