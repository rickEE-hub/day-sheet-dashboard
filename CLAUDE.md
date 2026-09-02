# Day Sheet — project memory

Public, no-login warehouse-ops dashboard for Event Equipment Group (Sydney/NSW).

- Repo: `rickEE-hub/day-sheet-dashboard`.
- Data source: Rentman (via the `Rentman` MCP server), pulled manually per refresh — there is no live sync.
- **Hosting is migrating from Netlify to Cloudflare Workers** (started 2026-09-02) because Netlify meters production deploys against a monthly credit allowance that a 5x/day refresh cadence burns through fast; Cloudflare Workers Builds' free tier (500 builds/month) comfortably covers that volume at $0. See "Cloudflare deploy" below for current status — until cutover is confirmed working, the Netlify site stays up as a fallback (see "Legacy: Netlify" at the bottom).

## Live architecture (Cloudflare Worker, `worker/`)

Everything under `worker/` is the current, deployed-going-forward version of the site:

- `worker/public/index.html` — team/edit page (passcode-gated writes, passcode `2866`).
- `worker/public/view.html` — contractor/read-only page.
- `worker/src/index.js` — the Worker: serves the two pages via the Assets binding and implements `/api/items`, `/api/notes`, `/api/reminder` against Workers KV (binding `DAY_SHEET_KV`, namespace id `f02d047a1e6b4cfeab61cd5e261effb0`, title `day-sheet-kv`). Request/response shapes are unchanged from the old Netlify functions.
- `worker/wrangler.toml` — Worker name `day-sheet-dashboard` (must match the Worker name Cloudflare's dashboard created during Git import — it auto-derived this from the repo name; renamed from an earlier `ee-day-sheet` to match, 2026-09-02), assets directory `./public` with `html_handling = "none"` (serves exact `/index.html` and `/view.html` paths, no auto-redirect to extensionless URLs — the Worker adds one explicit rewrite of `/` → `/index.html` so the root URL still works). KV namespace id is already filled in.

**Schedule (Rentman) data is intentionally NOT an API endpoint.** It stays baked into `worker/public/index.html` and `worker/public/view.html`'s `<script id="app-state" type="application/json">` block, exactly like the old Netlify setup — see "Baked data mechanics" below. This was a deliberate choice, not an oversight: the Cloudflare MCP connector available in this environment can manage KV *namespaces* (create/list/delete) and inspect Workers (list/get/get-code) but has **no tool to write KV values or deploy Worker code**, and this sandbox's outbound network is locked to an allowlist that excludes `api.cloudflare.com` and `*.workers.dev` (only GitHub, npm/pypi/etc. registries, and Anthropic infra are reachable). So there is no way for a Claude session in this environment to push a live schedule update directly to a deployed Worker — only `git push` is reachable, which is why schedule refreshes stay a "bake into HTML, commit, push" workflow. Do not re-attempt the KV/live-fetch design for schedule data unless something changes about the available tools — it was tried and reverted in this session for exactly this reason.

## Cloudflare deploy (Workers Builds / Git integration)

Deploys happen via Cloudflare's Git integration (their equivalent of Netlify's auto-deploy), **not** `wrangler deploy` from this sandbox — `wrangler` can run fine locally (`wrangler dev`) for testing, but `wrangler deploy`/CLI auth cannot reach `api.cloudflare.com` from here (network policy, see above).

One-time setup (a human with dashboard access must do this, not Claude):
1. Cloudflare dashboard → **Workers & Pages** → **Create application** → **Import a repository**.
2. Connect the `rickEE-hub/day-sheet-dashboard` GitHub repo.
3. Set **Root directory** to `worker` (this is a monorepo — the Worker's `wrangler.toml` lives at `worker/wrangler.toml`, not repo root). The Worker name shown in the dashboard must match `name` in that `wrangler.toml` (`day-sheet-dashboard`) or the build fails.
4. Production branch: `main`. Deploy command defaults to `npx wrangler deploy` — leave as-is.
5. Save and deploy. Every subsequent push to `main` rebuilds and redeploys automatically (free, well within the 500 builds/month tier at this project's volume).
6. The site is served at the assigned `*.workers.dev` subdomain (Rick chose the free subdomain over a custom domain on 2026-09-02) — record the final URL here once known.

Status as of 2026-09-02: KV namespace created, `wrangler.toml` has the real namespace id, Worker code committed and pushed to `main`, verified end-to-end with local `wrangler dev` (all three API routes, static asset routing at exact `/index.html` and `/view.html` paths, Playwright screenshot pass). **Not yet actually deployed to Cloudflare** — waiting on the one-time dashboard import above.

## Rentman fetch recipe (authoritative — follow exactly, every refresh)

1. Query `projectfunctions` → action `list`, filter `{"planperiod_start[gte]":"<ISO>","planperiod_start[lt]":"<ISO>","type[neq]":"shift"}`, fields `"id,name,type,planperiod_start,planperiod_end,subproject,project,amount,in_planning"`, limit 500.
2. **Mandatory filter: `in_planning === true`.** This field is the API equivalent of the "Show in planner" toggle on each function in Rentman's "Crew and transport" UI tab, and it is what actually determines whether a function shows up in the "Crew scheduling" tab. **Discard any row where `in_planning` is not `true`**, regardless of its `type` (this is not a type-based rule — e.g. a `transport_function` can have `in_planning:true` and belongs on the sheet; a `crew_function` can have `in_planning:false` and must be dropped). Confirmed by the user (2026-09-02) against Rentman UI screenshots: "You should not get the data from the 'crew and transport' tab, but yes on 'crew scheduling' only. I have the option to show in planner or not, and you should follow that!" — this is a permanent rule, not a one-off fix.
3. Resolve each unique `subproject` via `subprojects` → `get`, `expand="location,status"`. Keep only NSW jobs: `asset_location_from === "/stocklocations/1"`, and `status.id` in `{1,3,4,5,6}` (1=pending, 3=confirmed, 4=prepped, 5=onlocation, 6=returned; excludes 2=canceled, 7=inquiry, 8=concept).
4. Fetch crew via `projectcrew` — filter `{"function":"/projectfunctions/<id>"}`, expand `crewmember`, **`fields` param is required** (e.g. `"id,function,crewmember"`) or the call fails.
5. Fetch vehicles via `projectvehicles` — same pattern, expand `vehicle`, fields `"id,function,vehicle"`. Vehicle label = `vehicle.displayname + ' · ' + vehicle.licenseplate`.
6. `classify(name)` keyword categorization (keep in sync with the JS in both HTML files): priority order — test → driver → delivery/deliver → collection/pickup/pick up/pick-up/return → packdown/pack down/pack-down/bump out/bump-out/bumpout/strike/de-rig/derig/teardown/dismantle → setup/set up/set-up/install/bump in/bump-in/bumpin/build up/build-up/rig → other.

## Resolving a Rentman "project number" the user gives you

Rick refers to jobs by Rentman's user-facing **project number**, which is the `number` field on the `projects` resource — **not** the internal `id`. To resolve: `mcp__Rentman__projects` → action `list` → filter `{"number": "<N>"}` (must be a **string**, not numeric — the API rejects a numeric filter value). Returns the project's internal `id`; use that to find its subproject(s) and functions.

## Baked data mechanics

- Schedule JSON lives at `<script id="app-state" type="application/json">{"items":[],"notes":{},"schedule":{"updatedAt":"...","days":{"YYYY-MM-DD":[...]}}}</script>` in both `worker/public/index.html` and `worker/public/view.html` (and, while the Netlify fallback is still live, in the root-level `index.html`/`view.html` too — keep all copies byte-identical in the `schedule` portion until the Netlify copies are retired).
- Each day bucket is an array of jobs; each job has a `rows` array of projectfunction rows (id, name, category, start, end, needed, crew, vehicles).
- After any data edit: bump `schedule.updatedAt` (ISO 8601 UTC), validate the JSON parses, `node --check` the inline `<script>` logic block, and ideally screenshot with Playwright (`/opt/pw-browsers/chromium`) to visually confirm before pushing.
- A function outside the currently-baked date window (e.g. an "AV Packdown" a couple of days after setup) is real but simply won't render until the window is refreshed to include it — note this to the user rather than silently adding it out-of-window.
- `items`/`notes` in this same JSON block are legacy/unused now that those are fetched live from `/api/items` and `/api/notes` — leave them as empty defaults (`[]`/`{}`), they're overwritten client-side on load.

## Deploy / git mechanics

- CCR's git proxy env vars break pushes to GitHub from this sandbox — unset them for the push:
  ```
  env -u https_proxy -u HTTPS_PROXY -u http_proxy -u HTTP_PROXY -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_KEY_1 -u GIT_CONFIG_KEY_2 -u GIT_CONFIG_VALUE_0 -u GIT_CONFIG_VALUE_1 -u GIT_CONFIG_VALUE_2 git -c http.proxy= push "https://<token>@github.com/rickEE-hub/day-sheet-dashboard.git" main:main
  ```
  Follow with `git fetch origin main` to resync the local tracking ref (pushing via an explicit URL doesn't update it automatically — expected, harmless).
- General outbound network from this sandbox is allowlist-only: GitHub (via the override above), npm/pypi/etc. registries, and Anthropic infra work; arbitrary sites (`netlify.app`, `cloudflare.com`, `api.cloudflare.com`, `*.workers.dev`, general web) do not — `curl`/`wrangler`/etc. to those will fail with a proxy CONNECT rejection. MCP connector tool calls (Netlify, Cloudflare, Rentman, etc.) are unaffected — they run through Anthropic's own MCP proxy, not this local egress path.

## Theme

Nordic Clean theme, light by default. `<html lang="en" data-theme="light">` is hardcoded on both pages so the site never falls back to a visitor's OS/browser dark-mode preference — this was a bug fixed on 2026-09-02 and must not regress.

## Legacy: Netlify (being retired)

Kept in place only as a fallback until the Cloudflare cutover is confirmed. Do not make new feature changes here — mirror any real fix into `worker/public/*.html` too, or better, treat `worker/` as the sole source of truth going forward.

- Team/edit link: https://ee-timeline.netlify.app/ · Contractor/read-only: https://ee-timeline.netlify.app/view.html
- Netlify site `ee-timeline`, auto-deploys on push to `main` — except production deploys were paused 2026-09-02 when the team's Netlify build-credit allowance ran out for the billing cycle (this is *why* the Cloudflare migration happened).
- `netlify/functions/{items,notes,reminder}.mts` — same three endpoints as the Worker, backed by `@netlify/blobs` instead of KV.
- Once Cloudflare is confirmed working and Rick has the new URL in hand, this whole Netlify path (root-level `index.html`/`view.html`, `netlify/` directory, the Netlify site itself) can be deleted/decommissioned — ask before doing so.
