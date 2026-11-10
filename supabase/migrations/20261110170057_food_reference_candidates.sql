-- Replace single best-match with a shortlist per name; the estimate function asks
-- Claude to pick from it, because the closest spelling is often the wrong food.
drop function if exists public.match_food_reference(text[]);

create or replace function public.food_reference_candidates(names text[], per_name int default 8)
returns table (idx int, query text, ref_id int, code text, name text, kcal_per_100g numeric, score real)
language sql stable security invoker set search_path = '' as $$
  select q.idx::int, q.query, c.id, c.code, c.name, c.kcal_per_100g, c.s
  from unnest(names[1:15]) with ordinality as q(query, idx)
  cross join lateral (
    select f.id, f.code, f.name, f.kcal_per_100g,
      greatest(
        extensions.similarity(lower(q.query), lower(f.name)),
        extensions.word_similarity(lower(q.query), lower(f.name)),
        (select count(*) filter (where position(w in lower(f.name)) > 0)::real / greatest(count(*), 1)
           from unnest(regexp_split_to_array(lower(q.query), '[^a-z]+')) as w where length(w) > 2)
      ) as s
    from public.food_reference f
    order by 5 desc, length(f.name)
    limit least(greatest(coalesce(per_name, 8), 1), 10)
  ) c
  order by q.idx, c.s desc;
$$;

revoke execute on function public.food_reference_candidates(text[], int) from public, anon;
grant execute on function public.food_reference_candidates(text[], int) to authenticated, service_role;
