begin;
create table if not exists public.cc_support_messages (
    id uuid primary key default gen_random_uuid(),
    email text not null check (length(email) between 3 and 254),
    message text not null check (length(btrim(message)) between 1 and 2000),
    created_at timestamptz not null default now()
);
alter table public.cc_support_messages enable row level security;
revoke all on table public.cc_support_messages from public, anon, authenticated;
grant select, insert on table public.cc_support_messages to service_role;
commit;
