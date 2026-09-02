// Day Sheet — Cloudflare Worker backend.
//
// Serves the static site (public/index.html, public/view.html) via the
// Assets binding, and implements the same four JSON endpoints the site's
// front-end already calls: /api/items, /api/notes, /api/reminder,
// /api/schedule. All four are backed by Workers KV instead of Netlify
// Blobs, but the request/response shapes are unchanged from the old
// Netlify functions, so no other front-end changes were needed.
//
// Auth: same light-deterrent shared passcode as before, sent as the
// x-day-sheet-passcode header on writes. GETs stay open for the
// read-only contractor link.

const PASSCODE = "2866";
const CATEGORIES = ["install", "packdown", "delivery", "collection", "driver", "test", "other"];

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

/* ------------------------- /api/schedule ------------------------- */
//
// This is what replaces "bake the Rentman snapshot into the HTML and
// redeploy". A refresh is now just a PUT here — no build, no deploy,
// so it doesn't touch any Cloudflare/Netlify deploy quota. Every open
// tab picks it up within ~20s via polling.

async function handleSchedule(req, env) {
  const kv = env.DAY_SHEET_KV;

  if (req.method === "GET") {
    const schedule = await kvGetJson(kv, "schedule", { updatedAt: null, days: {} });
    return json(schedule);
  }

  if (req.method === "PUT") {
    if (!checkPasscode(req)) return new Response("Invalid passcode", { status: 401 });
    const body = await readJson(req);
    if (!body || typeof body !== "object" || !body.days) {
      return new Response("Body must be {updatedAt, days}", { status: 400 });
    }
    const schedule = { updatedAt: body.updatedAt || new Date().toISOString(), days: body.days };
    await kv.put("schedule", JSON.stringify(schedule));
    return json(schedule);
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
  }
};
