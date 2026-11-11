-- Add USDA FoodData Central and Ciqual 2020 alongside CoFID in food_reference.

-- Longer names (USDA dish names run to ~185 characters) and energy up to 950 kcal
-- (USDA and Ciqual list a few fats at 901-902 kcal/100 g).
alter table public.food_reference drop constraint if exists food_reference_name_check;
alter table public.food_reference add constraint food_reference_name_check check (char_length(name) between 1 and 255);
alter table public.food_reference drop constraint if exists food_reference_kcal_per_100g_check;
alter table public.food_reference add constraint food_reference_kcal_per_100g_check check (kcal_per_100g >= 0 and kcal_per_100g <= 950);
alter table public.food_reference add column if not exists group_label text check (char_length(group_label) <= 80);
alter table public.food_reference add constraint food_reference_source_check check (source in
  ('cofid_2021', 'usda_foundation', 'usda_sr_legacy', 'usda_fndds', 'ciqual_2020'));
update public.food_reference set group_label = public.cofid_group_name(food_group) where source = 'cofid_2021';

alter table public.meal_items drop constraint meal_items_food_name_check;
alter table public.meal_items add constraint meal_items_food_name_check check (char_length(food_name) between 1 and 255);
alter table public.meal_items drop constraint meal_items_kcal_per_100g_check;
alter table public.meal_items add constraint meal_items_kcal_per_100g_check check (kcal_per_100g >= 0 and kcal_per_100g <= 950);
alter table public.foods drop constraint foods_name_check;
alter table public.foods add constraint foods_name_check check (char_length(name) between 1 and 255);
alter table public.foods drop constraint foods_kcal_per_100g_check;
alter table public.foods add constraint foods_kcal_per_100g_check check (kcal_per_100g >= 0 and kcal_per_100g <= 950);
alter table public.foods drop constraint foods_source_check;
alter table public.foods add constraint foods_source_check check (source in ('manual', 'label', 'cofid', 'usda', 'ciqual', 'other'));

-- Codes shown to the app: CoFID codes as they are, others prefixed so they can't clash.
create or replace function public.food_reference_ref(source text, code text)
returns text language sql immutable set search_path = '' as $$
  select case when source = 'cofid_2021' then code
              when source like 'usda%' then 'usda:' || code
              when source like 'ciqual%' then 'ciqual:' || code
              else code end;
$$;

create or replace function public.food_reference_source_label(source text)
returns text language sql immutable set search_path = '' as $$
  select case when source = 'cofid_2021' then 'CoFID'
              when source = 'usda_fndds' then 'USDA dishes'
              when source like 'usda%' then 'USDA'
              when source like 'ciqual%' then 'Ciqual'
              else source end;
$$;

-- UK data first when matches are about as good.
create or replace function public.food_reference_priority(source text)
returns int language sql immutable set search_path = '' as $$
  select case source when 'cofid_2021' then 0 when 'usda_sr_legacy' then 1 when 'usda_foundation' then 1
                     when 'usda_fndds' then 2 when 'ciqual_2020' then 2 else 3 end;
$$;

drop function if exists public.search_food_reference(text, int);
create function public.search_food_reference(q text, max_results int default 12)
returns table (code text, name text, source text, source_label text, group_name text, kcal_per_100g numeric, score real)
language sql stable security invoker set search_path = '' as $$
  with terms as (
    select array_agg(t) as ts
    from unnest(regexp_split_to_array(lower(trim(coalesce(q, ''))), '[^a-z0-9]+')) as t
    where t <> ''
  )
  select public.food_reference_ref(f.source, f.code), f.name, f.source, public.food_reference_source_label(f.source),
         f.group_label, f.kcal_per_100g, extensions.word_similarity(lower(q), lower(f.name)) as score
  from public.food_reference f, terms
  where terms.ts is not null
    and not exists (select 1 from unnest(terms.ts) t where position(t in lower(f.name)) = 0)
  order by (lower(f.name) like terms.ts[1] || '%') desc,
           round(extensions.word_similarity(lower(q), lower(f.name))::numeric, 1) desc,
           public.food_reference_priority(f.source), length(f.name)
  limit least(greatest(coalesce(max_results, 12), 1), 30);
$$;

-- Same shortlist as before, with non-UK entries tagged so the picker can tell them apart.
create or replace function public.food_reference_candidates(names text[], per_name int default 8)
returns table (idx int, query text, ref_id int, code text, name text, kcal_per_100g numeric, score real)
language sql stable security invoker set search_path = '' as $$
  select q.idx::int, q.query, c.id, c.ref, c.label, c.kcal, c.s
  from unnest(names[1:15]) with ordinality as q(query, idx)
  cross join lateral (
    select x.* from (
      select f.id,
        public.food_reference_ref(f.source, f.code) as ref,
        f.name || case when f.source = 'cofid_2021' then '' else ' [' || public.food_reference_source_label(f.source) || ', not UK]' end as label,
        f.kcal_per_100g as kcal,
        greatest(
          extensions.similarity(lower(q.query), lower(f.name)),
          extensions.word_similarity(lower(q.query), lower(f.name)),
          (select count(*) filter (where position(w in lower(f.name)) > 0)::real / greatest(count(*), 1)
             from unnest(regexp_split_to_array(lower(q.query), '[^a-z]+')) as w where length(w) > 2)
        ) as s,
        public.food_reference_priority(f.source) as pr,
        length(f.name) as len
      from public.food_reference f
    ) x
    order by round(x.s::numeric, 1) desc, x.pr, x.s desc, x.len
    limit least(greatest(coalesce(per_name, 8), 1), 10)
  ) c
  order by q.idx, c.s desc;
$$;

revoke execute on function public.search_food_reference(text, int) from public, anon;
grant execute on function public.search_food_reference(text, int) to authenticated, service_role;
revoke execute on function public.food_reference_candidates(text[], int) from public, anon;
grant execute on function public.food_reference_candidates(text[], int) to authenticated, service_role;
revoke execute on function public.food_reference_ref(text, text) from public, anon;
revoke execute on function public.food_reference_source_label(text) from public, anon;
revoke execute on function public.food_reference_priority(text) from public, anon;
grant execute on function public.food_reference_ref(text, text) to authenticated, service_role;
grant execute on function public.food_reference_source_label(text) to authenticated, service_role;
grant execute on function public.food_reference_priority(text) to authenticated, service_role;
