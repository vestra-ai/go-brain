-- The flights booking switch is now the booking switch, flights and stays (travel/booking/): its stored value (on, off or
-- an instance list) carries over under the new name.
update switches set name = 'BOOKING' where name = 'FLIGHT_BOOKING' and not exists (select 1 from switches where name = 'BOOKING');
