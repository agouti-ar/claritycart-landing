-- PREPARED ONLY. Review and apply to a test database before production.
-- Requires existing public.questions(store_domain, question_text, product_context).
-- Keeps existing questions and SELECT policies unchanged.
begin;

create table public.chat_requests (
  request_id uuid primary key,
  store_domain text not null,
  fingerprint text not null,
  owner_token uuid not null,
  state text not null default 'processing' check (state in ('processing', 'completed')),
  response jsonb,
  http_status integer,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
alter table public.chat_requests enable row level security;
revoke all on public.chat_requests from public, anon, authenticated;
grant select, insert, update on public.chat_requests to service_role;

create function public.claim_chat_request(p_request_id uuid, p_domain text, p_fingerprint text, p_owner uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.chat_requests%rowtype;
begin
  insert into public.chat_requests(request_id, store_domain, fingerprint, owner_token)
  values (p_request_id, p_domain, p_fingerprint, p_owner)
  on conflict (request_id) do nothing;
  select * into strict r from public.chat_requests where request_id = p_request_id for update;
  if r.store_domain <> p_domain or r.fingerprint <> p_fingerprint then
    return jsonb_build_object('state', 'conflict');
  end if;
  -- Do not regenerate a crashed request. Expire it to a terminal, uncharged result.
  if r.state = 'processing' and r.created_at < now() - interval '2 minutes' then
    update public.chat_requests set state = 'completed', http_status = 504, completed_at = now(),
      response = jsonb_build_object('error', 'REQUEST_EXPIRED', 'answer', 'The previous request expired. Please try again.',
        'requestId', p_request_id, 'usageRecorded', false)
      where request_id = p_request_id returning * into r;
  end if;
  if r.state = 'completed' then
    return jsonb_build_object('state', 'completed', 'response', r.response, 'http_status', r.http_status);
  elsif r.owner_token = p_owner then
    return jsonb_build_object('state', 'claimed');
  end if;
  return jsonb_build_object('state', 'processing');
end;
$$;

create function public.complete_chat_request(p_request_id uuid, p_owner uuid, p_response jsonb,
  p_http_status integer, p_record_usage boolean, p_question text, p_product_context text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.chat_requests%rowtype;
begin
  select * into strict r from public.chat_requests where request_id = p_request_id for update;
  if r.owner_token <> p_owner then raise exception 'Request owner mismatch'; end if;
  if r.state <> 'completed' then
    if r.created_at < now() - interval '2 minutes' then
      p_record_usage := false;
      p_http_status := 504;
      p_response := jsonb_build_object('error', 'REQUEST_EXPIRED', 'answer', 'The previous request expired. Please try again.',
        'requestId', p_request_id, 'usageRecorded', false);
    end if;
    if p_record_usage then
      insert into public.questions(store_domain, question_text, product_context)
      values (r.store_domain, p_question, p_product_context);
    end if;
    update public.chat_requests set state = 'completed', response = p_response,
      http_status = p_http_status, completed_at = now() where request_id = p_request_id
      returning * into r;
  end if;
  return jsonb_build_object('response', r.response, 'http_status', r.http_status);
end;
$$;

revoke all on function public.claim_chat_request(uuid,text,text,uuid) from public, anon, authenticated;
revoke all on function public.complete_chat_request(uuid,uuid,jsonb,integer,boolean,text,text) from public, anon, authenticated;
grant execute on function public.claim_chat_request(uuid,text,text,uuid) to service_role;
grant execute on function public.complete_chat_request(uuid,uuid,jsonb,integer,boolean,text,text) to service_role;

-- Browser writes must be disabled together with rollout of server-owned recording.
-- SELECT policies stay unchanged, so dashboards can continue reading questions.
revoke insert on public.questions from public, anon, authenticated;
commit;
