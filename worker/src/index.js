// Day Sheet — Cloudflare Worker backend.
//
// Serves the static site (public/index.html, public/view.html) via the
// Assets binding, and implements the site's four JSON endpoints:
// /api/items, /api/notes, /api/reminder, /api/schedule. All four are
// backed by Workers KV instead of Netlify Blobs, but the request/response
// shapes for items/notes/reminder are unchanged from the old Netlify
// functions.
//
// /api/schedule is new: a Cron Trigger (see wrangler.toml) calls Rentman's
// REST API directly on a schedule, applies the same filter/classify/
// override recipe documented in CLAUDE.md, and writes the resulting
// 14-day schedule to KV. The front-end fetches it live instead of reading
// a snapshot baked into the HTML at commit time — see CLAUDE.md for why
// this replaced the old bake-and-push workflow.
//
// Auth: same light-deterrent shared passcode as before, sent as the
// x-day-sheet-passcode header on writes. GETs stay open for the
// read-only contractor link.

const PASSCODE = "4242";
const CATEGORIES = ["install", "packdown", "delivery", "collection", "driver", "warehouse", "operator", "test", "other"];

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(data, init) {
  return new Response(JSON.stringify(data), { ...init, headers: { ...JSON_HEADERS, ...(init && init.headers) } });
}

function checkPasscode(req) {
  return req.headers.get("x-day-sheet-passcode") === PASSCODE;
}

async function readJson(req) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function clamp(s, n) {
  return String(s ?? "").slice(0, n);
}

function sanitizeItem(input) {
  const category = CATEGORIES.includes(input?.category) ? input.category : "other";
  return {
    date: clamp(input?.date, 10),
    start: clamp(input?.start, 5),
    end: clamp(input?.end, 5),
    category,
    title: clamp(input?.title, 200),
    crew: clamp(input?.crew, 200),
    note: clamp(input?.note, 4000)
  };
}

async function kvGetJson(kv, key, fallback) {
  const v = await kv.get(key, { type: "json" });
  return v == null ? fallback : v;
}

/* ------------------------- /api/items ------------------------- */

async function handleItems(req, env) {
  const kv = env.DAY_SHEET_KV;

  if (req.method === "GET") {
    const items = await kvGetJson(kv, "items", []);
    return json({ items });
  }

  if (req.method === "POST") {
    if (!checkPasscode(req)) return new Response("Invalid passcode", { status: 401 });
    const body = await readJson(req);
    if (!body) return new Response("Invalid JSON", { status: 400 });
    const item = sanitizeItem(body);
    if (!item.title) return new Response("Title is required", { status: 400 });
    item.id = "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const items = await kvGetJson(kv, "items", []);
    items.push(item);
    await kv.put("items", JSON.stringify(items));
    return json({ items });
  }

  if (req.method === "PUT") {
    if (!checkPasscode(req)) return new Response("Invalid passcode", { status: 401 });
    const body = await readJson(req);
    if (!body?.id) return new Response("id is required", { status: 400 });
    const items = await kvGetJson(kv, "items", []);
    const idx = items.findIndex((i) => i.id === body.id);
    if (idx === -1) return new Response("Not found", { status: 404 });
    const updated = sanitizeItem(body);
    if (!updated.title) return new Response("Title is required", { status: 400 });
    items[idx] = { ...items[idx], ...updated };
    await kv.put("items", JSON.stringify(items));
    return json({ items });
  }

  if (req.method === "DELETE") {
    if (!checkPasscode(req)) return new Response("Invalid passcode", { status: 401 });
    const url = new URL(req.url);
    let id = url.searchParams.get("id");
    if (!id) {
      const body = await readJson(req);
      id = body?.id ?? null;
    }
    if (!id) return new Response("id is required", { status: 400 });
    const items = await kvGetJson(kv, "items", []);
    const next = items.filter((i) => i.id !== id);
    await kv.put("items", JSON.stringify(next));
    return json({ items: next });
  }

  return new Response("Method not allowed", { status: 405 });
}

/* ------------------------- /api/notes ------------------------- */

async function handleNotes(req, env) {
  const kv = env.DAY_SHEET_KV;

  if (req.method === "GET") {
    const notes = await kvGetJson(kv, "notes", {});
    return json({ notes });
  }

  if (req.method === "PUT" || req.method === "POST") {
    if (!checkPasscode(req)) return new Response("Invalid passcode", { status: 401 });
    const body = await readJson(req);
    if (!body) return new Response("Invalid JSON", { status: 400 });
    const id = clamp(body.id, 64);
    if (!id) return new Response("id is required", { status: 400 });
    const text = clamp(body.text, 4000);
    const notes = await kvGetJson(kv, "notes", {});
    if (text) {
      notes[id] = { text, updatedAt: new Date().toISOString() };
    } else {
      delete notes[id];
    }
    await kv.put("notes", JSON.stringify(notes));
    return json({ notes });
  }

  if (req.method === "DELETE") {
    if (!checkPasscode(req)) return new Response("Invalid passcode", { status: 401 });
    const url = new URL(req.url);
    let id = url.searchParams.get("id");
    if (!id) {
      const body = await readJson(req);
      id = body?.id ?? null;
    }
    if (!id) return new Response("id is required", { status: 400 });
    const notes = await kvGetJson(kv, "notes", {});
    delete notes[id];
    await kv.put("notes", JSON.stringify(notes));
    return json({ notes });
  }

  return new Response("Method not allowed", { status: 405 });
}

/* ------------------------- /api/reminder ------------------------- */

async function handleReminder(req, env) {
  const kv = env.DAY_SHEET_KV;

  if (req.method === "GET") {
    const reminder = await kvGetJson(kv, "reminder", { text: "", updatedAt: null });
    return json(reminder);
  }

  if (req.method === "PUT") {
    if (!checkPasscode(req)) return new Response("Invalid passcode", { status: 401 });
    const body = await readJson(req);
    if (!body) return new Response("Invalid JSON", { status: 400 });
    const text = clamp(body.text, 2000);
    const reminder = { text, updatedAt: new Date().toISOString() };
    await kv.put("reminder", JSON.stringify(reminder));
    return json(reminder);
  }

  return new Response("Method not allowed", { status: 405 });
}

/* ------------------------- /api/schedule (Rentman, via KV) ------------------------- */
//
// A Cron Trigger (see wrangler.toml [triggers]) calls buildSchedule() on a
// schedule and writes the result to KV key "schedule". This handler just
// serves whatever is currently in KV, plus a POST to force an immediate
// refresh (passcode-gated, same convention as the other write endpoints) —
// useful for Rick to confirm the RENTMAN_API_TOKEN secret is working
// without waiting for the next cron tick.

const RENTMAN_BASE = "https://api.rentman.net";
const NSW_LOCATION = "/stocklocations/1";
const ALLOWED_STATUS_IDS = new Set([1, 3, 4, 5, 6]); // pending, confirmed, prepped, onlocation, returned
const WINDOW_DAYS = 14;

// Manual overrides — see CLAUDE.md "Active manual overrides". Rick has
// confirmed Rentman's own data for these specific function rows is wrong
// and given exact replacement times; these are used verbatim instead of
// whatever projectfunctions currently returns. Prune an entry once its
// date has rolled out of the visible 14-day window.
const OVERRIDES = {
  5188: { start: "2026-09-09T10:30:00+10:00", end: "2026-09-09T11:30:00+10:00" },
  5248: { start: "2026-09-09T11:30:00+10:00", end: "2026-09-09T14:00:00+10:00" }
};

// Keyword categorization — keep in sync with classify() in both HTML files.
function classify(name) {
  const n = String(name || "").toLowerCase();
  const has = (arr) => arr.some((k) => n.indexOf(k) !== -1);
  if (has(["test"])) return "test";
  if (has(["driver"])) return "driver";
  if (has(["operator", "forklift", "scissor lift", "boom lift", "crane", "ehs"])) return "operator";
  if (has(["delivery", "deliver"])) return "delivery";
  if (has(["collection", "pickup", "pick up", "pick-up", "return"])) return "collection";
  if (has(["packdown", "pack down", "pack-down", "bump out", "bump-out", "bumpout", "strike", "de-rig", "derig", "teardown", "dismantle"])) return "packdown";
  if (has(["setup", "set up", "set-up", "install", "bump in", "bump-in", "bumpin", "build up", "build-up", "rig"])) return "install";
  if (has(["warehouse", "restock", "stocktake", "stock take", "prep", "sorting"])) return "warehouse";
  return "other";
}

function statusKey(name) {
  return String(name || "").toLowerCase().replace(/\s+/g, "");
}

function sydneyTodayKey() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function addDaysToKey(dateKey, days) {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * 86400000).toISOString().slice(0, 10);
}

// Converts a Sydney *local* calendar date's midnight into the equivalent
// UTC instant, without hardcoding a fixed AEST/AEDT offset (Sydney
// observes daylight saving, and this Worker runs indefinitely across that
// boundary). Converges in 1-2 iterations.
function sydneyMidnightUtcIso(dateKey) {
  let guess = new Date(dateKey + "T00:00:00+10:00");
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  const target = new Date(dateKey + "T00:00:00Z").getTime();
  for (let i = 0; i < 3; i++) {
    const parts = fmt.formatToParts(guess);
    const get = (t) => Number(parts.find((p) => p.type === t).value);
    const localAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    const diff = target - localAsUtc;
    if (diff === 0) break;
    guess = new Date(guess.getTime() + diff);
  }
  return guess.toISOString();
}

async function rentmanRequest(env, path, params) {
  const url = new URL(RENTMAN_BASE + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v == null) continue;
      url.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
    }
  }
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${env.RENTMAN_API_TOKEN}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Rentman ${path} -> ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function rentmanGet(env, path, params) {
  const page = await rentmanRequest(env, path, params);
  return page.data;
}

async function rentmanList(env, path, params) {
  let page = await rentmanRequest(env, path, params);
  let out = (page.data || []).slice();
  let guard = 0;
  while (page.next_page_url && guard < 20) {
    const res = await fetch(page.next_page_url, { headers: { Authorization: `Bearer ${env.RENTMAN_API_TOKEN}` } });
    if (!res.ok) break;
    page = await res.json();
    out = out.concat(page.data || []);
    guard++;
  }
  return out;
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function buildSchedule(env) {
  const todayKey = sydneyTodayKey();
  const dayKeys = [];
  for (let i = 0; i < WINDOW_DAYS; i++) dayKeys.push(addDaysToKey(todayKey, i));
  const startIso = sydneyMidnightUtcIso(todayKey);
  const endIso = sydneyMidnightUtcIso(addDaysToKey(todayKey, WINDOW_DAYS));

  const fnRows = await rentmanList(env, "/projectfunctions", {
    filter: { "planperiod_start[gte]": startIso, "planperiod_start[lt]": endIso, "type[neq]": "shift" },
    fields: "id,name,type,planperiod_start,planperiod_end,subproject,project,amount,in_planning",
    limit: "500"
  });

  // Mandatory filter — see CLAUDE.md "Rentman fetch recipe" step 2. This is
  // not a type-based rule: discard any row where in_planning isn't true,
  // regardless of its "type".
  const inPlanning = fnRows.filter((r) => r.in_planning === true);
  const subIds = Array.from(new Set(inPlanning.map((r) => Number(r.subproject.split("/").pop()))));

  const subInfoById = new Map();
  await mapWithConcurrency(subIds, 8, async (sid) => {
    const sub = await rentmanGet(env, `/subprojects/${sid}`, { expand: "project,status,location" });
    subInfoById.set(sid, sub);
  });

  const survivorSubIds = new Set(
    subIds.filter((sid) => {
      const sub = subInfoById.get(sid);
      return !!sub && sub.asset_location_from === NSW_LOCATION && ALLOWED_STATUS_IDS.has(sub.status?.id);
    })
  );

  const survivorRows = inPlanning.filter((r) => survivorSubIds.has(Number(r.subproject.split("/").pop())));

  const crewByFn = new Map();
  const vehByFn = new Map();
  await mapWithConcurrency(survivorRows, 8, async (r) => {
    const [crew, vehicles] = await Promise.all([
      rentmanList(env, "/projectcrew", { filter: { function: `/projectfunctions/${r.id}` }, fields: "id,function,crewmember", expand: "crewmember" }),
      rentmanList(env, "/projectvehicles", { filter: { function: `/projectfunctions/${r.id}` }, fields: "id,function,vehicle", expand: "vehicle" })
    ]);
    crewByFn.set(r.id, crew.sort((a, b) => a.id - b.id).map((c) => c.crewmember?.displayname).filter(Boolean));
    vehByFn.set(r.id, vehicles.sort((a, b) => a.id - b.id).map((v) => (v.vehicle ? `${v.vehicle.displayname} · ${v.vehicle.licenseplate}` : null)).filter(Boolean));
  });

  const days = {};
  for (const k of dayKeys) days[k] = [];
  const jobsByDay = new Map();

  for (const r of survivorRows) {
    const sid = Number(r.subproject.split("/").pop());
    const override = OVERRIDES[r.id];
    const start = override ? override.start : r.planperiod_start;
    const end = override ? override.end : r.planperiod_end;
    const dateKey = start.slice(0, 10);
    // A function outside the currently-baked date window is real but simply
    // won't render until the window rolls forward to include it.
    if (!(dateKey in days)) continue;

    const row = {
      id: r.id,
      name: r.name,
      category: classify(r.name),
      start,
      end,
      needed: r.amount,
      crew: crewByFn.get(r.id) || [],
      vehicles: vehByFn.get(r.id) || []
    };

    let dayJobs = jobsByDay.get(dateKey);
    if (!dayJobs) {
      dayJobs = new Map();
      jobsByDay.set(dateKey, dayJobs);
    }
    let job = dayJobs.get(sid);
    if (!job) {
      const sub = subInfoById.get(sid);
      job = {
        id: sid,
        title: sub.project?.displayname || sub.project?.name || "",
        status: statusKey(sub.status?.name),
        venue: sub.location?.displayname || "",
        rows: [],
        loadError: null
      };
      dayJobs.set(sid, job);
    }
    job.rows.push(row);
  }

  for (const [dateKey, dayJobs] of jobsByDay) {
    const jobs = Array.from(dayJobs.values());
    for (const job of jobs) job.rows.sort((a, b) => a.id - b.id);
    jobs.sort((a, b) => Math.min(...a.rows.map((row) => row.id)) - Math.min(...b.rows.map((row) => row.id)));
    days[dateKey] = jobs;
  }

  return { updatedAt: new Date().toISOString(), days };
}

async function refreshSchedule(env) {
  const kv = env.DAY_SHEET_KV;
  try {
    const schedule = await buildSchedule(env);
    await kv.put("schedule", JSON.stringify(schedule));
    await kv.delete("schedule:lastError");
  } catch (err) {
    console.error("Rentman schedule refresh failed:", err);
    await kv.put("schedule:lastError", JSON.stringify({ message: String(err?.message || err), at: new Date().toISOString() }));
  }
}

async function handleSchedule(req, env) {
  const kv = env.DAY_SHEET_KV;

  if (req.method === "GET") {
    const schedule = await kvGetJson(kv, "schedule", { updatedAt: null, days: {} });
    const lastError = await kvGetJson(kv, "schedule:lastError", null);
    return json({ schedule, lastError });
  }

  if (req.method === "POST") {
    if (!checkPasscode(req)) return new Response("Invalid passcode", { status: 401 });
    await refreshSchedule(env);
    const schedule = await kvGetJson(kv, "schedule", { updatedAt: null, days: {} });
    const lastError = await kvGetJson(kv, "schedule:lastError", null);
    return json({ schedule, lastError }, { status: lastError ? 500 : 200 });
  }

  return new Response("Method not allowed", { status: 405 });
}

/* ------------------------- routing ------------------------- */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === "/api/items") return handleItems(req, env);
    if (url.pathname === "/api/notes") return handleNotes(req, env);
    if (url.pathname === "/api/reminder") return handleReminder(req, env);
    if (url.pathname === "/api/schedule") return handleSchedule(req, env);

    // Everything else is a static asset. html_handling is set to "none"
    // in wrangler.toml so /index.html and /view.html are served at those
    // exact paths with no redirect (matching the links already shared
    // with the team) — the only rewrite needed is mapping "/" to
    // "/index.html" ("/" has no literal file of its own).
    if (env.ASSETS) {
      if (url.pathname === "/") {
        const indexUrl = new URL(req.url);
        indexUrl.pathname = "/index.html";
        return env.ASSETS.fetch(new Request(indexUrl, req));
      }
      return env.ASSETS.fetch(req);
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshSchedule(env));
  }
};
