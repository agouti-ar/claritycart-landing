-- READ ONLY. Run after the separately approved Stage 8 migration.
select c.relrowsecurity as rls_enabled,
 not has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') as anon_no_direct_access,
 not has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') as authenticated_no_direct_access
from pg_class c where c.oid='cc_private.store_knowledge'::regclass;
select p.oid::regprocedure::text as rpc,not p.prosecdef as invoker,
 has_function_privilege('service_role',p.oid,'EXECUTE') as service_allowed,
 not has_function_privilege('anon',p.oid,'EXECUTE') as anon_denied,
 not has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_denied
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('manage_cc_knowledge','load_cc_knowledge');
select count(*) as preserved_unmapped_questions from public.questions where cc_store_id is null;
