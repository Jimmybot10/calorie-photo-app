// Calorie Lab: Phase 0 meal-testing app.
// Log weighed meals with photos, ask Claude for a photo-only estimate, record what
// other apps say, and track how far each source lands from the weighed total.

const initialHash = location.hash; // read before the auth library tidies the URL
const cfg = window.APP_CONFIG || {};
const app = document.getElementById("app");
const nav = document.getElementById("nav");
const toastEl = document.getElementById("toast");

const TARGET = Number(cfg.targetMeals) || 50;
const MAX_SIDE = 1600;
const BUCKET = "meal-photos";

const CATEGORIES = [
  { id: "home_plate", label: "Home plate", target: 20 },
  { id: "bowl", label: "Bowl", target: 10 },
  { id: "takeaway", label: "Takeaway", target: 10 },
  { id: "packaged", label: "Packaged", target: 10 },
];
const CAT = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

const SOURCES = {
  claude_photo: { label: "Claude, photo only", short: "Claude" },
  claude_photo_answer: { label: "Claude, photo + cooking answer", short: "Claude + Q" },
  claude_photo_db: { label: "Claude grams × CoFID, photo only", short: "CoFID" },
  claude_photo_answer_db: { label: "Claude grams × CoFID, photo + answer", short: "CoFID + Q" },
  cal_ai: { label: "Cal AI", short: "Cal AI" },
  myfitnesspal: { label: "MyFitnessPal", short: "MFP" },
  other_app: { label: "Other app", short: "Other" },
};
const SOURCE_ORDER = ["claude_photo", "claude_photo_answer", "claude_photo_db", "claude_photo_answer_db", "cal_ai", "myfitnesspal", "other_app"];
const APP_SOURCES = ["cal_ai", "myfitnesspal", "other_app"];

const ANGLES = [
  { id: "overhead", label: "Overhead", hint: "Straight down" },
  { id: "angle45", label: "45° angle", hint: "Shows height" },
  { id: "card", label: "With card", hint: "Bank card by the plate" },
];
const ANGLE_LABEL = { overhead: "Overhead", angle45: "45° angle", card: "With card", other: "Other" };

const FATS = [["none", "None"], ["oil", "Oil"], ["butter", "Butter"], ["other", "Other fat"], ["unsure", "Not sure"]];
const AMOUNTS = [["tsp", "About 1 tsp"], ["tbsp", "About 1 tbsp"], ["more", "More than 1 tbsp"], ["unsure", "Not sure"]];
const FAT_LABEL = Object.fromEntries(FATS);
const AMOUNT_LABEL = { none: "none", ...Object.fromEntries(AMOUNTS) };
const FOOD_SOURCES = [["manual", "Manual"], ["label", "Pack label"], ["cofid", "CoFID"], ["other", "Other"]];
const FOOD_SOURCE_LABEL = Object.fromEntries(FOOD_SOURCES);

// ---------- setup ----------

if (!window.supabase || !cfg.supabaseUrl || !cfg.supabaseKey) {
  app.innerHTML = '<p class="err-text">The app couldn\'t load its settings. Check config.js.</p>';
  throw new Error("Missing Supabase config");
}

const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

const state = { session: null, user: null, booted: false, recovering: false, authMode: "signin", authMessage: "" };
let renderSeq = 0;

// ---------- helpers ----------

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
const kcalText = (v) => (v == null || Number.isNaN(Number(v)) ? "—" : Math.round(Number(v)).toLocaleString("en-GB"));
const signedPct = (est, truth) => (truth > 0 ? (100 * (Number(est) - truth)) / truth : null);

function band(abs) {
  if (abs == null || Number.isNaN(abs)) return "none";
  return abs <= 10 ? "good" : abs <= 20 ? "ok" : "bad";
}
function fmtPct(v, signed = true) {
  if (v == null || Number.isNaN(v)) return "—";
  const r = Math.round(v * 10) / 10;
  const s = Math.abs(r).toFixed(1) + "%";
  if (!signed) return s;
  return r > 0 ? "+" + s : r < 0 ? "−" + s : s;
}
function fmtDate(iso, withTime = true) {
  const opts = { weekday: "short", day: "numeric", month: "short" };
  if (withTime) Object.assign(opts, { hour: "2-digit", minute: "2-digit" });
  return new Date(iso).toLocaleString("en-GB", opts);
}
function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

let toastTimer;
function toast(msg, kind = "info") {
  toastEl.textContent = msg;
  toastEl.className = "toast" + (kind === "error" ? " error" : "");
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), kind === "error" ? 8000 : 3500);
}
function fail(err) {
  console.error(err);
  toast(err?.message || String(err), "error");
}
function must({ data, error }) {
  if (error) throw error;
  return data;
}

function choices(name, options, selected, labelledBy) {
  return `<div class="choices" role="radiogroup" aria-labelledby="${labelledBy}">${options
    .map(
      ([v, l]) =>
        `<label><input type="radio" name="${name}" value="${v}" ${v === selected ? "checked" : ""}><span>${esc(l)}</span></label>`,
    )
    .join("")}</div>`;
}

function redirectUrl() {
  return location.origin + location.pathname;
}

async function signedUrls(paths) {
  if (!paths.length) return {};
  const data = must(await sb.storage.from(BUCKET).createSignedUrls(paths, 3600));
  return Object.fromEntries(data.filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl]));
}

// Resize in the browser so uploads are small and Claude gets a sensible image size.
async function prepareImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("This photo format can't be opened in this browser. Try a JPEG or PNG."));
      i.src = url;
    });
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't process the photo."))), "image/jpeg", 0.85),
    );
    return { blob, width: w, height: h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function csvCell(v) {
  if (v == null) return "";
  if (typeof v === "number") return String(v);
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheets treating text as a formula
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function downloadCsv(filename, rows) {
  const csv = rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// Latest estimate per meal and source, with error against the weighed total.
function latestBySource(rows) {
  const seen = new Set();
  const out = [];
  for (const r of [...rows].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))) {
    const key = r.meal_id + "|" + r.source;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
function stats(rows) {
  const valid = rows.filter((r) => r.abs_pct != null);
  const ranged = valid.filter((r) => r.kcal_low != null && r.kcal_high != null);
  return {
    n: valid.length,
    avgAbs: mean(valid.map((r) => Number(r.abs_pct))),
    bias: mean(valid.map((r) => Number(r.signed_pct))),
    within20: valid.length ? (100 * valid.filter((r) => Number(r.abs_pct) <= 20).length) / valid.length : null,
    rangeN: ranged.length,
    rangeHit: ranged.length
      ? (100 *
          ranged.filter((r) => Number(r.kcal_low) <= Number(r.true_kcal) && Number(r.true_kcal) <= Number(r.kcal_high))
            .length) /
        ranged.length
      : null,
  };
}

// ---------- routing ----------

function parseHash() {
  const h = location.hash.replace(/^#\/?/, "");
  if (!h || h.includes("=")) return ["meals"];
  const [view, arg] = h.split("/");
  return [view, arg ? decodeURIComponent(arg) : undefined];
}

function setActiveNav(view) {
  const section = ["new", "edit", "meal"].includes(view) ? "meals" : view;
  nav.querySelectorAll("a[data-view]").forEach((a) => {
    if (a.dataset.view === section) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}

async function route() {
  const seq = ++renderSeq;
  if (state.recovering && state.session) {
    nav.hidden = true;
    return renderRecovery();
  }
  if (!state.session) {
    nav.hidden = true;
    document.title = "Sign in · Calorie Lab";
    return renderAuth();
  }
  nav.hidden = false;
  const [view, arg] = parseHash();
  setActiveNav(view);
  try {
    if (view === "new") await renderMealForm(null, seq);
    else if (view === "edit" && arg) await renderMealForm(arg, seq);
    else if (view === "meal" && arg) await renderMeal(arg, seq);
    else if (view === "results") await renderResults(seq);
    else if (view === "foods") await renderFoods(seq);
    else await renderMeals(seq);
  } catch (err) {
    console.error(err);
    if (seq !== renderSeq) return;
    app.innerHTML = `<div class="card"><p class="err-text">${esc(err?.message || err)}</p><div><a class="btn" href="#meals">Back to meals</a></div></div>`;
  }
}

// ---------- auth ----------

function renderAuth() {
  const mode = state.authMode;
  const heading = mode === "signup" ? "Create your account" : mode === "reset" ? "Reset your password" : "Sign in";
  const submit = mode === "signup" ? "Create account" : mode === "reset" ? "Send reset link" : "Sign in";
  app.innerHTML = `
    <section class="auth card">
      <div class="stack">
        <p class="eyebrow">Phase 0 · meal testing</p>
        <h1>${heading}</h1>
        <p class="muted small">Log weighed meals, ask Claude to estimate them from photos, and see how far each app lands from the truth. Your meals and photos are private to your account.</p>
      </div>
      ${state.authMessage ? `<div class="notice">${esc(state.authMessage)}</div>` : ""}
      <form id="auth-form" class="stack" novalidate>
        <label class="field">Email<input type="email" name="email" autocomplete="email" required></label>
        ${
          mode === "reset"
            ? ""
            : `<label class="field">Password<input type="password" name="password" required minlength="8"
                 autocomplete="${mode === "signup" ? "new-password" : "current-password"}">
                 ${mode === "signup" ? '<span class="hint">At least 8 characters.</span>' : ""}</label>`
        }
        <button class="btn primary" type="submit">${submit}</button>
        <p class="err-text" id="auth-err" hidden></p>
      </form>
      <div class="row small">
        ${mode !== "signin" ? '<button class="link-btn" data-mode="signin">Back to sign in</button>' : ""}
        ${mode !== "signup" ? '<button class="link-btn" data-mode="signup">Create an account</button>' : ""}
        ${mode === "signin" ? '<button class="link-btn" data-mode="reset">Forgot password?</button>' : ""}
      </div>
    </section>`;

  app.querySelectorAll("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => {
      state.authMode = b.dataset.mode;
      state.authMessage = "";
      renderAuth();
    }),
  );

  const form = document.getElementById("auth-form");
  const errEl = document.getElementById("auth-err");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errEl.hidden = true;
    const email = form.email.value.trim();
    const password = form.password?.value ?? "";
    if (!/^\S+@\S+\.\S+$/.test(email)) return showErr("Enter a valid email address.");
    if (mode !== "reset" && password.length < 8) return showErr("Use a password of at least 8 characters.");
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      if (mode === "signin") {
        must(await sb.auth.signInWithPassword({ email, password }));
      } else if (mode === "signup") {
        const data = must(await sb.auth.signUp({ email, password, options: { emailRedirectTo: redirectUrl() } }));
        if (!data.session) {
          state.authMode = "signin";
          state.authMessage = "Check your inbox for a confirmation link. Once you've confirmed, sign in here.";
          renderAuth();
        }
      } else {
        must(await sb.auth.resetPasswordForEmail(email, { redirectTo: redirectUrl() }));
        state.authMode = "signin";
        state.authMessage = "If that email has an account, a reset link is on its way.";
        renderAuth();
      }
    } catch (err) {
      showErr(err.message || String(err));
    } finally {
      btn.disabled = false;
    }
  });
  function showErr(msg) {
    errEl.textContent = msg;
    errEl.hidden = false;
  }
}

function renderRecovery() {
  document.title = "New password · Calorie Lab";
  app.innerHTML = `
    <section class="auth card">
      <h1>Choose a new password</h1>
      <form id="pw-form" class="stack" novalidate>
        <label class="field">New password<input type="password" name="password" autocomplete="new-password" minlength="8" required></label>
        <button class="btn primary" type="submit">Save password</button>
        <p class="err-text" id="pw-err" hidden></p>
      </form>
    </section>`;
  const form = document.getElementById("pw-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("pw-err");
    const password = form.password.value;
    if (password.length < 8) {
      errEl.textContent = "Use at least 8 characters.";
      errEl.hidden = false;
      return;
    }
    try {
      must(await sb.auth.updateUser({ password }));
      state.recovering = false;
      toast("Password updated.");
      location.hash = "#meals";
      route();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });
}

// ---------- meals list ----------

async function renderMeals(seq) {
  document.title = "Meals · Calorie Lab";
  const meals = must(
    await sb
      .from("meals")
      .select("id, title, category, eaten_at, meal_items(kcal), meal_photos(id), estimates(source, kcal, created_at)")
      .order("eaten_at", { ascending: false }),
  );
  if (seq !== renderSeq) return;

  const rows = meals.map((m) => {
    const truth = m.meal_items.reduce((s, i) => s + Number(i.kcal), 0);
    const latest = {};
    for (const e of [...m.estimates].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))) {
      if (!latest[e.source]) latest[e.source] = e;
    }
    return {
      ...m,
      truth,
      items: m.meal_items.length,
      photos: m.meal_photos.length,
      latest,
      complete: m.meal_items.length > 0 && m.meal_photos.length > 0,
    };
  });
  const complete = rows.filter((r) => r.complete);
  const byCat = Object.fromEntries(CATEGORIES.map((c) => [c.id, complete.filter((r) => r.category === c.id).length]));
  const pctDone = Math.min(100, (100 * complete.length) / TARGET);

  const list = rows.length
    ? `<ul class="meal-list">${rows.map(mealCard).join("")}</ul>`
    : `<div class="card">
        <h2>How to log a meal</h2>
        <ol class="stack small" style="margin:0;padding-left:20px">
          <li>Weigh each food as served, in grams. Put the plate on the scale and press tare between foods.</li>
          <li>Take three photos: straight down, at about 45°, and one with a bank card next to the plate.</li>
          <li>Log it here, then ask Claude and type in what Cal AI and MyFitnessPal say for the same photo.</li>
        </ol>
        <div><a class="btn primary" href="#new">Log your first meal</a></div>
      </div>`;

  app.innerHTML = `
    <div class="row spread">
      <div><p class="eyebrow">Phase 0 · meal log</p><h1>Meals</h1></div>
      <a class="btn primary" href="#new">Log a meal</a>
    </div>
    <div class="card">
      <div class="row spread"><h2>Progress</h2><span class="num">${complete.length} / ${TARGET}</span></div>
      <div class="progress" role="progressbar" aria-label="Meals logged" aria-valuemin="0" aria-valuemax="${TARGET}" aria-valuenow="${complete.length}"><span style="width:${pctDone}%"></span></div>
      <div class="chips">${CATEGORIES.map(
        (c) => `<span class="chip ${byCat[c.id] >= c.target ? "good" : ""}">${esc(c.label)} ${byCat[c.id]}/${c.target}</span>`,
      ).join("")}</div>
      <p class="small muted">A meal counts once it has at least one photo and one weighed item.</p>
    </div>
    ${list}`;
}

function mealCard(m) {
  const chips = [];
  if (!m.photos) chips.push('<span class="chip bad">No photos</span>');
  if (!m.items) chips.push('<span class="chip bad">Not weighed</span>');
  for (const s of SOURCE_ORDER) {
    const e = m.latest[s];
    if (!e) continue;
    const sp = signedPct(e.kcal, m.truth);
    chips.push(
      `<span class="chip ${band(sp == null ? null : Math.abs(sp))}">${esc(SOURCES[s].short)} ${sp == null ? kcalText(e.kcal) : fmtPct(sp)}</span>`,
    );
  }
  return `<li><a class="card meal-link" href="#meal/${m.id}">
      <div>
        <div class="meal-title">${esc(m.title)}</div>
        <div class="small muted">${esc(CAT[m.category]?.label ?? m.category)} · ${esc(fmtDate(m.eaten_at))}</div>
      </div>
      <div class="meal-kcal">${m.items ? kcalText(m.truth) : "—"}<small>kcal weighed</small></div>
      ${chips.length ? `<div class="chips">${chips.join("")}</div>` : ""}
    </a></li>`;
}

// ---------- meal form ----------

let rowSeq = 0;
function itemRowHtml(it = {}) {
  const id = `sug-${++rowSeq}`;
  return `<div class="item-row" data-code="${esc(it.food_code ?? "")}">
    <div class="name-cell">
      <input name="food_name" placeholder="Food, e.g. rice basmati boiled" maxlength="160" value="${esc(it.food_name)}" aria-label="Food"
        autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${id}">
      <ul class="suggest" id="${id}" role="listbox" aria-label="Matching foods" hidden></ul>
    </div>
    <input name="grams" class="num" type="number" inputmode="decimal" min="0.1" max="5000" step="0.1" placeholder="grams" value="${esc(it.grams)}" aria-label="Grams">
    <input name="kcal_per_100g" class="num" type="number" inputmode="decimal" min="0" max="900" step="0.1" placeholder="kcal/100g" value="${esc(it.kcal_per_100g)}" aria-label="kcal per 100 g">
    <span class="kcal-out" aria-label="kcal for this item">—</span>
    <button type="button" class="icon-btn" data-remove aria-label="Remove item">×</button>
  </div>`;
}

async function renderMealForm(mealId, seq) {
  document.title = (mealId ? "Edit meal" : "Log a meal") + " · Calorie Lab";
  const foodsP = sb.from("foods").select("name, kcal_per_100g, source, source_ref").order("name");
  let meal = null;
  let items = [];
  let photos = [];
  if (mealId) {
    const [m, it, ph] = await Promise.all([
      sb.from("meals").select("*").eq("id", mealId).maybeSingle(),
      sb.from("meal_items").select("food_name, grams, kcal_per_100g, food_code, position").eq("meal_id", mealId).order("position"),
      sb.from("meal_photos").select("id, storage_path, angle, created_at").eq("meal_id", mealId).order("created_at"),
    ]);
    meal = must(m);
    if (!meal) throw new Error("That meal doesn't exist or isn't yours.");
    items = must(it);
    photos = must(ph);
  }
  const foods = must(await foodsP);
  const existing = {};
  for (const p of photos) existing[p.angle] = p; // latest per angle wins
  const urls = await signedUrls(Object.values(existing).map((p) => p.storage_path));
  if (seq !== renderSeq) return;

  // Your own foods, offered first in suggestions and auto-filled on an exact name.
  const personal = foods.map((f) => ({
    name: f.name,
    kcal: Number(f.kcal_per_100g),
    code: f.source === "cofid" && f.source_ref ? f.source_ref : "",
    mine: true,
  }));
  const foodMap = new Map(personal.map((f) => [f.name.toLowerCase(), f]));
  const files = {}; // angle -> { blob, width, height, preview }
  let currentId = mealId;

  const eaten = meal ? new Date(meal.eaten_at) : new Date();
  const fat = meal?.cooking_fat ?? null;
  const amount = meal?.fat_amount && meal.fat_amount !== "none" ? meal.fat_amount : null;

  app.innerHTML = `
    <div><p class="eyebrow">${mealId ? "Edit" : "New"} meal</p><h1>${mealId ? "Edit meal" : "Log a meal"}</h1></div>
    <form id="meal-form" class="stack" novalidate>
      <div class="card">
        <label class="field">Title
          <input name="title" maxlength="80" required value="${esc(meal?.title)}" placeholder="e.g. Chicken curry and rice">
          <span class="hint">Just for you. Claude never sees the title, so its estimate comes from the photos alone.</span>
        </label>
        <label class="field">When<input name="eaten_at" type="datetime-local" required value="${toLocalInput(eaten)}"></label>
        <div class="stack"><span class="group-label" id="cat-label">Type of meal</span>
          ${choices("category", CATEGORIES.map((c) => [c.id, c.label]), meal?.category ?? null, "cat-label")}
        </div>
      </div>

      <div class="card">
        <div><h2>Photos</h2><p class="small muted">Get the whole plate in frame for all three. For the third, put a bank card flat next to the plate.</p></div>
        <div class="photo-slots">
          ${ANGLES.map(
            (a) => `<div class="slot">
              <label class="slot-box" data-slot="${a.id}">
                ${existing[a.id] && urls[existing[a.id].storage_path] ? `<img alt="${esc(a.label)} photo" src="${esc(urls[existing[a.id].storage_path])}">` : `<span>Add photo</span>`}
                <input type="file" accept="image/*" data-angle="${a.id}" aria-label="${esc(a.label)} photo">
              </label>
              <span class="slot-label">${esc(a.label)}</span>
              <span class="small muted" style="text-align:center">${esc(a.hint)}</span>
            </div>`,
          ).join("")}
        </div>
      </div>

      <div class="card">
        <div><h2>Weighed items</h2><p class="small muted">Grams as served. Start typing a food to pick it from your foods or the UK CoFID tables, which fills in the energy per 100 g. Add measured oil, butter and sauces as their own items.</p></div>
        <div class="item-head" aria-hidden="true"><span>Food</span><span>Grams</span><span>kcal/100g</span><span>kcal</span><span></span></div>
        <div class="items" id="items">${(items.length ? items : [{}]).map(itemRowHtml).join("")}</div>
        <div><button type="button" class="btn small" id="add-item">Add item</button></div>
        <div class="total-line"><span class="muted">Weighed total</span><span><span class="num" id="total">0</span> kcal</span></div>
      </div>

      <div class="card">
        <div><h2 id="fat-label">Was oil, butter or another fat added while cooking?</h2>
          <p class="small muted">Claude only gets this answer when you choose “photo + cooking answer”.</p></div>
        ${choices("cooking_fat", FATS, fat, "fat-label")}
        <div class="stack" id="amount-wrap" ${!fat || fat === "none" ? "hidden" : ""}>
          <span class="group-label" id="amount-label">Roughly how much?</span>
          ${choices("fat_amount", AMOUNTS, amount, "amount-label")}
        </div>
      </div>

      <div class="card">
        <label class="field">Notes<textarea name="notes" maxlength="500" placeholder="Anything odd about this meal">${esc(meal?.notes)}</textarea></label>
      </div>

      <p class="err-text" id="form-err" hidden></p>
      <div class="row">
        <button class="btn primary" type="submit" id="save-btn">Save meal</button>
        <a class="btn" href="${mealId ? `#meal/${mealId}` : "#meals"}">Cancel</a>
      </div>
    </form>`;

  const form = document.getElementById("meal-form");
  const itemsEl = document.getElementById("items");
  const totalEl = document.getElementById("total");

  function recalc() {
    let total = 0;
    itemsEl.querySelectorAll(".item-row").forEach((row) => {
      const g = parseFloat(row.querySelector("[name=grams]").value);
      const k = parseFloat(row.querySelector("[name=kcal_per_100g]").value);
      const out = row.querySelector(".kcal-out");
      if (Number.isFinite(g) && Number.isFinite(k)) {
        const v = (g * k) / 100;
        total += v;
        out.textContent = kcalText(v);
      } else out.textContent = "—";
    });
    totalEl.textContent = kcalText(total);
  }
  recalc();

  // ----- food suggestions -----
  let suggestTimer;
  let suggestSeq = 0;
  function closeSuggest(row) {
    const ul = row.querySelector(".suggest");
    ul.hidden = true;
    ul.innerHTML = "";
    row._options = [];
    row._active = -1;
    row.querySelector("[name=food_name]").setAttribute("aria-expanded", "false");
    row.querySelector("[name=food_name]").removeAttribute("aria-activedescendant");
  }
  function pickOption(row, opt) {
    row.querySelector("[name=food_name]").value = opt.name;
    const per = row.querySelector("[name=kcal_per_100g]");
    per.value = opt.kcal;
    per.dataset.auto = "1";
    row.dataset.code = opt.code || "";
    closeSuggest(row);
    recalc();
    row.querySelector("[name=grams]").focus();
  }
  function setActive(row, i) {
    const items = row.querySelectorAll(".suggest [role=option]");
    if (!items.length) return;
    row._active = (i + items.length) % items.length;
    items.forEach((li, j) => li.setAttribute("aria-selected", String(j === row._active)));
    const active = items[row._active];
    row.querySelector("[name=food_name]").setAttribute("aria-activedescendant", active.id);
    active.scrollIntoView({ block: "nearest" });
  }
  async function suggest(input) {
    const row = input.closest(".item-row");
    const ul = row.querySelector(".suggest");
    const q = input.value.trim();
    if (q.length < 2) return closeSuggest(row);
    const seq = ++suggestSeq;
    const words = q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const mine = personal.filter((f) => words.every((w) => f.name.toLowerCase().includes(w))).slice(0, 4);
    let ref = [];
    try {
      ref = must(await sb.rpc("search_food_reference", { q, max_results: 8 })) || [];
    } catch (err) {
      console.error(err);
    }
    if (seq !== suggestSeq || document.activeElement !== input) return;
    const seen = new Set(mine.map((m) => m.name.toLowerCase()));
    const options = [
      ...mine,
      ...ref
        .filter((r) => !seen.has(r.name.toLowerCase()))
        .map((r) => ({ name: r.name, kcal: Number(r.kcal_per_100g), code: r.code, group: r.group_name })),
    ];
    row._options = options;
    row._active = -1;
    ul.innerHTML = options.length
      ? options
          .map(
            (o, i) => `<li role="option" id="${ul.id}-${i}" data-i="${i}" aria-selected="false">
              <span class="s-name">${esc(o.name)}</span>
              <span class="s-meta">${o.mine ? '<span class="s-tag">Yours</span> · ' : ""}${kcalText(o.kcal)} kcal/100g${o.group ? ` · ${esc(o.group)}` : ""}</span>
            </li>`,
          )
          .join("")
      : '<li class="suggest-empty">No match. Type the kcal per 100 g yourself.</li>';
    ul.hidden = false;
    input.setAttribute("aria-expanded", options.length ? "true" : "false");
  }

  itemsEl.addEventListener("input", (e) => {
    const row = e.target.closest(".item-row");
    if (!row) return;
    if (e.target.name === "food_name") {
      row.dataset.code = "";
      const per = row.querySelector("[name=kcal_per_100g]");
      const known = foodMap.get(e.target.value.trim().toLowerCase());
      if (known && (!per.value || per.dataset.auto === "1")) {
        per.value = known.kcal;
        per.dataset.auto = "1";
        row.dataset.code = known.code;
      }
      clearTimeout(suggestTimer);
      const input = e.target;
      suggestTimer = setTimeout(() => suggest(input), 180);
    } else if (e.target.name === "kcal_per_100g") {
      e.target.dataset.auto = "";
      row.dataset.code = "";
    }
    recalc();
  });
  itemsEl.addEventListener("keydown", (e) => {
    if (e.target.name !== "food_name") return;
    const row = e.target.closest(".item-row");
    const open = !row.querySelector(".suggest").hidden && row._options?.length;
    if (e.key === "Enter") {
      e.preventDefault(); // Enter in a food name never submits the whole form
      if (open) pickOption(row, row._options[row._active >= 0 ? row._active : 0]);
    } else if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setActive(row, (row._active ?? -1) + (e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Escape") {
      closeSuggest(row);
    }
  });
  itemsEl.addEventListener("pointerdown", (e) => {
    const li = e.target.closest(".suggest [role=option]");
    if (!li) return;
    e.preventDefault(); // keep focus in the input until the pick is done
    const row = li.closest(".item-row");
    pickOption(row, row._options[Number(li.dataset.i)]);
  });
  itemsEl.addEventListener("focusout", (e) => {
    if (e.target.name !== "food_name") return;
    const row = e.target.closest(".item-row");
    setTimeout(() => {
      if (!row.contains(document.activeElement) || document.activeElement.name !== "food_name") closeSuggest(row);
    }, 120);
  });
  itemsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-remove]");
    if (!btn) return;
    const rows = itemsEl.querySelectorAll(".item-row");
    if (rows.length === 1) rows[0].querySelectorAll("input").forEach((i) => (i.value = ""));
    else btn.closest(".item-row").remove();
    recalc();
  });
  document.getElementById("add-item").addEventListener("click", () => {
    itemsEl.insertAdjacentHTML("beforeend", itemRowHtml());
    itemsEl.lastElementChild.querySelector("input").focus();
  });

  form.querySelectorAll("input[name=cooking_fat]").forEach((r) =>
    r.addEventListener("change", () => {
      document.getElementById("amount-wrap").hidden = r.value === "none";
    }),
  );

  form.querySelectorAll("input[type=file]").forEach((input) =>
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      const angle = input.dataset.angle;
      const box = input.closest(".slot-box");
      try {
        const prepared = await prepareImage(file);
        if (files[angle]?.preview) URL.revokeObjectURL(files[angle].preview);
        prepared.preview = URL.createObjectURL(prepared.blob);
        files[angle] = prepared;
        box.querySelector("img, span")?.remove();
        box.insertAdjacentHTML("afterbegin", `<img alt="New ${esc(ANGLE_LABEL[angle])} photo" src="${prepared.preview}">`);
      } catch (err) {
        fail(err);
      } finally {
        input.value = "";
      }
    }),
  );

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("form-err");
    errEl.hidden = true;
    const fd = new FormData(form);
    const title = String(fd.get("title") || "").trim();
    const category = fd.get("category");
    const eatenAt = fd.get("eaten_at");
    const cookingFat = fd.get("cooking_fat") || null;
    const fatAmount = cookingFat === "none" ? "none" : cookingFat ? fd.get("fat_amount") || "unsure" : null;
    const notes = String(fd.get("notes") || "").trim() || null;

    const rows = [...itemsEl.querySelectorAll(".item-row")]
      .map((r) => ({
        food_name: r.querySelector("[name=food_name]").value.trim(),
        grams: r.querySelector("[name=grams]").value.trim(),
        per: r.querySelector("[name=kcal_per_100g]").value.trim(),
        code: r.dataset.code || "",
      }))
      .filter((r) => r.food_name || r.grams || r.per);

    const problems = [];
    if (!title) problems.push("Add a title.");
    if (!category) problems.push("Choose the type of meal.");
    if (!eatenAt || Number.isNaN(new Date(eatenAt).getTime())) problems.push("Set when you ate it.");
    rows.forEach((r, i) => {
      const g = Number(r.grams);
      const k = Number(r.per);
      const label = r.food_name || `Item ${i + 1}`;
      if (!r.food_name) problems.push(`Item ${i + 1} needs a name.`);
      if (!r.grams || !(g > 0 && g <= 5000)) problems.push(`${label}: grams must be between 0.1 and 5000.`);
      if (r.per === "" || !(k >= 0 && k <= 900)) problems.push(`${label}: kcal per 100 g must be between 0 and 900.`);
    });
    if (problems.length) {
      errEl.textContent = problems.join(" ");
      errEl.hidden = false;
      errEl.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }

    const btn = document.getElementById("save-btn");
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const uid = state.user.id;
      const mealRow = {
        title,
        category,
        eaten_at: new Date(eatenAt).toISOString(),
        cooking_fat: cookingFat,
        fat_amount: fatAmount,
        notes,
      };
      const isUpdate = Boolean(currentId);
      if (isUpdate) {
        must(await sb.from("meals").update(mealRow).eq("id", currentId));
      } else {
        currentId = must(await sb.from("meals").insert({ ...mealRow, user_id: uid }).select("id").single()).id;
      }

      // Remember foods for next time (one row per exact name). CoFID picks keep their code;
      // the two kinds go in separate calls so a plain entry never wipes a food's source.
      const coded = new Map();
      const plain = new Map();
      for (const r of rows) {
        const base = { user_id: uid, name: r.food_name, kcal_per_100g: Number(r.per) };
        if (r.code) coded.set(r.food_name, { ...base, source: "cofid", source_ref: r.code });
        else plain.set(r.food_name, base);
      }
      for (const name of coded.keys()) plain.delete(name);
      if (coded.size) must(await sb.from("foods").upsert([...coded.values()], { onConflict: "user_id,name" }));
      if (plain.size) must(await sb.from("foods").upsert([...plain.values()], { onConflict: "user_id,name" }));

      // Replace the weighed items.
      if (isUpdate) must(await sb.from("meal_items").delete().eq("meal_id", currentId));
      if (rows.length) {
        must(
          await sb.from("meal_items").insert(
            rows.map((r, i) => ({
              meal_id: currentId,
              user_id: uid,
              food_name: r.food_name,
              grams: Number(r.grams),
              kcal_per_100g: Number(r.per),
              food_code: r.code || null,
              position: i,
            })),
          ),
        );
      }

      // Upload new photos; a new photo replaces the old one at the same angle.
      for (const a of ANGLES) {
        const f = files[a.id];
        if (!f) continue;
        btn.textContent = `Uploading ${a.label.toLowerCase()} photo…`;
        const path = `${uid}/${currentId}/${a.id}-${Date.now()}.jpg`;
        must(await sb.storage.from(BUCKET).upload(path, f.blob, { contentType: "image/jpeg", upsert: false }));
        const row = must(
          await sb
            .from("meal_photos")
            .insert({ meal_id: currentId, user_id: uid, storage_path: path, angle: a.id, width: f.width, height: f.height })
            .select("id, storage_path, angle, created_at")
            .single(),
        );
        const old = existing[a.id];
        if (old) {
          await sb.storage.from(BUCKET).remove([old.storage_path]);
          await sb.from("meal_photos").delete().eq("id", old.id);
        }
        existing[a.id] = row;
        URL.revokeObjectURL(f.preview);
        delete files[a.id];
      }

      toast("Meal saved.");
      location.hash = `#meal/${currentId}`;
    } catch (err) {
      fail(err);
      btn.disabled = false;
      btn.textContent = "Save meal";
    }
  });
}

// ---------- meal detail ----------

async function renderMeal(mealId, seq) {
  const [m, it, ph, es] = await Promise.all([
    sb.from("meals").select("*").eq("id", mealId).maybeSingle(),
    sb.from("meal_items").select("food_name, grams, kcal_per_100g, kcal, food_code, position").eq("meal_id", mealId).order("position"),
    sb.from("meal_photos").select("id, storage_path, angle, created_at").eq("meal_id", mealId).order("created_at"),
    sb.from("estimates").select("*").eq("meal_id", mealId).order("created_at", { ascending: false }),
  ]);
  const meal = must(m);
  if (!meal) throw new Error("That meal doesn't exist or isn't yours.");
  const items = must(it);
  const photos = must(ph);
  const estimates = must(es);
  const urls = await signedUrls(photos.map((p) => p.storage_path));
  if (seq !== renderSeq) return;
  document.title = `${meal.title} · Calorie Lab`;

  const truth = items.reduce((s, i) => s + Number(i.kcal), 0);
  const hasTruth = items.length > 0 && truth > 0;
  const fatLine = meal.cooking_fat
    ? `${FAT_LABEL[meal.cooking_fat]}${meal.cooking_fat !== "none" ? `, ${AMOUNT_LABEL[meal.fat_amount] ?? "amount not given"}` : ""}`
    : "Not answered";

  app.innerHTML = `
    <div class="row spread">
      <div style="min-width:0"><p class="eyebrow">${esc(CAT[meal.category]?.label)} · ${esc(fmtDate(meal.eaten_at))}</p><h1>${esc(meal.title)}</h1></div>
      <a class="btn small" href="#edit/${meal.id}">Edit</a>
    </div>

    <div class="card">
      <div class="row spread" style="align-items:flex-end">
        <div><p class="eyebrow">Weighed total</p><div class="readout"><span class="big">${hasTruth ? kcalText(truth) : "—"}</span><span class="muted">kcal</span></div></div>
        <span class="small muted">${items.length} item${items.length === 1 ? "" : "s"}</span>
      </div>
      ${
        items.length
          ? `<div class="table-wrap"><table>
              <thead><tr><th>Food</th><th class="r">Grams</th><th class="r">kcal/100g</th><th class="r">kcal</th></tr></thead>
              <tbody>${items
                .map(
                  (i) =>
                    `<tr><td>${esc(i.food_name)}${i.food_code ? ` <span class="small muted">CoFID ${esc(i.food_code)}</span>` : ""}</td><td class="r num">${esc(i.grams)}</td><td class="r num">${esc(i.kcal_per_100g)}</td><td class="r num">${kcalText(i.kcal)}</td></tr>`,
                )
                .join("")}</tbody></table></div>`
          : `<div class="notice warn">No weighed items yet. <a href="#edit/${meal.id}">Add them</a> so estimates can be scored.</div>`
      }
      <p class="small"><span class="muted">Cooking fat:</span> ${esc(fatLine)}</p>
      ${meal.notes ? `<p class="small"><span class="muted">Notes:</span> ${esc(meal.notes)}</p>` : ""}
    </div>

    <div class="card">
      <h2>Photos</h2>
      ${
        photos.length
          ? `<div class="photos-view">${photos
              .map(
                (p) =>
                  `<figure>${urls[p.storage_path] ? `<a href="${esc(urls[p.storage_path])}" target="_blank" rel="noopener"><img alt="${esc(ANGLE_LABEL[p.angle])} photo" src="${esc(urls[p.storage_path])}" loading="lazy"></a>` : ""}<figcaption>${esc(ANGLE_LABEL[p.angle])}</figcaption></figure>`,
              )
              .join("")}</div>`
          : `<div class="notice warn">No photos yet. <a href="#edit/${meal.id}">Add them</a> before asking Claude.</div>`
      }
    </div>

    <div class="card">
      <h2>Estimates</h2>
      <div class="row">
        <button class="btn primary" data-ask="0" ${photos.length ? "" : "disabled"}>Ask Claude: photo only</button>
        <button class="btn" data-ask="1" ${photos.length && meal.cooking_fat ? "" : "disabled"}>Ask Claude: photo + cooking answer</button>
      </div>
      <p class="small muted">${
        meal.cooking_fat
          ? "Run both to see whether the cooking answer helps. Each run takes 10–30 seconds."
          : "Answer the cooking question on this meal to unlock the second run."
      }</p>
      <form id="manual-form" class="stack">
        <h3>Add another app's estimate</h3>
        <div class="grid2">
          <label class="field">App<select name="source">${APP_SOURCES.map((s) => `<option value="${s}">${esc(SOURCES[s].label)}</option>`).join("")}</select></label>
          <label class="field">kcal it gave<input name="kcal" class="num" type="number" inputmode="decimal" min="0" max="10000" step="1" required></label>
        </div>
        <label class="field">Note <span class="hint">Optional, e.g. “edited portion to medium”</span><input name="note" maxlength="200"></label>
        <div><button class="btn small" type="submit">Add estimate</button></div>
      </form>
      <div id="est-list">${estimates.length ? estimates.map((e) => estimateHtml(e, hasTruth ? truth : null)).join("") : '<p class="small muted">No estimates yet.</p>'}</div>
    </div>

    <div><button class="btn danger" id="del-meal" type="button">Delete meal</button></div>`;

  app.querySelectorAll("[data-ask]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const buttons = app.querySelectorAll("[data-ask]");
      const original = btn.textContent;
      buttons.forEach((b) => (b.disabled = true));
      btn.textContent = "Asking Claude…";
      try {
        const { data, error } = await sb.functions.invoke("estimate", {
          body: { meal_id: meal.id, with_answer: btn.dataset.ask === "1" },
        });
        if (error) {
          let msg = error.message;
          try {
            const body = await error.context.json();
            if (body?.error) msg = body.error;
          } catch {
            /* keep the generic message */
          }
          throw new Error(msg);
        }
        const said = (x) => {
          const sp = x && hasTruth ? signedPct(x.kcal, truth) : null;
          return `${kcalText(x?.kcal)} kcal${sp != null ? ` (${fmtPct(sp)})` : ""}`;
        };
        let msg = `Claude says ${said(data?.estimate)}.`;
        if (data?.db_estimate) msg += ` Priced with CoFID: ${said(data.db_estimate)}.`;
        else if (data?.db_error) msg += ` The CoFID step failed: ${data.db_error}`;
        toast(msg, data?.db_error ? "error" : "info");
        route();
      } catch (err) {
        fail(err);
        btn.textContent = original;
        buttons.forEach((b) => (b.disabled = b.dataset.ask === "1" ? !(photos.length && meal.cooking_fat) : !photos.length));
      }
    }),
  );

  document.getElementById("manual-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const value = Number(f.kcal.value);
    if (!f.kcal.value || !(value >= 0 && value <= 10000)) return toast("Enter the kcal the app gave, 0–10000.", "error");
    try {
      must(
        await sb.from("estimates").insert({
          meal_id: meal.id,
          user_id: state.user.id,
          source: f.source.value,
          kcal: value,
          detail: f.note.value.trim() ? { note: f.note.value.trim() } : null,
        }),
      );
      toast("Estimate added.");
      route();
    } catch (err) {
      fail(err);
    }
  });

  document.getElementById("est-list").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-del-est]");
    if (!btn) return;
    if (!confirm("Delete this estimate?")) return;
    try {
      must(await sb.from("estimates").delete().eq("id", btn.dataset.delEst));
      route();
    } catch (err) {
      fail(err);
    }
  });

  document.getElementById("del-meal").addEventListener("click", async () => {
    if (!confirm("Delete this meal with its photos and estimates? This can't be undone.")) return;
    try {
      if (photos.length) must(await sb.storage.from(BUCKET).remove(photos.map((p) => p.storage_path)));
      must(await sb.from("meals").delete().eq("id", meal.id));
      toast("Meal deleted.");
      location.hash = "#meals";
    } catch (err) {
      fail(err);
    }
  });
}

function estimateHtml(e, truth) {
  const sp = truth ? signedPct(e.kcal, truth) : null;
  const abs = sp == null ? null : Math.abs(sp);
  const d = e.detail || {};
  const hasRange = e.kcal_low != null && e.kcal_high != null;
  const inRange = hasRange && truth ? Number(e.kcal_low) <= truth && truth <= Number(e.kcal_high) : null;
  const isClaude = e.source.startsWith("claude");
  const isDb = e.source.endsWith("_db");
  let more = "";
  if (isDb && Array.isArray(d.items)) {
    more = `<details><summary>How CoFID priced it (${esc(d.matched ?? 0)} of ${esc(d.items.length)} foods matched)</summary>
      <div class="table-wrap"><table>
        <thead><tr><th>Food</th><th class="r">Est. g</th><th>CoFID match</th><th class="r">kcal</th></tr></thead>
        <tbody>${d.items
          .map(
            (it) => `<tr>
              <td>${esc(it.name)}<div class="small muted">${esc(it.cofid_name)}</div></td>
              <td class="r num">${kcalText(it.grams)}</td>
              <td>${it.matched ? `${esc(it.ref_name)}<div class="small muted num">${kcalText(it.kcal_per_100g)} kcal/100g · was ${kcalText(it.claude_kcal)}</div>` : '<span class="small muted">No good match, kept Claude\'s value</span>'}</td>
              <td class="r num">${kcalText(it.kcal)}</td></tr>`,
          )
          .join("")}</tbody></table></div>
      <p class="small">Hidden fat added: <span class="num">${kcalText(d.hidden_fat_kcal)}</span> kcal (Claude's figure)</p>
    </details>`;
  } else if (isClaude && Array.isArray(d.foods)) {
    const usage = d.usage ? ` · ${d.usage.input_tokens ?? "?"} in / ${d.usage.output_tokens ?? "?"} out tokens` : "";
    more = `<details><summary>What Claude saw</summary>
      <div class="table-wrap"><table>
        <thead><tr><th>Food</th><th class="r">Est. g</th><th class="r">kcal</th></tr></thead>
        <tbody>${d.foods
          .map(
            (f) =>
              `<tr><td>${esc(f.name)}${f.notes ? `<div class="small muted">${esc(f.notes)}</div>` : ""}</td><td class="r num">${kcalText(f.estimated_grams)}</td><td class="r num">${kcalText(f.kcal)}</td></tr>`,
          )
          .join("")}</tbody></table></div>
      <p class="small">Hidden fat allowed for: <span class="num">${kcalText(d.hidden_fat_kcal)}</span> kcal · Confidence: ${esc(d.confidence ?? "—")}</p>
      ${d.assumptions ? `<p class="small muted">${esc(d.assumptions)}</p>` : ""}
      <p class="small muted">${esc(e.model ?? "")} · ${esc(d.photos_used ?? "?")} photo(s)${esc(usage)}${d.ms ? ` · ${(d.ms / 1000).toFixed(1)} s` : ""}</p>
    </details>`;
  }
  return `<div class="est">
    <div>
      <div class="meal-title">${esc(SOURCES[e.source]?.label ?? e.source)}</div>
      <div class="small muted">${esc(fmtDate(e.created_at))}
        · <button class="link-btn small" style="padding:0" data-del-est="${e.id}">Delete</button></div>
      ${hasRange ? `<div class="small muted">80% range ${kcalText(e.kcal_low)}–${kcalText(e.kcal_high)} kcal${inRange == null ? "" : inRange ? " · truth inside" : " · truth outside"}</div>` : ""}
      ${d.note ? `<div class="small muted">${esc(d.note)}</div>` : ""}
    </div>
    <div class="val">${kcalText(e.kcal)} kcal<br><span class="badge ${band(abs)}">${sp == null ? "no truth yet" : fmtPct(sp)}</span></div>
    ${more}
  </div>`;
}

// ---------- results ----------

async function renderResults(seq) {
  document.title = "Results · Calorie Lab";
  const [t, e, p] = await Promise.all([
    sb.from("meal_truth").select("meal_id, title, category, eaten_at, true_kcal, item_count"),
    sb.from("estimate_errors").select("*"),
    sb.from("meal_photos").select("meal_id"),
  ]);
  const truth = must(t);
  const errors = must(e);
  const photoMeals = new Set(must(p).map((r) => r.meal_id));
  if (seq !== renderSeq) return;

  const complete = truth.filter((m) => m.item_count > 0 && photoMeals.has(m.meal_id));
  const byCat = Object.fromEntries(CATEGORIES.map((c) => [c.id, complete.filter((m) => m.category === c.id).length]));
  const latest = latestBySource(errors);
  const bySource = Object.fromEntries(SOURCE_ORDER.map((s) => [s, stats(latest.filter((r) => r.source === s))]));
  const activeSources = SOURCE_ORDER.filter((s) => bySource[s].n > 0);

  // Gate 0, check 1: existing apps miss by more than 20% on average.
  const apps = APP_SOURCES.filter((s) => bySource[s].n >= 10);
  let gate1;
  if (!apps.length) {
    const most = Math.max(0, ...APP_SOURCES.map((s) => bySource[s].n));
    gate1 = check("wait", "Existing apps average more than 20% error", `Needs 10+ scored meals for at least one app. Best so far: ${most}.`);
  } else {
    const best = apps.reduce((a, b) => (bySource[a].avgAbs <= bySource[b].avgAbs ? a : b));
    const v = bySource[best].avgAbs;
    gate1 =
      v > 20
        ? check("pass", "Existing apps average more than 20% error", `The best app, ${SOURCES[best].label}, averages ${fmtPct(v, false)} error over ${bySource[best].n} meals. There's room to beat it.`)
        : check("fail", "Existing apps average more than 20% error", `${SOURCES[best].label} already averages ${fmtPct(v, false)} over ${bySource[best].n} meals. Accuracy alone won't set you apart; see the stop rules.`);
  }

  // Check 2 is the LiDAR volume test, run outside this app.
  const gate2 = check(
    "sep",
    "LiDAR volumes within about 15% on simple single foods",
    "Measured separately with the iPhone depth test. Record the result alongside this page.",
  );

  // Average error of two sources on the meals that have both.
  function paired(a, b) {
    const A = new Map(latest.filter((r) => r.source === a && r.abs_pct != null).map((r) => [r.meal_id, Number(r.abs_pct)]));
    const B = latest.filter((r) => r.source === b && r.abs_pct != null && A.has(r.meal_id));
    return { n: B.length, a: mean(B.map((r) => A.get(r.meal_id))), b: mean(B.map((r) => Number(r.abs_pct))) };
  }

  // Check 3: the cooking answer reduces Claude's error on the same meals.
  const q = paired("claude_photo", "claude_photo_answer");
  let gate3;
  if (q.n < 10) {
    gate3 = check("wait", "The cooking question reduces Claude's error", `Needs 10+ meals with both Claude runs. Have ${q.n}.`);
  } else {
    const drop = q.a - q.b;
    const body = `Average error ${fmtPct(q.a, false)} without the answer, ${fmtPct(q.b, false)} with it, across ${q.n} meals (${drop >= 0 ? "down" : "up"} ${Math.abs(drop).toFixed(1)} points). Pass needs a drop of at least 2 points.`;
    gate3 = check(drop >= 2 ? "pass" : "fail", "The cooking question reduces Claude's error", body);
  }

  // Design question: does pricing Claude's grams with CoFID beat Claude's own numbers?
  const dbRows = [
    ["Photo only", paired("claude_photo", "claude_photo_db")],
    ["Photo + cooking answer", paired("claude_photo_answer", "claude_photo_answer_db")],
  ]
    .map(([label, r]) => {
      const change = r.n ? r.b - r.a : null;
      return `<tr><td>${label}</td><td class="r num">${r.n}</td>
        <td class="r"><span class="badge ${band(r.a)}">${fmtPct(r.a, false)}</span></td>
        <td class="r"><span class="badge ${band(r.b)}">${fmtPct(r.b, false)}</span></td>
        <td class="r num">${change == null ? "—" : `${change <= 0 ? "−" : "+"}${Math.abs(change).toFixed(1)} pts`}</td></tr>`;
    })
    .join("");

  const sourceRows = activeSources.length
    ? activeSources
        .map((s) => {
          const st = bySource[s];
          return `<tr><td>${esc(SOURCES[s].label)}</td><td class="r num">${st.n}</td>
            <td class="r"><span class="badge ${band(st.avgAbs)}">${fmtPct(st.avgAbs, false)}</span></td>
            <td class="r num">${fmtPct(st.bias)}</td><td class="r num">${st.within20 == null ? "—" : Math.round(st.within20) + "%"}</td>
            <td class="r num">${st.rangeHit == null ? "—" : Math.round(st.rangeHit) + "%"}</td></tr>`;
        })
        .join("")
    : `<tr><td colspan="6" class="muted">No scored estimates yet. Log a weighed meal and ask Claude.</td></tr>`;

  const catRows = CATEGORIES.map((c) => {
    const cells = activeSources
      .map((s) => {
        const st = stats(latest.filter((r) => r.source === s && r.category === c.id));
        return `<td class="r">${st.n ? `<span class="badge ${band(st.avgAbs)}">${fmtPct(st.avgAbs, false)}</span> <span class="small muted">(${st.n})</span>` : "—"}</td>`;
      })
      .join("");
    return `<tr><td>${esc(c.label)}</td><td class="r num">${byCat[c.id]}/${c.target}</td>${cells}</tr>`;
  }).join("");

  app.innerHTML = `
    <div class="row spread">
      <div><p class="eyebrow">Phase 0 · benchmark</p><h1>Results</h1></div>
      <div class="row"><button class="btn small" id="csv-est">Estimates CSV</button><button class="btn small" id="csv-items">Weighed items CSV</button></div>
    </div>

    <div class="card">
      <div class="row spread"><h2>Meals logged</h2><span class="num">${complete.length} / ${TARGET}</span></div>
      <div class="progress" role="progressbar" aria-label="Meals logged" aria-valuemin="0" aria-valuemax="${TARGET}" aria-valuenow="${complete.length}"><span style="width:${Math.min(100, (100 * complete.length) / TARGET)}%"></span></div>
      <p class="small muted">Counts meals with at least one photo and one weighed item.</p>
    </div>

    <div class="card">
      <div><h2>Error by source</h2><p class="small muted">Latest estimate per meal, against the weighed total. Target: under 20% average. Negative bias means the source undercounts, usually missed fat.</p></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Source</th><th class="r">Meals</th><th class="r">Avg error</th><th class="r">Bias</th><th class="r">Within ±20%</th><th class="r">Range hit</th></tr></thead>
        <tbody>${sourceRows}</tbody>
      </table></div>
      <p class="small muted">Range hit is how often the weighed total fell inside Claude's 80% range. Near 80% means its ranges are honest. CoFID rows are Claude's gram estimates priced with CoFID values.</p>
    </div>

    <div class="card">
      <div><h2>Does the CoFID lookup help?</h2><p class="small muted">Same meals, same Claude gram estimates. Claude's own kcal against the grams priced with CoFID. A negative change means CoFID made it more accurate. Trust it after 10+ meals.</p></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Run</th><th class="r">Meals</th><th class="r">Claude</th><th class="r">CoFID</th><th class="r">Change</th></tr></thead>
        <tbody>${dbRows}</tbody>
      </table></div>
    </div>

    <div class="card">
      <h2>Average error by meal type</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>Type</th><th class="r">Logged</th>${activeSources.map((s) => `<th class="r">${esc(SOURCES[s].short)}</th>`).join("")}</tr></thead>
        <tbody>${catRows}</tbody>
      </table></div>
    </div>

    <div class="card">
      <div><h2>Gate 0</h2><p class="small muted">Go if all three are true by the end of week 4.</p></div>
      <div>${gate1}${gate2}${gate3}</div>
    </div>`;

  const titles = new Map(truth.map((m) => [m.meal_id, m]));
  document.getElementById("csv-est").addEventListener("click", () => {
    const rows = [["meal_id", "title", "category", "eaten_at", "true_kcal", "source", "estimate_kcal", "kcal_low", "kcal_high", "signed_pct", "abs_pct", "estimated_at"]];
    for (const r of [...errors].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))) {
      const m = titles.get(r.meal_id);
      rows.push([r.meal_id, m?.title, r.category, m?.eaten_at, r.true_kcal, r.source, r.estimate_kcal, r.kcal_low, r.kcal_high, r.signed_pct, r.abs_pct, r.created_at]);
    }
    downloadCsv(`calorie-lab-estimates-${new Date().toISOString().slice(0, 10)}.csv`, rows);
  });
  document.getElementById("csv-items").addEventListener("click", async () => {
    try {
      const items = must(await sb.from("meal_items").select("meal_id, food_name, grams, kcal_per_100g, kcal, position").order("meal_id").order("position"));
      const rows = [["meal_id", "title", "category", "eaten_at", "food", "grams", "kcal_per_100g", "kcal"]];
      for (const i of items) {
        const m = titles.get(i.meal_id);
        rows.push([i.meal_id, m?.title, m?.category, m?.eaten_at, i.food_name, i.grams, i.kcal_per_100g, i.kcal]);
      }
      downloadCsv(`calorie-lab-items-${new Date().toISOString().slice(0, 10)}.csv`, rows);
    } catch (err) {
      fail(err);
    }
  });
}

function check(kind, title, body) {
  const label = { pass: "Pass", fail: "Fail", wait: "Waiting", sep: "Separate test" }[kind];
  const cls = kind === "sep" ? "wait" : kind;
  return `<div class="check"><span class="state ${cls}">${label}</span><div><h3>${esc(title)}</h3><p class="small muted">${esc(body)}</p></div></div>`;
}

// ---------- foods ----------

async function renderFoods(seq) {
  document.title = "Foods · Calorie Lab";
  const foods = must(await sb.from("foods").select("*").order("name"));
  if (seq !== renderSeq) return;

  app.innerHTML = `
    <div>
      <p class="eyebrow">Reference values</p><h1>Foods</h1>
      <p class="muted small" style="margin-top:6px">Energy per 100 g as eaten (cooked weight). Use the pack label, or
        <a href="https://www.gov.uk/government/publications/composition-of-foods-integrated-dataset-cofid" target="_blank" rel="noopener">CoFID</a>
        for home-cooked food. Foods you type into a meal are saved here automatically.</p>
    </div>
    <form class="card" id="food-form" novalidate>
      <h2 id="food-form-title">Add a food</h2>
      <div class="grid2">
        <label class="field">Name<input name="fname" maxlength="80" required></label>
        <label class="field">kcal per 100 g<input name="kcal" class="num" type="number" inputmode="decimal" min="0" max="900" step="0.1" required></label>
        <label class="field">Source<select name="source">${FOOD_SOURCES.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("")}</select></label>
        <label class="field">Reference <span class="hint">Optional, e.g. CoFID code</span><input name="ref" maxlength="40"></label>
      </div>
      <p class="small muted">Saving a name that already exists updates it.</p>
      <div class="row"><button class="btn primary" type="submit">Save food</button><button class="btn" type="reset">Clear</button></div>
    </form>
    <div class="card" id="foods-table">
      ${
        foods.length
          ? `<div class="table-wrap"><table>
              <thead><tr><th>Food</th><th class="r">kcal/100g</th><th>Source</th><th></th></tr></thead>
              <tbody>${foods
                .map(
                  (f) => `<tr>
                    <td>${esc(f.name)}</td><td class="r num">${esc(f.kcal_per_100g)}</td>
                    <td class="small">${esc(FOOD_SOURCE_LABEL[f.source] ?? f.source)}${f.source_ref ? ` <span class="muted">${esc(f.source_ref)}</span>` : ""}</td>
                    <td><div class="actions"><button class="link-btn small" data-edit="${f.id}">Edit</button><button class="link-btn small" data-del="${f.id}">Delete</button></div></td>
                  </tr>`,
                )
                .join("")}</tbody></table></div>`
          : '<p class="small muted">No foods yet.</p>'
      }
    </div>`;

  const form = document.getElementById("food-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = form.fname.value.trim();
    const value = Number(form.kcal.value);
    if (!name) return toast("Add a name.", "error");
    if (form.kcal.value === "" || !(value >= 0 && value <= 900)) return toast("kcal per 100 g must be between 0 and 900.", "error");
    try {
      must(
        await sb.from("foods").upsert(
          { user_id: state.user.id, name, kcal_per_100g: value, source: form.source.value, source_ref: form.ref.value.trim() || null },
          { onConflict: "user_id,name" },
        ),
      );
      toast("Food saved.");
      route();
    } catch (err) {
      fail(err);
    }
  });
  document.getElementById("foods-table").addEventListener(
    "click",
    async (e) => {
      const edit = e.target.closest("[data-edit]");
      const del = e.target.closest("[data-del]");
      if (edit) {
        const f = foods.find((x) => x.id === edit.dataset.edit);
        form.fname.value = f.name;
        form.kcal.value = f.kcal_per_100g;
        form.source.value = f.source;
        form.ref.value = f.source_ref ?? "";
        document.getElementById("food-form-title").textContent = "Edit food";
        form.scrollIntoView({ behavior: "smooth", block: "start" });
        form.kcal.focus({ preventScroll: true });
      } else if (del) {
        const f = foods.find((x) => x.id === del.dataset.del);
        if (!confirm(`Delete “${f.name}”? Meals that used it keep their values.`)) return;
        try {
          must(await sb.from("foods").delete().eq("id", f.id));
          route();
        } catch (err) {
          fail(err);
        }
      }
    },
  );
}

// ---------- boot ----------

document.getElementById("signout").addEventListener("click", async () => {
  await sb.auth.signOut();
});

sb.auth.onAuthStateChange((event, session) => {
  const before = state.user?.id ?? null;
  state.session = session;
  state.user = session?.user ?? null;
  if (event === "PASSWORD_RECOVERY") state.recovering = true;
  if (event === "SIGNED_OUT") {
    state.recovering = false;
    state.authMode = "signin";
  }
  // Re-render only when who is signed in changes, so token refreshes don't wipe a half-filled form.
  if (state.booted && (before !== (state.user?.id ?? null) || event === "PASSWORD_RECOVERY")) setTimeout(route, 0);
});

window.addEventListener("hashchange", () => {
  if (state.booted) route();
});

(async function boot() {
  const params = new URLSearchParams(initialHash.replace(/^#/, ""));
  if (params.get("type") === "recovery") state.recovering = true;
  const linkError = params.get("error_description");
  const { data } = await sb.auth.getSession();
  state.session = data.session;
  state.user = data.session?.user ?? null;
  if (linkError) {
    state.authMessage = `That link didn't work: ${linkError}. Request a new one or sign in.`;
    history.replaceState(null, "", location.pathname + location.search);
  }
  state.booted = true;
  route();
})();
