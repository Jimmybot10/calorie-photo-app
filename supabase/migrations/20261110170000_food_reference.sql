-- Shared, read-only food composition reference (CoFID 2021) with search and matching.

create extension if not exists pg_trgm with schema extensions;

create table public.food_reference (
  id integer generated always as identity primary key,
  source text not null default 'cofid_2021',
  code text not null check (char_length(code) <= 20),
  name text not null check (char_length(name) between 1 and 160),
  food_group text check (char_length(food_group) <= 10),
  kcal_per_100g numeric(6,1) not null check (kcal_per_100g >= 0 and kcal_per_100g <= 900),
  protein_g numeric(6,2),
  fat_g numeric(6,2),
  carb_g numeric(6,2),
  sugars_g numeric(6,2),
  fibre_g numeric(6,2),
  water_g numeric(6,2),
  edible_proportion numeric(5,3),
  -- CoFID 2021 reuses code 13-669 for two foods, so the code alone isn't unique
  unique (source, code, name)
);
create index food_reference_name_trgm on public.food_reference using gin (lower(name) extensions.gin_trgm_ops);

alter table public.food_reference enable row level security;
create policy food_reference_read on public.food_reference for select to authenticated using (true);
revoke all on public.food_reference from anon, authenticated;
grant select on public.food_reference to authenticated;

-- Readable food group from the CoFID group code's first letter
create or replace function public.cofid_group_name(code text)
returns text language sql immutable set search_path = '' as $$
  select case upper(left(code, 1))
    when 'A' then 'Cereals' when 'B' then 'Milk and dairy' when 'C' then 'Eggs'
    when 'D' then 'Vegetables' when 'F' then 'Fruit' when 'G' then 'Nuts and seeds'
    when 'H' then 'Herbs and spices' when 'J' then 'Fish' when 'M' then 'Meat'
    when 'O' then 'Fats and oils' when 'P' then 'Drinks' when 'Q' then 'Alcoholic drinks'
    when 'S' then 'Sugars and snacks' when 'W' then 'Soups and sauces' else null end;
$$;

-- Type-ahead search: every word must appear in the name; names starting with the
-- first word come first, then closest overall match.
create or replace function public.search_food_reference(q text, max_results int default 12)
returns table (code text, name text, food_group text, group_name text, kcal_per_100g numeric, score real)
language sql stable security invoker set search_path = '' as $$
  with terms as (
    select array_agg(t) as ts
    from unnest(regexp_split_to_array(lower(trim(coalesce(q, ''))), '[^a-z0-9]+')) as t
    where t <> ''
  )
  select f.code, f.name, f.food_group, public.cofid_group_name(f.food_group), f.kcal_per_100g,
         extensions.word_similarity(lower(q), lower(f.name)) as score
  from public.food_reference f, terms
  where terms.ts is not null
    and not exists (select 1 from unnest(terms.ts) t where position(t in lower(f.name)) = 0)
  order by (lower(f.name) like terms.ts[1] || '%') desc, score desc, length(f.name)
  limit least(greatest(coalesce(max_results, 12), 1), 30);
$$;

-- Best single match for each name (used by the estimate function).
create or replace function public.match_food_reference(names text[])
returns table (idx int, query text, code text, name text, kcal_per_100g numeric, score real)
language sql stable security invoker set search_path = '' as $$
  select q.idx::int, q.query, m.code, m.name, m.kcal_per_100g, m.score
  from unnest(names) with ordinality as q(query, idx)
  left join lateral (
    select f.code, f.name, f.kcal_per_100g, extensions.similarity(lower(q.query), lower(f.name)) as score
    from public.food_reference f
    order by extensions.similarity(lower(q.query), lower(f.name)) desc, length(f.name)
    limit 1
  ) m on true
  order by q.idx;
$$;

revoke execute on function public.search_food_reference(text, int) from public, anon;
revoke execute on function public.match_food_reference(text[]) from public, anon;
revoke execute on function public.cofid_group_name(text) from public, anon;
grant execute on function public.search_food_reference(text, int) to authenticated, service_role;
grant execute on function public.match_food_reference(text[]) to authenticated, service_role;
grant execute on function public.cofid_group_name(text) to authenticated, service_role;

-- Allow CoFID-length names and record which reference food a weighed item came from
alter table public.meal_items drop constraint meal_items_food_name_check;
alter table public.meal_items add constraint meal_items_food_name_check check (char_length(food_name) between 1 and 160);
alter table public.meal_items add column food_code text check (char_length(food_code) <= 20);
alter table public.foods drop constraint foods_name_check;
alter table public.foods add constraint foods_name_check check (char_length(name) between 1 and 160);

-- Estimates built from Claude's grams times CoFID energy values
alter table public.estimates drop constraint estimates_source_check;
alter table public.estimates add constraint estimates_source_check check (source in (
  'claude_photo', 'claude_photo_answer', 'claude_photo_db', 'claude_photo_answer_db',
  'cal_ai', 'myfitnesspal', 'other_app'));
