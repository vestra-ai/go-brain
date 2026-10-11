-- Lane C: ixigo has more of a search than its set holds (a stays list whose one page read was full), so a card's
-- "See more" reads ixigo's next page once the set's own are all shown (Keshav, 11 Oct: "show 10 then see more button,
-- and on click 10 more"). False once the next page is read, or for any other search.

alter table travel_results add column if not exists site_more boolean not null default false;
