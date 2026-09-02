import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Notes keyed by Rentman row (projectfunction) id — or a manual item's own
// id, though manual items normally carry their note inline via /api/items.
// Reads (GET) stay open so the read-only contractor link can display notes.
// Writes require the shared passcode, same light-deterrent pattern as items.mts.
const PASSCODE = "4242";

function store() {
  return getStore("day-sheet-notes");
}

function checkPasscode(req: Request): boolean {
  return req.headers.get("x-day-sheet-passcode") === PASSCODE;
}

export default async (req: Request, context: Context) => {
  const store_ = store();

  if (req.method === "GET") {
    const notes = (await store_.get("notes", { type: "json" })) || {};
    return Response.json({ notes });
  }

  if (req.method === "PUT" || req.method === "POST") {
    if (!checkPasscode(req)) return new Response("Invalid passcode", { status: 401 });
    let body: any;
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    const id = String(body?.id ?? "").slice(0, 64);
    if (!id) return new Response("id is required", { status: 400 });
    const text = String(body?.text ?? "").slice(0, 4000);
    const notes = (await store_.get("notes", { type: "json" })) || {};
    if (text) {
      notes[id] = { text, updatedAt: new Date().toISOString() };
    } else {
      delete notes[id];
    }
    await store_.setJSON("notes", notes);
    return Response.json({ notes });
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
    const notes = (await store_.get("notes", { type: "json" })) || {};
    delete notes[id];
    await store_.setJSON("notes", notes);
    return Response.json({ notes });
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config: Config = {
  path: "/api/notes"
};
