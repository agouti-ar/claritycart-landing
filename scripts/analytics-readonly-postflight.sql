-- READ ONLY. Run after the separately approved Stage 7 migration.
select count(*)=2 as two_tables,
 bool_and(c.relrowsecurity) as all_rls_enabled,
 bool_and(not has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE')) as anon_no_direct_access,
 bool_and(not has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE')) as authenticated_no_direct_access
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='cc_private' and c.relname in ('analytics_sessions','analytics_events');
select p.oid::regprocedure::text as rpc,not p.prosecdef as invoker,
 has_function_privilege('service_role',p.oid,'EXECUTE') as service_allowed,
 not has_function_privilege('anon',p.oid,'EXECUTE') as anon_denied,
 not has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_denied
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('ingest_cc_events','bind_cc_chat_analytics','get_cc_analytics');
select count(*) as preserved_unmapped_questions from public.questions where cc_store_id is null;
