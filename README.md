# Calorie Lab

Phase 0 test tool for the calorie-from-a-photo app. Log meals you've weighed, photograph them, ask Claude for a photo-only estimate, type in what Cal AI and MyFitnessPal say, and see how far each one lands from the weighed truth.

The goal is the Gate 0 decision at the end of week 4:

1. Existing apps average more than 20% error on your meals.
2. LiDAR volumes are within about 15% on simple single foods (tested separately).
3. Asking the cooking-fat question visibly reduces Claude's error.

## How it fits together

| Part | Where | What it does |
| --- | --- | --- |
| Web app | GitHub Pages (`index.html`, `app.js`, `styles.css`) | Sign in, log meals, view results. Static files, no build step. |
| Database and photos | Supabase project `jusxrlmsvovytghdolrv` (London) | Tables for meals, weighed items, photos, estimates and foods. Row Level Security keeps every row private to its owner. Photos sit in a private bucket. |
| Claude call | Supabase Edge Function `estimate` | Reads the meal's photos, sends them to Claude, saves the structured answer. The Claude API key never reaches the browser. |
| Food database | `food_reference` table: 18,750 foods from CoFID 2021 (UK), USDA FoodData Central and Ciqual 2020 | Read-only. Powers the food search on the meal form (UK entries ranked first) and prices Claude's gram estimates. |

Claude never sees the meal title, so its estimate comes from the photos alone. The cooking answer is only added on the "photo + cooking answer" run, so you can compare the two.

Each Claude run saves two estimates:

1. **Claude's own total.**
2. **Claude's grams × CoFID.** Claude names each food the way CoFID would, the database shortlists the closest entries, and a second short Claude call picks the right one (or none). Matched foods are priced at CoFID's kcal per 100 g; unmatched foods keep Claude's value. The results page shows whether this beats Claude's own numbers, which tells you how to build the real app.

## Setup

1. **Claude API key.** In Supabase, open Edge Functions → Secrets and add `ANTHROPIC_API_KEY`. Optionally add `ANTHROPIC_MODEL` to change the model (default `claude-sonnet-5-5`) and `ANTHROPIC_MATCH_MODEL` for the CoFID matching step (defaults to the same model).
2. **GitHub Pages.** In this repo, open Settings → Pages, choose "Deploy from a branch", branch `main`, folder `/ (root)`. The site appears at `https://<your-username>.github.io/calorie-photo-app/`.
3. **Auth URLs.** In Supabase, open Authentication → URL Configuration. Set Site URL to the Pages address above and add the same address under Redirect URLs. Confirmation and password-reset links won't work until this is set.
4. **Sign up.** Supabase's built-in email service only sends to addresses on your Supabase team and is rate limited, so sign up with the email you use for Supabase. To skip confirmation for this solo tool, turn off "Confirm email" under Authentication → Sign In / Providers → Email.

## Logging a meal

1. Weigh each food as served, in grams. Tare the scale between foods. Add measured oil, butter and sauces as their own items. Type a few letters of each food (e.g. "rice bas") and pick it from your foods or CoFID to fill in the kcal per 100 g; choose the cooked version that matches how it was made.
2. Take three photos with the whole plate in frame: straight down, at about 45°, and one with a bank card flat beside the plate.
3. Answer the cooking question: was fat added, and roughly how much.
4. Save, then press both Claude buttons. Run the same photo through Cal AI and MyFitnessPal and type in their numbers.

Aim for 50 meals: 20 home plates, 10 bowls, 10 takeaways, 10 packaged.

## Results page

- **Error by source:** average absolute error, bias (negative means undercounting), share within ±20%, and how often the truth fell inside Claude's 80% range.
- **Does the CoFID lookup help?** Claude's own totals against the same grams priced with CoFID, on the same meals.
- **By meal type:** where each source struggles.
- **Gate 0:** checks 1 and 3 turn green or red once there are 10 scored meals; check 2 is the separate LiDAR test.
- **CSV export:** estimates and weighed items, for your own analysis.

## Files

```
index.html, app.js, styles.css, config.js   web app
vendor/supabase-2.118.0.js                  Supabase client (MIT, see vendor/supabase-LICENSE)
supabase/migrations/                        database schema, policies, views, storage bucket, food search
supabase/seed/                              how the data files were loaded
data/*.tsv                                  CoFID, USDA and Ciqual values per 100 g (see data/README.md)
supabase/functions/estimate/index.ts        Edge Function that calls Claude
```

## Security notes

- `config.js` holds only the project URL and the publishable key, which are safe in public code. Row Level Security decides what each user can read or write.
- Never commit a secret key (`sb_secret_…`), the database password or the Claude API key.
- Users can't write Claude estimates themselves; only the Edge Function can, so the benchmark can't be faked from the browser.

## Data licences

- CoFID 2021: contains public sector information licensed under the [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/). McCance and Widdowson's The Composition of Foods Integrated Dataset 2021.
- USDA FoodData Central (Foundation Foods, SR Legacy, FNDDS): U.S. Department of Agriculture, Agricultural Research Service. Public domain.
- Ciqual 2020: ANSES, French food composition table, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Reformatted to per-100 g columns.

Details of how each file was extracted are in `data/README.md`. Open Food Facts (ODbL) is deliberately not merged in; use it as a live barcode lookup so its share-alike terms don't apply to this database.
