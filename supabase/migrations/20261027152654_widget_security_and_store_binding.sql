-- Stage 3, PREPARED ONLY. Review preflight output before applying to any shared DB.
begin;
alter table public.cc_stores add column domain_verified_at timestamptz,
 add column domain_verification_token uuid not null default gen_random_uuid(),
 add column widget_epoch integer not null default 1;
create function cc_private.reset_domain_verification() returns trigger language plpgsql set search_path='' as $$
begin
 if new.domain<>old.domain or new.owner_id<>old.owner_id then
  new.domain_verified_at:=null;new.domain_verification_token:=gen_random_uuid();new.widget_epoch:=old.widget_epoch+1;
 end if;
 return new;
end; $$;
revoke all on function cc_private.reset_domain_verification() from public,anon,authenticated;
create trigger cc_domain_changed before update of domain,owner_id on public.cc_stores for each row execute function cc_private.reset_domain_verification();

create table cc_private.rate_limits(bucket text not null,window_start timestamptz not null,used integer not null check(used>0),primary key(bucket,window_start));
create index cc_rate_window_idx on cc_private.rate_limits(window_start);
alter table cc_private.rate_limits enable row level security;
revoke all on cc_private.rate_limits from public,anon,authenticated;
create function cc_private.consume_rate(p_bucket text,p_limit integer,p_window_seconds integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w timestamptz; n integer;
begin
 if p_limit<1 or p_limit>10000 or p_window_seconds<10 or p_window_seconds>3600 or p_bucket!~'^[a-f0-9]{64}$' then raise exception 'Invalid rate parameters'; end if;
 w:=to_timestamp(floor(extract(epoch from clock_timestamp())/p_window_seconds)*p_window_seconds);
 insert into cc_private.rate_limits(bucket,window_start,used) values(p_bucket,w,1)
 on conflict(bucket,window_start) do update set used=cc_private.rate_limits.used+1 where cc_private.rate_limits.used<p_limit returning used into n;
 -- These rows contain only keyed hashes, not raw IPs. Bound their retention to one day.
 delete from cc_private.rate_limits where window_start<clock_timestamp()-interval '1 day';
 return jsonb_build_object('allowed',n is not null);
end; $$;
revoke all on function cc_private.consume_rate(text,integer,integer) from public,anon,authenticated;
grant execute on function cc_private.consume_rate(text,integer,integer) to service_role;
create function public.consume_cc_rate_limit(p_bucket text,p_limit integer,p_window_seconds integer) returns jsonb language sql security invoker set search_path='' as $$select cc_private.consume_rate(p_bucket,p_limit,p_window_seconds);$$;
revoke all on function public.consume_cc_rate_limit(text,integer,integer) from public,anon,authenticated;
grant execute on function public.consume_cc_rate_limit(text,integer,integer) to service_role;

-- The checked store ID is locked before reusing the Stage 2 reservation logic.
create function cc_private.claim_verified(p_request_id uuid,p_domain text,p_fingerprint text,p_owner uuid,p_store_id uuid,p_widget_epoch integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.cc_stores%rowtype;
begin
 select * into s from public.cc_stores where id=p_store_id for update;
 if not found or s.domain<>p_domain or s.widget_epoch<>p_widget_epoch then return jsonb_build_object('state','denied','error','STORE_MISMATCH','http_status',403);end if;
 return cc_private.claim(p_request_id,p_domain,p_fingerprint,p_owner);
end; $$;
revoke all on function cc_private.claim_verified(uuid,text,text,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function cc_private.claim_verified(uuid,text,text,uuid,uuid,integer) to service_role;
create function public.claim_verified_chat_request(p_request_id uuid,p_domain text,p_fingerprint text,p_owner uuid,p_store_id uuid,p_widget_epoch integer)
returns jsonb language sql security invoker set search_path='' as $$select cc_private.claim_verified(p_request_id,p_domain,p_fingerprint,p_owner,p_store_id,p_widget_epoch);$$;
revoke all on function public.claim_verified_chat_request(uuid,text,text,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.claim_verified_chat_request(uuid,text,text,uuid,uuid,integer) to service_role;

-- Keep old policies for review, but AND a restrictive owner predicate with every
-- permissive authenticated SELECT policy. No unreviewed policy is dropped.
alter table public.questions enable row level security;
revoke all on public.questions from public,anon,authenticated;
grant select on public.questions to authenticated;
-- Column-specific grants can otherwise survive a table-level REVOKE.
do $$declare col record;begin
 for col in select attname from pg_attribute where attrelid='public.questions'::regclass and attnum>0 and not attisdropped loop
  execute format('revoke all privileges (%I) on public.questions from public,anon,authenticated',col.attname);
 end loop;
end;$$;
create policy cc_question_owner_allow on public.questions for select to authenticated using (
 exists(select 1 from public.cc_stores s where s.owner_id=(select auth.uid()) and
 s.id=cc_store_id));
create policy cc_question_owner_restrict on public.questions as restrictive for select to authenticated using (
 exists(select 1 from public.cc_stores s where s.owner_id=(select auth.uid()) and
 s.id=cc_store_id));
commit;
