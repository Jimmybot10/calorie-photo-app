// Supabase Edge Function: estimate
// Sends a meal's photos to Claude and stores two estimates:
//   1. Claude's own calorie total.
//   2. Claude's gram estimates priced with CoFID values (Claude picks the matching
//      CoFID food from a shortlist; foods with no good match keep Claude's value).
//
// POST { meal_id: string, with_answer?: boolean }
// Requires the caller's Supabase session token in the Authorization header.
//
// Secrets (Supabase dashboard → Edge Functions → Secrets):
//   ANTHROPIC_API_KEY      required
//   ANTHROPIC_MODEL        optional, defaults to claude-sonnet-5-5
//   ANTHROPIC_MATCH_MODEL  optional, model for the CoFID matching step; defaults to ANTHROPIC_MODEL

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const MAX_PHOTOS = 3;
const MAX_FOODS = 15;
const CANDIDATES_PER_FOOD = 8;
const DEFAULT_MODEL = "claude-sonnet-5-5";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function envKey(jsonVar: string, legacyVar: string): string | undefined {
  const raw = Deno.env.get(jsonVar);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.default) return parsed.default;
    } catch { /* fall through to legacy */ }
  }
  return Deno.env.get(legacyVar) ?? undefined;
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : n;
};
const round1 = (n: number) => Math.round(n * 10) / 10;

const FAT_LABELS: Record<string, string> = {
  none: "no added oil or butter",
  oil: "cooked in oil",
  butter: "cooked in butter",
  other: "cooked with another fat",
  unsure: "unsure whether fat was added",
};
const AMOUNT_LABELS: Record<string, string> = {
  none: "none",
  tsp: "about a teaspoon (5 ml)",
  tbsp: "about a tablespoon (15 ml)",
  more: "more than a tablespoon",
  unsure: "amount unknown",
};

const SYSTEM_PROMPT = `You estimate the energy content (kcal) of meals from photos for a UK user.
- Identify each distinct food and estimate its weight in grams as served, from what is visible.
- Use the plate, bowl, cutlery and any bank card in shot for scale. A bank card is 85.6 x 54 mm. A typical UK dinner plate is 26-27 cm across.
- For each food give cofid_name: how UK food composition tables (McCance and Widdowson's CoFID) would name it, main food first, then type, then how it was cooked or bought. Examples: "Rice, white, basmati, boiled in unsalted water", "Curry, chicken, average, takeaway", "Potato chips, homemade, fried in sunflower oil", "Bread, naan, retail".
- Use typical UK composition values for foods as served.
- Each food's kcal covers that food as described, including any fat its description already includes (for example "fried in oil").
- hidden_fat_kcal is extra energy from oils, butter, dressings or sauces that you can't see and that no food's description already covers. Restaurant and takeaway food usually has more fat than home cooking.
- total_kcal must equal the sum of the foods' kcal plus hidden_fat_kcal.
- Give low_kcal and high_kcal so the true total falls inside that range about 80% of the time.
- Report through the report_estimate tool only.`;

const ESTIMATE_TOOL = {
  name: "report_estimate",
  description: "Report the calorie estimate for the meal in the photos.",
  input_schema: {
    type: "object",
    properties: {
      foods: {
        type: "array",
        maxItems: MAX_FOODS,
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Plain name, e.g. 'chicken curry'." },
            cofid_name: { type: "string", description: "CoFID-style name, e.g. 'Curry, chicken, average, takeaway'." },
            estimated_grams: { type: "number" },
            kcal: { type: "number" },
            notes: { type: "string" },
          },
          required: ["name", "cofid_name", "estimated_grams", "kcal"],
        },
      },
      hidden_fat_kcal: {
        type: "number",
        description: "Extra energy from unseen oils, butter or sauces not covered by any food's description.",
      },
      total_kcal: { type: "number" },
      low_kcal: { type: "number" },
      high_kcal: { type: "number" },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      assumptions: { type: "string" },
    },
    required: ["foods", "hidden_fat_kcal", "total_kcal", "low_kcal", "high_kcal", "confidence"],
  },
};

const MATCH_SYSTEM = `You match foods from a meal to entries in the UK food composition table (CoFID).
For each food, choose the candidate that is the same food as eaten: same main food, same type, and the same cooking method where the table offers one.
Choose "none" if no candidate is a reasonable match. A wrong match is worse than none.
Report through the pick_matches tool only.`;

const MATCH_TOOL = {
  name: "pick_matches",
  description: "Report the chosen CoFID candidate for each food.",
  input_schema: {
    type: "object",
    properties: {
      matches: {
        type: "array",
        items: {
          type: "object",
          properties: {
            food: { type: "integer", description: "Food number from the list." },
            choice: { type: "string", description: "Candidate id such as '2c', or 'none'." },
          },
          required: ["food", "choice"],
        },
      },
    },
    required: ["matches"],
  },
};

async function callClaude(apiKey: string, payload: Record<string, unknown>) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = text.slice(0, 300);
    try { msg = JSON.parse(text)?.error?.message ?? msg; } catch { /* keep raw */ }
    throw new Error(`Claude returned an error (${res.status}): ${msg}`);
  }
  const body = await res.json();
  const toolUse = (body.content ?? []).find((c: { type: string }) => c.type === "tool_use");
  return { input: toolUse?.input, model: body.model as string | undefined, usage: body.usage ?? null };
}

type Food = { name: string; cofid_name: string; estimated_grams: number; kcal: number; notes?: string };
type Candidate = { idx: number; ref_id: number; code: string; name: string; kcal_per_100g: number; score: number };

// Price Claude's grams with CoFID values. Returns null if matching can't run.
async function priceWithCofid(
  admin: SupabaseClient,
  apiKey: string,
  model: string,
  foods: Food[],
  hiddenFat: number,
) {
  const names = foods.map((f) => String(f.cofid_name || f.name).slice(0, 160));
  const { data, error } = await admin.rpc("food_reference_candidates", { names, per_name: CANDIDATES_PER_FOOD });
  if (error) throw new Error(`Food lookup failed: ${error.message}`);
  const byFood = new Map<number, Candidate[]>();
  for (const c of (data ?? []) as Candidate[]) {
    if (!byFood.has(c.idx)) byFood.set(c.idx, []);
    byFood.get(c.idx)!.push(c);
  }

  const letters = "abcdefghij";
  const options = new Map<string, Candidate>();
  const lines: string[] = [];
  foods.forEach((f, i) => {
    const n = i + 1;
    lines.push(`Food ${n}: "${f.name}", described as "${f.cofid_name}"${f.notes ? ` (${f.notes})` : ""}`);
    (byFood.get(n) ?? []).forEach((c, j) => {
      const id = `${n}${letters[j]}`;
      options.set(id, c);
      lines.push(`  ${id}: ${c.name} (${Number(c.kcal_per_100g)} kcal/100 g)`);
    });
  });

  const pick = await callClaude(apiKey, {
    model,
    max_tokens: 600,
    system: MATCH_SYSTEM,
    tools: [MATCH_TOOL],
    tool_choice: { type: "tool", name: "pick_matches" },
    messages: [{ role: "user", content: `For each food, pick one candidate id or "none".\n\n${lines.join("\n")}` }],
  });
  const choices = new Map<number, string>();
  for (const m of (pick.input?.matches ?? []) as { food: number; choice: string }[]) {
    choices.set(Number(m.food), String(m.choice ?? "none").trim().toLowerCase());
  }

  let total = 0;
  let matched = 0;
  const items = foods.map((f, i) => {
    const grams = Math.max(0, num(f.estimated_grams) ?? 0);
    const own = Math.max(0, num(f.kcal) ?? 0);
    const c = options.get(choices.get(i + 1) ?? "none");
    if (c && c.idx === i + 1) {
      const kcal = (grams * Number(c.kcal_per_100g)) / 100;
      total += kcal;
      matched++;
      return {
        name: f.name, cofid_name: f.cofid_name, grams, claude_kcal: own,
        ref_code: c.code, ref_name: c.name, kcal_per_100g: Number(c.kcal_per_100g), kcal: round1(kcal), matched: true,
      };
    }
    total += own;
    return { name: f.name, cofid_name: f.cofid_name, grams, claude_kcal: own, kcal: round1(own), matched: false };
  });
  total += Math.max(0, hiddenFat);
  return { total: round1(total), items, matched, hidden_fat_kcal: hiddenFat, model: pick.model ?? model, usage: pick.usage };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const publishable = envKey("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY");
  const secret = envKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY");
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  const model = Deno.env.get("ANTHROPIC_MODEL") || DEFAULT_MODEL;
  const matchModel = Deno.env.get("ANTHROPIC_MATCH_MODEL") || model;

  if (!publishable || !secret) return json({ error: "Server keys are missing." }, 500);
  if (!anthropicKey) {
    return json({
      error: "The Claude API key isn't set yet. Add ANTHROPIC_API_KEY in Supabase under Edge Functions → Secrets.",
    }, 503);
  }

  // Who is calling?
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Sign in first." }, 401);
  const userClient = createClient(url, publishable, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser(token);
  if (userErr || !userData?.user) return json({ error: "Your session has expired. Sign in again." }, 401);
  const userId = userData.user.id;

  let body: { meal_id?: string; with_answer?: boolean };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Send JSON with meal_id." }, 400);
  }
  const mealId = body.meal_id;
  const withAnswer = body.with_answer === true;
  if (!mealId || !/^[0-9a-f-]{36}$/i.test(mealId)) return json({ error: "meal_id is missing or invalid." }, 400);

  // Read the meal and its photos as the user, so RLS guarantees ownership.
  const { data: meal, error: mealErr } = await userClient
    .from("meals")
    .select("id, category, cooking_fat, fat_amount")
    .eq("id", mealId)
    .maybeSingle();
  if (mealErr) return json({ error: mealErr.message }, 500);
  if (!meal) return json({ error: "Meal not found." }, 404);

  const { data: photos, error: photoErr } = await userClient
    .from("meal_photos")
    .select("storage_path, angle")
    .eq("meal_id", mealId)
    .order("created_at", { ascending: true })
    .limit(MAX_PHOTOS);
  if (photoErr) return json({ error: photoErr.message }, 500);
  if (!photos || photos.length === 0) return json({ error: "Add at least one photo first." }, 400);

  if (withAnswer && !meal.cooking_fat) {
    return json({ error: "Answer the cooking question on this meal first." }, 400);
  }

  const imageBlocks: unknown[] = [];
  for (const p of photos) {
    const { data: blob, error: dlErr } = await userClient.storage.from("meal-photos").download(p.storage_path);
    if (dlErr || !blob) return json({ error: `Couldn't read a photo: ${dlErr?.message ?? "unknown error"}` }, 500);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const mediaType = blob.type && blob.type.startsWith("image/") ? blob.type : "image/jpeg";
    imageBlocks.push({ type: "text", text: `Photo angle: ${p.angle}` });
    imageBlocks.push({ type: "image", source: { type: "base64", media_type: mediaType, data: encodeBase64(bytes) } });
  }

  let instruction = "Estimate the total calories in this meal as served.";
  if (withAnswer) {
    instruction += ` The person who ate it says: ${FAT_LABELS[meal.cooking_fat] ?? meal.cooking_fat}; amount of added fat: ${AMOUNT_LABELS[meal.fat_amount ?? "unsure"] ?? meal.fat_amount}.`;
  }

  // 1. Claude's own estimate from the photos.
  const started = Date.now();
  let ai;
  try {
    ai = await callClaude(anthropicKey, {
      model,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      tools: [ESTIMATE_TOOL],
      tool_choice: { type: "tool", name: "report_estimate" },
      messages: [{ role: "user", content: [...imageBlocks, { type: "text", text: instruction }] }],
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
  const est = ai.input;
  const total = num(est?.total_kcal);
  if (!est || total === null || total < 0 || total > 10000 || !Array.isArray(est.foods)) {
    return json({ error: "Claude's answer couldn't be read. Try again." }, 502);
  }
  const low = num(est.low_kcal);
  const high = num(est.high_kcal);
  const foods: Food[] = est.foods.slice(0, MAX_FOODS);
  const hiddenFat = Math.max(0, num(est.hidden_fat_kcal) ?? 0);
  const visionMs = Date.now() - started;

  // Store with the admin client: users can't write Claude estimates themselves.
  const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
  const source = withAnswer ? "claude_photo_answer" : "claude_photo";
  const { data: saved, error: saveErr } = await admin
    .from("estimates")
    .insert({
      meal_id: mealId,
      user_id: userId,
      source,
      kcal: round1(total),
      kcal_low: low === null ? null : Math.max(0, low),
      kcal_high: high === null ? null : Math.max(0, high),
      model: String(ai.model ?? model).slice(0, 80),
      detail: { ...est, photos_used: photos.length, instruction, usage: ai.usage, ms: visionMs },
    })
    .select("id, source, kcal, kcal_low, kcal_high, model, detail, created_at")
    .single();
  if (saveErr) return json({ error: saveErr.message }, 500);

  // 2. The same grams priced with CoFID. A failure here doesn't lose estimate 1.
  let dbSaved = null;
  let dbError: string | null = null;
  if (foods.length) {
    try {
      const t0 = Date.now();
      const priced = await priceWithCofid(admin, anthropicKey, matchModel, foods, hiddenFat);
      const { data, error } = await admin
        .from("estimates")
        .insert({
          meal_id: mealId,
          user_id: userId,
          source: `${source}_db`,
          kcal: Math.min(10000, priced.total),
          model: String(priced.model).slice(0, 80),
          detail: {
            based_on: saved.id,
            items: priced.items,
            matched: priced.matched,
            foods: priced.items.length,
            hidden_fat_kcal: priced.hidden_fat_kcal,
            usage: priced.usage,
            ms: Date.now() - t0,
          },
        })
        .select("id, source, kcal, kcal_low, kcal_high, model, detail, created_at")
        .single();
      if (error) throw new Error(error.message);
      dbSaved = data;
    } catch (e) {
      dbError = (e as Error).message;
      console.error("CoFID pricing failed:", dbError);
    }
  }

  return json({ estimate: saved, db_estimate: dbSaved, db_error: dbError });
});
