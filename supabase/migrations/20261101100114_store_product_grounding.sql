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
