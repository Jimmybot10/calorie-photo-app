-- With ~18,750 foods, scoring every row for every name took ~10 s. Narrow to rows that
-- contain one of the first two words of the description (main food first, as in CoFID
-- naming; the regex uses the trigram index), then score that shorter list.
create or replace function public.food_reference_candidates(names text[], per_name int default 8)
returns table (idx int, query text, ref_id int, code text, name text, kcal_per_100g numeric, score real)
language sql stable security invoker set search_path = '' as $$
  select q.idx::int, q.query, c.id, c.ref, c.label, c.kcal, c.s
  from unnest(names[1:15]) with ordinality as q(query, idx)
  cross join lateral (
    select coalesce(array_agg(t.w order by t.n), '{}') as ws
    from unnest(regexp_split_to_array(lower(q.query), '[^a-z]+')) with ordinality as t(w, n)
    where length(t.w) > 2
  ) qw
  cross join lateral (
    select x.* from (
      select f.id,
        public.food_reference_ref(f.source, f.code) as ref,
        f.name || case when f.source = 'cofid_2021' then '' else ' [' || public.food_reference_source_label(f.source) || ', not UK]' end as label,
        f.kcal_per_100g as kcal,
        greatest(
          extensions.similarity(lower(q.query), lower(f.name)),
          extensions.word_similarity(lower(q.query), lower(f.name)),
          (select count(*) from unnest(qw.ws) as w where position(w in lower(f.name)) > 0)::real / greatest(cardinality(qw.ws), 1)
        ) as s,
        public.food_reference_priority(f.source) as pr,
        length(f.name) as len
      from public.food_reference f
      where cardinality(qw.ws) > 0
        and lower(f.name) ~ ('(' || array_to_string(qw.ws[1:2], '|') || ')')
    ) x
    order by round(x.s::numeric, 1) desc, x.pr, x.s desc, x.len
    limit least(greatest(coalesce(per_name, 8), 1), 10)
  ) c
  order by q.idx, c.s desc;
$$;

revoke execute on function public.food_reference_candidates(text[], int) from public, anon;
grant execute on function public.food_reference_candidates(text[], int) to authenticated, service_role;
