-- PREPARED ONLY: run after 001, Stage 2 and Stage 3, before enabling new traffic.
-- Default is validation only. No domain-based ownership inference is performed.
-- Fill explicit, independently reviewed IDs/owners; never include question text.
-- Applying to any shared database requires separate approval.
begin;
set local statement_timeout = '15s';
set local lock_timeout = '3s';
set local claritycart.apply_legacy_mapping = 'false';
create temporary table cc_legacy_mapping_plan (
 question_id bigint primary key,
 store_id uuid not null,
 expected_owner_id uuid not null,
 expected_store_domain text not null,
 expected_question_domain text not null
) on commit drop;
-- APPROVED_MAPPING_ROWS
-- insert into cc_legacy_mapping_plan values
-- (123, '<verified-store-uuid>', '<verified-owner-uuid>', 'current.example', 'historical.example');

-- Maintenance operation: serialize with claims/completions and ownership changes.
lock table public.cc_stores, public.questions, public.cc_usage_periods in share row exclusive mode;
do $$
begin
 if exists (
  select 1 from cc_legacy_mapping_plan p
  left join public.cc_stores s on s.id=p.store_id
  left join public.questions q on q.id=p.question_id
  where s.id is null or q.id is null or s.owner_id<>p.expected_owner_id
   or s.domain<>p.expected_store_domain or q.store_domain<>p.expected_question_domain
   or q.cc_request_id is not null or (q.cc_store_id is not null and q.cc_store_id<>s.id)
 ) then raise exception 'Legacy mapping rejected: missing row, stale owner/domain, conflicting binding or non-legacy request'; end if;
 if exists (
  select 1 from cc_legacy_mapping_plan p join public.questions q on q.id=p.question_id
  join public.cc_usage_periods u on u.store_id=p.store_id where q.cc_store_id is null
 ) then raise exception 'Legacy mapping rejected: usage period already exists; reconcile counters before mapping'; end if;
 if current_setting('claritycart.apply_legacy_mapping')='true' then
  update public.questions q set cc_store_id=p.store_id
   from cc_legacy_mapping_plan p where q.id=p.question_id and q.cc_store_id is null;
 end if;
end; $$;
select current_setting('claritycart.apply_legacy_mapping')='true' as apply_requested,
 count(*)::integer as reviewed_rows,
 count(*) filter(where q.cc_store_id=p.store_id)::integer as bound_rows,
 count(*) filter(where q.cc_store_id is null)::integer as unbound_rows
from cc_legacy_mapping_plan p join public.questions q on q.id=p.question_id;
commit;
