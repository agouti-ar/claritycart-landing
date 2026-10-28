-- Read-only inspection. Execute against the intended test project first.
begin read only;
set local statement_timeout = '10s';
select jsonb_build_object(
 'database', current_database(),
 'questions_columns', (select jsonb_agg(jsonb_build_object('name',column_name,'type',data_type,'nullable',is_nullable,'default',column_default,'identity',is_identity,'identity_generation',identity_generation,'generated',is_generated)) from information_schema.columns where table_schema='public' and table_name='questions'),
 'questions_rls', (select jsonb_build_object('enabled',relrowsecurity,'forced',relforcerowsecurity) from pg_class where oid=to_regclass('public.questions')),
 'questions_policies', (select jsonb_agg(to_jsonb(p)) from pg_policies p where schemaname='public' and tablename='questions'),
 'questions_grants', (select jsonb_agg(to_jsonb(g)) from information_schema.role_table_grants g where table_schema='public' and table_name='questions'),
 'questions_column_grants', (select jsonb_agg(to_jsonb(g)) from information_schema.column_privileges g where table_schema='public' and table_name='questions'),
 'questions_constraints', (select jsonb_agg(pg_get_constraintdef(oid)) from pg_constraint where conrelid=to_regclass('public.questions')),
 'questions_triggers', (select jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'function_schema',n.nspname,'function_name',p.proname,'security_definer',p.prosecdef)) from pg_trigger t join pg_proc p on p.oid=t.tgfoid join pg_namespace n on n.oid=p.pronamespace where t.tgrelid=to_regclass('public.questions') and not t.tgisinternal),
 'usage_migration_present', to_regclass('public.chat_requests') is not null,
 'stage2_present', to_regclass('public.cc_stores') is not null
) as compatibility_snapshot;
-- Only execute this if questions exists; contains counts/timestamps, not question text.
select count(*) as rows, count(*) filter(where store_domain is null) as missing_domain,
       min(created_at) as earliest, max(created_at) as latest from public.questions;
commit;
