-- Prepared only. Depends on Stage 1–4; independent of the deferred Paddle migration.
begin;
create table cc_private.analytics_sessions (
 store_id uuid not null references public.cc_stores(id) on delete cascade,
 session_id uuid not null, visitor_hash text not null check(visitor_hash ~ '^[a-f0-9]{64}$'),
 first_seen timestamptz not null default now(), last_seen timestamptz not null default now(),
 primary key(store_id,session_id)
);
create index analytics_sessions_activity on cc_private.analytics_sessions(store_id,last_seen,visitor_hash);
create table cc_private.analytics_events (
 store_id uuid not null references public.cc_stores(id) on delete cascade,
 event_id uuid not null, session_id uuid not null, visitor_hash text not null,
 event_type text not null check(event_type in ('session_start','product_view','cart_add')),
 product_ref text check(product_ref ~ '^[a-f0-9]{64}$'), source text,
 received_at timestamptz not null default now(), primary key(store_id,event_id),
 foreign key(store_id,session_id) references cc_private.analytics_sessions(store_id,session_id),
 check(event_type='session_start' or product_ref is not null),
 check(event_type<>'cart_add' or (source is not null and source in ('merchant_confirmed','shopify_ajax','woocommerce_added')))
);
create index analytics_events_window on cc_private.analytics_events(store_id,received_at,event_type);
create unique index analytics_session_start_once on cc_private.analytics_events(store_id,session_id) where event_type='session_start';
alter table cc_private.analytics_sessions enable row level security;
alter table cc_private.analytics_events enable row level security;
revoke all on cc_private.analytics_sessions,cc_private.analytics_events from public,anon,authenticated,service_role;
-- Only the private functions below may write telemetry, including service clients.
alter table public.chat_requests add column analytics_preview boolean,
 add column analytics_visitor text, add column analytics_session uuid;
create index analytics_answers_window on public.chat_requests(store_id,completed_at) where state='completed' and analytics_preview=false;

create function cc_private.analytics_session(p_store uuid,p_session uuid,p_visitor text) returns boolean
language plpgsql security definer set search_path='' as $$
declare s cc_private.analytics_sessions%rowtype;
begin
 insert into cc_private.analytics_sessions(store_id,session_id,visitor_hash) values(p_store,p_session,p_visitor) on conflict do nothing;
 select * into s from cc_private.analytics_sessions where store_id=p_store and session_id=p_session for update;
 if s.visitor_hash<>p_visitor then return false;end if;
 update cc_private.analytics_sessions set last_seen=now() where store_id=p_store and session_id=p_session;
 return true;
end;$$;

create function cc_private.ingest_events(p_store_id uuid,p_epoch integer,p_visitor text,p_session uuid,p_events jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.cc_stores%rowtype; e jsonb; old cc_private.analytics_events%rowtype; n integer:=0; inserted integer; fresh boolean:=false;
begin
 select * into s from public.cc_stores where id=p_store_id for update;
 if not found or s.widget_epoch is distinct from p_epoch or s.domain_verified_at is null then return jsonb_build_object('error','STORE_MISMATCH');end if;
 if p_visitor is null or p_visitor !~ '^[a-f0-9]{64}$' or p_session is null or jsonb_typeof(p_events)<>'array' or jsonb_array_length(p_events) not between 1 and 20 then raise exception 'Invalid events';end if;
 if (select count(distinct (value->>'event_id')::uuid) from jsonb_array_elements(p_events))<>jsonb_array_length(p_events) then raise exception 'Duplicate event IDs';end if;
 -- Validate whole batch before writes: mixed changed/new retries cannot partially commit.
 for e in select value from jsonb_array_elements(p_events) loop
  if e->>'type' not in ('session_start','product_view','cart_add') or (e->>'event_id')::uuid is null then raise exception 'Invalid event';end if;
  select * into old from cc_private.analytics_events where store_id=p_store_id and event_id=(e->>'event_id')::uuid;
  if found and (old.session_id<>p_session or old.visitor_hash<>p_visitor or old.event_type<>e->>'type' or old.product_ref is distinct from e->>'product_ref' or old.source is distinct from e->>'source') then return jsonb_build_object('error','EVENT_CONFLICT');end if;
  if old.event_id is null and (e->>'type'<>'session_start' or not exists(select 1 from cc_private.analytics_events where store_id=p_store_id and session_id=p_session and event_type='session_start')) then fresh:=true;end if;
 end loop;
 if not fresh then return jsonb_build_object('accepted',0);end if;
 if not cc_private.analytics_session(p_store_id,p_session,p_visitor) then return jsonb_build_object('error','SESSION_CONFLICT');end if;
 for e in select value from jsonb_array_elements(p_events) loop
  insert into cc_private.analytics_events(store_id,event_id,session_id,visitor_hash,event_type,product_ref,source)
   values(p_store_id,(e->>'event_id')::uuid,p_session,p_visitor,e->>'type',e->>'product_ref',e->>'source') on conflict do nothing;
  get diagnostics inserted=row_count;n:=n+inserted;
 end loop;
 return jsonb_build_object('accepted',n);
end;$$;

-- Attach optional telemetry to the request owned by this worker; never inserts usage/questions.
create function cc_private.bind_chat_analytics(p_request uuid,p_worker uuid,p_store uuid,p_epoch integer,p_preview boolean,p_visitor text,p_session uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare s public.cc_stores%rowtype;
begin
 select * into s from public.cc_stores where id=p_store for update;
 if not found or s.widget_epoch is distinct from p_epoch then return false;end if;
 if not exists(select 1 from public.chat_requests where request_id=p_request and store_id=p_store and owner_token=p_worker and state='processing') then return false;end if;
 if not p_preview and p_visitor is not null and p_session is not null then
  if not cc_private.analytics_session(p_store,p_session,p_visitor) then return false;end if;
 end if;
 update public.chat_requests set analytics_preview=p_preview,
 analytics_visitor=case when not p_preview then p_visitor end,analytics_session=case when not p_preview then p_session end
 where request_id=p_request and owner_token=p_worker and state='processing';
 return true;
end;$$;

create function cc_private.get_analytics(p_store_id uuid,p_owner_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; since_at timestamptz:=now()-interval '30 days';
begin
 if not exists(select 1 from public.cc_stores where id=p_store_id and owner_id=p_owner_id) then return jsonb_build_object('error','STORE_OWNER_MISMATCH');end if;
 with answers as (
  select r.* from public.chat_requests r where r.store_id=p_store_id and r.state='completed' and r.analytics_preview=false
   and r.completed_at>=since_at and r.http_status between 200 and 299 and r.response->>'usageRecorded'='true'
 ), activity as (
  select count(*) as sessions,count(distinct visitor_hash) as visitors from cc_private.analytics_sessions where store_id=p_store_id and last_seen>=since_at
 ), ev as (
  select count(*) filter(where event_type='product_view') as views,count(*) filter(where event_type='cart_add') as carts from cc_private.analytics_events where store_id=p_store_id and received_at>=since_at
 ), days as (
  select d::date as day from generate_series((now() at time zone 'UTC')::date-6,(now() at time zone 'UTC')::date,interval '1 day') d
 )
 select jsonb_build_object('store_id',p_store_id,'window_start',since_at,'window_end',now(),
  'questions_answered',(select count(*) from answers),'sessions',activity.sessions,'visitors',activity.visitors,
  'product_views',ev.views,'cart_additions',ev.carts,'engaged_visitors',(select count(distinct analytics_visitor) from answers),
  'estimated_time_saved_seconds',(select count(*)*150 from answers),'time_saved_method','Estimate: 2.5 minutes per confirmed answer; not measured support time.',
  'revenue',null,'conversion_uplift',null,
  'daily_questions',(select jsonb_agg(jsonb_build_object('day',day,'count',(select count(*) from answers where (completed_at at time zone 'UTC')::date=day)) order by day) from days),
  'unclassified_answers',(select count(*) from public.questions q left join public.chat_requests r on q.cc_request_id=r.request_id where q.cc_store_id=p_store_id and q.created_at>=since_at and r.analytics_preview is null)
 ) into result from activity cross join ev;
 return result;
end;$$;

revoke all on function cc_private.analytics_session(uuid,uuid,text),cc_private.ingest_events(uuid,integer,text,uuid,jsonb),cc_private.bind_chat_analytics(uuid,uuid,uuid,integer,boolean,text,uuid),cc_private.get_analytics(uuid,uuid) from public,anon,authenticated;
grant execute on function cc_private.ingest_events(uuid,integer,text,uuid,jsonb),cc_private.bind_chat_analytics(uuid,uuid,uuid,integer,boolean,text,uuid),cc_private.get_analytics(uuid,uuid) to service_role;
create function public.ingest_cc_events(p_store_id uuid,p_epoch integer,p_visitor text,p_session uuid,p_events jsonb) returns jsonb language sql security invoker set search_path='' as $$select cc_private.ingest_events(p_store_id,p_epoch,p_visitor,p_session,p_events);$$;
create function public.bind_cc_chat_analytics(p_request uuid,p_worker uuid,p_store uuid,p_epoch integer,p_preview boolean,p_visitor text,p_session uuid) returns boolean language sql security invoker set search_path='' as $$select cc_private.bind_chat_analytics(p_request,p_worker,p_store,p_epoch,p_preview,p_visitor,p_session);$$;
create function public.get_cc_analytics(p_store_id uuid,p_owner_id uuid) returns jsonb language sql security invoker set search_path='' as $$select cc_private.get_analytics(p_store_id,p_owner_id);$$;
revoke all on function public.ingest_cc_events(uuid,integer,text,uuid,jsonb),public.bind_cc_chat_analytics(uuid,uuid,uuid,integer,boolean,text,uuid),public.get_cc_analytics(uuid,uuid) from public,anon,authenticated;
grant execute on function public.ingest_cc_events(uuid,integer,text,uuid,jsonb),public.bind_cc_chat_analytics(uuid,uuid,uuid,integer,boolean,text,uuid),public.get_cc_analytics(uuid,uuid) to service_role;
commit;
