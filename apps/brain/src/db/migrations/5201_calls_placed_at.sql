-- When Twilio accepted the call: "nobody picked up" is measured from here, not from when the window ended.
alter table calls add column placed_at timestamptz;
