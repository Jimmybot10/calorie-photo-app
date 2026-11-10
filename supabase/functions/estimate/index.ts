// Supabase Edge Function: estimate
// Sends a meal's photos to Claude and stores a structured calorie estimate.
//
// POST { meal_id: string, with_answer?: boolean }
// Requires the caller's Supabase session token in the Authorization header.
//
// Secrets (Supabase dashboard → Edge Functions → Secrets):
//   ANTHROPIC_API_KEY  required
//   ANTHROPIC_MODEL    optional, defaults to claude-sonnet-5-5

import { createClient } from "npm:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const MAX_PHOTOS = 3;
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
- Identify each distinct food and estimate its weight in grams from what is visible.
- Use the plate, bowl, cutlery and any bank card in shot for scale. A bank card is 85.6 x 54 mm. A typical UK dinner plate is 26-27 cm across.
- Use typical UK composition values (McCance and Widdowson's CoFID) for cooked foods as served.
- Include energy from cooking fats, sauces, dressings and spreads, even when they are hard to see. Restaurant and takeaway food usually contains more fat than home cooking.
- Give a low and high value that you expect to contain the true total about 80% of the time.
- Report through the report_estimate tool only.`;

const TOOL = {
  name: "report_estimate",
  description: "Report the calorie estimate for the meal in the photos.",
  input_schema: {
    type: "object",
    properties: {
      foods: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            estimated_grams: { type: "number" },
            kcal: { type: "number" },
            notes: { type: "string" },
          },
          required: ["name", "estimated_grams", "kcal"],
        },
      },
      hidden_fat_kcal: {
        type: "number",
        description: "Energy from oils, butter or sauces you assumed but cannot see directly.",
      },
      total_kcal: { type: "number" },
      low_kcal: { type: "number" },
      high_kcal: { type: "number" },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      assumptions: { type: "string" },
    },
    required: ["foods", "total_kcal", "low_kcal", "high_kcal", "confidence"],
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const publishable = envKey("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY");
  const secret = envKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY");
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  const model = Deno.env.get("ANTHROPIC_MODEL") || DEFAULT_MODEL;

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

  const started = Date.now();
  const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      tools: [TOOL],
      tool_choice: { type: "tool", name: "report_estimate" },
      messages: [{ role: "user", content: [...imageBlocks, { type: "text", text: instruction }] }],
    }),
  });

  if (!aiRes.ok) {
    const text = await aiRes.text();
    let msg = text.slice(0, 300);
    try { msg = JSON.parse(text)?.error?.message ?? msg; } catch { /* keep raw */ }
    return json({ error: `Claude returned an error (${aiRes.status}): ${msg}` }, 502);
  }

  const ai = await aiRes.json();
  const toolUse = (ai.content ?? []).find((c: { type: string }) => c.type === "tool_use");
  const est = toolUse?.input;
  const total = Number(est?.total_kcal);
  if (!est || !Number.isFinite(total) || total < 0 || total > 10000) {
    return json({ error: "Claude's answer couldn't be read. Try again." }, 502);
  }
  const low = Number.isFinite(Number(est.low_kcal)) ? Math.max(0, Number(est.low_kcal)) : null;
  const high = Number.isFinite(Number(est.high_kcal)) ? Math.max(0, Number(est.high_kcal)) : null;

  // Store with the admin client: users can't write Claude estimates themselves.
  const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: saved, error: saveErr } = await admin
    .from("estimates")
    .insert({
      meal_id: mealId,
      user_id: userId,
      source: withAnswer ? "claude_photo_answer" : "claude_photo",
      kcal: Math.round(total * 10) / 10,
      kcal_low: low,
      kcal_high: high,
      model: String(ai.model ?? model).slice(0, 80),
      detail: {
        ...est,
        photos_used: photos.length,
        instruction,
        usage: ai.usage ?? null,
        ms: Date.now() - started,
      },
    })
    .select("id, source, kcal, kcal_low, kcal_high, model, detail, created_at")
    .single();
  if (saveErr) return json({ error: saveErr.message }, 500);

  return json({ estimate: saved });
});
