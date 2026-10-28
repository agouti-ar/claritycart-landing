-- READ ONLY: execute before and after migrations, while application writes are stopped.
-- Compare both returned values. No question text or per-question content hash is returned.
begin read only;
set local statement_timeout='10s';
set local timezone='UTC';
select count(*) as original_history_rows,
 md5(coalesce(string_agg(jsonb_build_array(q.id,q.created_at,q.store_domain,q.question_text,q.product_context)::text,
 E'\n' order by q.id),'')) as original_history_fingerprint
from public.questions q where to_jsonb(q)->>'cc_request_id' is null;
commit;
