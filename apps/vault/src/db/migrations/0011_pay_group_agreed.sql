-- Whether the group agreed to a payment first (its vote, among more than one person), as Go knows it from its payments row:
-- the pay page says "The group agreed to this first" only then, never on a person's own ticket or a trip of one. Null: an
-- older pay link; the page goes by whether the approval names a vote.
alter table pay_requests add column if not exists group_agreed boolean;
