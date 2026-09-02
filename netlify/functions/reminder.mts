import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// A single optional banner shown at the top of the day sheet. Reads (GET)
// stay open; writes (PUT) require the shared passcode. Setting an empty
// text clears the banner.
const PASSCODE = "4242";

function store() {
  return getStore("day-sheet-reminder");
}

function checkPasscode(req: Request): boolean {
  return req.headers.get("x-day-sheet-passcode") === PASSCODE;
}

export default async (req: Request, context: Context) => {
  const store_ = store();

  if (req.method === "GET") {
    const reminder = (await store_.get("reminder", { type: "json" })) || { text: "", updatedAt: null };
    return Response.json(reminder);
  }

  if (req.method === "PUT") {
    if (!checkPasscode(req)) return new Response("Invalid passcode", { status: 401 });
    let body: any;
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    const text = String(body?.text ?? "").slice(0, 2000);
    const reminder = { text, updatedAt: new Date().toISOString() };
    await store_.setJSON("reminder", reminder);
    return Response.json(reminder);
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config: Config = {
  path: "/api/reminder"
};
