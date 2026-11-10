-- Phase 0 meal-testing schema: weighed meals, photos, estimates, personal food list

create table public.foods (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  kcal_per_100g numeric(6,1) not null check (kcal_per_100g >= 0 and kcal_per_100g <= 900),
  source text not null default 'manual' check (source in ('manual','label','cofid','other')),
  source_ref text check (char_length(source_ref) <= 40),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

create table public.meals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 80),
  category text not null check (category in ('home_plate','bowl','takeaway','packaged')),
  eaten_at timestamptz not null default now(),
  cooking_fat text check (cooking_fat in ('none','oil','butter','other','unsure')),
  fat_amount text check (fat_amount in ('none','tsp','tbsp','more','unsure')),
  notes text check (char_length(notes) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index meals_user_eaten_idx on public.meals (user_id, eaten_at desc);

create table public.meal_items (
  id uuid primary key default gen_random_uuid(),
  meal_id uuid not null references public.meals(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  food_name text not null check (char_length(food_name) between 1 and 80),
  grams numeric(7,1) not null check (grams > 0 and grams <= 5000),
  kcal_per_100g numeric(6,1) not null check (kcal_per_100g >= 0 and kcal_per_100g <= 900),
  kcal numeric(8,1) generated always as (round(grams * kcal_per_100g / 100, 1)) stored,
  position smallint not null default 0,
  created_at timestamptz not null default now()
);
create index meal_items_meal_idx on public.meal_items (meal_id);
create index meal_items_user_idx on public.meal_items (user_id);

create table public.meal_photos (
  id uuid primary key default gen_random_uuid(),
  meal_id uuid not null references public.meals(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  storage_path text not null unique check (char_length(storage_path) <= 200),
  angle text not null check (angle in ('overhead','angle45','card','other')),
  width int check (width > 0 and width <= 10000),
  height int check (height > 0 and height <= 10000),
  created_at timestamptz not null default now()
);
create index meal_photos_meal_idx on public.meal_photos (meal_id);
create index meal_photos_user_idx on public.meal_photos (user_id);

create table public.estimates (
  id uuid primary key default gen_random_uuid(),
  meal_id uuid not null references public.meals(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  source text not null check (source in ('claude_photo','claude_photo_answer','cal_ai','myfitnesspal','other_app')),
  kcal numeric(8,1) not null check (kcal >= 0 and kcal <= 10000),
  kcal_low numeric(8,1) check (kcal_low >= 0),
  kcal_high numeric(8,1) check (kcal_high >= 0),
  model text check (char_length(model) <= 80),
  detail jsonb,
  created_at timestamptz not null default now()
);
create index estimates_meal_idx on public.estimates (meal_id);
create index estimates_user_idx on public.estimates (user_id);

-- keep updated_at current
create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger meals_touch before update on public.meals
  for each row execute function public.touch_updated_at();
create trigger foods_touch before update on public.foods
  for each row execute function public.touch_updated_at();

-- Row level security: every row belongs to one signed-in user
alter table public.foods enable row level security;
alter table public.meals enable row level security;
alter table public.meal_items enable row level security;
alter table public.meal_photos enable row level security;
alter table public.estimates enable row level security;

create policy foods_owner_all on public.foods for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy meals_owner_all on public.meals for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy meal_items_owner_all on public.meal_items for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.meals m where m.id = meal_id and m.user_id = (select auth.uid()))
  );

create policy meal_photos_owner_all on public.meal_photos for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.meals m where m.id = meal_id and m.user_id = (select auth.uid()))
  );

-- Users can read and delete all their estimates, but only add or edit the
-- manually entered ones; Claude estimates are written by the edge function.
create policy estimates_owner_select on public.estimates for select to authenticated
  using (user_id = (select auth.uid()));
create policy estimates_owner_delete on public.estimates for delete to authenticated
  using (user_id = (select auth.uid()));
create policy estimates_owner_insert_manual on public.estimates for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and source in ('cal_ai','myfitnesspal','other_app')
    and exists (select 1 from public.meals m where m.id = meal_id and m.user_id = (select auth.uid()))
  );
create policy estimates_owner_update_manual on public.estimates for update to authenticated
  using (user_id = (select auth.uid()) and source in ('cal_ai','myfitnesspal','other_app'))
  with check (user_id = (select auth.uid()) and source in ('cal_ai','myfitnesspal','other_app'));

revoke all on public.foods, public.meals, public.meal_items, public.meal_photos, public.estimates from anon;
grant select, insert, update, delete on public.foods, public.meals, public.meal_items, public.meal_photos, public.estimates to authenticated;

-- Views (run with the caller's permissions, so RLS applies)
create view public.meal_truth with (security_invoker = true) as
select m.id as meal_id, m.user_id, m.title, m.category, m.eaten_at,
       coalesce(sum(i.kcal), 0)::numeric(8,1) as true_kcal,
       count(i.id) as item_count
from public.meals m
left join public.meal_items i on i.meal_id = m.id
group by m.id;

create view public.estimate_errors with (security_invoker = true) as
select e.id as estimate_id, e.meal_id, e.user_id, e.source, e.kcal as estimate_kcal,
       e.kcal_low, e.kcal_high, t.true_kcal, t.category, e.created_at,
       case when t.true_kcal > 0 then round(100.0 * (e.kcal - t.true_kcal) / t.true_kcal, 1) end as signed_pct,
       case when t.true_kcal > 0 then round(100.0 * abs(e.kcal - t.true_kcal) / t.true_kcal, 1) end as abs_pct
from public.estimates e
join public.meal_truth t on t.meal_id = e.meal_id;

create view public.source_summary with (security_invoker = true) as
with latest as (
  select distinct on (meal_id, source) *
  from public.estimate_errors
  where abs_pct is not null
  order by meal_id, source, created_at desc
)
select user_id, source,
       count(*) as meals,
       round(avg(abs_pct), 1) as avg_abs_pct,
       round(avg(signed_pct), 1) as bias_pct,
       round(100.0 * avg((abs_pct <= 20)::int), 0) as pct_within_20
from latest
group by user_id, source;

revoke all on public.meal_truth, public.estimate_errors, public.source_summary from anon;
grant select on public.meal_truth, public.estimate_errors, public.source_summary to authenticated;

-- Private photo storage: each user can only touch files under their own folder
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('meal-photos', 'meal-photos', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

create policy meal_photos_read_own on storage.objects for select to authenticated
  using (bucket_id = 'meal-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy meal_photos_insert_own on storage.objects for insert to authenticated
  with check (bucket_id = 'meal-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy meal_photos_delete_own on storage.objects for delete to authenticated
  using (bucket_id = 'meal-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
