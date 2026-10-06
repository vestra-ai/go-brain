-- An outcome Go refused for good (400, 409 or 422) is kept apart from one Go took, so it is never read as delivered.
alter table used_approvals add column callback_refused_at timestamptz;
