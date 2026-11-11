-- ==========================================================================
-- CLARITYCART CONSOLIDATED ROLLOUT: STAGE 5 (BILLING) + STAGE 7 (ANALYTICS) + STAGE 8 (GROUNDING)
-- Paste this entire file into Supabase SQL Editor and click RUN.
-- ==========================================================================

-- >>> START OF supabase/migrations/20261028184410_paddle_subscription_lifecycle.sql <<<
-- PREPARED ONLY. Requires the complete Stage 1–4 schema. No live application here.
begin;
alter table public.cc_stores add column paddle_subscription_id text,
 add column paddle_status text, add column billing_hold boolean not null default false;
create table cc_private.paddle_prices(
 environment text not null check(environment in ('sandbox','production')),price_id text not null,
 plan text not null check(plan in ('starter','pro','business')),
 billing_interval text not null check(billing_interval in ('month','year')),
 trial_days integer not null check(trial_days in (0,7)),primary key(environment,price_id));
create table cc_private.paddle_checkouts(
 id uuid primary key default gen_random_uuid(),owner_id uuid not null references auth.users(id),
 store_id uuid not null references public.cc_stores(id),request_id uuid not null,
 environment text not null,price_id text not null,plan text not null,billing_interval text not null,
 status text not null default 'creating' check(status in ('creating','ready','completed','failed')),
 transaction_id text,checkout_url text,created_at timestamptz not null default now(),
 unique(owner_id,request_id),unique(environment,transaction_id),
 foreign key(environment,price_id) references cc_private.paddle_prices(environment,price_id));
create index cc_paddle_checkout_store_idx on cc_private.paddle_checkouts(store_id,status);
create table cc_private.paddle_subscriptions(
 environment text not null,id text not null,store_id uuid not null references public.cc_stores(id),
 owner_id uuid not null references auth.users(id),checkout_id uuid not null references cc_private.paddle_checkouts(id),
 customer_id text not null,price_id text not null,status text not null check(status in ('trialing','active','past_due','paused','canceled')),
 started_at timestamptz,first_billed_at timestamptz,period_start timestamptz,period_end timestamptz,
 trial_start timestamptz,trial_end timestamptz,scheduled_cancel boolean not null default false,
 scheduled_at timestamptz,canceled_at timestamptz,last_event_at timestamptz not null,
 primary key(environment,id));
create unique index cc_paddle_one_live_subscription on cc_private.paddle_subscriptions(store_id) where status<>'canceled';
create index cc_paddle_subscription_checkout_idx on cc_private.paddle_subscriptions(checkout_id);
create table cc_private.paddle_trials(
 owner_id uuid primary key references auth.users(id),environment text not null,subscription_id text not null,
 starts_at timestamptz not null,ends_at timestamptz not null,check(ends_at>starts_at),check(ends_at<=starts_at+interval '7 days'));
create table cc_private.paddle_payments(
 environment text not null,id text not null,store_id uuid not null references public.cc_stores(id),
 subscription_id text not null,customer_id text not null,price_id text not null,
 status text not null check(status in ('paid','completed','payment_failed')),
 amount numeric(30,0) not null check(amount>=0),currency text,period_start timestamptz,period_end timestamptz,
 last_event_at timestamptz not null,primary key(environment,id));
create index cc_paddle_payment_sub_idx on cc_private.paddle_payments(environment,subscription_id,status);
create table cc_private.paddle_events(
 environment text not null,event_id text not null,type text not null,occurred_at timestamptz not null,
 payload_hash text not null check(payload_hash~'^[a-f0-9]{64}$'),processed_at timestamptz not null default now(),
 primary key(environment,event_id));
do $$declare t text;begin
 foreach t in array array['paddle_prices','paddle_checkouts','paddle_subscriptions','paddle_trials','paddle_payments','paddle_events'] loop
  execute format('alter table cc_private.%I enable row level security',t);
  execute format('revoke all on cc_private.%I from public,anon,authenticated',t);
 end loop;
end;$$;

-- Every billing writer takes the owner advisory lock, then the existing store lock.
create function cc_private.billing_sync(p_environment text,p_subscription text) returns void
language plpgsql security definer set search_path='' as $$
declare b cc_private.paddle_subscriptions%rowtype;s public.cc_stores%rowtype;p cc_private.paddle_prices%rowtype;
 c cc_private.paddle_checkouts%rowtype;t cc_private.paddle_trials%rowtype;until_at timestamptz;
 state text:='inactive';anchor timestamptz;
begin
 select * into strict b from cc_private.paddle_subscriptions where environment=p_environment and id=p_subscription;
 select * into strict s from public.cc_stores where id=b.store_id for update;
 if s.owner_id<>b.owner_id then raise exception 'Billing owner changed; reconcile subscription';end if;
 -- An old canceled subscription cannot overwrite a newer linked subscription.
 if s.paddle_subscription_id is not null and s.paddle_subscription_id<>b.id and b.status='canceled' then return;end if;
 select * into p from cc_private.paddle_prices where environment=b.environment and price_id=b.price_id;
 select * into strict c from cc_private.paddle_checkouts where id=b.checkout_id;
 until_at:=greatest(s.access_start,now());
 if p.price_id is not null and b.status='trialing' then
  select * into t from cc_private.paddle_trials where owner_id=b.owner_id;
  if not found and b.trial_start is not null and b.trial_end>b.trial_start and
    exists(select 1 from cc_private.paddle_prices x where x.environment=c.environment and x.price_id=c.price_id and x.trial_days=7) then
   insert into cc_private.paddle_trials(owner_id,environment,subscription_id,starts_at,ends_at)
    values(b.owner_id,b.environment,b.id,b.trial_start,least(b.trial_end,b.trial_start+interval '7 days')) on conflict do nothing;
   select * into t from cc_private.paddle_trials where owner_id=b.owner_id;
  end if;
  if t.subscription_id=b.id and t.environment=b.environment then
   until_at:=least(t.ends_at,coalesce(b.trial_end,t.ends_at));if t.starts_at<=now() then state:='trialing';end if;
  end if;
 elsif p.price_id is not null and b.status='active' and b.period_end>b.period_start then
  -- A completed positive transaction, not frontend success or transaction.paid,
  -- proves payment. Initial checkout may omit billing_period; use its signed sub period.
  select max(coalesce(x.period_end,case when x.id=c.transaction_id then b.period_end end)) into until_at
   from cc_private.paddle_payments x where x.environment=b.environment and x.subscription_id=b.id
    and x.customer_id=b.customer_id and x.status='completed' and x.amount>0
    and coalesce(x.period_start,case when x.id=c.transaction_id then b.period_start end)<=now()
    and exists(select 1 from cc_private.paddle_prices paid where paid.environment=x.environment and paid.price_id=x.price_id
      and paid.billing_interval=p.billing_interval and
      (case paid.plan when 'business' then 3 when 'pro' then 2 else 1 end)>=(case p.plan when 'business' then 3 when 'pro' then 2 else 1 end));
  until_at:=least(coalesce(until_at,s.access_start),b.period_end);
  if until_at>now() and b.period_start<=now() then state:='active';end if;
 end if;
 if b.scheduled_cancel and b.scheduled_at is not null then until_at:=least(until_at,b.scheduled_at);end if;
 if until_at<=now() then state:='inactive';end if;
 if s.billing_hold then state:='paused';end if;
 anchor:=case when s.billing_source<>'paddle' or s.paddle_subscription_id is distinct from b.id
  or (s.paddle_status='trialing' and b.status='active')
  then coalesce(b.first_billed_at,b.trial_start,b.period_start,b.started_at,s.monthly_anchor) else s.monthly_anchor end;
 update public.cc_stores set billing_source='paddle',paddle_subscription_id=b.id,paddle_status=b.status,
  plan=coalesce(p.plan,s.plan),quota_override=null,status=state,
  access_start=coalesce(b.started_at,s.access_start),
  access_until=greatest(coalesce(b.started_at,s.access_start),until_at),
  monthly_anchor=anchor,cancel_at_period_end=b.scheduled_cancel where id=s.id;
end;$$;

create function cc_private.billing_operation(p_action text,p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.cc_stores%rowtype;c cc_private.paddle_checkouts%rowtype;b cc_private.paddle_subscriptions%rowtype;
 p cc_private.paddle_prices%rowtype;owner uuid:=(p_input->>'owner_id')::uuid;trial_available boolean;
begin
 if p_action='register_price' then
  insert into cc_private.paddle_prices(environment,price_id,plan,billing_interval,trial_days)
   values(p_input->>'environment',p_input->>'price_id',p_input->>'plan',p_input->>'billing_interval',(p_input->>'trial_days')::int) on conflict do nothing;
  select * into strict p from cc_private.paddle_prices where environment=p_input->>'environment' and price_id=p_input->>'price_id';
  if p.plan<>p_input->>'plan' or p.billing_interval<>p_input->>'billing_interval' or p.trial_days<>(p_input->>'trial_days')::int then raise exception 'Price mapping immutable';end if;
  return to_jsonb(p);
 end if;
 if owner is null then raise exception 'Owner required';end if;
 perform pg_advisory_xact_lock(hashtextextended('cc-billing:'||owner::text,0));
 select * into s from public.cc_stores where id=(p_input->>'store_id')::uuid and owner_id=owner for update;
 if not found then return jsonb_build_object('error','STORE_NOT_FOUND');end if;
 select * into b from cc_private.paddle_subscriptions where store_id=s.id order by (status<>'canceled') desc,last_event_at desc limit 1;
 select * into c from cc_private.paddle_checkouts where owner_id=owner and request_id=(p_input->>'request_id')::uuid;
 trial_available:=not exists(select 1 from cc_private.paddle_trials where owner_id=owner)
  and not exists(select 1 from cc_private.paddle_checkouts x join cc_private.paddle_prices y using(environment,price_id)
    where x.owner_id=owner and y.trial_days=7 and x.status<>'failed');
 if p_action='inspect' then return jsonb_build_object('store_id',s.id,'trial_available',trial_available,
  'subscription',case when b.id is not null then to_jsonb(b) else null end,
  'open_checkout',(select to_jsonb(x) from cc_private.paddle_checkouts x where x.store_id=s.id and x.status in ('creating','ready') order by x.created_at desc limit 1),
  'request_checkout',case when c.id is not null then to_jsonb(c) else null end);end if;
 if p_action='prepare' then
  if c.id is not null then
   if c.store_id<>s.id or c.plan<>p_input->>'plan' or c.billing_interval<>p_input->>'billing_interval' then return jsonb_build_object('error','CHECKOUT_CONFLICT');end if;
   return jsonb_build_object('created',false,'checkout',to_jsonb(c));
  end if;
  if b.id is not null and b.status<>'canceled' then return jsonb_build_object('error','SUBSCRIPTION_EXISTS');end if;
  if exists(select 1 from cc_private.paddle_checkouts x where x.store_id=s.id and (x.status in ('creating','ready')
    or (x.status='completed' and not exists(select 1 from cc_private.paddle_subscriptions y where y.checkout_id=x.id)))) then return jsonb_build_object('error','CHECKOUT_ALREADY_OPEN');end if;
  select * into strict p from cc_private.paddle_prices where environment=p_input->>'environment' and price_id=p_input->>'price_id';
  if p.plan<>p_input->>'plan' or p.billing_interval<>p_input->>'billing_interval' or ((p.trial_days=7)<>trial_available) then return jsonb_build_object('error','TRIAL_SELECTION_CHANGED');end if;
  insert into cc_private.paddle_checkouts(owner_id,store_id,request_id,environment,price_id,plan,billing_interval)
   values(owner,s.id,(p_input->>'request_id')::uuid,p.environment,p.price_id,p.plan,p.billing_interval) returning * into c;
  return jsonb_build_object('created',true,'checkout',to_jsonb(c));
 elsif p_action='finish' then
  select * into c from cc_private.paddle_checkouts where id=(p_input->>'checkout_id')::uuid and owner_id=owner and store_id=s.id for update;
  if not found or c.status<>'creating' then raise exception 'Checkout not pending';end if;
  update cc_private.paddle_checkouts set status=case when p_input->>'failed'='true' then 'failed' else 'ready' end,
   transaction_id=p_input->>'transaction_id',checkout_url=p_input->>'checkout_url' where id=c.id returning * into c;
  return to_jsonb(c);
 end if;
 raise exception 'Unknown billing operation';
end;$$;

create function cc_private.apply_paddle_event(p_event jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e text:=p_event->>'environment';sid text:=p_event->>'subscription_id';
 b cc_private.paddle_subscriptions%rowtype;c cc_private.paddle_checkouts%rowtype;s public.cc_stores%rowtype;
 previous_hash text;added integer;stamp timestamptz:=(p_event->>'updated_at')::timestamptz;
begin
 insert into cc_private.paddle_events(environment,event_id,type,occurred_at,payload_hash)
  values(e,p_event->>'event_id',p_event->>'type',(p_event->>'occurred_at')::timestamptz,p_event->>'payload_hash') on conflict do nothing;
 get diagnostics added=row_count;
 if added=0 then
  select payload_hash into previous_hash from cc_private.paddle_events where environment=e and event_id=p_event->>'event_id';
  if previous_hash<>p_event->>'payload_hash' then raise exception 'Event ID payload conflict';end if;
  return jsonb_build_object('duplicate',true);
 end if;
 select * into b from cc_private.paddle_subscriptions where environment=e and id=sid;
 if b.id is not null then select * into strict c from cc_private.paddle_checkouts where id=b.checkout_id;
 else
  select * into c from cc_private.paddle_checkouts where environment=e and transaction_id=p_event->>'transaction_id';
  if c.id is null or (p_event->>'checkout_id' is not null and c.id<>(p_event->>'checkout_id')::uuid) then raise exception 'Billing binding not available; retry delivery';end if;
 end if;
 perform pg_advisory_xact_lock(hashtextextended('cc-billing:'||c.owner_id::text,0));
 select * into strict s from public.cc_stores where id=c.store_id for update;
 if s.owner_id<>c.owner_id then raise exception 'Store owner changed; reconcile billing';end if;
 -- Re-read after the lock: concurrent deliveries may have created the subscription.
 select * into b from cc_private.paddle_subscriptions where environment=e and id=sid;
 if b.id is not null and (b.store_id<>s.id or b.customer_id<>p_event->>'customer_id') then raise exception 'Subscription binding mismatch';end if;
 if p_event->>'kind'='subscription' then
  if b.id is null and (c.price_id<>p_event->>'price_id' or c.status='failed') then raise exception 'Initial checkout price mismatch';end if;
  if b.id is not null and stamp<=b.last_event_at then return jsonb_build_object('ignored_stale',true);end if;
  if p_event->>'status' in ('active','trialing') and ((p_event->>'period_start') is null or (p_event->>'period_end') is null
    or (p_event->>'period_end')::timestamptz<=(p_event->>'period_start')::timestamptz) then raise exception 'Subscription period missing';end if;
  insert into cc_private.paddle_subscriptions(environment,id,store_id,owner_id,checkout_id,customer_id,price_id,status,started_at,first_billed_at,
    period_start,period_end,trial_start,trial_end,scheduled_cancel,scheduled_at,canceled_at,last_event_at)
   values(e,sid,s.id,c.owner_id,c.id,p_event->>'customer_id',p_event->>'price_id',p_event->>'status',(p_event->>'started_at')::timestamptz,
    (p_event->>'first_billed_at')::timestamptz,(p_event->>'period_start')::timestamptz,(p_event->>'period_end')::timestamptz,
    (p_event->>'trial_start')::timestamptz,(p_event->>'trial_end')::timestamptz,(p_event->>'scheduled_cancel')::boolean,
    (p_event->>'scheduled_at')::timestamptz,(p_event->>'canceled_at')::timestamptz,stamp)
   on conflict(environment,id) do update set price_id=excluded.price_id,status=excluded.status,
    first_billed_at=coalesce(cc_private.paddle_subscriptions.first_billed_at,excluded.first_billed_at),
    period_start=coalesce(excluded.period_start,cc_private.paddle_subscriptions.period_start),period_end=coalesce(excluded.period_end,cc_private.paddle_subscriptions.period_end),
    trial_start=coalesce(cc_private.paddle_subscriptions.trial_start,excluded.trial_start),trial_end=excluded.trial_end,
    scheduled_cancel=excluded.scheduled_cancel,scheduled_at=excluded.scheduled_at,canceled_at=excluded.canceled_at,last_event_at=stamp;
  update cc_private.paddle_checkouts set status='completed' where id=c.id;
 elsif p_event->>'kind'='payment' then
  insert into cc_private.paddle_payments(environment,id,store_id,subscription_id,customer_id,price_id,status,amount,currency,period_start,period_end,last_event_at)
   values(e,p_event->>'transaction_id',s.id,sid,p_event->>'customer_id',p_event->>'price_id',p_event->>'status',(p_event->>'amount')::numeric,
    p_event->>'currency',(p_event->>'period_start')::timestamptz,(p_event->>'period_end')::timestamptz,stamp)
   on conflict(environment,id) do update set status=excluded.status,amount=excluded.amount,currency=excluded.currency,
    period_start=excluded.period_start,period_end=excluded.period_end,last_event_at=stamp
    where cc_private.paddle_payments.subscription_id=excluded.subscription_id and cc_private.paddle_payments.customer_id=excluded.customer_id
    and cc_private.paddle_payments.last_event_at<stamp
    and (cc_private.paddle_payments.status<>'completed' or excluded.status='completed');
  if p_event->>'status'='completed' and c.transaction_id=p_event->>'transaction_id' then update cc_private.paddle_checkouts set status='completed' where id=c.id;end if;
 else raise exception 'Invalid event kind';end if;
 if exists(select 1 from cc_private.paddle_subscriptions where environment=e and id=sid) then perform cc_private.billing_sync(e,sid);end if;
 return jsonb_build_object('processed',true);
end;$$;

revoke all on function cc_private.billing_sync(text,text),cc_private.billing_operation(text,jsonb),cc_private.apply_paddle_event(jsonb) from public,anon,authenticated;
grant execute on function cc_private.billing_operation(text,jsonb),cc_private.apply_paddle_event(jsonb) to service_role;
create function public.cc_billing_operation(p_action text,p_input jsonb) returns jsonb language sql security invoker set search_path='' as $$select cc_private.billing_operation(p_action,p_input);$$;
create function public.apply_cc_paddle_event(p_event jsonb) returns jsonb language sql security invoker set search_path='' as $$select cc_private.apply_paddle_event(p_event);$$;
revoke all on function public.cc_billing_operation(text,jsonb),public.apply_cc_paddle_event(jsonb) from public,anon,authenticated;
grant execute on function public.cc_billing_operation(text,jsonb),public.apply_cc_paddle_event(jsonb) to service_role;
commit;


-- >>> START OF supabase/migrations/20261101085947_storefront_analytics.sql <<<
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


-- >>> START OF supabase/migrations/20261101100114_store_product_grounding.sql <<<
-- Prepared only. Requires Stage 1–4; independent of Paddle and Analytics migrations.
begin;
create table cc_private.store_knowledge (
 store_id uuid primary key references public.cc_stores(id) on delete cascade,
 owner_id uuid not null references auth.users(id) on delete cascade,
 document jsonb not null check(jsonb_typeof(document)='object' and octet_length(document::text)<=24576),
 revision uuid not null default gen_random_uuid(),
 updated_at timestamptz not null default now(),
 expires_at timestamptz not null,
 check(expires_at>updated_at and expires_at<=updated_at+interval '30 days')
);
alter table cc_private.store_knowledge enable row level security;
revoke all on cc_private.store_knowledge from public,anon,authenticated,service_role;
create function cc_private.knowledge_operation(p_store_id uuid,p_owner_id uuid,p_document jsonb,p_expected uuid,p_expires timestamptz) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.cc_stores%rowtype;k cc_private.store_knowledge%rowtype;
begin
 select * into s from public.cc_stores where id=p_store_id for update;
 if not found or s.owner_id is distinct from p_owner_id then return jsonb_build_object('error','STORE_OWNER_MISMATCH');end if;
 select * into k from cc_private.store_knowledge where store_id=p_store_id;
 if found and k.owner_id<>p_owner_id then return jsonb_build_object('error','STORE_OWNER_MISMATCH');end if;
 if p_document is null then
  return case when k.store_id is null then jsonb_build_object('available',false,'domain',s.domain) else to_jsonb(k)||jsonb_build_object('available',true,'domain',s.domain) end;
 end if;
 if (k.store_id is not null and k.revision is distinct from p_expected) or (k.store_id is null and p_expected is not null) then return jsonb_build_object('error','KNOWLEDGE_REVISION_CONFLICT');end if;
 if p_expires is null or p_expires<=now() or p_expires>now()+interval '30 days' or jsonb_typeof(p_document->'products')<>'array' or jsonb_array_length(p_document->'products')>20 or jsonb_typeof(p_document->'store')<>'object' then raise exception 'Invalid knowledge document';end if;
 insert into cc_private.store_knowledge(store_id,owner_id,document,expires_at) values(p_store_id,p_owner_id,p_document,p_expires)
 on conflict(store_id) do update set document=excluded.document,expires_at=excluded.expires_at,revision=gen_random_uuid(),updated_at=now()
 returning * into k;
 return to_jsonb(k)||jsonb_build_object('available',true,'domain',s.domain);
end;$$;
create function cc_private.load_knowledge(p_store_id uuid,p_epoch integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.cc_stores%rowtype;k cc_private.store_knowledge%rowtype;
begin
 select * into s from public.cc_stores where id=p_store_id for share;
 if not found or s.widget_epoch is distinct from p_epoch then return jsonb_build_object('error','STORE_MISMATCH');end if;
 select * into k from cc_private.store_knowledge where store_id=p_store_id and owner_id=s.owner_id;
 return case when k.store_id is null then jsonb_build_object('available',false,'domain',s.domain) else
 jsonb_build_object('available',true,'domain',s.domain,'document',k.document,'revision',k.revision,'updated_at',k.updated_at,'expires_at',k.expires_at) end;
end;$$;
revoke all on function cc_private.knowledge_operation(uuid,uuid,jsonb,uuid,timestamptz),cc_private.load_knowledge(uuid,integer) from public,anon,authenticated;
grant execute on function cc_private.knowledge_operation(uuid,uuid,jsonb,uuid,timestamptz),cc_private.load_knowledge(uuid,integer) to service_role;
create function public.manage_cc_knowledge(p_store_id uuid,p_owner_id uuid,p_document jsonb,p_expected uuid,p_expires timestamptz) returns jsonb language sql security invoker set search_path='' as $$select cc_private.knowledge_operation(p_store_id,p_owner_id,p_document,p_expected,p_expires);$$;
create function public.load_cc_knowledge(p_store_id uuid,p_epoch integer) returns jsonb language sql security invoker set search_path='' as $$select cc_private.load_knowledge(p_store_id,p_epoch);$$;
revoke all on function public.manage_cc_knowledge(uuid,uuid,jsonb,uuid,timestamptz),public.load_cc_knowledge(uuid,integer) from public,anon,authenticated;
grant execute on function public.manage_cc_knowledge(uuid,uuid,jsonb,uuid,timestamptz),public.load_cc_knowledge(uuid,integer) to service_role;
commit;
