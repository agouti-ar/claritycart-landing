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
