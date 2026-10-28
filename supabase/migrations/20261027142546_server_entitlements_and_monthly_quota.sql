-- Stage 2 PREPARED ONLY; apply after 001 in a reviewed test database.
begin;
create schema cc_private;
revoke all on schema cc_private from public, anon, authenticated;
grant usage on schema cc_private to service_role;

create table public.cc_stores (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id) on delete cascade,
 domain text not null unique check (domain=lower(btrim(domain)) and domain ~ '^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$'),
 plan text not null default 'starter' check (plan in ('starter','pro','business')),
 quota_override integer check (quota_override >= 0),
 status text not null default 'inactive' check (status in ('inactive','trialing','active','paused','canceled')),
 access_start timestamptz not null default now(),
 access_until timestamptz not null default now(),
 monthly_anchor timestamptz not null default now(),
 cancel_at_period_end boolean not null default false,
 billing_source text not null default 'manual' check (billing_source in ('manual','paddle')),
 settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings)='object'),
 created_at timestamptz not null default now(),
 check (access_until >= access_start)
);
create index cc_stores_owner_idx on public.cc_stores(owner_id);
alter table public.cc_stores enable row level security;
revoke all on public.cc_stores from public, anon, authenticated;
grant select on public.cc_stores to authenticated;
grant select,insert,update,delete on public.cc_stores to service_role;
create policy cc_stores_owner_read on public.cc_stores for select to authenticated using (owner_id=(select auth.uid()));

create table public.cc_usage_periods (
 store_id uuid not null references public.cc_stores(id) on delete cascade,
 period_start timestamptz not null,
 period_end timestamptz not null,
 used integer not null default 0 check (used>=0),
 primary key(store_id,period_start),
 check (period_end>period_start)
);
alter table public.cc_usage_periods enable row level security;
revoke all on public.cc_usage_periods from public,anon,authenticated;
grant select on public.cc_usage_periods to authenticated;
grant select,insert,update,delete on public.cc_usage_periods to service_role;
create policy cc_usage_owner_read on public.cc_usage_periods for select to authenticated using
 (exists(select 1 from public.cc_stores s where s.id=store_id and s.owner_id=(select auth.uid())));

alter table public.chat_requests add column store_id uuid references public.cc_stores(id) on delete set null,
 add column period_start timestamptz, add column period_end timestamptz,
 add column quota_reserved boolean not null default false;
create index cc_pending_reservations_idx on public.chat_requests(store_id,period_start,created_at)
 where state='processing' and quota_reserved;
alter table public.questions add column cc_store_id uuid references public.cc_stores(id) on delete set null,
 add column cc_request_id uuid, add column cc_period_start timestamptz;
create unique index cc_question_request_idx on public.questions(cc_request_id) where cc_request_id is not null;
create index cc_legacy_usage_idx on public.questions(store_domain,created_at) where cc_request_id is null;

-- UTC calendar months from the original anchor, so Jan 31 -> Feb 28 -> Mar 31.
create function cc_private.month_bounds(p_anchor timestamptz,p_at timestamptz)
returns table(period_start timestamptz,period_end timestamptz)
language plpgsql immutable set search_path='' as $$
declare a timestamp := p_anchor at time zone 'UTC'; t timestamp := p_at at time zone 'UTC'; n integer; b timestamp;
begin
 n := (extract(year from t)::int-extract(year from a)::int)*12 + extract(month from t)::int-extract(month from a)::int;
 b := a+make_interval(months=>n);
 if b>t then n:=n-1; end if;
 return query select (a+make_interval(months=>n)) at time zone 'UTC', (a+make_interval(months=>n+1)) at time zone 'UTC';
end; $$;

-- All quota transactions take the store row lock first, then request row lock.
create function cc_private.claim(p_request_id uuid,p_domain text,p_fingerprint text,p_owner uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.cc_stores%rowtype; r public.chat_requests%rowtype; b record; u integer; pending integer; lim integer; deny text;
begin
 select * into s from public.cc_stores where domain=p_domain for update;
 if not found then return jsonb_build_object('state','denied','error','UNKNOWN_STORE','http_status',404); end if;
 insert into public.chat_requests(request_id,store_domain,fingerprint,owner_token,store_id)
 values(p_request_id,p_domain,p_fingerprint,p_owner,s.id) on conflict(request_id) do nothing;
 select * into strict r from public.chat_requests where request_id=p_request_id for update;
 if r.store_domain<>p_domain or r.fingerprint<>p_fingerprint then return jsonb_build_object('state','conflict'); end if;
 if r.state='processing' and r.created_at<now()-interval '2 minutes' then
  update public.chat_requests set state='completed',http_status=504,completed_at=now(),quota_reserved=false,
   response=jsonb_build_object('error','REQUEST_EXPIRED','answer','The previous request expired. Please try again.','requestId',p_request_id,'usageRecorded',false)
   where request_id=p_request_id returning * into r;
 end if;
 if r.state='completed' then return jsonb_build_object('state','completed','response',r.response,'http_status',r.http_status); end if;
 if r.owner_token<>p_owner then return jsonb_build_object('state','processing'); end if;
 select * into b from cc_private.month_bounds(s.monthly_anchor,now());
 lim:=coalesce(s.quota_override,case s.plan when 'pro' then 2500 when 'business' then 10000 else 500 end);
 -- Import only explicitly mapped legacy rows for this month. New requests carry explicit period attribution.
 insert into public.cc_usage_periods(store_id,period_start,period_end,used)
 select s.id,b.period_start,b.period_end,count(*)::integer from public.questions q
  where q.cc_store_id=s.id and q.cc_request_id is null and q.created_at>=b.period_start and q.created_at<b.period_end
 on conflict(store_id,period_start) do nothing;
 select used into u from public.cc_usage_periods where store_id=s.id and period_start=b.period_start;
 select count(*)::integer into pending from public.chat_requests where store_id=s.id and period_start=b.period_start
  and state='processing' and quota_reserved and created_at>=now()-interval '2 minutes';
 if s.status not in ('active','trialing','canceled') or now()<s.access_start or now()>=s.access_until then deny:='ACCESS_INACTIVE';
 elsif u+pending>=lim then deny:='QUOTA_EXHAUSTED'; end if;
 if deny is not null then
  update public.chat_requests set state='completed',http_status=200,completed_at=now(),response=jsonb_build_object(
   'error',deny,'answer',case when deny='QUOTA_EXHAUSTED' then 'The store has reached its AI answer limit.' else 'The store AI assistant is currently unavailable.' end,
   'blocked',deny<>'QUOTA_EXHAUSTED','limitReached',deny='QUOTA_EXHAUSTED','requestId',p_request_id,'usageRecorded',false,
   'queryCount',u,'queryLimit',lim) where request_id=p_request_id returning * into r;
  return jsonb_build_object('state','completed','http_status',r.http_status,'response',r.response);
 end if;
 update public.chat_requests set quota_reserved=true,period_start=b.period_start,period_end=b.period_end where request_id=p_request_id;
 return jsonb_build_object('state','claimed','store_id',s.id,'plan',s.plan,'settings',s.settings,
  'queryCount',u,'queryLimit',lim,'periodStart',b.period_start,'periodEnd',b.period_end);
end; $$;

create function cc_private.complete(p_request_id uuid,p_owner uuid,p_response jsonb,p_http_status integer,p_record_usage boolean,p_question text,p_product_context text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.chat_requests%rowtype; sid uuid; s public.cc_stores%rowtype; lim integer; used_now integer;
begin
 select store_id into strict sid from public.chat_requests where request_id=p_request_id;
 if sid is not null then select * into strict s from public.cc_stores where id=sid for update; end if;
 select * into strict r from public.chat_requests where request_id=p_request_id for update;
 if r.owner_token<>p_owner then raise exception 'Request owner mismatch'; end if;
 if r.state<>'completed' then
  if r.created_at<now()-interval '2 minutes' or not r.quota_reserved or sid is null then
   p_record_usage:=false; p_http_status:=504;
   p_response:=jsonb_build_object('error','REQUEST_EXPIRED','answer','The previous request expired. Please try again.','requestId',p_request_id,'usageRecorded',false);
  elsif s.status not in ('active','trialing','canceled') or now()>=s.access_until or now()<s.access_start then
   p_record_usage:=false; p_http_status:=200;
   p_response:=jsonb_build_object('error','ACCESS_INACTIVE','answer','The store AI assistant is currently unavailable.','blocked',true,'requestId',p_request_id,'usageRecorded',false);
  end if;
  if p_record_usage then
   lim:=coalesce(s.quota_override,case s.plan when 'pro' then 2500 when 'business' then 10000 else 500 end);
   select used into strict used_now from public.cc_usage_periods where store_id=sid and period_start=r.period_start;
   if used_now>=lim then
    p_record_usage:=false;p_http_status:=200;
    p_response:=jsonb_build_object('error','QUOTA_EXHAUSTED','answer','The store has reached its AI answer limit.','limitReached',true,'requestId',p_request_id,'usageRecorded',false);
   end if;
  end if;
  if p_record_usage then
   insert into public.questions(store_domain,question_text,product_context,cc_store_id,cc_request_id,cc_period_start)
   values(r.store_domain,p_question,p_product_context,sid,p_request_id,r.period_start);
   update public.cc_usage_periods set used=used+1 where store_id=sid and period_start=r.period_start;
   if not found then raise exception 'Missing reserved usage period'; end if;
  end if;
  update public.chat_requests set state='completed',response=p_response,http_status=p_http_status,completed_at=now(),quota_reserved=false
   where request_id=p_request_id returning * into r;
 end if;
 return jsonb_build_object('response',r.response,'http_status',r.http_status);
end; $$;

-- Public PostgREST entrypoints are invoker wrappers; private implementations are service-only.
create or replace function public.claim_chat_request(p_request_id uuid,p_domain text,p_fingerprint text,p_owner uuid)
returns jsonb language sql security invoker set search_path='' as $$ select cc_private.claim(p_request_id,p_domain,p_fingerprint,p_owner); $$;
create or replace function public.complete_chat_request(p_request_id uuid,p_owner uuid,p_response jsonb,p_http_status integer,p_record_usage boolean,p_question text,p_product_context text)
returns jsonb language sql security invoker set search_path='' as $$ select cc_private.complete(p_request_id,p_owner,p_response,p_http_status,p_record_usage,p_question,p_product_context); $$;
revoke all on all functions in schema cc_private from public,anon,authenticated;
grant execute on all functions in schema cc_private to service_role;
revoke all on function public.claim_chat_request(uuid,text,text,uuid) from public,anon,authenticated;
revoke all on function public.complete_chat_request(uuid,uuid,jsonb,integer,boolean,text,text) from public,anon,authenticated;
grant execute on function public.claim_chat_request(uuid,text,text,uuid) to service_role;
grant execute on function public.complete_chat_request(uuid,uuid,jsonb,integer,boolean,text,text) to service_role;
create function cc_private.snapshot(p_store_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.cc_stores%rowtype; b record; used_count integer; reserved integer;
begin
 select * into strict s from public.cc_stores where id=p_store_id;
 select * into b from cc_private.month_bounds(s.monthly_anchor,now());
 select used into used_count from public.cc_usage_periods where store_id=s.id and period_start=b.period_start;
 if used_count is null then
  select count(*)::int into used_count from public.questions where cc_store_id=s.id and cc_request_id is null
   and created_at>=b.period_start and created_at<b.period_end;
 end if;
 select count(*)::int into reserved from public.chat_requests where store_id=s.id and period_start=b.period_start
  and state='processing' and quota_reserved and created_at>=now()-interval '2 minutes';
 return to_jsonb(s)||jsonb_build_object('query_limit',coalesce(s.quota_override,case s.plan when 'pro' then 2500 when 'business' then 10000 else 500 end),
  'query_count',used_count,'reserved',reserved,'period_start',b.period_start,'period_end',b.period_end,
  'access_active',s.status in ('active','trialing','canceled') and now()>=s.access_start and now()<s.access_until);
end; $$;
revoke all on function cc_private.snapshot(uuid) from public,anon,authenticated;
grant execute on function cc_private.snapshot(uuid) to service_role;
create function public.get_cc_store_snapshot(p_store_id uuid) returns jsonb language sql security invoker set search_path='' as $$ select cc_private.snapshot(p_store_id); $$;
revoke all on function public.get_cc_store_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.get_cc_store_snapshot(uuid) to service_role;
commit;
