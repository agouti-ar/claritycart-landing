-- READ ONLY, after the separately approved Stage 5 migration. No payment/user content.
begin read only;
set local statement_timeout='10s';
select count(*)=6 and bool_and(c.relrowsecurity) as all_six_private_tables_have_rls
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='cc_private' and c.relname in
 ('paddle_prices','paddle_checkouts','paddle_subscriptions','paddle_trials','paddle_payments','paddle_events');
select p.oid::regprocedure::text as rpc,not p.prosecdef as invoker_wrapper,
 has_function_privilege('service_role',p.oid,'EXECUTE') as service_allowed,
 not has_function_privilege('anon',p.oid,'EXECUTE') as anon_denied,
 not has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_denied
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('cc_billing_operation','apply_cc_paddle_event');
select count(*) filter(where billing_source='manual') as manual_stores,
 count(*) filter(where billing_source='paddle') as paddle_stores from public.cc_stores;
commit;
