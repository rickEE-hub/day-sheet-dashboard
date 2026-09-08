# Day Sheet — project memory

Public, no-login warehouse-ops dashboard for Event Equipment Group (Sydney/NSW).

- Repo: `rickEE-hub/day-sheet-dashboard`.
- Data source: Rentman. As of 2026-09-08 the schedule refreshes itself — the Worker's own Cron Trigger calls Rentman's REST API directly and writes to KV, no Claude session in the loop. See "Live schedule refresh (Cron Trigger)" below. The `Rentman` MCP server is still used for one-off investigation (resolving a project number, checking why a job looks wrong) and for editing the manual-overrides table, but it is no longer part of the routine refresh path.
- **Hosting is migrating from Netlify to Cloudflare Workers** (started 2026-09-02) because Netlify meters production deploys against a monthly credit allowance that a 5x/day refresh cadence burns through fast; Cloudflare Workers Builds' free tier (500 builds/month) comfortably covers that volume at $0. See "Cloudflare deploy" below for current status — until cutover is confirmed working, the Netlify site stays up as a fallback (see "Legacy: Netlify" at the bottom).

## Live architecture (Cloudflare Worker, `worker/`)

Everything under `worker/` is the current, deployed-going-forward version of the site:

- `worker/public/index.html` — team/edit page (passcode-gated writes, passcode `4242` as of 2026-09-02 — was `2866`).
- `worker/public/view.html` — contractor/read-only page.
- `worker/src/index.js` — the Worker: serves the two pages via the Assets binding and implements `/api/items`, `/api/notes`, `/api/reminder`, and `/api/schedule` against Workers KV (binding `DAY_SHEET_KV`, namespace id `f02d047a1e6b4cfeab61cd5e261effb0`, title `day-sheet-kv`). Request/response shapes for items/notes/reminder are unchanged from the old Netlify functions.
- `worker/wrangler.toml` — Worker name `day-sheet-dashboard` (must match the Worker name Cloudflare's dashboard created during Git import — it auto-derived this from the repo name; renamed from an earlier `ee-day-sheet` to match, 2026-09-02), assets directory `./public` with `html_handling = "none"` (serves exact `/index.html` and `/view.html` paths, no auto-redirect to extensionless URLs — the Worker adds one explicit rewrite of `/` → `/index.html` so the root URL still works). KV namespace id is already filled in. Also carries the `[triggers]` cron schedule for the live schedule refresh (see below).

**Schedule (Rentman) data is served live from `/api/schedule`, backed by KV.** This reverses the earlier "baked into HTML" design (see git history / old handoffs for why that was originally chosen — sandbox egress and missing MCP write tools). It changed once the real blocker turned out to be a *Claude-sandbox* limitation, not a limitation of the Worker itself: the Worker runs on Cloudflare's own infrastructure and can reach `api.rentman.net` directly, with no Claude session involved at request time. See "Live schedule refresh (Cron Trigger)" below for the mechanism. `worker/public/*.html`'s baked `<script id="app-state">` block is now only a first-paint fallback shown for an instant before the page's `fetchSchedule()` replaces it — it is not kept fresh and that's fine, see "Baked data mechanics" below.

## Cloudflare deploy (Workers Builds / Git integration)

Deploys happen via Cloudflare's Git integration (their equivalent of Netlify's auto-deploy), **not** `wrangler deploy` from this sandbox — `wrangler` can run fine locally (`wrangler dev`) for testing, but `wrangler deploy`/CLI auth cannot reach `api.cloudflare.com` from here (network policy, see above).

One-time setup (a human with dashboard access must do this, not Claude):
1. Cloudflare dashboard → **Workers & Pages** → **Create application** → **Import a repository**.
2. Connect the `rickEE-hub/day-sheet-dashboard` GitHub repo.
3. Set **Root directory** to `worker` (this is a monorepo — the Worker's `wrangler.toml` lives at `worker/wrangler.toml`, not repo root). The Worker name shown in the dashboard must match `name` in that `wrangler.toml` (`day-sheet-dashboard`) or the build fails.
4. Production branch: `main`. Deploy command defaults to `npx wrangler deploy` — leave as-is.
5. Save and deploy. Every subsequent push to `main` rebuilds and redeploys automatically (free, well within the 500 builds/month tier at this project's volume).
6. The site is served at the assigned `*.workers.dev` subdomain (Rick chose the free subdomain over a custom domain on 2026-09-02) — record the final URL here once known.

Status as of 2026-09-06: **live and working** at https://day-sheet-dashboard.rick-120.workers.dev/ (team/edit) and `/view.html` (contractor read-only). Git integration deploys automatically on every push to `main`, confirmed repeatedly via `workers_get_worker_code`. Passcode `4242`.

## Live schedule refresh (Cron Trigger) — added 2026-09-08

The manual "pull via Rentman MCP, bake into 4 HTML files, push" loop is retired for routine refreshes. Instead:

- `worker/wrangler.toml` has `[triggers] crons = ["0 */3 * * *"]` — every 3 hours.
- The Worker's exported `scheduled(event, env, ctx)` handler (in `worker/src/index.js`) calls `refreshSchedule(env)`, which runs `buildSchedule(env)` — a straight port of the "Rentman fetch recipe" below into JS, hitting `https://api.rentman.net` directly with `fetch()` — and writes the result to KV key `"schedule"`. On any error (bad token, Rentman down, etc.) the KV write is skipped entirely and the error is instead written to KV key `"schedule:lastError"`; the last good schedule is never clobbered by a failed run.
- `GET /api/schedule` (public, same as the other GETs) returns `{schedule, lastError}` straight from KV. The front-end's `fetchSchedule()` in both HTML files calls this on load, on the existing 20s poll, and on tab-visibility change.
- `POST /api/schedule` (passcode-gated, same convention as the other writes) forces an immediate refresh instead of waiting for the next cron tick — useful for confirming the setup below actually works, or for pushing out a just-added override without waiting up to 3 hours.
- The date-window math (`sydneyTodayKey`, `sydneyMidnightUtcIso` in `worker/src/index.js`) is timezone-aware via `Intl` — it does not hardcode Sydney's UTC+10 offset, because that would silently go wrong once AEDT (UTC+11) starts. Don't "simplify" it back to a fixed offset.

### Required one-time setup — a human must do this, not Claude

This cannot be completed or verified from a Claude session in this sandbox: outbound network here is allowlist-only (GitHub, npm/pypi/etc., Anthropic infra) and excludes both `api.cloudflare.com` and `api.rentman.net`, so neither "set the secret" nor "test the live call" is reachable from here.

1. **Generate a Rentman API token**: Rentman → Settings → Configuration → Account → Integrations → **API** → Connect → Show token.
2. **Set it as a Worker secret** named `RENTMAN_API_TOKEN` — either the Cloudflare dashboard (Workers & Pages → day-sheet-dashboard → Settings → Variables and Secrets → Add secret) or `npx wrangler secret put RENTMAN_API_TOKEN` run from a machine that *can* reach `api.cloudflare.com`. This is independent of git pushes/deploys — setting it once is enough, it isn't overwritten by later deploys.
3. **Verify it works**: hit `POST /api/schedule` with header `x-day-sheet-passcode: 4242` (e.g. from the browser console on the live site, or curl from a machine with normal internet access) and confirm the response has no `lastError` and `schedule.days` is populated. If `lastError` is present, its `message` is the raw HTTP status/body from Rentman — that's the fastest way to tell "bad token" (401) from something else.

One specific unknown worth flagging: the auth header format sent by `rentmanRequest()` in `worker/src/index.js` — `Authorization: Bearer <token>` — was inferred from Rentman's own OpenAPI-generated Python client pattern (`AuthenticatedClient(base_url=..., token=...)`) and general REST convention, **not confirmed against Rentman's actual API docs**, because `api.rentman.net` and its support-docs domain are both unreachable from this sandbox (WebFetch included). If step 3 above comes back with a 401 even though the token is definitely valid, this header format is the first thing to check.

## Rentman fetch recipe (authoritative — this is what `buildSchedule()` in `worker/src/index.js` implements; keep both in sync if either changes)

1. Query `projectfunctions` → action `list`, filter `{"planperiod_start[gte]":"<ISO>","planperiod_start[lt]":"<ISO>","type[neq]":"shift"}`, fields `"id,name,type,planperiod_start,planperiod_end,subproject,project,amount,in_planning"`, limit 500.
2. **Mandatory filter: `in_planning === true`.** This field is the API equivalent of the "Show in planner" toggle on each function in Rentman's "Crew and transport" UI tab, and it is what actually determines whether a function shows up in the "Crew scheduling" tab. **Discard any row where `in_planning` is not `true`**, regardless of its `type` (this is not a type-based rule — e.g. a `transport_function` can have `in_planning:true` and belongs on the sheet; a `crew_function` can have `in_planning:false` and must be dropped). Confirmed by the user (2026-09-02) against Rentman UI screenshots: "You should not get the data from the 'crew and transport' tab, but yes on 'crew scheduling' only. I have the option to show in planner or not, and you should follow that!" — this is a permanent rule, not a one-off fix.
3. Resolve each unique `subproject` via `subprojects` → `get`, `expand="location,status"`. Keep only NSW jobs: `asset_location_from === "/stocklocations/1"`, and `status.id` in `{1,3,4,5,6}` (1=pending, 3=confirmed, 4=prepped, 5=onlocation, 6=returned; excludes 2=canceled, 7=inquiry, 8=concept).
4. Fetch crew via `projectcrew` — filter `{"function":"/projectfunctions/<id>"}`, expand `crewmember`, **`fields` param is required** (e.g. `"id,function,crewmember"`) or the call fails.
5. Fetch vehicles via `projectvehicles` — same pattern, expand `vehicle`, fields `"id,function,vehicle"`. Vehicle label = `vehicle.displayname + ' · ' + vehicle.licenseplate`.
6. `classify(name)` keyword categorization (keep in sync with the JS in both HTML files): priority order — test → driver → operator/forklift/scissor lift/boom lift/crane/ehs → delivery/deliver → collection/pickup/pick up/pick-up/return → packdown/pack down/pack-down/bump out/bump-out/bumpout/strike/de-rig/derig/teardown/dismantle → setup/set up/set-up/install/bump in/bump-in/bumpin/build up/build-up/rig → warehouse/restock/stocktake/stock take/prep/sorting → other. `warehouse` sits *after* install/packdown deliberately so "Warehouse Pack Down" still reads as a packdown; `operator` sits high so "Forklift Operator" isn't swallowed by another rule.

## Active manual overrides (do not overwrite from Rentman until resolved)

Rick has told us Rentman's own data for these specific jobs is wrong, and given exact replacement times to use instead — verbatim, "These are manual overrides and stay as written, even where Rentman shows something different." **These now live as code, not just documentation**: the `OVERRIDES` object in `worker/src/index.js` (keyed by function id, each entry `{start, end}` in Sydney-local ISO with offset), applied by `buildSchedule()` on every cron run in place of whatever `projectfunctions` currently returns for that function id — crew/vehicle assignments for the same function are still pulled from Rentman normally, since only the times are disputed. Adding, changing, or removing an override is now a code change + push, not a data-bake — update both the `OVERRIDES` object and this section together.

- **Project 1468 / subproject 1510 (6M x 3M LED Wall Ground Built)** — AV Packdown (function id 5248): fixed at **2026-09-09 (Wed) 11:30–14:00**, not Rentman's value (which as of 2026-09-08 was still showing Wed 10:30–12:00). (Its AV Setup, function id 5247, is NOT overridden — keep pulling that one from Rentman normally.)
- **Project 1449 / subproject 1491 (LED Poster Board Hire)** — AV Packdown (function id 5188): fixed at **2026-09-09 (Wed) 10:30–11:30**, not Rentman's value (which as of 2026-09-08 was still showing Mon 09-08 15:28–20:30).
- ~~AV Setup (function id 5187), fixed at 2026-09-06 (Sun) 11:00–11:30~~ — **removed from `OVERRIDES` 2026-09-08.** Its override date (09-06) is now outside the 14-day window regardless of override status, so it's moot for display purposes. Rentman has since moved this row to 2026-09-07 06:58, which Rick has previously said is wrong, but he was asked twice (per the 2026-09-07 handoff) for a replacement time and hasn't answered — **do not silently re-add an override for it; ask Rick first** if he raises this job again.

These are one-off date/time corrections tied to this specific occurrence of each job, not a recurring weekday rule. Once 2026-09-09 rolls out of the visible 14-day window (i.e. once "today" passes 2026-09-09), the two remaining overrides above are moot and can be deleted from both `OVERRIDES` and this section — check with Rick before removing if in doubt.

## Resolving a Rentman "project number" the user gives you

Rick refers to jobs by Rentman's user-facing **project number**, which is the `number` field on the `projects` resource — **not** the internal `id`. To resolve: `mcp__Rentman__projects` → action `list` → filter `{"number": "<N>"}` (must be a **string**, not numeric — the API rejects a numeric filter value). Returns the project's internal `id`; use that to find its subproject(s) and functions.

## Baked data mechanics (legacy — `worker/public/*.html` only; superseded by the Cron Trigger above for anything live)

- The `<script id="app-state" type="application/json">{"items":[],"notes":{},"schedule":{"updatedAt":"...","days":{"YYYY-MM-DD":[...]}}}</script>` block in `worker/public/index.html` and `worker/public/view.html` is now **only a first-paint fallback**: `loadScheduleFromState()` renders it for the instant before `fetchSchedule()` resolves against `/api/schedule` and overwrites it client-side. It is not kept fresh by the Cron Trigger and will look stale — that's expected, don't "fix" it by re-baking unless asked.
- The root-level `index.html`/`view.html` (Netlify fallback) still use the old fully-baked model with no live fetch — see "Legacy: Netlify" below. They are not touched by the Cron Trigger change and no longer need to be kept byte-identical to the Worker copies' schedule portion, since the Worker copies' baked block is no longer the source of truth for anything live.
- Same shape as before either way: each day bucket is an array of jobs; each job has a `rows` array of projectfunction rows (id, name, category, start, end, needed, crew, vehicles).
- `items`/`notes` in this JSON block are legacy/unused now that those are fetched live from `/api/items` and `/api/notes` — leave them as empty defaults (`[]`/`{}`), they're overwritten client-side on load.
- If ever hand-editing this fallback block again (e.g. to refresh it for its own sake, not required): bump `schedule.updatedAt` (ISO 8601 UTC), validate the JSON parses, `node --check` the inline `<script>` logic block first.

## Deploy / git mechanics

- **Pushes can go through the GitHub connector's MCP tools (`mcp__github__*`) or plain `git push`** — both confirmed working 2026-09-08 once the Claude GitHub App's permission set was re-approved by Rick (`get_me` resolves to `rickEE-hub`; `push_files`/`create_or_update_file`/`create_branch` and a normal `git push` from the sandbox all work). Before that re-approval, raw `git push` hit a 403 ("Claude doesn't have GitHub access...") and `create_branch`/`push_files`-to-a-new-branch hit a 403 on the underlying `git/refs` creation call specifically — pushing to an *existing* branch worked throughout, only creating a new one was blocked. `git push` is the simpler path for large files (an HTML page with a baked JSON snapshot, say) since it doesn't require inlining full file contents into a tool call.
- General outbound network from this sandbox is allowlist-only: GitHub, npm/pypi/etc. registries, and Anthropic infra work; arbitrary sites (`netlify.app`, `cloudflare.com`, `api.cloudflare.com`, `*.workers.dev`, `api.rentman.net`, general web) do not — `curl`/`wrangler`/`WebFetch`/etc. to those will fail with a proxy/egress rejection. MCP connector tool calls (Netlify, Cloudflare, Rentman, GitHub, etc.) are unaffected — they run through Anthropic's own MCP proxy, not this local egress path.

## Day window — 14 days (changed 2026-09-07)

The sheet started as a 3-day view, went to 5, and is now **14 days** at Rick's request. `DAY_OFFSETS` in the inline `<script id="app-script">` of all 4 HTML files is `[0..13]`. Day tabs are 14 static `.day-tab` buttons in the markup, laid out as a CSS grid — `repeat(7,1fr)` (7 across, 2 rows) on desktop, `repeat(4,1fr)` (4 across, 4 rows) at `max-width:640px`. `WINDOW_DAYS = 14` in `worker/src/index.js`'s `buildSchedule()` keeps the live `/api/schedule` data matching this — if the day count ever changes again, update both, or the back half of the sheet renders as empty days.

## Categories

Nine categories: `install`, `packdown`, `delivery`, `collection`, `driver`, `warehouse`, `operator`, `test`, `other`. `warehouse` (olive `#4D7C0F`) and `operator` (deep red `#B91C1C`) were added 2026-09-07 — colors are provisional, revisit if Rick wants different ones. Adding a category means touching: the `--cat-*`/`--cat-*-soft` vars in all three colour blocks of each HTML file (light, `prefers-color-scheme` dark, explicit dark), the `.cat-*` chip class, the legend row, `CAT_LABEL` in the JS (drives the Add-item dropdown), `classify()`, and the `CATEGORIES` allowlist in both `worker/src/index.js` and `netlify/functions/items.mts` (the Worker silently coerces unknown categories to `other`). Unlike the original 7, Warehouse and Operator **do** have Rentman-keyword auto-classification — see the `classify()` entry above.

## Branding

The masthead h1 reads **"Daily Schedule"** (renamed from "Day Sheet" 2026-09-07; the project, repo and Worker keep the day-sheet name). Empty-state text reads "No jobs or tasks for X" (was "No jobs or manual items for X"). The Event Equipment "AUDIO VISUAL" logo (red play-button + wordmark) renders top-right on both pages: background removed (distance-from-white alpha ramp, no white halo), cropped, resized to 100px height, re-encoded as WebP, and embedded **inline** as a `data:image/webp;base64,...` `<img class="logo">` — no external hosting (`/logo.png` was tried first by another pass at this change and doesn't work, since Cloudflare's Assets binding only serves files actually committed to `worker/public/`, and none was; inline data-URI is the only approach consistent with this project's fully self-contained-HTML architecture — don't reintroduce an external logo path). It sits inside a `.logo-bar` div (`display:flex; justify-content:flex-end;`) that is the very first child of `.wrap`, above the reminder banner and masthead — this renders as top-right regardless of the masthead's own wrap behavior. Do **not** position the logo with `position:absolute` relative to `.wrap` either — tried and reverted, it overlapped the snapshot badge on `view.html` (whose masthead-right never wraps, unlike `index.html`'s, which does wrap under the title at normal desktop widths because the eyebrow text + badge/buttons don't both fit above ~1400px — pre-existing layout behavior, not a regression). The `.logo-bar` row sidesteps that by reserving its own dedicated space.

## Theme

Nordic Clean theme, light by default. `<html lang="en" data-theme="light">` is hardcoded on both pages so the site never falls back to a visitor's OS/browser dark-mode preference — this was a bug fixed on 2026-09-02 and must not regress.

## Legacy: Netlify (being retired)

Kept in place only as a fallback until the Cloudflare cutover is confirmed. Do not make new feature changes here — mirror any real fix into `worker/public/*.html` too, or better, treat `worker/` as the sole source of truth going forward.

- Team/edit link: https://ee-timeline.netlify.app/ · Contractor/read-only: https://ee-timeline.netlify.app/view.html
- Netlify site `ee-timeline`, auto-deploys on push to `main` — except production deploys were paused 2026-09-02 when the team's Netlify build-credit allowance ran out for the billing cycle (this is *why* the Cloudflare migration happened).
- `netlify/functions/{items,notes,reminder}.mts` — same three endpoints as the Worker, backed by `@netlify/blobs` instead of KV.
- Once Cloudflare is confirmed working and Rick has the new URL in hand, this whole Netlify path (root-level `index.html`/`view.html`, `netlify/` directory, the Netlify site itself) can be deleted/decommissioned — ask before doing so.
