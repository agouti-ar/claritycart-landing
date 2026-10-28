-- READ ONLY. Run only AFTER all three migrations. No customer content is returned.
begin read only;
set local statement_timeout='10s';
select 'questions_rls' as check_name, relrowsecurity as passed
 from pg_class where oid='public.questions'::regclass
union all select 'anon_no_question_table_privileges',not (
 has_table_privilege('anon','public.questions','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
union all select 'anon_no_question_column_privileges',not (
 has_any_column_privilege('anon','public.questions','SELECT,INSERT,UPDATE,REFERENCES'))
union all select 'authenticated_question_select_only',
 has_table_privilege('authenticated','public.questions','SELECT') and not
 has_table_privilege('authenticated','public.questions','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') and not
 has_any_column_privilege('authenticated','public.questions','INSERT,UPDATE,REFERENCES')
union all select 'owner_allow_and_restrict_policies',count(*)=2
 from pg_policies where schemaname='public' and tablename='questions'
 and policyname in ('cc_question_owner_allow','cc_question_owner_restrict')
 and roles=array['authenticated']::name[] and cmd='SELECT'
 and qual like '%cc_store_id%' and qual not like '%user_metadata%'
union all select 'owner_restrict_is_restrictive',count(*)=1
 from pg_policies where schemaname='public' and tablename='questions'
 and policyname='cc_question_owner_restrict' and permissive='RESTRICTIVE'
union all select 'protected_tables_rls',count(*)=5 and bool_and(c.relrowsecurity)
 from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where (n.nspname='public' and c.relname in ('questions','chat_requests','cc_stores','cc_usage_periods'))
 or (n.nspname='cc_private' and c.relname='rate_limits')
union all select 'private_schema_service_only',has_schema_privilege('service_role','cc_private','USAGE')
 and not has_schema_privilege('anon','cc_private','USAGE')
 and not has_schema_privilege('authenticated','cc_private','USAGE')
union all select 'client_entitlement_writes_denied',not
 has_table_privilege('authenticated','public.cc_stores','INSERT,UPDATE,DELETE,TRUNCATE')
union all select 'domain_change_revokes_sessions',count(*)=1
 from pg_trigger where tgrelid='public.cc_stores'::regclass
 and tgname='cc_domain_changed' and tgenabled<>'D'
union all select 'unique_request_index',count(*)=1
 from pg_index where indexrelid='public.cc_question_request_idx'::regclass and indisunique and indisvalid;

select p.oid::regprocedure::text as rpc,
 not p.prosecdef as invoker_wrapper,
 has_function_privilege('service_role',p.oid,'EXECUTE') as service_can_execute,
 not has_function_privilege('anon',p.oid,'EXECUTE') as anon_denied,
 not has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_denied
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in
 ('claim_chat_request','complete_chat_request','get_cc_store_snapshot','consume_cc_rate_limit','claim_verified_chat_request')
order by rpc;
-- Expect five RPC rows with every boolean true; every check above must pass.
-- These catalog checks complement, not replace, two-owner synthetic RLS/API tests.
commit;
