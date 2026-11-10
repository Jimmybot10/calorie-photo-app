-- Load data/cofid_2021_proximates.tsv into public.food_reference.
-- Run in the Supabase SQL editor, one step at a time. Uses pg_net to fetch the
-- file from this public GitHub repo, then removes pg_net again.

-- 1. Fetch the file. Note the number this returns.
create extension if not exists pg_net;
select net.http_get(
  'https://raw.githubusercontent.com/Jimmybot10/calorie-photo-app/main/data/cofid_2021_proximates.tsv',
  timeout_milliseconds := 30000
) as request_id;

-- 2. A few seconds later, check it arrived (status 200).
select id, status_code, length(content) from net._http_response order by id desc limit 1;

-- 3. Load it (replace 1 with the request id from step 1).
with body as (
  select content from net._http_response where id = 1 and status_code = 200
), lines as (
  select line, n
  from body, string_to_table(content, E'\n') with ordinality as l(line, n)
  where n > 1 and line <> ''
), fields as (
  select string_to_array(line, E'\t') as f from lines
)
insert into public.food_reference
  (source, code, name, food_group, kcal_per_100g, protein_g, fat_g, carb_g, sugars_g, fibre_g, water_g, edible_proportion)
select 'cofid_2021', f[1], f[2], nullif(f[3], ''), f[4]::numeric,
       nullif(f[5], '')::numeric, nullif(f[6], '')::numeric, nullif(f[7], '')::numeric,
       nullif(f[8], '')::numeric, nullif(f[9], '')::numeric, nullif(f[10], '')::numeric,
       nullif(f[11], '')::numeric
from fields
on conflict (source, code, name) do update set
  food_group = excluded.food_group, kcal_per_100g = excluded.kcal_per_100g,
  protein_g = excluded.protein_g, fat_g = excluded.fat_g, carb_g = excluded.carb_g,
  sugars_g = excluded.sugars_g, fibre_g = excluded.fibre_g, water_g = excluded.water_g,
  edible_proportion = excluded.edible_proportion;

-- 4. Tidy up.
drop extension pg_net;
select count(*) from public.food_reference;  -- expect 2854
