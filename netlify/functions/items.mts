import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const CATEGORIES = ["install", "packdown", "delivery", "collection", "driver", "test", "other"];

// Simple shared passcode gating writes (add/edit/delete). Reads (GET) stay
// open so the read-only contractor link keeps working with no passcode.
// This is a light deterrent, not real auth — the page is public source.
const PASSCODE = "2866";

function store() {
  return getStore("day-sheet-items");
}

function checkPasscode(req: Request): boolean {
  return req.headers.get("x-day-sheet-passcode") === PASSCODE;
}

function sanitizeItem(input: any) {
  const clamp = (s: any, n: number) => String(s ?? "").slice(0, n);
  const category = CATEGORIES.includes(input?.category) ? input.category : "other";
  return {
    date: clamp(input?.date, 10),
    time: clamp(input?.time, 5),
    category,
    title: clamp(input?.title, 200),
    crew: clamp(input?.crew, 200),
    note: clamp(input?.note, 1000)
  };
}

export default async (req: Request, context: Context) => {
  const store_ = store();

  if (req.method === "GET") {
    const items = (await store_.get("items", { type: "json" })) || [];
    return Response.json({ items });
  }

  if (req.method === "POST") {
    if (!checkPasscode(req)) return new Response("Invalid passcode", { status: 401 });
    let body: any;
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    const item: any = sanitizeItem(body);
    if (!item.title) return new Response("Title is required", { status: 400 });
    item.id = "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const items = (await store_.get("items", { type: "json" })) || [];
    items.push(item);
    await store_.setJSON("items", items);
    return Response.json({ items });
  }

  if (req.method === "PUT") {
    if (!checkPasscode(req)) return new Response("Invalid passcode", { status: 401 });
    let body: any;
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    if (!body?.id) return new Response("id is required", { status: 400 });
    const items = (await store_.get("items", { type: "json" })) || [];
    const idx = items.findIndex((i: any) => i.id === body.id);
    if (idx === -1) return new Response("Not found", { status: 404 });
    const updated = sanitizeItem(body);
    if (!updated.title) return new Response("Title is required", { status: 400 });
    items[idx] = { ...items[idx], ...updated };
    await store_.setJSON("items", items);
    return Response.json({ items });
  }

  if (req.method === "DELETE") {
    if (!checkPasscode(req)) return new Response("Invalid passcode", { status: 401 });
    let id: string | null = new URL(req.url).searchParams.get("id");
    if (!id) {
      try {
        const body = await req.json();
        id = body?.id ?? null;
      } catch {}
    }
    if (!id) return new Response("id is required", { status: 400 });
    const items = (await store_.get("items", { type: "json" })) || [];
    const next = items.filter((i: any) => i.id !== id);
    await store_.setJSON("items", next);
    return Response.json({ items: next });
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config: Config = {
  path: "/api/items"
};
