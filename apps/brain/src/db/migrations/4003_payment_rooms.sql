-- The rooms a stay's expenses split by (REV4 B6): the arrangement picked on its rooms card, read once when the payment
-- is asked (the card closes at payment), and kept with it, so a tap on the card after that never changes what a finish
-- run again reads. Null for a payment asked before this; [] when none was picked: one expense across everyone.
alter table payments add column rooms jsonb;
