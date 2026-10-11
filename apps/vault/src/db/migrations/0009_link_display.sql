-- Where a home link's page opens (contract 1.3, rev 5 R8): sheet, the system browser sheet, as before; or embedded, inside
-- the App, which may frame it (the App's origins only) and which reads its unlock session from a header, not a cookie.
alter table links add column display text not null default 'sheet' check (display in ('sheet', 'embedded'));
