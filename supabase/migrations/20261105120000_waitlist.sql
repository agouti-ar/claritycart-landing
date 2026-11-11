begin;
create table if not exists public.cc_waitlist (
    email text primary key check (length(email) between 3 and 254 and email = lower(btrim(email))),
    created_at timestamptz not null default now()
);
alter table public.cc_waitlist enable row level security;
revoke all on table public.cc_waitlist from public, anon, authenticated;
grant select, insert on table public.cc_waitlist to service_role;
commit;
